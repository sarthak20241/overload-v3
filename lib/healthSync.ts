/**
 * Holistic tracking: the READ / mirror pipeline.
 *
 * This is a PULL, deliberately SEPARATE from the push write queue
 * (lib/syncQueue.ts). On app-open / AppState 'active' the platform adapter reads
 * daily-aggregated health data from the hub (Apple HealthKit on iOS, Android
 * Health Connect on Android), and we upsert it into the `daily_metrics` table
 * (migration 0053). The (user, day, type) tuple is the idempotency key, so a
 * re-read of a day overwrites with the latest deduped aggregate.
 *
 * Both native adapters ship in this PR (HealthKit on iOS, Health Connect on
 * Android), so getHealthAdapter() returns the platform adapter and
 * syncHealthData() reads real data once the libs are installed + prebuilt.
 * getHealthAdapter() still returns null on web / unsupported platforms, where
 * syncHealthData() stays a safe no-op. This file is the platform-agnostic
 * backbone the adapters plug into.
 *
 * Plan: .planning/holistic-tracking-plan.md (sections 2, 3d, 3e).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dailyMetricDef, type DailyMetricType, type MetricSource } from './dailyMetrics';
import type { HealthHub } from './healthSources';

/** The metric types a platform hub can populate (everything except the derived readiness score). */
export type ReadableMetric = Exclude<DailyMetricType, 'readiness_score'>;

export const READABLE_METRICS: ReadableMetric[] = [
  'steps',
  'sleep_minutes',
  'bodyweight_kg',
  'resting_hr_bpm',
  'hrv_sdnn_ms',
  'active_energy_kcal',
];

/** One daily-aggregated reading the platform already deduped across its sources. */
export interface DailyReading {
  type: ReadableMetric;
  /** Local calendar day, 'YYYY-MM-DD'. */
  date: string;
  value: number;
  source: MetricSource;
}

/**
 * What every platform adapter implements. The orchestration owns cursors,
 * upserts and scheduling; the adapter only knows how to authorize and read.
 */
export interface HealthAdapter {
  readonly hub: HealthHub;
  /** Is the hub present/usable on this device (HealthKit available, Health Connect installed + ready)? */
  isAvailable(): Promise<boolean>;
  /** Request read authorization for the given types. Resolves true if we can proceed (note: iOS read denial is invisible, treat empty as no-data). */
  requestAuthorization(types: ReadableMetric[]): Promise<boolean>;
  /** Daily-aggregated readings for [sinceDate, today], already deduped by the platform's statistics/aggregate query. */
  readDaily(sinceDate: string, types: ReadableMetric[]): Promise<DailyReading[]>;
}

// ── cursors (per-user, AsyncStorage, same keying convention as syncQueue) ─────
const CURSOR_KEY = (userId: string) => `health_sync_cursor_v1::${userId}`;
/** How far back to read on first sync / when no cursor exists (covers the readiness baseline window). */
const DEFAULT_BACKFILL_DAYS = 28;
/** Re-read this many days before the cursor each run, to catch backdated writes (the platform reads do not surface deletions; a periodic full reconcile handles those). */
const OVERLAP_DAYS = 2;

async function getCursor(userId: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(CURSOR_KEY(userId));
  } catch {
    return null;
  }
}

async function setCursor(userId: string, isoDay: string): Promise<void> {
  try {
    await AsyncStorage.setItem(CURSOR_KEY(userId), isoDay);
  } catch {
    // A failed cursor write just means we re-read an overlapping window next time; upserts are idempotent.
  }
}

// ── local-day helpers (app runtime; bucket on the user's local calendar day) ──
function toLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayLocalISO(): string {
  return toLocalISO(new Date());
}

function shiftDaysISO(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return toLocalISO(new Date(y, m - 1, d + deltaDays));
}

/**
 * Resolve the platform adapter, or null when none applies (e.g. web).
 *
 * Lazy-require so each platform only loads its OWN native module: importing the
 * iOS HealthKit module on Android (or vice versa) would pull in a native module
 * that doesn't exist on that platform. This is the ONLY place that branches on
 * platform, so the rest of the pipeline stays platform-agnostic.
 */
export function getHealthAdapter(): HealthAdapter | null {
  if (Platform.OS === 'ios') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./health/healthkitAdapter').healthkitAdapter as HealthAdapter;
  }
  if (Platform.OS === 'android') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./health/healthConnectAdapter').healthConnectAdapter as HealthAdapter;
  }
  return null;
}

