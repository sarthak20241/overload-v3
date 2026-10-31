/**
 * Ask iOS for time to finish Drona's work after the app leaves the screen.
 *
 * iOS suspends an app seconds after it goes to the background. A build still
 * streaming then stops until the user comes back, so the "it's ready"
 * notification never comes while they are away. holdBackgroundTime() starts a
 * background task (modules/background-time, about 30 s of grace), and the
 * returned release ends it. Holds are counted, so overlapping work (a kept
 * sheet and a meal parse) shares one task.
 *
 * Fail-soft: a binary built before the module existed (and Android, which
 * does not suspend this way) gets a no-op.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { createHolds, type NativeTask } from '@/lib/backgroundHolds';

// Counting rules (and the cap on a hold that never ends) live in
// lib/backgroundHolds. Loaded on first use.
let holds: ReturnType<typeof createHolds> | null = null;
function load() {
  if (!holds) {
    holds = createHolds(requireOptionalNativeModule<NativeTask>('BackgroundTime'), {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
  }
  return holds;
}

/** Time kept after work ends, so its ready notification is posted before iOS suspends the app. */
export const NOTICE_GRACE_MS = 3000;

export function holdBackgroundTime(): () => void {
  return load().hold();
}

/** Hold background time while `work` runs, and a grace period after it settles. */
export async function withBackgroundTime<T>(work: () => Promise<T>): Promise<T> {
  const release = holdBackgroundTime();
  try {
    return await work();
  } finally {
    setTimeout(release, NOTICE_GRACE_MS);
  }
}
