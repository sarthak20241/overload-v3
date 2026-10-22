/**
 * The weekly check of a phase's metrics: this week's number for each metric,
 * from what the app already stores, and its status word (phaseMetrics.ts).
 *
 * The readings are gathered by the drona-cards worker (metrics.ts) from the
 * same tables the rest of Drona reads: weigh-ins and steps and sleep from
 * daily_metrics, a lift's e1RM from user_lift_stats, sets per muscle from
 * user_volume_stats, sessions and cardio from drona_week_facts, protein days
 * from user_nutrition_stats, a distance or duration from workout_sets, a
 * custom metric from its own logs. This file only does the arithmetic, so
 * `deno test` reaches it.
 *
 * Pure: no network, no Date.
 */
import {
  isWeeklyKind, type MetricKind, type MetricRef, type MetricStatus, statusFor,
} from './phaseMetrics.ts';
import { MUSCLE_GROUP_REFINEMENTS } from './exerciseVocab.ts';

/** This week's numbers, each null when the source had nothing. */
export interface WeeklyReadings {
  /** The latest weigh-in, kg. */
  bodyweight: number | null;
  /** Estimated one-rep max by exercise id, kg. */
  e1rm_by_exercise: Record<string, number>;
  /** Working sets last whole week by muscle group (as user_volume_stats names them). */
  sets_by_muscle: Record<string, number>;
  /** Finished workouts last whole week. */
  sessions: number | null;
  /** Cardio sessions last whole week. */
  cardio_sessions: number | null;
  /** Steps a day, averaged over last whole week's complete days. */
  steps_avg: number | null;
  /** Hours asleep a night, averaged over last whole week. */
  sleep_avg_h: number | null;
  /** Days last whole week at or above the protein target. */
  protein_days: number | null;
  /** The longest distance in one logged set of any exercise, km. */
  distance_best_km: number | null;
  /** The longest time in one logged set of any exercise, minutes. */
  duration_best_min: number | null;
  /** For a distance or duration metric that names its exercise: that exercise's best, by metric id. */
  best_by_metric: Record<string, number>;
  /** The latest hand-logged value by metric id. */
  custom_latest: Record<string, number>;
}

export const EMPTY_READINGS: WeeklyReadings = {
  bodyweight: null,
  e1rm_by_exercise: {},
  sets_by_muscle: {},
  sessions: null,
  cardio_sessions: null,
  steps_avg: null,
  sleep_avg_h: null,
  protein_days: null,
  distance_best_km: null,
  duration_best_min: null,
  best_by_metric: {},
  custom_latest: {},
};

export interface MetricToCheck {
  id: string;
  kind: MetricKind;
  direction: 'up' | 'down' | 'hold';
  ref?: MetricRef | null;
  start_value: number | null;
  target_value: number;
  current_value: number | null;
}

/** The sets on one muscle group: the group itself plus its finer heads (Chest counts "Upper Chest"). */
export function setsForMuscle(setsByMuscle: Record<string, number>, muscle: string): number | null {
  const names = new Set<string>([muscle, ...(MUSCLE_GROUP_REFINEMENTS[muscle] ?? [])]);
  let total = 0;
  let any = false;
  for (const [group, sets] of Object.entries(setsByMuscle)) {
    if (!names.has(group)) continue;
    any = true;
    total += sets;
  }
  return any ? total : null;
}

/** This week's number for one metric, or null when its source had nothing. */
export function currentValueFor(m: MetricToCheck, r: WeeklyReadings): number | null {
  switch (m.kind) {
    case 'bodyweight': return r.bodyweight;
    case 'lift_e1rm': {
      const id = m.ref?.exercise_id;
      return id && Number.isFinite(r.e1rm_by_exercise[id]) ? r.e1rm_by_exercise[id] : null;
    }
    case 'sets_per_muscle': return m.ref?.muscle ? setsForMuscle(r.sets_by_muscle, m.ref.muscle) : null;
    case 'steps': return r.steps_avg;
    case 'sessions_per_week': return r.sessions;
    case 'cardio_sessions': return r.cardio_sessions;
    case 'sleep_hours': return r.sleep_avg_h;
    case 'protein_days': return r.protein_days;
    // A metric that names its exercise reads that exercise's best, and
    // nothing at all while the name is unresolved; only one that names no
    // exercise reads the best of any exercise.
    case 'distance': return m.ref?.exercise_name ? (Number.isFinite(r.best_by_metric[m.id]) ? r.best_by_metric[m.id] : null) : r.distance_best_km;
    case 'duration': return m.ref?.exercise_name ? (Number.isFinite(r.best_by_metric[m.id]) ? r.best_by_metric[m.id] : null) : r.duration_best_min;
    case 'custom': return Number.isFinite(r.custom_latest[m.id]) ? r.custom_latest[m.id] : null;
  }
}

export interface MetricCheck {
  id: string;
  current_value: number | null;
  status: MetricStatus;
  /** Set when a progress metric had no start: its first reading becomes the start. */
  start_value?: number;
}

