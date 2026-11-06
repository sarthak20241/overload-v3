// The arithmetic behind the chat's question pin (useQuestionPin in
// components/ai/AICoachModal.tsx). When a reply starts, the chat scrolls once
// so the question sits at the top and the reply types in under it. A tail space
// under the thread gives that scroll room. Heights are scroll-content points.

/** Scroll offset that puts the question at the top, `gap` below the edge. */
export function pinOffset(questionY: number, gap: number): number {
  return Math.max(0, questionY - gap);
}

/** Content height the pin needs: its offset plus one screen under it. */
export function pinRoom(questionY: number, gap: number, viewH: number): number {
  return pinOffset(questionY, gap) + viewH;
}

/**
 * Tail space a finished reply still needs so its question stays at the top:
 * the room the pin needs, less the thread above the tail. `threadEnd` is where
 * the tail starts, measured on the tail itself, so it never depends on the
 * tail's own height. A reply taller than the screen needs none.
 */
export function tailAfterReply(
  threadEnd: number,
  questionY: number,
  gap: number,
  viewH: number,
): number {
  return Math.max(0, Math.round(pinRoom(questionY, gap, viewH) - threadEnd));
}
