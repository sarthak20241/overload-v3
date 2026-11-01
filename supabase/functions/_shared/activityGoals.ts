/**
 * Activity goals: a daily step goal and a weekly cardio goal, per program phase.
 *
 * A phase already plans what the user eats. These plan how much they move
 * outside the lifting: "10k steps a day" and "3 cardio sessions a week". The
 * coach sets them in generate_program, only when the goal calls for it (a cut,
 * endurance, general health, or the user asked). A phase without them shows
 * nothing extra; null is "no goal", never "zero".
 *
 *   - Steps come from Apple Health / Health Connect (daily_metrics 'steps').
 *   - A cardio SESSION is a finished workout with at least one completed,
 *     non-warmup set of a Cardio exercise that is timed (duration,
 *     distance_duration, resistance_duration). A treadmill warmup set before a
 *     lifting day does not make it a cardio day. A run recorded on a watch
 *     counts once it is imported (workouts.source, lib/healthCardio.ts).
 *   - An imported workout gives way to an in-app cardio session on the same
 *     local day: a run that came in from the watch and was then also logged by
 *     hand counts once. Same day, not overlapping time, because "Log one you
 *     did" guesses the time (6 pm, or just now), so the two copies rarely
 *     overlap. The cost: a watch run in the morning and a separate treadmill
 *     session logged in the app that evening count as one. The weekly facts
 *     (drona_rebuild_activity_facts) hold the same rule.
 *   - Weeks start Monday, like every other weekly fact.
 *
 * The clamps are the real bounds. The tool schema only steers the model, and
 * the database checks (migration 20261018120000) hold the same numbers.
 *
 * Pure on purpose: no imports, so `deno test` reaches it and the app and the
 * edge functions share one set of rules.
 */

export const STEPS_MIN = 2000;
export const STEPS_MAX = 30000;
/** Step goals land on a 500 grid: 7,500 reads like a goal, 7,342 does not. */
export const STEPS_STEP = 500;
export const CARDIO_MIN = 1;
export const CARDIO_MAX = 7;

export const CARDIO_MUSCLE_GROUP = "Cardio";
export const CARDIO_METRIC_TYPES: readonly string[] = ["duration", "distance_duration", "resistance_duration"];

export interface ActivityGoals {
  /** Steps per day; null = no step goal this phase. */
  steps_per_day: number | null;
  /** Cardio sessions per week; null = no cardio goal this phase. */
  cardio_sessions_per_week: number | null;
}

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * A step goal inside [2,000, 30,000] on the 500 grid, or null for "no goal".
 * Zero, negative, missing or non-numeric all mean no goal: a phase that asks
 * for 0 steps has not set one.
 */
export function clampStepsTarget(v: unknown): number | null {
  const n = finite(v);
  if (n == null || n <= 0) return null;
  const snapped = Math.round(n / STEPS_STEP) * STEPS_STEP;
  return Math.min(STEPS_MAX, Math.max(STEPS_MIN, snapped));
}

/** Cardio sessions per week inside [1, 7], or null for "no goal". */
export function clampCardioSessions(v: unknown): number | null {
  const n = finite(v);
  if (n == null || n <= 0) return null;
  return Math.min(CARDIO_MAX, Math.max(CARDIO_MIN, Math.round(n)));
}

/** The coach's activity block ({steps_per_day, cardio_sessions_per_week}) made safe. */
export function normalizeActivityGoals(v: unknown): ActivityGoals {
  const a = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    steps_per_day: clampStepsTarget(a.steps_per_day),
    cardio_sessions_per_week: clampCardioSessions(a.cardio_sessions_per_week),
  };
}

export const hasActivityGoals = (g: ActivityGoals | null | undefined): boolean =>
  !!g && (g.steps_per_day != null || g.cardio_sessions_per_week != null);

export interface CardioSetRow {
  workout_id: string;
  completed?: boolean | null;
  set_type?: string | null;
  muscle_group?: string | null;
  metric_type?: string | null;
  /** workouts.source: 'healthkit' / 'health_connect' when imported, null when logged in the app. */
  source?: string | null;
  /** The workout's local start day, 'YYYY-MM-DD'. Without it an import never gives way. */
  day?: string | null;
}

/** Does this set make its workout a cardio session? */
export function isCardioSet(s: CardioSetRow): boolean {
  return s.completed === true
    && s.set_type !== "warmup"
    && s.muscle_group === CARDIO_MUSCLE_GROUP
    && CARDIO_METRIC_TYPES.includes(s.metric_type ?? "");
}

