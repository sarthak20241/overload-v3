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
import { afterSave, markAsked, parseReviewState, type ReviewState } from '@/lib/reviewPrompt';

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
    return parseReviewState(await AsyncStorage.getItem(KEY));
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
    // No native module: never ask, so the gap is not spent on a dialog this
    // binary cannot show.
    return ask && getStoreReview() != null;
  } catch {
    return false;
  }
}

/**
 * Show the system review dialog, if this binary and store can. The 90-day gap
 * starts here, right before the request, not when the ask was decided.
 */
export function askForReview(): void {
  const sr = getStoreReview();
  if (!sr) return;
  setTimeout(() => {
    void (async () => {
      try {
        if (!(await sr.hasAction())) return;
        const state = await readState();
        if (state) await AsyncStorage.setItem(KEY, JSON.stringify(markAsked(state, Date.now())));
        track('review_prompt_requested');
        await sr.requestReview();
      } catch {
        // The store said no, or the dialog failed. Nothing to show the user.
      }
    })();
  }, ASK_DELAY_MS);
}
