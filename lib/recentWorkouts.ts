/**
 * The last 90 days of workouts, read once and shared by the dashboard, History
 * and Analytics through lib/screenCache (key workouts:<clerkId>). Each screen
 * used to run its own nested select of the same rows on every focus and on
 * every sync-count change.
 *
 * The select is the union of what the three read: every set and exercise
 * column (dashboard, Analytics) plus the per-exercise session notes (History).
 * The rows are shared: callers map them into their own shapes and never edit
 * them in place.
 *
 * A flush that lands (components/SyncProvider) and a delete clear the entry;
 * the freshness window only bounds how late a change made elsewhere (another
 * device) shows up.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchShared, invalidate } from '@/lib/screenCache';
import { olderWindow } from '@/lib/workoutWindows';

const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const WORKOUTS_FRESH_MS = 30_000;

export const RECENT_WORKOUTS_SELECT =
  '*, workout_exercise_notes(exercise_id, note, exercises(name, metric_type, muscle_group)), workout_sets(*, exercises(*))';

type Supa = SupabaseClient<any, any, any>;

/**
 * Workouts started in the last 90 days, newest first, as the server has them.
 * Throws on a failed read, so callers keep what they had. Pass `fresh` (pull to
 * refresh) to read regardless of the freshness window.
 */
export function loadRecentWorkouts(
  supabase: Supa,
  clerkId: string | null | undefined,
  opts?: { fresh?: boolean },
): Promise<any[]> {
  const read = async () => {
    const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();
    let q = supabase
      .from('workouts')
      .select(RECENT_WORKOUTS_SELECT)
      .gte('started_at', sinceIso)
      .order('started_at', { ascending: false });
    if (clerkId) q = q.eq('user_id', clerkId);
    const { data, error } = await q;
    if (error) throw error;
    return (data as any[]) ?? [];
  };
  if (!clerkId) return read();
  return fetchShared(`workouts:${clerkId}`, read, opts?.fresh ? undefined : { maxAgeMs: WORKOUTS_FRESH_MS });
}

/**
 * Analytics' older half: 180 to 89 days back (lib/workoutWindows), cached
 * beside the recent read and cleared with it.
 */
export function loadOlderWorkouts(
  supabase: Supa,
  clerkId: string | null | undefined,
  opts?: { fresh?: boolean },
): Promise<any[]> {
  const read = async () => {
    const { sinceIso, beforeIso } = olderWindow();
    let q = supabase
      .from('workouts')
      .select('*, workout_sets(*, exercises(*))')
      .gte('started_at', sinceIso)
      .lt('started_at', beforeIso)
      .order('started_at', { ascending: false });
    if (clerkId) q = q.eq('user_id', clerkId);
    const { data, error } = await q;
    if (error) throw error;
    return (data as any[]) ?? [];
  };
  if (!clerkId) return read();
  return fetchShared(`workouts:${clerkId}:older`, read, opts?.fresh ? undefined : { maxAgeMs: WORKOUTS_FRESH_MS });
}

/** A workout was written or deleted: the next read of either half goes to the server. */
export function invalidateWorkouts(clerkId: string | null | undefined): void {
  if (clerkId) invalidate(`workouts:${clerkId}`);
}
