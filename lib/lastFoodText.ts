// The last food text the user sent from the Nutrition box, offered back while
// the box is empty ("use again"). People log the same breakfast most days and
// retype it whole: one user resent an 8-item message word for word 52 minutes
// later (live, 2026-10-14). Kept on the phone only (lib/lastFoodTextStore),
// never synced: it is the user's own draft, not diary data.
//
// No imports, so Deno can test it directly (lib/lastFoodText.test.ts).

export interface LastFoodText {
  text: string;
  /** When it was sent, epoch ms. */
  at: number;
  /** Who sent it. One phone can change accounts; nobody sees the last one's food. */
  userId: string | null;
}

/** Offered back for this long. Past it, the last meal is history, not a draft. */
export const RECALL_MS = 12 * 60 * 60 * 1000;

/** May this text be offered to `userId` now? A clock that moved backwards
 *  (a timestamp in the future) is not trusted. */
export function isRecallable(
  last: LastFoodText | null,
  now: number,
  userId: string | null,
): last is LastFoodText {
  if (!last || !last.text.trim() || !userId || last.userId !== userId) return false;
  const age = now - last.at;
  return age >= 0 && age < RECALL_MS;
}
