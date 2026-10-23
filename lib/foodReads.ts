/**
 * Reshaping for the food reads that embed their child rows in one select
 * (meals with their entries, saved meals with their items) instead of a
 * second trip by id. Pure, so `deno test lib/foodReads.test.ts` covers it.
 */

const num = (v: unknown) => (v == null ? 0 : Number(v));

interface MacroRow { kcal?: unknown; protein_g?: unknown; carb_g?: unknown; fat_g?: unknown }

/**
 * Per-day macro totals for `days` (local YYYY-MM-DD, in order), zeros for a
 * day with nothing logged. `dayOf` turns a meal's logged_at into its local day.
 */
export function dayTotalsFromMeals(
  days: string[],
  meals: { logged_at: string; meal_entries?: MacroRow[] | null }[],
  dayOf: (loggedAt: string) => string,
): { dayIso: string; kcal: number; protein_g: number; carb_g: number; fat_g: number }[] {
  const out = days.map((dayIso) => ({ dayIso, kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 }));
  const idx = new Map(days.map((d, i) => [d, i]));
  for (const m of meals) {
    const i = idx.get(dayOf(m.logged_at));
    if (i == null) continue;
    for (const e of m.meal_entries ?? []) {
      out[i].kcal += num(e.kcal); out[i].protein_g += num(e.protein_g);
      out[i].carb_g += num(e.carb_g); out[i].fat_g += num(e.fat_g);
    }
  }
  return out;
}

/** Every entry of meals that arrive newest first, newest meal first. */
export function entriesNewestFirst<E>(meals: { meal_entries?: E[] | null }[]): E[] {
  return meals.flatMap((m) => m.meal_entries ?? []);
}

/** A saved meal's embedded items in the order they were saved. */
export function itemsInPositionOrder<I extends { position?: unknown }>(items: I[] | null | undefined): I[] {
  return [...(items ?? [])].sort((a, b) => num(a.position) - num(b.position));
}
