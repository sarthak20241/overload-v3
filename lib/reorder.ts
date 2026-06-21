// Small, pure helper for moving an item within a list. Used by the routine
// editor's drag-to-reorder. Pure so it's trivial to reason about and test.

/** Return a new array with the item at `from` moved to index `to`. */
export function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  // Clamp the destination so splice can't insert past the end.
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}
