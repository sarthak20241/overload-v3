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
  try {
    const monday = mondayOfLocal(todayLocalISO());
    const [y, m, d] = monday.split('-').map((n) => parseInt(n, 10));
    const sinceISO = new Date(y, m - 1, d).toISOString();
    const { data } = await supabase
      .from('workouts')
      .select('name, started_at, finished_at')
      .eq('user_id', clerkId)
      .not('finished_at', 'is', null)
      .gte('started_at', sinceISO)
      .order('started_at', { ascending: true });
    const out = { ...empty, doneByDay: [...empty.doneByDay] };
    for (const w of (data ?? []) as { name: string | null; started_at: string }[]) {
      const day = weekdayIndex(localISO(new Date(w.started_at)));
      if (day < 0 || day > 6) continue;
      if (out.doneByDay[day] == null) out.doneByDay[day] = w.name ?? '';
      out.count += 1;
    }
    return out;
  } catch {
    return empty;
  }
}

export interface RoutineSummary {
  id: string;
  name: string;
  exercises: number;
}

/** The phase's routines with how many exercises each holds. */
export async function loadRoutineSummaries(supabase: SupabaseClient, routineIds: string[]): Promise<RoutineSummary[]> {
  if (routineIds.length === 0) return [];
  try {
    const { data } = await supabase
      .from('routines')
      .select('id, name, created_at, routine_exercises(id)')
      .in('id', routineIds)
      .order('created_at', { ascending: true });
    return ((data ?? []) as { id: string; name: string; routine_exercises: { id: string }[] | null }[])
      .map((r) => ({ id: r.id, name: r.name, exercises: r.routine_exercises?.length ?? 0 }));
  } catch {
    return [];
  }
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
  try {
    const { data } = await supabase
      .from('daily_metrics')
      .select('metric_date, value')
      .eq('user_id', clerkId)
      .eq('metric_type', 'sleep_minutes')
      .gte('metric_date', days[0])
      .lte('metric_date', today);
    for (const r of (data ?? []) as { metric_date: string; value: number }[]) {
      const n = out.find((x) => x.day === r.metric_date);
      const v = Number(r.value);
      if (n && Number.isFinite(v) && v > 0) n.hours = Math.round((v / 60) * 10) / 10;
    }
  } catch {
    /* empty nights */
  }
  return out;
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
  try {
    const { data } = await supabase
      .from('daily_metrics')
      .select('metric_type, metric_date, value')
      .eq('user_id', clerkId)
      .in('metric_type', ['readiness_score', 'resting_hr_bpm', 'hrv_sdnn_ms', 'sleep_minutes'])
      .gte('metric_date', addDaysLocal(today, -28))
      .lte('metric_date', today);
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
  } catch {
    /* nothing today */
  }
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
