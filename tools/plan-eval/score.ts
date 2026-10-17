/**
 * Deterministic scoring for a generate_plan result.
 *
 * No LLM judge on purpose. Every check is a fact about the output that either
 * holds or does not, which makes this reproducible and safe in CI. It exists
 * to be the guardrail while we trade structure for latency: if compact
 * encoding mangles prescriptions, or fan-out lets two days collide, these
 * fail before anyone notices in production.
 *
 * CATALOG DENOMINATOR
 * The resolver is injected, because the right denominator depends on the
 * surface. Onboarding validates against EXERCISE_LIBRARY (46 names) since
 * that is what lib/onboardingDrona.ts actually checks. The coach save path
 * resolves via ilike against the 787 global rows in the exercises table, so
 * scoring coach output against the 46 overstates the failure rate. An earlier
 * revision of this file made exactly that mistake.
 */
import { EXERCISE_LIBRARY } from '../../lib/exercises';
import type { EvalCase } from './cases';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Case- and whitespace-insensitive index, matching the normalization used by
 *  lib/onboardingDrona.ts (PR #66) and lib/exerciseResolve.ts. */
export function buildCatalogIndex(names: string[]): Set<string> {
  return new Set(names.map(norm));
}

export const LIBRARY_INDEX = buildCatalogIndex(EXERCISE_LIBRARY.map((e) => e.name));

const MUSCLE_BY_NAME = new Map(EXERCISE_LIBRARY.map((e) => [norm(e.name), e.muscle_group]));

export interface ScoreResult {
  failures: string[];
  warnings: string[];
  metrics: {
    workouts: number;
    exercisesTotal: number;
    exercisesResolved: number;
    catalogResolution: number;
    weeklySets: number;
    setsByMuscle: Record<string, number>;
    rationaleChars: number;
    /** Distinct exercise names / total slots. 1.0 = no repeats anywhere. */
    distinctRatio: number;
    /** Exercises appearing on more than one day, with their day count. */
    crossDayRepeats: { name: string; days: number }[];
    /** Names not present in the scoring catalog. Kept for diagnosis: the
     *  earlier wrong-denominator bug was invisible without these. */
    unresolvedNames: string[];
    /** Exercises Drona invented (NEW lines), with how each is measured. */
    newExercises: { name: string; metric_type: string; reps: unknown }[];
  };
}

function parseRepsOk(reps: unknown): boolean {
  if (typeof reps === 'number') return Number.isFinite(reps) && reps >= 1 && reps <= 30;
  if (typeof reps !== 'string') return false;
  const t = reps.trim();
  // Plain rep prescriptions: "8", "6-10".
  if (/^\d{1,2}\s*(-\s*\d{1,2})?$/.test(t)) return true;
  // Timed work: "45s", "30-45s". Legal ONLY because the compact format asks
  // for it explicitly and assembly can route it by the catalog's metric_type.
  if (/^\d{1,3}\s*(-\s*\d{1,3})?\s*s$/i.test(t)) return true;
  // Cardio for time: "20min", "15-20min".
  if (/^\d{1,3}\s*(-\s*\d{1,3})?\s*min$/i.test(t)) return true;
  if (/^(amrap|to failure)$/i.test(t)) return true;
  return false;
}

/** True when a reps value is a time in seconds ("45s") or minutes ("20min"). */
export function isTimedReps(reps: unknown): boolean {
  return typeof reps === 'string' && /^\d{1,3}\s*(-\s*\d{1,3})?\s*(s|min)$/i.test(reps.trim());
}

/** True when a reps value is a duration rather than a rep count. */
export function isDurationReps(reps: unknown): boolean {
  return typeof reps === 'string' && /^\d{1,3}\s*(-\s*\d{1,3})?\s*s$/i.test(reps.trim());
}

export interface ScoreOpts {
  /** Names considered valid. Defaults to the 46-name EXERCISE_LIBRARY. */
  catalog?: Set<string>;
  /** Fail when a plan repeats exercises across days beyond this share.
   *  Repeats are legitimate in some programs (a 3x/week beginner full body
   *  reasonably squats every session), so this is a loose backstop and the
   *  per-repeat detail lands in warnings + metrics for analysis. */
  minDistinctRatio?: number;
}

export function scorePlan(
  c: EvalCase,
  plan: Record<string, unknown> | null,
  opts: ScoreOpts = {},
): ScoreResult {
  const catalog = opts.catalog ?? LIBRARY_INDEX;
  const minDistinct = opts.minDistinctRatio ?? 0.5;

  const failures: string[] = [];
  const warnings: string[] = [];
  const setsByMuscle: Record<string, number> = {};
  const unresolvedNames: string[] = [];
  const newExercises: { name: string; metric_type: string; reps: unknown }[] = [];
  const dayCountByExercise = new Map<string, number>();
  let exercisesTotal = 0, exercisesResolved = 0, weeklySets = 0;

  const empty: ScoreResult['metrics'] = {
    workouts: 0, exercisesTotal: 0, exercisesResolved: 0, catalogResolution: 0,
    weeklySets: 0, setsByMuscle: {}, rationaleChars: 0, distinctRatio: 0,
    crossDayRepeats: [], unresolvedNames: [], newExercises: [],
  };

  if (!plan) return { failures: ['no plan emitted'], warnings, metrics: empty };
  const workouts = plan.workouts;
  if (!Array.isArray(workouts)) return { failures: ['workouts is not an array'], warnings, metrics: empty };

  const e = c.expect;

  if (workouts.length < e.minWorkouts || workouts.length > e.maxWorkouts) {
    failures.push(`workouts=${workouts.length}, expected ${e.minWorkouts}-${e.maxWorkouts} for ${e.daysPerWeek} days/week`);
  }

  const dpw = plan.days_per_week;
  if (typeof dpw === 'number' && dpw !== e.daysPerWeek) {
    failures.push(`days_per_week=${dpw}, requested ${e.daysPerWeek}`);
  }

  const rationale = typeof plan.rationale === 'string' ? plan.rationale : '';
  if (!rationale.trim()) failures.push('rationale missing');
  else if (rationale.length < 120) warnings.push(`rationale is short (${rationale.length} chars)`);
  if (/^\s*[-*\d]\s|\n\s*[-*]\s/.test(rationale)) warnings.push('rationale contains a list; prose was asked for');

  const seenWorkoutNames = new Set<string>();

  workouts.forEach((raw, wi) => {
    if (typeof raw !== 'object' || raw === null) { failures.push(`workout[${wi}] is not an object`); return; }
    const w = raw as { name?: unknown; exercises?: unknown };
    const wName = typeof w.name === 'string' ? w.name.trim() : '';
    if (!wName) failures.push(`workout[${wi}] has no name`);
    else if (seenWorkoutNames.has(norm(wName))) failures.push(`duplicate workout name "${wName}"`);
    else seenWorkoutNames.add(norm(wName));

    if (!Array.isArray(w.exercises)) { failures.push(`workout[${wi}] "${wName}" has no exercises array`); return; }
    const exs = w.exercises;
    if (exs.length < e.minExercisesPerWorkout || exs.length > e.maxExercisesPerWorkout) {
      failures.push(`workout[${wi}] "${wName}" has ${exs.length} exercises, expected ${e.minExercisesPerWorkout}-${e.maxExercisesPerWorkout}`);
    }

    const seenInWorkout = new Set<string>();
    exs.forEach((rawEx, xi) => {
      exercisesTotal++;
      if (typeof rawEx !== 'object' || rawEx === null) { failures.push(`workout[${wi}].exercise[${xi}] is not an object`); return; }
      const ex = rawEx as { name?: unknown; sets?: unknown; reps?: unknown; rest_seconds?: unknown; new_exercise?: { metric_type?: unknown } };
      const name = typeof ex.name === 'string' ? ex.name.trim() : '';
      if (!name) { failures.push(`workout[${wi}].exercise[${xi}] has no name`); return; }

      if (seenInWorkout.has(norm(name))) failures.push(`"${name}" appears twice in workout[${wi}] "${wName}"`);
      seenInWorkout.add(norm(name));

      if (catalog.has(norm(name))) {
        exercisesResolved++;
        const mg = MUSCLE_BY_NAME.get(norm(name));
        const sets = typeof ex.sets === 'number' ? ex.sets : 0;
        if (mg) setsByMuscle[mg] = (setsByMuscle[mg] ?? 0) + sets;
      } else if (ex.new_exercise && typeof ex.new_exercise === 'object') {
        // A deliberate invention with a template, saved as a custom exercise.
        // NOT a catalog match, so it stays out of exercisesResolved; it is
        // also not junk, so it stays out of unresolvedNames. Tracked on its
        // own for the invention cap and the mobility check.
        newExercises.push({ name, metric_type: String(ex.new_exercise.metric_type ?? ''), reps: ex.reps });
      } else {
        unresolvedNames.push(name);
      }

      const sets = ex.sets;
      if (typeof sets !== 'number' || !Number.isInteger(sets) || sets < 1 || sets > 6) {
        failures.push(`"${name}" sets=${JSON.stringify(sets)}, expected integer 1-6`);
      } else weeklySets += sets;

      if (!parseRepsOk(ex.reps)) failures.push(`"${name}" reps=${JSON.stringify(ex.reps)} is not a usable prescription`);

      const rest = ex.rest_seconds;
      if (typeof rest !== 'number' || rest < 30 || rest > 300) {
        failures.push(`"${name}" rest_seconds=${JSON.stringify(rest)}, expected 30-300`);
      }
    });

    // Count each exercise once per DAY for the cross-day check.
    for (const n of seenInWorkout) dayCountByExercise.set(n, (dayCountByExercise.get(n) ?? 0) + 1);
  });

  // catalogResolution is the honest catalog share. The floor, though, guards
  // against JUNK: names that are neither a catalog row nor a templated
  // invention, which save as muscle group "Other". Inventions are bounded by
  // their own cap below, so they count as grounded here, not as catalog.
  const resolution = exercisesTotal === 0 ? 0 : exercisesResolved / exercisesTotal;
  const grounded = exercisesTotal === 0 ? 0 : (exercisesResolved + newExercises.length) / exercisesTotal;
  if (grounded < e.minCatalogResolution) {
    failures.push(
      `grounded share ${(grounded * 100).toFixed(0)}% (${unresolvedNames.length}/${exercisesTotal} unresolved), floor ${(e.minCatalogResolution * 100).toFixed(0)}%` +
      (unresolvedNames.length ? ` [${unresolvedNames.slice(0, 4).join(', ')}${unresolvedNames.length > 4 ? ', ...' : ''}]` : ''),
    );
  }

  // ── Cross-day variant collision ─────────────────────────────────────────
  // The failure mode fan-out can produce and a single call cannot: two days
  // that train the same muscle both reaching for the same movement, because
  // neither knew what the other picked.
  const crossDayRepeats = [...dayCountByExercise.entries()]
    .filter(([, days]) => days > 1)
    .map(([name, days]) => ({ name, days }))
    .sort((a, b) => b.days - a.days);

  const distinctRatio = exercisesTotal === 0 ? 0 : dayCountByExercise.size / exercisesTotal;
  if (distinctRatio < minDistinct) {
    failures.push(`only ${dayCountByExercise.size} distinct exercises across ${exercisesTotal} slots (ratio ${distinctRatio.toFixed(2)}, floor ${minDistinct})`);
  }
  for (const { name, days } of crossDayRepeats) {
    warnings.push(`"${name}" repeats on ${days} days`);
  }

  // Timed by BOTH its template and its prescription: a duration stretch left
  // on the 8-12 rep fallback has no time target and does not count.
  const timedNew = newExercises.filter(
    (n) => n.metric_type !== 'weight_reps' && n.metric_type !== 'bodyweight_reps' && isTimedReps(n.reps),
  );
  if (e.mobility === 'required' && timedNew.length === 0) {
    failures.push('asked for mobility/stretching but the plan has no timed new exercise with a time target');
  }
  if (!e.mobility && newExercises.length > 0) {
    warnings.push(`invented ${newExercises.length} exercise(s) nobody asked for: ${newExercises.map((n) => n.name).join(', ')}`);
  }
  if (newExercises.length > exercisesTotal / 3) {
    failures.push(`${newExercises.length}/${exercisesTotal} exercises are invented; the catalog should carry most of the plan`);
  }

  for (const [muscle, sets] of Object.entries(setsByMuscle)) {
    if (sets > 32) warnings.push(`${muscle}: ${sets} sets/week across the plan looks high`);
  }
  if (weeklySets > 0 && weeklySets < e.daysPerWeek * 8) {
    warnings.push(`only ${weeklySets} total sets across ${workouts.length} workouts`);
  }

  return {
    failures, warnings,
    metrics: {
      workouts: workouts.length, exercisesTotal, exercisesResolved,
      catalogResolution: resolution, weeklySets, setsByMuscle,
      rationaleChars: rationale.length, distinctRatio, crossDayRepeats, unresolvedNames, newExercises,
    },
  };
}
