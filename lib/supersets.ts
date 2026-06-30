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
