import type { SupabaseClient } from '@supabase/supabase-js';
import type { LoggedEntry, ParsedMealItem } from './dietData';
import { deleteMealIfEmpty } from './mealCleanup';
import { missingColumn, withoutColumns } from './missingColumn';

/** Save the edited snapshot and meal assignment in one row update. */
export async function persistLoggedEntryEdit(
  supabase: SupabaseClient,
  entry: LoggedEntry,
  item: ParsedMealItem,
  date: Date,
  findMeal: (meal: ParsedMealItem['meal_type'], date: Date) => Promise<{ id?: string; error?: string }>,
): Promise<{ error?: string }> {
  const name = item.food_name.trim();
  if (!name || !(item.quantity > 0) || !Number.isFinite(item.quantity) || !item.serving_label.trim() ||
      [item.kcal, item.protein_g, item.carb_g, item.fat_g, item.grams].some(n => !Number.isFinite(n) || n < 0)) {
    return { error: 'Enter a valid portion and nutrition values.' };
  }
  let mealId = entry.meal_id;
  if (item.meal_type !== entry.meal_type) {
    const m = await findMeal(item.meal_type, date);
    if (m.error || !m.id) return { error: m.error ?? 'Could not create the meal' };
    mealId = m.id;
  }
  const nutritionChanged = item.grams !== (entry.grams_logged ?? 0) || item.kcal !== entry.kcal ||
    item.protein_g !== entry.protein_g || item.carb_g !== entry.carb_g || item.fat_g !== entry.fat_g;
  const typed = numbersTyped(entry, item);
  const update: Record<string, unknown> = {
    meal_id: mealId, quantity: item.quantity, serving_unit: item.serving_label,
    grams_logged: item.grams > 0 ? item.grams : null,
    kcal: item.kcal, protein_g: item.protein_g, carb_g: item.carb_g, fat_g: item.fat_g,
    // A rename is a label fix: the numbers stay as logged, so source does not move.
    ...(name !== entry.food_name ? { food_name: name } : {}),
    // Extended nutrients were not edited; after a correction they are unknown.
    ...(nutritionChanged ? { source: 'manual', fiber_g: null, sugar_g: null, sat_fat_g: null, sodium_mg: null } : {}),
    // New numbers per 100 g are the user's own (step 4). A change of amount
    // alone scales the same numbers: the line keeps its origin.
    ...(typed ? { origin: 'user_typed', copied_from: null } : {}),
  };
  let { data, error } = await supabase.from('meal_entries').update(update).eq('id', entry.id).select('id').single();
  if (error && missingColumn(error, ['origin', 'copied_from'])) {
    // The database predates migration 20261107120000: save without the
    // columns. Once it lands, its trigger reads this edit's "manual" as typed
    // numbers by the same rule (numbersTyped).
    ({ data, error } = await supabase.from('meal_entries').update(withoutColumns([update], ['origin', 'copied_from'])[0])
      .eq('id', entry.id).select('id').single());
  }
  if (error || !data) return { error: error?.message ?? 'This food could not be updated. Try again.' };
  if (mealId !== entry.meal_id) await deleteMealIfEmpty(supabase, entry.meal_id);
  return {};
}


/** Did the user type new numbers, not just a new amount? Compared per 100 g:
 *  kcal by more than 1% (or 0.5), a macro by more than 0.2 g. Same rule as the
 *  database's stamp_entry_origin. */
export function numbersTyped(
  entry: { grams_logged: number | null; kcal: number; protein_g: number; carb_g: number; fat_g: number },
  item: { grams: number; kcal: number; protein_g: number; carb_g: number; fat_g: number },
): boolean {
  const g0 = entry.grams_logged ?? 0;
  const g1 = item.grams;
  if (!(g0 > 0) || !(g1 > 0)) {
    // No weight to compare against: any change of the numbers is typed.
    return item.kcal !== entry.kcal || item.protein_g !== entry.protein_g ||
      item.carb_g !== entry.carb_g || item.fat_g !== entry.fat_g;
  }
  const per = (v: number, g: number) => (v * 100) / g;
  const k0 = per(entry.kcal, g0);
  if (Math.abs(per(item.kcal, g1) - k0) > Math.max(0.5, k0 * 0.01)) return true;
  return (['protein_g', 'carb_g', 'fat_g'] as const).some((m) => Math.abs(per(item[m], g1) - per(entry[m], g0)) > 0.2);
}
