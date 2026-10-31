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

type BackgroundTimeModule = { begin(): void; end(): void };

let native: BackgroundTimeModule | null | undefined;
function load(): BackgroundTimeModule | null {
  if (native === undefined) native = requireOptionalNativeModule<BackgroundTimeModule>('BackgroundTime');
  return native;
}

let holds = 0;

/** Time kept after work ends, so its ready notification is posted before iOS suspends the app. */
export const NOTICE_GRACE_MS = 3000;

export function holdBackgroundTime(): () => void {
  const m = load();
  if (!m) return () => {};
  holds += 1;
  if (holds === 1) {
    try { m.begin(); } catch { /* no time is the old behaviour */ }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) {
      try { m.end(); } catch { /* nothing held */ }
    }
  };
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
