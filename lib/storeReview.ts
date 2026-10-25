/**
 * The store rating ask: count each saved workout, and when lib/reviewPrompt.ts
 * says the moment is right, show the system review dialog (Play in-app review
 * on Android, SKStoreReviewController on iOS).
 *
 * expo-store-review is a native module, and binaries built before it was added
 * (1.0.2 and older) have no such module. Same discipline as lib/clipboard.ts:
 * ask for the native side first, load lazily, never crash. On those binaries
 * an OTA of this code counts workouts and stays silent.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { track } from '@/lib/analytics';
import { afterSave, type ReviewState } from '@/lib/reviewPrompt';

const KEY = 'overload.storeReview.v1';
// Wait for the screen change to settle, so the sheet does not land on top of
// a navigation transition.
const ASK_DELAY_MS = 800;

type StoreReview = typeof import('expo-store-review');
let mod: StoreReview | null | undefined;

function getStoreReview(): StoreReview | null {
  if (mod === undefined) {
    if (!requireOptionalNativeModule('ExpoStoreReview')) {
      mod = null;
      return null;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('expo-store-review') as StoreReview;
    } catch {
      mod = null;
    }
  }
  return mod;
}

async function readState(): Promise<ReviewState | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ReviewState) : null;
  } catch {
    return null;
  }
}

/**
 * Count a saved workout. Resolves true when this workout earned an ask; the
 * caller then calls askForReview() once the user has left the finish flow.
 */
export async function noteWorkoutSaved(prCount: number): Promise<boolean> {
  try {
    const { ask, state } = afterSave(await readState(), { prCount, now: Date.now() });
    await AsyncStorage.setItem(KEY, JSON.stringify(state));
    return ask;
  } catch {
    return false;
  }
}

/** Show the system review dialog, if this binary and store can. */
export function askForReview(): void {
  const sr = getStoreReview();
  if (!sr) return;
  setTimeout(() => {
    void (async () => {
      try {
        if (!(await sr.hasAction())) return;
        track('review_prompt_requested');
        await sr.requestReview();
      } catch {
        // The store said no, or the dialog failed. Nothing to show the user.
      }
    })();
  }, ASK_DELAY_MS);
}
