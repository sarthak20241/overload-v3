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
 * is what to store. It does not spend the ask: call markAsked only when the
 * dialog is really requested, since it may never be (no native module on an
 * old binary, or the app closed before the share card did).
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

  return { ask, state };
}

/** Start the gap: the dialog was requested at `now`. */
export function markAsked(state: ReviewState, now: number): ReviewState {
  return { ...state, lastAskedAt: now };
}

/**
 * Read stored state, or null when it is missing or not the right shape. A
 * malformed value is a fresh start, never a NaN count that blocks every ask.
 */
export function parseReviewState(raw: string | null): ReviewState | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { firstSavedAt, saved, lastAskedAt } = v as Record<string, unknown>;
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (!num(firstSavedAt) || !num(saved)) return null;
  if (lastAskedAt !== null && !num(lastAskedAt)) return null;
  return { firstSavedAt, saved, lastAskedAt };
}

export interface SavedExerciseForPr {
  /** Best weight ever logged before this session, if known. */
  allTimeBestWeight?: number | null;
  /** Last session's sets, the fallback when all-time is missing. */
  previousSets?: { weight_kg: number }[] | null;
  sets: {
    completed: boolean;
    /** countsAsWorkingSet(set_type): warmups never make a PR. */
    working: boolean;
    weight_kg: number;
    is_unilateral?: boolean;
    weight_kg_right?: number | null;
  }[];
}

/**
 * Whether the workout as saved holds a weight PR: a completed working set
 * heavier than anything before this session. Same test the live PR badge uses
 * (handleLogSet in app/workout/[id].tsx), run on what was kept, so a PR set
 * deleted or edited down before saving does not earn a rating ask.
 */
export function hasSavedPr(exercises: SavedExerciseForPr[]): boolean {
  return exercises.some((e) => {
    const prior = e.previousSets ?? [];
    if (!((e.allTimeBestWeight ?? 0) > 0 || prior.length > 0)) return false;
    const before = Math.max(0, e.allTimeBestWeight ?? 0, ...prior.map((s) => s.weight_kg));
    const best = Math.max(
      0,
      ...e.sets
        .filter((s) => s.completed && s.working)
        .map((s) => Math.max(s.weight_kg, s.is_unilateral ? (s.weight_kg_right ?? s.weight_kg) : 0)),
    );
    return best > before;
  });
}

// Store ids: eas.json submit.production.ios.ascAppId and app.json android.package.
const APP_STORE_ID = '6773063775';
const PLAY_PACKAGE = 'com.overload.tracker';

/**
 * Where the Profile "Rate Overload" row goes, in the order to try. Not the
 * in-app sheet: that one is capped by the store and may show nothing, which
 * reads as a broken button. A row anyone can tap at any time, with no question
 * before it, is not review gating.
 */
export function storePageUrls(platform: string): string[] {
  if (platform === 'ios') {
    // An apps.apple.com link opens the App Store app on iPhone. Not itms-apps://:
    // it resolves even where no App Store app exists, so no fallback could run.
    return [`https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`];
  }
  if (platform === 'android') {
    return [
      `market://details?id=${PLAY_PACKAGE}`,
      `https://play.google.com/store/apps/details?id=${PLAY_PACKAGE}`,
    ];
  }
  return [];
}
