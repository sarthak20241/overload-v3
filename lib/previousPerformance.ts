/**
 * Previous-performance prefill computed from LOCAL data only — no network on
 * the workout-start path.
 *
 * The data we need is already on the device: every workout is cached
 * (dashboard 90d + analytics 180d, both nest workout_sets(*, exercises(*))),
 * and a just-finished session sits in the sync queue before it uploads. So
 * "what did I lift last time for this exercise" is a pure local lookup, exactly
 * the way guest mode already works. The caches are kept fresh by the
 * dashboard/history screens, so this stays current without a dedicated fetch.
 */
import { getPendingWorkouts } from '@/lib/syncQueue';
import { applyEditsToDashboardRows, applyEditsToHistoryRows } from '@/lib/editQueue';
import { readCache } from '@/lib/localCache';

type Sets = { weight_kg: number; reps: number }[];

/**
 * For each exercise name, the sets from the most recent local workout that
 * contained it. Keyed by the original name passed in.
 */
export function getLocalPreviousPerformance(
  userId: string | null | undefined,
  names: string[],
): Record<string, Sets> {
  if (!userId) return {};
  const want = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  if (want.size === 0) return {};

  // Each candidate is one workout's sets for the wanted exercises, with a time.
  const candidates: { time: number; perEx: Record<string, Sets> }[] = [];

  // 1) Pending (not-yet-synced) workouts — the freshest data; includes the
  //    session just finished before it has uploaded.
  for (const e of getPendingWorkouts(userId)) {
    const perEx: Record<string, Sets> = {};
    for (const ex of e.exercises) {
      const key = ex.def.name.trim().toLowerCase();
      if (!want.has(key)) continue;
      // Warmups never seed prefill / PR comparison.
      const working = ex.sets.filter((s) => s.set_type !== 'warmup');
      if (working.length === 0) continue;
      perEx[key] = working.map((s) => ({ weight_kg: s.weight_kg, reps: s.reps }));
    }
    if (Object.keys(perEx).length > 0) {
      // Key by FINISH time (start + duration) so ordering is consistent with the
      // cached workouts below, which sort by finished_at. Otherwise a long
      // just-finished session could sort behind an older, shorter one.
      candidates.push({ time: (Date.parse(e.startedAtIso) || 0) + (e.durationSeconds || 0) * 1000, perEx });
    }
  }

  // 2) Locally cached workouts (analytics 180d ∪ dashboard 90d), deduped by id.
  //    Overlay not-yet-synced edits so a corrected workout feeds the right
  //    prefill before the edit reaches the server.
  const seen = new Set<string>();
  const cachedWorkouts = applyEditsToDashboardRows(userId, [
    ...(readCache<any[]>('analyticsWorkouts', userId) ?? []),
    ...(readCache<any[]>('dashboardWorkouts', userId) ?? []),
  ]);
  for (const w of cachedWorkouts) {
    if (w?.id) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
    }
    const sets = w.workout_sets ?? w.sets ?? [];
    const grouped: Record<string, { weight_kg: number; reps: number; order: number }[]> = {};
    for (const s of sets) {
      const nm = s?.exercises?.name;
      if (!nm) continue;
      const key = String(nm).trim().toLowerCase();
      if (!want.has(key) || s.completed === false || s.set_type === 'warmup') continue;
      (grouped[key] ??= []).push({
        weight_kg: Number(s.weight_kg),
        reps: s.reps,
        order: s.order ?? (grouped[key]?.length ?? 0),
      });
    }
    const perEx: Record<string, Sets> = {};
    for (const [k, arr] of Object.entries(grouped)) {
      perEx[k] = arr.sort((a, b) => a.order - b.order).map(({ weight_kg, reps }) => ({ weight_kg, reps }));
    }
    if (Object.keys(perEx).length > 0) {
      candidates.push({ time: Date.parse(w.finished_at ?? w.started_at) || 0, perEx });
    }
  }

  // 3) History cache, which stores a different (grouped) shape:
  //    exercises: [{ name, sets: [{ weight_kg, reps, completed }] }]. Covers a
  //    user who has only opened History (deduped against the above by id).
  for (const w of applyEditsToHistoryRows(userId, readCache<any[]>('historyWorkouts', userId) ?? [])) {
    if (w?.id) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
    }
    const perEx: Record<string, Sets> = {};
    for (const ex of w.exercises ?? []) {
      const key = String(ex?.name ?? '').trim().toLowerCase();
      if (!key || !want.has(key)) continue;
      const sets: Sets = (ex.sets ?? [])
        .filter((s: any) => s?.completed !== false && s?.set_type !== 'warmup')
        .map((s: any) => ({ weight_kg: Number(s.weight_kg), reps: s.reps }));
      if (sets.length > 0) perEx[key] = sets;
    }
    if (Object.keys(perEx).length > 0) {
      candidates.push({ time: Date.parse(w.finished_at ?? w.started_at) || 0, perEx });
    }
  }

  // Most recent first; for each wanted exercise take the newest workout with it.
  candidates.sort((a, b) => b.time - a.time);
  const result: Record<string, Sets> = {};
  for (const name of names) {
    const key = name.trim().toLowerCase();
    for (const c of candidates) {
      if (c.perEx[key]) {
        result[name] = c.perEx[key];
        break;
      }
    }
  }
  return result;
}
