// The food card's return arrow, one message at a time (app/(app)/nutrition.tsx).
// A card that a follow-up moved on remembers the card before that message,
// the message itself and the chat turns before it. The arrow goes back to that
// card and puts only that message back in the box. A card with nothing before
// it (the first message, or one back from a restart) starts the meal over.
//
// Local edits (a line's amount, a removed line) made after the last message
// are part of "after that message": going back drops them with it. The arrow
// is "undo my last message", and the card it returns to is exactly the one
// the user saw when they sent it.

export type Turn = { role: 'user' | 'drona'; text: string };

/** One step back: the card before the message, and that message. */
export interface CardBack<C> {
  review: C;
  turns: Turn[];
  /** The message that moved the card on, as the user typed it. */
  last: string;
}

/** How many messages the arrow can go back. Older steps are dropped, so a
 *  long chat does not keep every card it ever showed in memory. */
export const BACK_STEPS = 10;

type WithBack<C> = C & { before?: CardBack<C> };

/** The card a message left on screen, remembering the card before it. The
 *  chain is cut at `max` steps. */
export function withBack<C extends object>(
  card: C,
  back: CardBack<WithBack<C>> | null,
  max: number = BACK_STEPS,
): WithBack<C> {
  if (!back || max < 1) return { ...card, before: undefined };
  return { ...card, before: { ...back, review: trim(back.review, max - 1) } };
}

function trim<C extends object>(card: WithBack<C>, keep: number): WithBack<C> {
  if (!card.before) return card;
  if (keep < 1) return { ...card, before: undefined };
  return { ...card, before: { ...card.before, review: trim(card.before.review, keep - 1) } };
}

/** What the arrow does: go back one step, or start over (null). */
export function stepBack<C extends object>(card: WithBack<C>): CardBack<WithBack<C>> | null {
  return card.before ?? null;
}

/** The box after a step back: the message, with any half-typed follow-up
 *  riding after it rather than over it. */
export function boxAfterBack(last: string, typed: string): string {
  return typed.trim() ? `${last}, ${typed.trim()}` : last;
}

/** How many messages the arrow can still go back on this card. */
export function backDepth<C extends object>(card: WithBack<C>): number {
  let n = 0;
  for (let c: WithBack<C> | undefined = card; c?.before; c = c.before.review) n++;
  return n;
}
