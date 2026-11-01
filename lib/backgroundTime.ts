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
import { AppState } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { createHolds, createWorkTracker, type NativeTask } from '@/lib/backgroundHolds';

// Counting rules (the cap on a hold that never ends, and a fresh hold when
// the app goes to the background mid-work) live in lib/backgroundHolds.
// Loaded on first use.
let tracker: ReturnType<typeof createWorkTracker> | null = null;
function load() {
  if (!tracker) {
    const holds = createHolds(requireOptionalNativeModule<NativeTask>('BackgroundTime'), {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const t = createWorkTracker(holds);
    AppState.addEventListener('change', (state) => t.appState(state));
    tracker = t;
  }
  return tracker;
}

/** Time kept after work ends, so its ready notification is posted before iOS suspends the app. */
export const NOTICE_GRACE_MS = 3000;

/** Work is running: keep time for it if the user leaves. The release says it ended. */
export function holdBackgroundTime(): () => void {
  return load().start();
}

/** Hold background time while `work` runs, and a grace period after it settles. */
export async function withBackgroundTime<T>(work: () => Promise<T>): Promise<T> {
  const release = holdBackgroundTime();
  try {
    return await work();
  } finally {
    // A JS timer: if iOS suspends the app before it fires, the release waits
    // until the app resumes, and the native task runs until iOS expires it.
    // Harmless (it only holds the time iOS already granted).
    setTimeout(release, NOTICE_GRACE_MS);
  }
}
