/**
 * Swap an exercise on a built plan before it is saved (the Phase 1 workouts
 * screen in components/ai/AICoachModal.tsx), the way Today swaps one for a
 * session (components/routines/ExerciseSwapList). Here the swap is the plan's
 * from then on: it is kept in the phase draft and saves with the plan.
 *
 * Saving looks each exercise up by name, so a swap takes the catalog row's
 * name. Sets, reps and rest stay; the old cue and an invented exercise's
 * definition go, since they were for the old exercise. The plan's own pick is
 * kept on the exercise (`planned`) to go back to it.
 *
 * Pure on purpose (no imports), so `deno test lib/planSwap.test.ts` reaches it.
 */

interface PlanExercise {
  name: string;
  sets: number;
  reps: string;
  rest: string;
  note?: string;
  new_exercise?: { muscle_group?: string | null; category?: string | null; metric_type?: string | null } | unknown;
  /** The plan's own pick, when the person swapped it. */
  planned?: PlanExercise;
}

interface PlanWorkout<E extends PlanExercise = PlanExercise> {
  exercises: E[];
}

interface Plan<W extends PlanWorkout = PlanWorkout> {
  workouts: W[];
}

interface CatalogRow {
  id: string;
  name: string;
  muscle_group?: string | null;
  category?: string | null;
  metric_type?: string | null;
  target_muscle?: string | null;
  swap_pattern?: string | null;
}

function key(name: string): string {
  return name.trim().toLowerCase();
}

function mapExercise<P extends Plan>(plan: P, day: number, index: number, f: (ex: PlanExercise) => PlanExercise): P {
  return {
    ...plan,
    workouts: plan.workouts.map((w, wi) =>
      wi !== day ? w : { ...w, exercises: w.exercises.map((ex, ei) => (ei !== index ? ex : f(ex))) },
    ),
  };
}

/** The plan with one exercise swapped for a catalog row. */
export function swapPlanExercise<P extends Plan>(plan: P, day: number, index: number, row: { id?: string; name: string }): P {
  return mapExercise(plan, day, index, (ex) => {
    const planned = ex.planned ?? ex;
    // Picking the plan's own exercise again is going back to it.
    if (key(row.name) === key(planned.name)) return planned;
    return { name: row.name, sets: ex.sets, reps: ex.reps, rest: ex.rest, planned };
  });
}

/** The plan with one exercise back to the plan's own pick. */
export function restorePlanExercise<P extends Plan>(plan: P, day: number, index: number): P {
  return mapExercise(plan, day, index, (ex) => ex.planned ?? ex);
}

/**
 * What the swap list ranks from: the catalog row of that name (it carries the
 * swap tags), else the plan exercise itself with the muscle group Drona gave
 * an invented one.
 */
export function swapFromFor<R extends CatalogRow>(ex: PlanExercise, catalog: readonly R[]): CatalogRow {
  const row = catalog.find((r) => key(r.name) === key(ex.name));
  if (row) return row;
  const def = (ex.new_exercise ?? null) as { muscle_group?: string | null; category?: string | null; metric_type?: string | null } | null;
  return {
    id: `plan:${key(ex.name)}`,
    name: ex.name,
    muscle_group: def?.muscle_group ?? null,
    category: def?.category ?? null,
    metric_type: def?.metric_type ?? null,
  };
}

/** Catalog ids of the day's other exercises: never offered as a swap. */
export function swapExcludeIds<R extends CatalogRow>(workout: PlanWorkout, index: number, catalog: readonly R[]): Set<string> {
  const byName = new Map(catalog.map((r) => [key(r.name), r.id]));
  const out = new Set<string>();
  workout.exercises.forEach((ex, i) => {
    if (i === index) return;
    const id = byName.get(key(ex.name));
    if (id) out.add(id);
  });
  return out;
}
