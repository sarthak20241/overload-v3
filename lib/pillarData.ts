/**
 * The readings behind the Train / Eat / Recover screens (app/goal-plan-pillar.tsx):
 * this week's finished sessions by weekday, the phase's routines with their
 * exercise counts, the last seven nights of sleep, and today's readiness,
 * resting heart rate and HRV against their four-week usual. All from tables
 * the app already reads; every read is best-effort and answers empty rather
 * than throwing, because each is one block on a screen that still renders
 * without it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { todayLocalISO } from '@/lib/programData';
import { bandForScore, directive, type ReadinessBand } from '@/lib/readiness';
import { liveFrom, type LiveReadings } from '@/lib/phaseMetricHeadline';
import { fetchShared, peek, prune } from '@/lib/screenCache';

function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The Monday of the local week `iso` falls in. */
export function mondayOfLocal(iso: string): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return localISO(dt);
}

export function addDaysLocal(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return localISO(new Date(y, m - 1, d + delta));
}

/** 0 = Monday ... 6 = Sunday for a local ISO day. */
export function weekdayIndex(iso: string): number {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

export const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
export const DAY_NAMES_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export interface WeekSessions {
  /** Finished workouts this local week, by weekday (0 = Monday): the first routine name done that day, or '' for a freestyle session. */
  doneByDay: (string | null)[];
  /** Finished workouts this week, in all. */
  count: number;
}

/** This local week's finished sessions, Monday first. */
export async function loadWeekSessions(supabase: SupabaseClient, clerkId: string): Promise<WeekSessions> {
  const empty: WeekSessions = { doneByDay: Array.from({ length: 7 }, () => null), count: 0 };
  const monday = mondayOfLocal(todayLocalISO());
  const [y, m, d] = monday.split('-').map((n) => parseInt(n, 10));
  const sinceISO = new Date(y, m - 1, d).toISOString();
  const { data, error } = await supabase
    .from('workouts')
    .select('name, started_at, finished_at')
    .eq('user_id', clerkId)
    .not('finished_at', 'is', null)
    .gte('started_at', sinceISO)
    .order('started_at', { ascending: true });
  if (error) throw error;
  const out = { ...empty, doneByDay: [...empty.doneByDay] };
  for (const w of (data ?? []) as { name: string | null; started_at: string }[]) {
    const day = weekdayIndex(localISO(new Date(w.started_at)));
    if (day < 0 || day > 6) continue;
    if (out.doneByDay[day] == null) out.doneByDay[day] = w.name ?? '';
    out.count += 1;
  }
  return out;
}

export interface RoutineSummary {
  id: string;
  name: string;
  exercises: number;
}

/** The phase's routines with how many exercises each holds. */
export async function loadRoutineSummaries(supabase: SupabaseClient, routineIds: string[]): Promise<RoutineSummary[]> {
  if (routineIds.length === 0) return [];
  const { data, error } = await supabase
    .from('routines')
    .select('id, name, created_at, routine_exercises(id)')
    .in('id', routineIds)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { id: string; name: string; routine_exercises: { id: string }[] | null }[])
    .map((r) => ({ id: r.id, name: r.name, exercises: r.routine_exercises?.length ?? 0 }));
}

export interface Night {
  /** Local ISO day the night belongs to (the morning it ended). */
  day: string;
  /** Hours asleep, or null when nothing was recorded. */
  hours: number | null;
}

/** The last seven nights of sleep, oldest first, with gaps kept as null. */
export async function loadLastNights(supabase: SupabaseClient, clerkId: string, nights = 7): Promise<Night[]> {
  const today = todayLocalISO();
  const days = Array.from({ length: nights }, (_, i) => addDaysLocal(today, i - (nights - 1)));
  const out: Night[] = days.map((day) => ({ day, hours: null }));
  const { data, error } = await supabase
    .from('daily_metrics')
    .select('metric_date, value')
    .eq('user_id', clerkId)
    .eq('metric_type', 'sleep_minutes')
    .gte('metric_date', days[0])
    .lte('metric_date', today);
  if (error) throw error;
  for (const r of (data ?? []) as { metric_date: string; value: number }[]) {
    const n = out.find((x) => x.day === r.metric_date);
    const v = Number(r.value);
    if (n && Number.isFinite(v) && v > 0) n.hours = Math.round((v / 60) * 10) / 10;
  }
  return out;
}

