import type { SupabaseClient } from '@supabase/supabase-js';
import type { LoggedEntry, ParsedMealItem } from './dietData';

/** Save the edited snapshot and meal assignment in one row update. */
export async function persistLoggedEntryEdit(
  supabase: SupabaseClient,
  entry: LoggedEntry,
  item: ParsedMealItem,
  date: Date,
  findMeal: (meal: ParsedMealItem['meal_type'], date: Date) => Promise<{ id?: string; error?: string }>,
): Promise<{ error?: string }> {
  if (!(item.quantity > 0) || !Number.isFinite(item.quantity) || !item.serving_label.trim() ||
      [item.kcal, item.protein_g, item.carb_g, item.fat_g, item.grams].some(n => !Number.isFinite(n) || n < 0)) {
    return { error: 'Enter a valid portion and nutrition values.' };
  }
  let mealId = entry.meal_id;
  if (item.meal_type !== entry.meal_type) {
    const m = await findMeal(item.meal_type, date);
    if (m.error || !m.id) return { error: m.error ?? 'Could not create the meal' };
    mealId = m.id;
  }
  const nutritionChanged = item.quantity !== entry.quantity || item.serving_label !== entry.serving_unit ||
    item.grams !== (entry.grams_logged ?? 0) || item.kcal !== entry.kcal ||
    item.protein_g !== entry.protein_g || item.carb_g !== entry.carb_g || item.fat_g !== entry.fat_g;
  const { data, error } = await supabase.from('meal_entries').update({
    meal_id: mealId, quantity: item.quantity, serving_unit: item.serving_label,
    grams_logged: item.grams > 0 ? item.grams : null,
    kcal: item.kcal, protein_g: item.protein_g, carb_g: item.carb_g, fat_g: item.fat_g,
    // Extended nutrients were not edited; after a correction they are unknown.
    ...(nutritionChanged ? { source: 'manual', fiber_g: null, sugar_g: null, sat_fat_g: null, sodium_mg: null } : {}),
  }).eq('id', entry.id).select('id').single();
  if (error || !data) return { error: error?.message ?? 'This food could not be updated. Try again.' };
  if (mealId !== entry.meal_id) {
    const { count, error: countError } = await supabase.from('meal_entries')
      .select('id', { count: 'exact', head: true }).eq('meal_id', entry.meal_id);
    if (!countError && count === 0) await supabase.from('meals').delete().eq('id', entry.meal_id);
  }
  return {};
}

