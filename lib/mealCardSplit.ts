/**
 * How ParsedMealCard, drawn in a box of fixed height (its `expanded` mode),
 * shares out its free height between the two parts that can give way: the
 * food list and Drona's note. That box was the popover card, which the
 * full-screen result (MealResultScreen) replaced; nothing draws the card
 * expanded today, and this stays with the card's `expanded` prop.
 *
 * The card is laid out in a box of fixed height. Left to Yoga, a box shorter
 * than the content came out wrong: the list held at its floor and the note on
 * a tiny shrink weight made its second pass divide by almost nothing, and the
 * list was laid out billions of points tall, or near full height. Everything
 * under it (the note, the meal chips, Discard, Add) went off the card. So the
 * card measures its fixed parts and asks this for the two heights instead.
 *
 * Order of giving way:
 *   1. The list shrinks first, down to its floor (a row and a half, so it
 *      still reads as a list that scrolls).
 *   2. Then the note scrolls, down to its first line.
 *   3. When not even both floors fit (keyboard up on a short phone, large
 *      text), the controls below still win: the list goes under its floor,
 *      then the note under its line. Add must never leave the card.
 *
 * With room to spare the list takes it, past its own content, so the
 * controls stay at the bottom of a taller frame.
 */
export interface CardSpace {
  /** Height left once every fixed part of the card has its share. */
  space: number;
  /** The list's full content height. */
  listContent: number;
  /** The note's full content height; 0 when no note shows. */
  noticeContent: number;
  /** The list's usual least height. */
  listFloor: number;
  /** The note's usual least height. */
  noticeFloor: number;
}

export function splitCardSpace(
  { space, listContent, noticeContent, listFloor, noticeFloor }: CardSpace,
): { list: number; notice: number } {
  // A floor is never more than the content: a short list is its own size.
  const listMin = Math.min(listContent, listFloor);
  const noticeMin = Math.min(noticeContent, noticeFloor);
  const room = Math.max(0, space);
  if (room < listMin + noticeMin) {
    const notice = Math.min(noticeMin, room);
    return { list: room - notice, notice };
  }
  const list = Math.max(listMin, room - noticeContent);
  return { list, notice: Math.min(noticeContent, room - list) };
}
