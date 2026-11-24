/**
 * Reorder of the exercises in a live workout (the pill row drag).
 *
 * Pure rules, so the drag UI only reports "from -> to":
 *  - A superset is one unbroken run (see lib/supersets). A drop INSIDE another
 *    superset lands right after it, so a stray drop cannot break a superset.
 *  - Members can change order inside their own superset.
 *  - A member dragged out of its run leaves the superset (a run of one dissolves).
 */
import { normalizeSupersetGroups, type HasSupersetGroup } from './supersets';

export interface MoveResult<T> {
  items: T[];
  /** old index -> new index, to remap parallel per-exercise arrays. */
  indexMap: number[];
  /** True when a superset gained, lost or dissolved a member. */
  groupsChanged: boolean;
}

export function moveExercise<T extends HasSupersetGroup>(items: T[], from: number, to: number): MoveResult<T> {
  const identity: MoveResult<T> = { items, indexMap: items.map((_, i) => i), groupsChanged: false };
  const n = items.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return identity;

  // The new order, as old indices.
  const order = items.map((_, i) => i);
  order.splice(from, 1);
  order.splice(to, 0, from);

  const groupAt = (pos: number) => (pos < 0 || pos >= n ? null : items[order[pos]].supersetGroup ?? null);
  const own = items[from].supersetGroup ?? null;
  const left = groupAt(to - 1);
  const right = groupAt(to + 1);
  let leftOwnRun = false;
  if (left != null && left === right && left !== own) {
    // Dropped inside another superset: slide to just after that run.
    let end = to + 1;
    while (groupAt(end + 1) === left) end++;
    order.splice(to, 1);
    order.splice(end, 0, from);
    leftOwnRun = own != null;
  } else if (own != null && left !== own && right !== own) {
    leftOwnRun = true;
  }

  const moved = order.map((oldI) =>
    oldI === from && leftOwnRun ? { ...items[oldI], supersetGroup: null } : items[oldI]);
  const next = normalizeSupersetGroups(moved);
  const indexMap = items.map((_, oldI) => order.indexOf(oldI));
  // Group ids are renumbered by normalize, so compare the SHAPE: the size of
  // each exercise's superset before and after.
  const sizeOf = (arr: HasSupersetGroup[], i: number) => {
    const g = arr[i].supersetGroup ?? null;
    if (g == null) return 0;
    return arr.filter((e) => e.supersetGroup === g).length;
  };
  const groupsChanged = items.some((_, oldI) => sizeOf(items, oldI) !== sizeOf(next, indexMap[oldI]));
  return { items: next, indexMap, groupsChanged };
}

/**
 * A stable key per exercise slot for the pill row. The workout has no slot id,
 * and one exercise can be in a workout twice, so the key is the exercise id
 * plus its occurrence number. It follows the exercise through a reorder. Two
 * copies of one exercise that change places keep their keys; they look the
 * same, so the row shows no difference.
 */
export function pillKeys(items: { exercise: { id: string } }[]): string[] {
  const seen = new Map<string, number>();
  return items.map((e) => {
    const k = seen.get(e.exercise.id) ?? 0;
    seen.set(e.exercise.id, k + 1);
    return `${e.exercise.id}#${k}`;
  });
}