/**
 * Cardio sessions in a set of rows: the number of distinct workouts with at
 * least one cardio set, less an imported one on a day that already has an
 * in-app cardio session. The caller passes only FINISHED workouts in the week.
 */
export function countCardioSessions(sets: CardioSetRow[]): number {
  const inApp = new Set<string>();
  const inAppDays = new Set<string>();
  const imported = new Map<string, string | null>();
  for (const s of sets) {
    if (!isCardioSet(s)) continue;
    if (s.source) {
      imported.set(s.workout_id, s.day ?? null);
    } else {
      inApp.add(s.workout_id);
      if (s.day) inAppDays.add(s.day);
    }
  }
  let n = inApp.size;
  for (const day of imported.values()) if (!day || !inAppDays.has(day)) n++;
  return n;
}

export interface GoalProgress {
  done: number;
  target: number;
  /** What is still to do, never below 0. */
  left: number;
  met: boolean;
  /** done / target, held to [0, 1] for a bar. */
  fraction: number;
}

/** Progress toward a goal, or null when there is no goal. A missing reading counts as 0 done. */
export function goalProgress(done: number | null | undefined, target: number | null | undefined): GoalProgress | null {
  const t = finite(target);
  if (t == null || t <= 0) return null;
  const d = Math.max(0, finite(done) ?? 0);
  return {
    done: d,
    target: t,
    left: Math.max(0, t - d),
    met: d >= t,
    fraction: Math.min(1, d / t),
  };
}

/** 10000 -> "10k", 7500 -> "7.5k", 3760 -> "3.8k", 640 -> "640". */
export function shortSteps(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  const k = Math.round(v / 100) / 10;
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`;
}

/** The step line under the bar, in the coach's voice. */
export function stepsLine(p: GoalProgress): string {
  if (p.met) return "Steps done for today";
  return `${shortSteps(p.left)} steps to go`;
}

/** The cardio line under the bar, in the coach's voice. */
export function cardioLine(p: GoalProgress): string {
  if (p.met) return "Cardio done this week";
  return p.left === 1 ? "1 cardio session left this week" : `${p.left} cardio sessions left this week`;
}

/** "10,000 steps a day, 3 cardio sessions a week": one phase's goals in a line. */
export function activityText(g: ActivityGoals): string {
  const parts: string[] = [];
  if (g.steps_per_day != null) parts.push(`${g.steps_per_day.toLocaleString("en-US")} steps a day`);
  if (g.cardio_sessions_per_week != null) {
    const n = g.cardio_sessions_per_week;
    parts.push(`${n} cardio ${n === 1 ? "session" : "sessions"} a week`);
  }
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * Today's step progress from the day's reading, or null when there is no
 * reading yet. No row is not "0 steps": a user without Health sync, or whose
 * sync has not run today, would read 0 all day. A reading of 0 is no reading
 * too: Health Connect writes 0 for a day with no data (the facts' steps_zero).
 */
export function stepsProgressFromReading(reading: unknown, target: number | null | undefined): GoalProgress | null {
  const v = typeof reading === "number" ? reading : typeof reading === "string" ? Number(reading) : NaN;
  if (!Number.isFinite(v) || v <= 0) return null;
  return goalProgress(v, target);
}

/** One workout as the dashboard reads it: workouts with workout_sets(..., exercises(...)). */
export interface WorkoutWithSets {
  id: string;
  source?: string | null;
  started_at?: string | null;
  workout_sets?: Array<{
    completed?: boolean | null;
    set_type?: string | null;
    exercises?: { muscle_group?: string | null; metric_type?: string | null } | null;
  }> | null;
}

/** The device's local day of an ISO time, 'YYYY-MM-DD'; null when it does not parse. */
export function localDayOf(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Flatten nested workouts into the rows countCardioSessions reads. */
export function cardioRowsFromWorkouts(workouts: WorkoutWithSets[]): CardioSetRow[] {
  const rows: CardioSetRow[] = [];
  for (const w of workouts) {
    const day = localDayOf(w.started_at);
    for (const s of w.workout_sets ?? []) {
      rows.push({
        workout_id: w.id,
        completed: s.completed ?? null,
        set_type: s.set_type ?? null,
        muscle_group: s.exercises?.muscle_group ?? null,
        metric_type: s.exercises?.metric_type ?? null,
        source: w.source ?? null,
        day,
      });
    }
  }
  return rows;
}
