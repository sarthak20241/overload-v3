/**
 * The dashboard's server read, extracted so it can run BEFORE the dashboard
 * mounts.
 *
 * Why: the dashboard paints cache-first, then revalidates. On a fresh install
 * there is no cache, so a user who lands on it straight from the paywall sees
 * an empty "Level 1 · no workouts" frame for a beat before their real data
 * pops in. The /upgrade success screen calls `prefetchDashboard` while the
 * user is reading "You're in." so the cache is warm by the time they arrive.
 *
 * Writes the same cache entities the dashboard writes itself
 * (`dashboardWorkouts`, `profileXp`), so a successful prefetch is
 * indistinguishable from a successful dashboard revalidate. Routines are only
 * written when nothing is cached yet: routines.tsx owns that entity's
 * pending-merged write, and overwriting it here could drop a routine that is
 * still in the sync queue.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { hydrateCache, readCache, writeCache } from '@/lib/localCache';

export interface DashboardData {
  /** Workouts from the last 90 days, newest first, with `sets` normalized. */
  workouts: any[];
  xp: number;
}

const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Fetch workouts (90-day window) + profile XP and write both to the cache.
 * Throws on any request error so callers keep whatever the cache already
 * holds — a failed read must never blank the dashboard.
 */
export async function fetchDashboardData(
  supabase: SupabaseClient<any, any, any>,
  clerkId: string | undefined,
): Promise<DashboardData> {
  // Only fetch the last 90 days to cap payload size; the client-side stats
  // need recent history only.
  const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();
  let workoutsQ = supabase
    .from('workouts')
    .select('*, workout_sets(*, exercises(*))')
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: false });
  let profileQ = supabase.from('user_profiles').select('xp').limit(1).maybeSingle();
  if (clerkId) {
    workoutsQ = workoutsQ.eq('user_id', clerkId);
    profileQ = supabase.from('user_profiles').select('xp').eq('clerk_user_id', clerkId).maybeSingle();
  }
  const [wRes, pRes] = await Promise.all([workoutsQ, profileQ]);
  if (wRes.error || pRes.error) throw wRes.error || pRes.error;
  const workouts = ((wRes.data as any[]) || []).map((w: any) => ({
    ...w,
    sets: w.workout_sets ?? w.sets ?? [],
  }));
  const xp = (pRes.data as any)?.xp || 0;
  writeCache('dashboardWorkouts', clerkId, workouts);
  writeCache('profileXp', clerkId, xp);
  return { workouts, xp };
}

/**
 * Warm the dashboard cache for a signed-in user. Fire-and-forget: never
 * throws, never blocks. Safe to call more than once.
 */
export async function prefetchDashboard(
  supabase: SupabaseClient<any, any, any>,
  clerkId: string | undefined,
): Promise<void> {
  if (!clerkId) return;
  try {
    await hydrateCache(clerkId);
    const jobs: PromiseLike<unknown>[] = [fetchDashboardData(supabase, clerkId)];
    if (readCache<any[]>('routines', clerkId) === null) {
      jobs.push(
        supabase
          .from('routines')
          .select('*, routine_exercises(*, exercises(*))')
          .eq('user_id', clerkId)
          .order('created_at', { ascending: false })
          .then(({ data, error }) => {
            if (!error && data) writeCache('routines', clerkId, data);
          }),
      );
    }
    await Promise.all(jobs);
  } catch {
    // Offline or unauthenticated — the dashboard revalidates on its own.
  }
}
