/**
 * Bridges the pure readiness compute (lib/readiness.ts) to the database.
 *
 * Reads the user's recent daily_metrics (today's values + a trailing baseline),
 * computes readiness, and upserts today's readiness_score back into
 * daily_metrics. Past days are never recomputed (the upsert only targets the
 * current local day), so a stored historical readiness stays frozen as the user
 * saw it (plan .planning/holistic-tracking-plan.md s5).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeReadiness, type BaselineStat, type ReadinessResult } from './readiness';
import { syncHealthData } from './healthSync';

const BASELINE_DAYS = 28;
const RECOVERY_TYPES = ['sleep_minutes', 'resting_hr_bpm', 'hrv_sdnn_ms'] as const;

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

function stat(values: number[]): BaselineStat {
  const n = values.length;
  if (n === 0) return { mean: null, sd: null, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, sd: Math.sqrt(variance), n };
}

/**
 * Compute today's readiness from daily_metrics WITHOUT writing. Read-only, so the
 * dashboard card can call it on render. Returns null when there is no user.
 * Acute training-load tempering is a documented TODO (read base
 * workouts/workout_sets, never the absent matviews).
 */
export async function loadReadiness(
  supabase: SupabaseClient,
  userId: string,
): Promise<ReadinessResult | null> {
  if (!userId) return null;
  const today = todayLocalISO();
  const since = shiftDaysISO(today, -BASELINE_DAYS);

  const { data, error } = await supabase
    .from('daily_metrics')
    .select('metric_date, metric_type, value')
    .in('metric_type', RECOVERY_TYPES as unknown as string[])
    .gte('metric_date', since)
    .lte('metric_date', today);
  if (error) throw error;

  const rows = (data ?? []) as { metric_date: string; metric_type: string; value: number | string }[];
  const todayVal: Record<string, number | null> = { sleep_minutes: null, resting_hr_bpm: null, hrv_sdnn_ms: null };
  const baseline: Record<string, number[]> = { sleep_minutes: [], resting_hr_bpm: [], hrv_sdnn_ms: [] };

  for (const r of rows) {
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    if (r.metric_date === today) todayVal[r.metric_type] = v;
    else if (baseline[r.metric_type]) baseline[r.metric_type].push(v);
  }

  return computeReadiness({
    today: {
      sleepMinutes: todayVal.sleep_minutes,
      restingHrBpm: todayVal.resting_hr_bpm,
      hrvMs: todayVal.hrv_sdnn_ms,
    },
    baseline: {
      sleepMinutes: stat(baseline.sleep_minutes),
      restingHrBpm: stat(baseline.resting_hr_bpm),
      hrvMs: stat(baseline.hrv_sdnn_ms),
    },
    // acuteLoad: TODO read recent set count vs typical from base workout tables.
  });
}

/**
 * Compute today's readiness and STORE it (current day only; past days frozen).
 * Thin wrapper over loadReadiness used by the foreground sync.
 */
export async function computeAndStoreReadiness(
  supabase: SupabaseClient,
  userId: string,
): Promise<ReadinessResult | null> {
  const result = await loadReadiness(supabase, userId);
  if (result && result.score != null) {
    const { error: upErr } = await supabase.from('daily_metrics').upsert(
      { user_id: userId, metric_date: todayLocalISO(), metric_type: 'readiness_score', value: result.score, unit: 'score', source: 'manual' },
      { onConflict: 'user_id,metric_date,metric_type' },
    );
    if (upErr) throw upErr;
  }
  return result;
}

/**
 * Foreground entry point: pull the latest hub data, then recompute today's
 * readiness from it. Safe to call on every app-open; both steps are idempotent.
 */
export async function runHealthSyncAndReadiness(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ synced: number | null; readiness: ReadinessResult | null }> {
  let synced: number | null = null;
  try {
    const r = await syncHealthData(supabase, userId);
    synced = r?.written ?? null;
  } catch {
    // A mirror failure should not block readiness from recomputing on cached data.
  }
  const readiness = await computeAndStoreReadiness(supabase, userId);
  return { synced, readiness };
}
