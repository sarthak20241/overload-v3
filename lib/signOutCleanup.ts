// One sign-out for every screen that offers it (Profile, the locked paywall):
// push queued work, sign out of Clerk, then drop the old account's local data
// so the next account on this phone never paints from it. The caller routes.
import { invalidateCustomExercisesCache } from '@/components/routines/ExercisePickerSheet';
import { setGuestMode } from '@/lib/guestMode';
import { flushQueue, getPendingCount } from '@/lib/syncQueue';
import { flushRoutineQueue, getPendingRoutineCount } from '@/lib/routineQueue';
import { flushEditQueue, getPendingEditCount } from '@/lib/editQueue';
import { clearUserCache } from '@/lib/localCache';
import { clearCoachConversations } from '@/lib/coachConversations';
import { invalidateCoachAccess } from '@/hooks/useCoachAccess';
import type { useSupabaseClient } from '@/lib/supabase';

export async function signOutAndCleanUp(opts: {
  userId: string | null | undefined;
  supabase: ReturnType<typeof useSupabaseClient>;
  clerkSignOut: () => Promise<void>;
  /** The locked paywall wants to know a sign-out failed (it stays and says
   *  so). Profile, as before, carries on with the cleanup and leaves. */
  throwIfSignOutFails?: boolean;
}): Promise<void> {
  const prevUserId = opts.userId ?? null;
  // Best-effort: push any queued workouts before the JWT drops. The queue is
  // keyed per user, so anything that still can't sync (offline) is parked
  // under this account and flushes the next time they sign in here, not lost.
  if (
    prevUserId &&
    (getPendingCount(prevUserId) > 0 ||
      getPendingRoutineCount(prevUserId) > 0 ||
      getPendingEditCount(prevUserId) > 0)
  ) {
    try {
      await Promise.race([
        (async () => {
          await flushRoutineQueue(opts.supabase, prevUserId);
          await flushQueue(opts.supabase, prevUserId);
          await flushEditQueue(opts.supabase, prevUserId);
        })(),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch {}
  }
  try {
    await opts.clerkSignOut();
  } catch (e) {
    if (opts.throwIfSignOutFails) throw e;
  }
  // Sign-out always lands on /(auth), however the user got into /(app).
  await setGuestMode(false);
  invalidateCustomExercisesCache();
  invalidateCoachAccess();
  // Per-user keyed, so the next account never sees them. allSettled so a
  // storage failure can't block the redirect after auth teardown.
  if (prevUserId) {
    await Promise.allSettled([clearUserCache(prevUserId), clearCoachConversations(prevUserId)]);
  }
}