/**
 * The live readings every screen falls back to when a metric has no job
 * reading yet (lib/phaseMetricHeadline.ts): sessions since Monday and the
 * sleep average of the last seven nights. Throws when either read fails;
 * callers keep the readings they had.
 */
export async function loadLiveReadings(supabase: SupabaseClient, clerkId: string): Promise<LiveReadings> {
  const [week, nights] = await Promise.all([sharedWeekSessions(supabase, clerkId), sharedLastNights(supabase, clerkId)]);
  return liveFrom(week, nights);
}

export interface Vital {
  value: number;
  /** The four-week usual, when there are enough days to say. */
  usual: number | null;
}

export interface TodayVitals {
  readiness: number | null;
  rhr: Vital | null;
  hrv: Vital | null;
  /** Any sleep, readiness, heart or HRV reading in the last 28 days at all. */
  anyHealthData: boolean;
}

/** Today's readiness, resting heart rate and HRV, each with its 28-day usual. */
export async function loadTodayVitals(supabase: SupabaseClient, clerkId: string): Promise<TodayVitals> {
  const today = todayLocalISO();
  const out: TodayVitals = { readiness: null, rhr: null, hrv: null, anyHealthData: false };
  const { data, error } = await supabase
    .from('daily_metrics')
    .select('metric_type, metric_date, value')
    .eq('user_id', clerkId)
    .in('metric_type', ['readiness_score', 'resting_hr_bpm', 'hrv_sdnn_ms', 'sleep_minutes'])
    .gte('metric_date', addDaysLocal(today, -28))
    .lte('metric_date', today);
  if (error) throw error;
  const rows = (data ?? []) as { metric_type: string; metric_date: string; value: number }[];
  out.anyHealthData = rows.length > 0;
  const vital = (type: string): Vital | null => {
    const todayRow = rows.find((r) => r.metric_type === type && r.metric_date === today);
    if (!todayRow || !Number.isFinite(Number(todayRow.value))) return null;
    const past = rows.filter((r) => r.metric_type === type && r.metric_date !== today).map((r) => Number(r.value)).filter((v) => Number.isFinite(v) && v > 0);
    const usual = past.length >= 5 ? past.reduce((a, b) => a + b, 0) / past.length : null;
    return { value: Number(todayRow.value), usual };
  };
  const r = rows.find((x) => x.metric_type === 'readiness_score' && x.metric_date === today);
  out.readiness = r && Number.isFinite(Number(r.value)) ? Number(r.value) : null;
  out.rhr = vital('resting_hr_bpm');
  out.hrv = vital('hrv_sdnn_ms');
  return out;
}

/** "Push today" / "Train as planned" / "Ease off today", from the readiness band. */
export function readinessVerdict(score: number): { text: string; band: ReadinessBand } {
  const band = bandForScore(score);
  return { text: directive(band), band };
}

/** Resting heart rate against the usual: lower is better. */
export function rhrVerdict(v: Vital): { text: string; tone: 'ok' | 'warn' | 'dim' } {
  if (v.usual == null) return { text: 'No usual yet', tone: 'dim' };
  const r = v.value / v.usual;
  if (r <= 0.95) return { text: 'Low', tone: 'ok' };
  if (r >= 1.05) return { text: 'High', tone: 'warn' };
  return { text: 'Normal', tone: 'dim' };
}

/** HRV against the usual: higher is better. */
export function hrvVerdict(v: Vital): { text: string; tone: 'ok' | 'warn' | 'dim' } {
  if (v.usual == null) return { text: 'No usual yet', tone: 'dim' };
  const r = v.value / v.usual;
  if (r >= 1.05) return { text: 'Up', tone: 'ok' };
  if (r <= 0.95) return { text: 'Down', tone: 'warn' };
  return { text: 'Flat', tone: 'dim' };
}

