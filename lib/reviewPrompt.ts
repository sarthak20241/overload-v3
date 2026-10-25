/**
 * When to ask for a store rating. Pure rules, no storage, so Deno can test
 * them (lib/reviewPrompt.test.ts); lib/storeReview.ts keeps the state and
 * shows the dialog.
 *
 * Play and Apple both cap how often the system dialog appears and never say
 * whether it did, so every ask is spent whether or not anyone saw it. Ask only
 * at a good moment: a workout with a PR, from someone who has come back for a
 * few sessions over a few days, and rarely.
 */

export const REVIEW_MIN_WORKOUTS = 3;
export const REVIEW_MIN_DAYS = 3;
export const REVIEW_GAP_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReviewState {
  /** When the first workout was saved on this install (ms). */
  firstSavedAt: number;
  /** Workouts saved on this install, this one included once counted. */
  saved: number;
  /** When we last asked (ms), or null if never. */
  lastAskedAt: number | null;
}

/**
 * Count one saved workout and decide whether to ask now. The returned state
 * is what to store, with lastAskedAt set when the answer is yes.
 */
export function afterSave(
  prev: ReviewState | null,
  { prCount, now }: { prCount: number; now: number },
): { ask: boolean; state: ReviewState } {
  const state: ReviewState = prev
    ? { ...prev, saved: prev.saved + 1 }
    : { firstSavedAt: now, saved: 1, lastAskedAt: null };

  const ask = prCount > 0
    && state.saved >= REVIEW_MIN_WORKOUTS
    && now - state.firstSavedAt >= REVIEW_MIN_DAYS * DAY_MS
    && (state.lastAskedAt == null || now - state.lastAskedAt >= REVIEW_GAP_DAYS * DAY_MS);

  return { ask, state: ask ? { ...state, lastAskedAt: now } : state };
}
