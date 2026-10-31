/**
 * A food-search sentence handed to the Nutrition food box.
 *
 * The food search screen offers "Log it with Drona" above the catalog rows.
 * Rather than grow a second copy of the review card there, the tap leaves the
 * words here and goes back to /nutrition, which takes them once on focus and
 * runs its own runParse with the meal and day the user was adding to.
 *
 * Same idea as setLogMeal / setQuickAddSeed: /nutrition is a retained Tabs
 * screen, so a router param would still be there (and stale) on the next
 * visit. Taking it CONSUMES it, which is what makes the parse run exactly once:
 * a re-focus, a second effect run or a dev double-mount all find nothing.
 *
 * A hand-off nobody took in PENDING_PARSE_MAX_AGE_MS is dropped rather than
 * fired later out of nowhere.
 *
 * No imports, so Deno can test it directly: deno test lib/pendingParse.test.ts
 */

/** Same union as lib/foods MealType, kept local so this file stays import-free. */
export type PendingParseMeal = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface PendingParse {
  text: string;
  meal: PendingParseMeal;
  /** The diary day the user was adding to (getLogDate on food search). */
  day: Date;
  at: number;
}

/** Fewer characters than this is still a search being typed, not a meal. */
export const MIN_DRONA_LOG_CHARS = 2;

/** Long enough to outlast a Precise parse still running on Nutrition, which
 *  the hand-off waits for; short enough that a lost one never surprises. */
export const PENDING_PARSE_MAX_AGE_MS = 2 * 60_000;

/** The words to send Drona from a search box, or null while there is not yet
 *  enough to send. Whitespace is collapsed so "2  eggs " reads as typed. */
export function dronaLogText(query: string): string | null {
  const t = query.replace(/\s+/g, ' ').trim();
  return t.length >= MIN_DRONA_LOG_CHARS ? t : null;
}

let _pending: PendingParse | null = null;

/** Leave a sentence for Nutrition. A newer hand-off replaces an older one. */
export function setPendingParse(
  p: { text: string; meal: PendingParseMeal; day: Date },
  now: number = Date.now(),
): void {
  const text = dronaLogText(p.text);
  _pending = text ? { text, meal: p.meal, day: new Date(p.day.getTime()), at: now } : null;
}

/** Take the waiting sentence, if any. Reading it clears it. */
export function takePendingParse(now: number = Date.now()): PendingParse | null {
  const p = _pending;
  _pending = null;
  if (!p || now - p.at > PENDING_PARSE_MAX_AGE_MS) return null;
  return p;
}