// ---- Shared, cached reads (lib/screenCache.ts) ------------------------------
// The Goal screen starts these for the current phase as soon as it has the
// program, so tapping Train, Eat or Recover paints at once from the cache
// and only refreshes in the background. Keys carry the local day (or week),
// so a value never crosses midnight.

const weekKey = (clerkId: string) => `pillar:week:${clerkId}:${mondayOfLocal(todayLocalISO())}`;
const nightsKey = (clerkId: string) => `pillar:nights:${clerkId}:${todayLocalISO()}`;
const vitalsKey = (clerkId: string) => `pillar:vitals:${clerkId}:${todayLocalISO()}`;
const routinesKey = (clerkId: string, ids: string[]) => `pillar:routines:${clerkId}:${[...ids].sort().join(',')}`;

/** Read through the cache, first dropping this user's older entries of the same kind (past days, an old routine set). */
function shared<T>(kindPrefix: string, key: string, fn: () => Promise<T>): Promise<T> {
  prune(kindPrefix, key);
  return fetchShared(key, fn);
}
export const sharedWeekSessions = (s: SupabaseClient, clerkId: string) =>
  shared(`pillar:week:${clerkId}`, weekKey(clerkId), () => loadWeekSessions(s, clerkId));
export const sharedLastNights = (s: SupabaseClient, clerkId: string) =>
  shared(`pillar:nights:${clerkId}`, nightsKey(clerkId), () => loadLastNights(s, clerkId));
export const sharedTodayVitals = (s: SupabaseClient, clerkId: string) =>
  shared(`pillar:vitals:${clerkId}`, vitalsKey(clerkId), () => loadTodayVitals(s, clerkId));
export const sharedRoutineSummaries = (s: SupabaseClient, clerkId: string, ids: string[]) =>
  shared(`pillar:routines:${clerkId}`, routinesKey(clerkId, ids), () => loadRoutineSummaries(s, ids));

export const peekWeekSessions = (clerkId: string | null) => (clerkId ? peek<WeekSessions>(weekKey(clerkId)) : undefined);
export const peekLastNights = (clerkId: string | null) => (clerkId ? peek<Night[]>(nightsKey(clerkId)) : undefined);
export const peekTodayVitals = (clerkId: string | null) => (clerkId ? peek<TodayVitals>(vitalsKey(clerkId)) : undefined);
export const peekRoutineSummaries = (clerkId: string | null, ids: string[]) =>
  (clerkId ? (ids.length === 0 ? [] : peek<RoutineSummary[]>(routinesKey(clerkId, ids))) : undefined);

/** The live readings from the cache, when both parts are there. */
export function peekLiveReadings(clerkId: string | null): LiveReadings | null {
  const week = peekWeekSessions(clerkId);
  const nights = peekLastNights(clerkId);
  return week && nights ? liveFrom(week, nights) : null;
}

/**
 * Warm the pillar screens for a phase: this week's sessions, the last seven
 * nights, today's vitals, and the phase's routine summaries, all at once, and
 * only the ones the cache does not hold yet (the screens refresh on focus).
 * Fire and forget: a failed read is simply not cached, and the screen reads
 * it again when it opens.
 */
export function prefetchPillars(s: SupabaseClient, clerkId: string, routineIds: string[]): void {
  const quiet = (p: Promise<unknown>) => { p.catch(() => {}); };
  if (peekWeekSessions(clerkId) === undefined) quiet(sharedWeekSessions(s, clerkId));
  if (peekLastNights(clerkId) === undefined) quiet(sharedLastNights(s, clerkId));
  if (peekTodayVitals(clerkId) === undefined) quiet(sharedTodayVitals(s, clerkId));
  if (routineIds.length > 0 && peekRoutineSummaries(clerkId, routineIds) === undefined) quiet(sharedRoutineSummaries(s, clerkId, routineIds));
}
