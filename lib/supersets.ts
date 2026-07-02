/**
 * Superset grouping rules, shared so the routine editor and the active-workout
 * logger can't drift apart on what a valid grouping is.
 *
 * A superset is 2+ CONTIGUOUS exercises that share a `supersetGroup` ordinal
 * (null = solo). Members must form one unbroken run; a run of one is not a
 * superset. After any link / split / reorder / remove, normalize: renumber each
 * contiguous run to 1, 2, 3… and dissolve singletons.
 */
export interface HasSupersetGroup {
  supersetGroup?: number | null;
}

/**
 * Renumber each contiguous run of equal `supersetGroup` to a fresh 1-based id and
 * dissolve singleton runs to null. Returns a shallow-copied array (inputs are not
 * mutated). The numeric id values are not meaningful on their own — only "same id +
 * contiguous = one superset" is — so callers may use any temporary id before
 * normalizing.
 */
export function normalizeSupersetGroups<T extends HasSupersetGroup>(items: T[]): T[] {
  const out = items.map((e) => ({ ...e }));
  let nextId = 1;
  let i = 0;
  while (i < out.length) {
    const g = out[i].supersetGroup ?? null;
    if (g == null) { i++; continue; }
    let j = i;
    while (j < out.length && (out[j].supersetGroup ?? null) === g) j++;
    if (j - i >= 2) {
      const id = nextId++;
      for (let k = i; k < j; k++) out[k].supersetGroup = id;
    } else {
      out[i].supersetGroup = null;
    }
    i = j;
  }
  return out;
}

/**
 * Group item `i` with its successor `i+1` into a superset (extending `i`'s existing
 * group if it has one). Returns a normalized copy. No-op if `i` is the last item.
 */
export function linkWithNext<T extends HasSupersetGroup>(items: T[], i: number): T[] {
  if (i < 0 || i >= items.length - 1) return items;
  const next = items.map((e) => ({ ...e }));
  const gid = next[i].supersetGroup ?? next[i + 1].supersetGroup ?? 9000 + i;
  next[i].supersetGroup = gid;
  next[i + 1].supersetGroup = gid;
  return normalizeSupersetGroups(next);
}

/**
 * Dissolve the whole superset that item `i` belongs to (every member back to solo).
 * Returns a normalized copy. No-op if `i` isn't in a group.
 */
export function dissolveGroupAt<T extends HasSupersetGroup>(items: T[], i: number): T[] {
  const g = items[i]?.supersetGroup ?? null;
  if (g == null) return items;
  const next = items.map((e) => (e.supersetGroup === g ? { ...e, supersetGroup: null } : { ...e }));
  return normalizeSupersetGroups(next);
}

/**
 * Group item `currentIdx` with the items at `picked` (any positions): the picked
 * items are MOVED to sit directly after currentIdx's run (contiguity is the
 * invariant), and all of them share one group. Extends currentIdx's existing
 * group when it has one. A picked member of another group is pulled out of it
 * (normalize dissolves any singleton it leaves behind).
 *
 * Returns the new array plus `indexMap` (old index -> new index) so callers can
 * remap parallel per-exercise arrays (started/finished flags, layout caches) and
 * the current index. Picks that are invalid or already in the run are ignored;
 * with nothing left to do it returns the inputs unchanged (identity map).
 */
export function groupWithPartners<T extends HasSupersetGroup>(
  items: T[],
  currentIdx: number,
  picked: number[],
): { items: T[]; indexMap: number[] } {
  const identity = { items, indexMap: items.map((_, i) => i) };
  if (currentIdx < 0 || currentIdx >= items.length) return identity;
  // currentIdx's contiguous run (just itself when solo).
  const g = items[currentIdx].supersetGroup ?? null;
  let start = currentIdx;
  let end = currentIdx;
  if (g != null) {
    while (start > 0 && (items[start - 1].supersetGroup ?? null) === g) start--;
    while (end < items.length - 1 && (items[end + 1].supersetGroup ?? null) === g) end++;
  }
  const pickedClean = [...new Set(picked)]
    .filter((i) => i >= 0 && i < items.length && (i < start || i > end))
    .sort((a, b) => a - b);
  if (pickedClean.length === 0) return identity;
  const pickedSet = new Set(pickedClean);
  // New order, expressed as old indices: everything up to the run end (minus the
  // picked), then the picked, then the rest (minus the picked).
  const order: number[] = [];
  for (let i = 0; i <= end; i++) if (!pickedSet.has(i)) order.push(i);
  for (const i of pickedClean) order.push(i);
  for (let i = end + 1; i < items.length; i++) if (!pickedSet.has(i)) order.push(i);
  const gid = g ?? 9000 + currentIdx;
  const inGroup = new Set<number>(pickedClean);
  for (let i = start; i <= end; i++) inGroup.add(i);
  const next = order.map((oldI) => ({
    ...items[oldI],
    supersetGroup: inGroup.has(oldI) ? gid : items[oldI].supersetGroup ?? null,
  }));
  const indexMap = items.map((_, oldI) => order.indexOf(oldI));
  return { items: normalizeSupersetGroups(next), indexMap };
}
