import type { SupabaseClient } from '@supabase/supabase-js';
import type { Exercise } from '@/lib/types';
import type { ExerciseDef } from '@/lib/exercises';
import { EXERCISE_LIBRARY } from '@/lib/exercises';
import { isSupabaseConfigured } from '@/lib/supabase';
import { readCache, writeCache } from '@/lib/localCache';

/** Row shape stored in the 'exercises' localCache (matches DbExercise). */
export interface CachedExercise {
  id: string;
  name: string;
  muscle_group: string;
  category: string;
  created_by: string | null;
}

/**
 * Optimistically add a user-created custom exercise to the local 'exercises'
 * cache so it's reusable OFFLINE — in the picker and on My Exercises — before
 * it ever reaches the server (a custom is only inserted server-side when its
 * workout syncs). No-op for a name that's in the static library or already
 * cached (deduped by lower-cased name). The temp `local-ex-` id is reconciled
 * to the real exercises.id the next time the catalog revalidates online.
 */
export function saveLocalCustomExercise(
  userId: string | null | undefined,
  def: { name: string; muscle_group: string; category: string },
): void {
  if (!userId) return;
  const name = def.name.trim();
  if (!name) return;
  const lower = name.toLowerCase();
  if (EXERCISE_LIBRARY.some((e) => e.name.toLowerCase() === lower)) return;
  const existing = readCache<CachedExercise[]>('exercises', userId) ?? [];
  if (existing.some((e) => e.name.toLowerCase() === lower)) return;
  const row: CachedExercise = {
    id: `local-ex-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    muscle_group: def.muscle_group || 'Other',
    category: def.category || 'Other',
    created_by: userId,
  };
  writeCache('exercises', userId, [row, ...existing]);
}

/**
 * Union any not-yet-synced local customs (id `local-ex-`) into a fresh server
 * exercise list, so a wholesale revalidate of the 'exercises' cache doesn't
 * clobber a custom created offline that hasn't reached the server yet. A local
 * row drops out only once a server row with the same (case-insensitive) name
 * exists — i.e. after its workout has synced.
 */
export function mergeLocalCustoms(
  serverRows: CachedExercise[],
  userId: string | null | undefined,
): CachedExercise[] {
  if (!userId) return serverRows;
  const serverNames = new Set(serverRows.map((r) => r.name.toLowerCase()));
  const surviving = (readCache<CachedExercise[]>('exercises', userId) ?? []).filter(
    (r) =>
      typeof r.id === 'string' &&
      r.id.startsWith('local-ex-') &&
      !serverNames.has(r.name.toLowerCase()),
  );
  return surviving.length > 0 ? [...surviving, ...serverRows] : serverRows;
}

/**
 * Resolve an exercise definition to a real `exercises` row id — find it by name,
 * else insert it. Shared by the live mid-workout add (reconcileExerciseRow in
 * the workout screen) and the background sync flusher, so a workout finished
 * offline can resolve its exercises at flush time instead of dropping their sets.
 *
 * Case-insensitive find with order + limit(1) matches the per-owner unique index
 * from migration 0037 (the oldest row is canonical). On a lost insert race
 * (23505) we re-find the winner's row.
 */
export async function resolveExerciseRow(
  supabase: SupabaseClient,
  lib: ExerciseDef,
): Promise<Exercise | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const findByName = async () => {
      const { data } = await supabase
        .from('exercises')
        .select('*')
        .ilike('name', lib.name)
        .order('created_at', { ascending: true })
        .limit(1);
      return data && data.length > 0 ? (data[0] as Exercise) : null;
    };
    const existing = await findByName();
    if (existing) return existing;
    const { data: inserted, error } = await supabase
      .from('exercises')
      .insert({ name: lib.name, muscle_group: lib.muscle_group, category: lib.category })
      .select()
      .single();
    if (!error) return (inserted as Exercise) ?? null;
    // 23505: lost the create race to another session — the winner's row is the
    // one we want.
    if (error.code === '23505') return await findByName();
    return null;
  } catch {
    return null;
  }
}
