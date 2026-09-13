/**
 * Read one logged workout back as a summary: its exercises in the order they
 * were done, and how many sets each muscle got.
 *
 * Works on the dashboard's flat row shape (`sets[]`, each with a nested
 * `exercises` row), which server, pending and guest workouts all share.
 *
 * Pure: no imports, no React, no network. Unit-tested in workoutSummary.test.ts.
 */

export interface SummarySet {
  weight_kg: number;
  reps: number;
  completed?: boolean | null;
  duration_seconds?: number | null;
  distance_m?: number | null;
  resistance?: number | null;
  set_type?: string | null;
  is_unilateral?: boolean | null;
  reps_right?: number | null;
  weight_kg_right?: number | null;
  /** Position in the session. Not always present, never trusted alone. */
  order?: number | null;
  exercises?: { name?: string | null; muscle_group?: string | null; metric_type?: string | null } | null;
}

export interface ExerciseGroup<S extends SummarySet = SummarySet> {
  name: string;
  metricType: string | null;
  sets: S[];
}

const byOrder = <S extends SummarySet>(sets: S[]) =>
  sets
    .map((s, i) => ({ s, i }))
    // Rows without an order keep their array position.
    .sort((a, b) => (a.s.order ?? a.i) - (b.s.order ?? b.i) || a.i - b.i)
    .map(({ s }) => s);

/** Sets grouped by exercise, in the order each exercise was first done. */
export function groupSetsByExercise<S extends SummarySet>(sets: S[] | null | undefined): ExerciseGroup<S>[] {
  const groups: ExerciseGroup<S>[] = [];
  const index = new Map<string, number>();
  for (const s of byOrder(sets ?? [])) {
    const name = s.exercises?.name?.trim() || 'Unknown';
    let at = index.get(name);
    if (at === undefined) {
      at = groups.length;
      index.set(name, at);
      groups.push({ name, metricType: s.exercises?.metric_type ?? null, sets: [] });
    }
    groups[at].sets.push(s);
  }
  return groups;
}

/**
 * Completed sets per muscle group, the unit BodyHeatmap reads. A set marked
 * `completed: false` was planned and skipped, so it trained nothing. A set with
 * no muscle group has nowhere to land on the body and is left out.
 */
export function muscleSetCounts(sets: SummarySet[] | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sets ?? []) {
    if (s.completed === false) continue;
    const muscle = s.exercises?.muscle_group?.trim();
    if (!muscle) continue;
    counts[muscle] = (counts[muscle] ?? 0) + 1;
  }
  return counts;
}
