// What the food box's meal card holds after the server answers one message.
//
// One rule, shared by the Nutrition screen (runParse) and the food box eval's
// live adapter (scripts/food-box-eval), so the eval scores the card the app
// would really show and not a card the adapter guessed at.
//
// The rule that matters most: a card the user has not added yet leaves the
// screen only when the user asks. A save card is a SECOND card beside it, never
// a replacement. Live 2026-11-05 15:23 a save card replaced a lunch card, and
// the lunch was gone for good.

/** The server's answer, reduced to what decides the card. */
export type FoodBarAnswer<I> =
  /** A meal: new lines, or the card reworked. `correctsPrevious` false with a
   *  card on screen means the new lines join it ("and a dosa"). */
  | { kind: 'meal'; items: I[]; correctsPrevious: boolean }
  /** A save card. It sits beside the meal card. */
  | { kind: 'create' }
  /** Words with no meal. `cleared`: the user removed the last line. */
  | { kind: 'declined'; cleared?: boolean }
  /** An error, a cap or a send still settling: nothing about the card changed. */
  | { kind: 'other' };

/** The meal card after the answer. `prev` is the card on screen when the
 *  message was sent (null for none). */
export function cardAfter<I>(prev: I[] | null, a: FoodBarAnswer<I>): I[] | null {
  if (a.kind === 'meal') return prev && !a.correctsPrevious ? [...prev, ...a.items] : a.items;
  if (a.kind === 'declined') return a.cleared ? null : prev;
  return prev;
}
