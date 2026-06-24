/**
 * Shape a not-yet-synced PendingWorkout (lib/syncQueue) into the row shapes the
 * read screens expect, so a workout finished offline shows up immediately in
 * history / dashboard / analytics and is included in their aggregates. One
 * source of truth for these shapes, mirroring getGuestWorkoutsDetailed.
 */
import type { PendingWorkout } from '@/lib/syncQueue';
import { getXpForWorkout } from '@/lib/xp';

function finishedAtIso(entry: PendingWorkout): string {
  return new Date(Date.parse(entry.startedAtIso) + entry.durationSeconds * 1000).toISOString();
}

/** Total completed sets across the workout. */
export function pendingSetCount(entry: PendingWorkout): number {
  return entry.exercises.reduce((n, ex) => n + ex.sets.length, 0);
}

/** XP this workout will award, for optimistic display before it syncs. */
export function pendingXp(entry: PendingWorkout): number {
  return getXpForWorkout(pendingSetCount(entry), entry.totalVolumeKg);
}

/**
 * Dashboard / analytics shape: nested `workout_sets[].exercises{...}` plus a
 * `sets` alias, matching what Supabase returns for `*, workout_sets(*,
 * exercises(*))` and what getGuestWorkoutsDetailed produces.
 */
export function pendingToDashboardWorkout(entry: PendingWorkout): any {
  let order = 0;
  const sets = entry.exercises.flatMap((ex, ei) => {
    const meta = {
      id: `${entry.clientId}-ex-${ei}`,
      name: ex.def.name,
      muscle_group: ex.def.muscle_group || 'Other',
      category: ex.def.category || 'Other',
    };
    return ex.sets.map((s, si) => ({
      id: `${entry.clientId}-set-${ei}-${si}`,
      exercise_id: meta.id,
      exercises: meta,
      weight_kg: s.weight_kg,
      reps: s.reps,
      completed: true,
      order: order++,
    }));
  });
  return {
    id: entry.clientId,
    client_id: entry.clientId,
    name: entry.name,
    started_at: entry.startedAtIso,
    finished_at: finishedAtIso(entry),
    duration_seconds: entry.durationSeconds,
    total_volume_kg: entry.totalVolumeKg,
    routine_id: entry.linkedRoutineId,
    notes: entry.notes ?? undefined,
    workout_sets: sets,
    sets,
    /** Marks this row as a local, not-yet-synced workout (for subtle UI hints). */
    _pendingSync: true,
  };
}

/**
 * History shape (WorkoutRaw): sets grouped per exercise into `exercises[]` and a
 * `workout_sets` array of `{ id }` for the set count.
 */
export function pendingToHistoryRow(entry: PendingWorkout): any {
  let setId = 0;
  return {
    id: entry.clientId,
    client_id: entry.clientId,
    name: entry.name,
    started_at: entry.startedAtIso,
    finished_at: finishedAtIso(entry),
    duration_seconds: entry.durationSeconds,
    total_volume_kg: entry.totalVolumeKg,
    routine_id: entry.linkedRoutineId ?? undefined,
    notes: entry.notes ?? undefined,
    workout_sets: entry.exercises.flatMap((ex) =>
      ex.sets.map(() => ({ id: `${entry.clientId}-s-${setId++}` })),
    ),
    exercises: entry.exercises.map((ex) => ({
      name: ex.def.name,
      metric_type: ex.def.metric_type,
      sets: ex.sets.map((s) => ({
        weight_kg: s.weight_kg, reps: s.reps, completed: true,
        duration_seconds: s.duration_seconds ?? null, distance_m: s.distance_m ?? null, resistance: s.resistance ?? null,
      })),
    })),
    _pendingSync: true,
  };
}
