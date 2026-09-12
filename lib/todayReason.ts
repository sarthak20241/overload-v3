/**
 * The one-line reason under the dashboard's TODAY card.
 *
 * "Push · 5 ex" is a label. This is the coaching: why THIS session, today.
 * It is deterministic and computed from the user's own logged sets, so it is
 * true offline, costs nothing, and never says something the data does not
 * support. Three beats, each dropped when the data cannot back it:
 *
 *   1. the gap   - how long since this routine last ran
 *   2. the case  - which muscle in it is the most rested
 *   3. the aim   - the lift that opens the session, at the weight it left off
 *
 * Pure: no imports, no React, no network. Unit-tested in todayReason.test.ts.
 * Deliberately NOT the AI coach: the model writes the plan, this narrates it.
 */

export interface ReasonSet {
  completed?: boolean;
  weight_kg?: number | null;
  reps?: number | null;
  muscle_group?: string | null;
  exercises?: { name?: string | null; muscle_group?: string | null } | null;
}

export interface ReasonWorkout {
  id: string;
  name?: string | null;
  started_at: string;
  routine_id?: string | null;
  sets?: ReasonSet[] | null;
}

export interface ReasonRoutine {
  id: string;
  name?: string | null;
  routine_exercises?:
    | {
        /** Position in the session. Supabase returns this join UNORDERED, so
         *  never trust array position. */
        order?: number | null;
        exercises?: { name?: string | null; muscle_group?: string | null } | null;
      }[]
    | null;
}

export interface TodayReasonInput {
  routine: ReasonRoutine | null | undefined;
  workouts: ReasonWorkout[] | null | undefined;
  /** Defaults to now; injectable for tests. */
  now?: Date;
}

// Catch-all buckets, not anatomy. Calling one of these "your most rested
// muscle" reads as a bug to anyone who lifts, and on a real account it is the
// bucket a custom exercise lands in by default, so it wins the "rested" race
// far too often.
const NOT_A_MUSCLE = new Set(['other', 'full body', 'cardio', 'olympic', 'compound', '']);

const startedMs = (w: ReasonWorkout) => {
  const t = new Date(w.started_at).getTime();
  return Number.isFinite(t) ? t : 0;
};

const setName = (s: ReasonSet) => s.exercises?.name?.trim() || '';
const setMuscle = (s: ReasonSet) => (s.exercises?.muscle_group || s.muscle_group || '').trim();

/** Whole days between two instants, floored, never negative. */
function daysBetween(then: number, now: number): number {
  return Math.max(0, Math.floor((now - then) / 86400000));
}

/** Trailing ".0" is noise on a plate weight: 70 not 70.0, but 67.5 stays. */
function fmtWeight(kg: number): string {
  return `${Math.round(kg * 10) / 10}`.replace(/\.0$/, '');
}

/**
 * A sentence explaining today's pick, or null when the data cannot support one
 * (no history at all, or no routine). Safe to render directly.
 */
export function todayReason(input: TodayReasonInput): string | null {
  const { routine } = input;
  const workouts = (input.workouts ?? []).filter((w) => w && w.started_at);
  if (!routine || workouts.length === 0) return null;

  const now = (input.now ?? new Date()).getTime();
  const routineName = routine.name?.trim() || 'this session';

  // ── 1. The gap ─────────────────────────────────────────────────────────────
  // Match on routine_id, falling back to the name: a session started before the
  // routine existed (or logged as a one-off) still counts as the same work.
  const lowerName = routineName.toLowerCase();
  const mine = workouts.filter(
    (w) =>
      (w.routine_id && w.routine_id === routine.id) ||
      (w.name && w.name.trim().toLowerCase() === lowerName),
  );
  const lastRunMs = mine.length > 0 ? Math.max(...mine.map(startedMs)) : null;
  const gap =
    lastRunMs != null
      ? (() => {
          const d = daysBetween(lastRunMs, now);
          if (d === 0) return `Second ${routineName} today`;
          return `${d} day${d === 1 ? '' : 's'} since ${routineName}`;
        })()
      : `First ${routineName} on record`;

  // ── 2. The case ────────────────────────────────────────────────────────────
  // The routine's own muscles, ranked by how long since each was last worked.
  // A muscle with NO history is untrained, not rested, so it is left out: the
  // card should never claim someone is "rested" on work they have never done.
  const lastByMuscle = new Map<string, number>();
  for (const w of workouts) {
    const t = startedMs(w);
    for (const s of w.sets ?? []) {
      if (s.completed === false) continue;
      const m = setMuscle(s);
      if (!m) continue;
      if (t > (lastByMuscle.get(m) ?? 0)) lastByMuscle.set(m, t);
    }
  }
  // Sorted once here: everything downstream reads the session in its real order.
  const orderedExercises = [...(routine.routine_exercises ?? [])].sort(
    (a, b) => (a?.order ?? Number.MAX_SAFE_INTEGER) - (b?.order ?? Number.MAX_SAFE_INTEGER),
  );
  const routineMuscles = Array.from(
    new Set(
      orderedExercises
        .map((re) => (re?.exercises?.muscle_group || '').trim())
        .filter((m) => m && !NOT_A_MUSCLE.has(m.toLowerCase())),
    ),
  );
  const rested = routineMuscles
    .filter((m) => lastByMuscle.has(m))
    .sort((a, b) => (lastByMuscle.get(a) ?? 0) - (lastByMuscle.get(b) ?? 0))[0];

  // ── 3. The aim ─────────────────────────────────────────────────────────────
  // The first exercise in the routine that carries real load, and the heaviest
  // weight it was last completed at, so "opens at" is a number to beat rather
  // than a guess. Bodyweight movements carry no weight and are skipped.
  const heaviestByExercise = new Map<string, { weight: number; at: number }>();
  for (const w of workouts) {
    const t = startedMs(w);
    for (const s of w.sets ?? []) {
      if (s.completed === false) continue;
      const kg = typeof s.weight_kg === 'number' ? s.weight_kg : 0;
      if (!(kg > 0)) continue;
      const n = setName(s);
      if (!n) continue;
      const prev = heaviestByExercise.get(n);
      // Latest session wins; within it, the heaviest set.
      if (!prev || t > prev.at || (t === prev.at && kg > prev.weight)) {
        heaviestByExercise.set(n, { weight: t === prev?.at ? Math.max(kg, prev.weight) : kg, at: t });
      }
    }
  }
  let aim: string | null = null;
  for (const re of orderedExercises) {
    const n = re?.exercises?.name?.trim();
    if (!n) continue;
    const hit = heaviestByExercise.get(n);
    if (hit) {
      aim = `${n} opens at ${fmtWeight(hit.weight)} kg`;
      break;
    }
  }
  if (!aim && lastRunMs == null) {
    const first = orderedExercises.find((re) => re?.exercises?.name?.trim());
    const n = first?.exercises?.name?.trim();
    if (n) aim = `${n} sets your baseline`;
  }

  const parts = [gap, rested ? `${rested} is your most rested` : null, aim].filter(
    (p): p is string => !!p,
  );
  return parts.join('. ') + '.';
}