/**
 * Ask the platform for READ authorization. Call on an explicit user tap (the
 * connect screen), not at app boot. On iOS this resolves true once the auth
 * sheet is handled, NOT whether read was granted (read-denial is invisible).
 * Returns false when no hub is available on this device.
 */
export async function requestHealthAuthorization(): Promise<boolean> {
  const adapter = getHealthAdapter();
  if (!adapter) return false;
  if (!(await adapter.isAvailable())) return false;
  return adapter.requestAuthorization(READABLE_METRICS);
}

/**
 * Read from the hub and mirror into daily_metrics. Safe no-op when no adapter is
 * wired or the hub is unavailable/unauthorized. Never writes readiness_score
 * (that is derived elsewhere and frozen per past day).
 *
 * Returns the number of rows written, or null when sync did not run.
 */
export async function syncHealthData(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ written: number } | null> {
  if (!userId) return null;
  const adapter = getHealthAdapter();
  if (!adapter || !(await adapter.isAvailable())) return null;

  const cursor = await getCursor(userId);
  const since = cursor
    ? shiftDaysISO(cursor, -OVERLAP_DAYS)
    : shiftDaysISO(todayLocalISO(), -DEFAULT_BACKFILL_DAYS);

  const readings = await adapter.readDaily(since, READABLE_METRICS);
  const today = todayLocalISO();

  if (readings.length === 0) {
    // Don't advance the cursor here: on iOS a read denial is indistinguishable
    // from "no data", and a foreground sync can run before the user grants
    // access. Advancing to today would shrink the next sync to just the overlap
    // window and skip most of the initial readiness baseline once permission is
    // actually granted — so leave the cursor and let the next run retry `since`.
    return { written: 0 };
  }

  const rows = readings.map((r) => ({
    user_id: userId,
    metric_date: r.date,
    metric_type: r.type,
    value: r.value,
    unit: dailyMetricDef(r.type)?.storedUnit ?? null,
    source: r.source,
  }));

  const { error } = await supabase
    .from('daily_metrics')
    .upsert(rows, { onConflict: 'user_id,metric_date,metric_type' });
  if (error) throw error;

  await setCursor(userId, today);
  return { written: rows.length };
}

/**
 * Which readable metrics have FRESH data (a daily_metrics row within the last
 * `freshDays`). This is our honest "what's connected" signal: iOS never reports
 * read-grant, so we infer a source is feeding from the presence of its rows
 * rather than from any permission read-back. Read-only.
 */
export async function loadConnectedMetrics(
  supabase: SupabaseClient,
  userId: string,
  freshDays = 3,
): Promise<Set<ReadableMetric>> {
  const present = new Set<ReadableMetric>();
  if (!userId) return present;
  const since = shiftDaysISO(todayLocalISO(), -freshDays);
  const { data, error } = await supabase
    .from('daily_metrics')
    .select('metric_type')
    .eq('user_id', userId)
    .in('metric_type', READABLE_METRICS as unknown as string[])
    .gte('metric_date', since);
  if (error) throw error;
  for (const r of (data ?? []) as { metric_type: string }[]) {
    if ((READABLE_METRICS as unknown as string[]).includes(r.metric_type)) {
      present.add(r.metric_type as ReadableMetric);
    }
  }
  return present;
}

/**
 * Recent daily series for every readable metric, ascending, grouped by type.
 * Powers the hub's "Your signals" trend cards. Read-only.
 */
export async function loadMetricSeries(
  supabase: SupabaseClient,
  userId: string,
  days = 14,
): Promise<Record<string, { date: string; value: number }[]>> {
  const out: Record<string, { date: string; value: number }[]> = {};
  if (!userId) return out;
  const since = shiftDaysISO(todayLocalISO(), -days);
  const { data, error } = await supabase
    .from('daily_metrics')
    .select('metric_type, metric_date, value')
    .eq('user_id', userId)
    .in('metric_type', READABLE_METRICS as unknown as string[])
    .gte('metric_date', since)
    .order('metric_date', { ascending: true });
  if (error) throw error;
  for (const r of (data ?? []) as { metric_type: string; metric_date: string; value: number | string }[]) {
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    (out[r.metric_type] ||= []).push({ date: r.metric_date, value: v });
  }
  return out;
}