/**
 * The check for one metric at `progress` through the phase. A weekly kind
 * with nothing this week keeps no stale number: current_value goes null and
 * the status says due. A progress kind with nothing this week keeps its last
 * reading (the scale did not move because nobody stood on it).
 *
 * `firstWeek`: the phase began this week, so "last whole week" is the phase
 * before (or no program at all). A weekly kind is not judged against the new
 * target on that: it reads `set` with no number until the phase has a week.
 */
export function checkMetric(m: MetricToCheck, r: WeeklyReadings, progress: number, firstWeek = false): MetricCheck {
  const weekly = isWeeklyKind(m.kind);
  if (weekly && firstWeek) return { id: m.id, current_value: null, status: 'set' };
  const fresh = currentValueFor(m, r);
  const current = fresh ?? (weekly ? null : m.current_value);
  const out: MetricCheck = {
    id: m.id,
    current_value: current,
    status: statusFor({ ...m, current_value: current, progress }),
  };
  // The job is measured from here: the status stays on track (statusFor with
  // no start), whatever week of the phase this first reading lands in.
  if (!weekly && m.direction !== 'hold' && m.start_value == null && current != null) {
    out.start_value = current;
  }
  return out;
}

export function checkMetrics(list: MetricToCheck[], r: WeeklyReadings, progress: number, firstWeek = false): MetricCheck[] {
  return list.map((m) => checkMetric(m, r, progress, firstWeek));
}

// ── Readings from rows ───────────────────────────────────────────────────────

/** The mean of the positive readings in a set of daily rows, or null. */
export function meanPositive(values: readonly (number | null | undefined)[]): number | null {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Days with protein at or above the target. Null when no day was logged. */
export function proteinDaysOf(days: readonly { protein_g: number | null | undefined }[], targetG: number | null): number | null {
  if (targetG == null || !Number.isFinite(targetG) || days.length === 0) return null;
  return days.filter((d) => typeof d.protein_g === 'number' && d.protein_g >= targetG).length;
}

/** The longest set, in km and in minutes, from workout_sets rows. */
export function bestOfSets(sets: readonly { distance_m?: number | null; duration_seconds?: number | null; completed?: boolean | null }[]): { distance_best_km: number | null; duration_best_min: number | null } {
  let km: number | null = null;
  let min: number | null = null;
  for (const s of sets) {
    if (s.completed === false) continue;
    if (typeof s.distance_m === 'number' && s.distance_m > 0) km = Math.max(km ?? 0, s.distance_m / 1000);
    if (typeof s.duration_seconds === 'number' && s.duration_seconds > 0) min = Math.max(min ?? 0, s.duration_seconds / 60);
  }
  return { distance_best_km: km, duration_best_min: min };
}

/**
 * The phase running on `day` (0-based index into `phases`, in seq order), or
 * null outside the program. Same arithmetic as the app's computeActivePhaseSeq.
 */
export function activePhaseIndex(
  startDate: string,
  phases: readonly { duration_weeks: number; start_offset_weeks: number }[],
  day: string,
): number | null {
  const days = daysBetween(startDate, day);
  if (days < 0) return null;
  for (let i = 0; i < phases.length; i++) {
    const startD = phases[i].start_offset_weeks * 7;
    const endD = (phases[i].start_offset_weeks + phases[i].duration_weeks) * 7;
    if (days >= startD && days < endD) return i;
  }
  return null;
}

/** 1-based week within a phase on `day`. */
export function weekInPhaseOn(startDate: string, phase: { start_offset_weeks: number }, day: string): number {
  return Math.floor((daysBetween(startDate, day) - phase.start_offset_weeks * 7) / 7) + 1;
}

/** The Monday on or before a local ISO day. */
export function mondayOf(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  const dow = new Date(t).getUTCDay(); // 0 Sunday
  const back = (dow + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The `checked_week` a phase's rows get when another phase was checked this
 * week. A past or running phase: this week, so it is not revisited. A phase
 * that has not started: the Monday BEFORE the week it starts in, so the
 * cron lists it again from its start week on and its first check is not
 * pushed a week back when it begins mid-week.
 */
export function stampWeekFor(startDate: string, phase: { start_offset_weeks: number }, weekStart: string): string {
  const phaseStart = addDays(startDate, phase.start_offset_weeks * 7);
  if (phaseStart <= weekStart) return weekStart;
  return addDays(mondayOf(phaseStart), -7);
}

/** The whole-day ISO date `days` after `iso`, no time zone. */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(aISO: string, bISO: string): number {
  const a = Date.parse(`${aISO}T00:00:00Z`);
  const b = Date.parse(`${bISO}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : 0;
}

/**
 * Is a check due this week: nothing checked yet, or the last check belongs
 * to an earlier LOCAL week. `checked_week` is the local Monday the job wrote
 * with the check; comparing the UTC date of `checked_at` with a local Monday
 * would read as "not yet" for hours after midnight east of UTC and re-run
 * the check (and the model) every 15 minutes until UTC caught up.
 */
export function checkDue(rows: readonly { checked_week: string | null }[], weekStart: string): boolean {
  return rows.length > 0 && rows.some((r) => !r.checked_week || r.checked_week < weekStart);
}
