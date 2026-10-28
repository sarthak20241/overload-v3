// Lines shown on the Nutrition screen the moment a suggestion or a copy is
// tapped, before their save lands. A save is a few round trips plus the
// database's own work, so without these the row read "Added" and the meal
// stayed empty for a second or more.
//
// A group lives from the tap until the day is read back with its rows in it.
// The save tells it the real ids (settlePending); the next read that holds
// them all retires it (prunePending). Until then the lines are drawn from
// here and count in the day's totals. A failed save just drops the group.
//
// Pure, so it is tested without React: lib/pendingEntries.test.ts.

export interface PendingRow { id: string; meal_type: string; pending?: boolean }

export interface PendingGroup<E extends PendingRow> {
  id: string;
  /** The day the lines were added to. Other days never show them. */
  dayIso: string;
  entries: E[];
  /** The ids the save wrote, once it has finished. null while it runs. */
  realIds: string[] | null;
}

type Day<E> = Record<string, E[]>;

function idsOf<E extends PendingRow>(byMeal: Day<E>): Set<string> {
  const ids = new Set<string>();
  for (const list of Object.values(byMeal)) for (const e of list) ids.add(e.id);
  return ids;
}

/** True once every row the save wrote is in the day that was read. */
export function landed<E extends PendingRow>(g: PendingGroup<E>, byMeal: Day<E>, ids = idsOf(byMeal)): boolean {
  return g.realIds != null && g.realIds.every((id) => ids.has(id));
}

/** The day as read, with this day's pending lines added under their meals.
 *  Returns `byMeal` itself when there is nothing to add, so memos keyed on it
 *  do not rerun. */
export function withPending<K extends string, E extends PendingRow>(
  byMeal: Record<K, E[]>, dayIso: string, groups: PendingGroup<E>[],
): Record<K, E[]> {
  const mine = groups.filter((g) => g.dayIso === dayIso);
  if (mine.length === 0) return byMeal;
  const ids = idsOf(byMeal);
  const shown = mine.filter((g) => !landed(g, byMeal, ids));
  if (shown.length === 0) return byMeal;
  const next = { ...byMeal };
  for (const g of shown) {
    for (const e of g.entries) {
      const k = e.meal_type as K;
      next[k] = [...(next[k] ?? []), e];
    }
  }
  return next;
}

/** The save finished: remember the real ids. When there is one per line they
 *  become the lines' ids too, so the rows keep their keys when the real ones
 *  replace them and nothing slides in twice. */
export function settlePending<E extends PendingRow>(
  groups: PendingGroup<E>[], groupId: string, realIds: string[],
): PendingGroup<E>[] {
  return groups.map((g) => {
    if (g.id !== groupId) return g;
    const entries = realIds.length === g.entries.length
      ? g.entries.map((e, i) => ({ ...e, id: realIds[i] }))
      : g.entries;
    return { ...g, entries, realIds };
  });
}

/** A read of `dayIso` landed: retire the groups it now holds in full. A group
 *  still saving, or read back by a request that left before the save landed,
 *  stays. Returns `groups` itself when nothing changed. */
export function prunePending<E extends PendingRow>(
  groups: PendingGroup<E>[], byMeal: Day<E>, dayIso: string,
): PendingGroup<E>[] {
  if (groups.length === 0) return groups;
  const ids = idsOf(byMeal);
  const next = groups.filter((g) => g.dayIso !== dayIso || !landed(g, byMeal, ids));
  return next.length === groups.length ? groups : next;
}

/** A past line, as the diary will hold it once saved. */
export interface PendingSource {
  food_id?: string | null;
  food_name: string;
  quantity: number;
  serving_unit: string;
  grams_logged: number | null;
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  source?: string | null;
}

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The rows to draw for `lines` added to `mealType`, rounded the way the save
 *  rounds them (logSection), so the numbers do not shift when the real rows
 *  arrive. No meal yet, so meal_id is empty: a pending row cannot be edited. */
export function pendingRows(groupId: string, lines: PendingSource[], mealType: string) {
  return lines.map((l, i) => ({
    id: `pending:${groupId}:${i}`,
    meal_id: '',
    meal_type: mealType,
    food_id: l.food_id ?? null,
    source: l.source ?? null,
    food_name: l.food_name,
    serving_unit: l.serving_unit,
    quantity: l.quantity,
    // 0 is "no weight known", stored as null (meal_entries allows null or > 0).
    grams_logged: l.grams_logged != null && l.grams_logged > 0 ? r1(l.grams_logged) : null,
    kcal: r0(l.kcal), protein_g: r1(l.protein_g), carb_g: r1(l.carb_g), fat_g: r1(l.fat_g),
    pending: true as const,
  }));
}
