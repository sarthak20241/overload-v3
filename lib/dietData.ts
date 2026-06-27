/**
 * Diet data layer — read today's log, search the catalog, and log a food.
 *
 * Read: useTodayNutrition() loads today's meals + meal_entries (RLS-scoped to the
 * Clerk user), groups by meal_type, and sums day totals. The day view + the
 * dashboard FUEL card both call it so they show the same real numbers.
 *
 * Write: logFood() find-or-creates today's meal of that type and inserts a
 * meal_entry with the DENORMALIZED macro snapshot (food_name + grams_logged +
 * per-entry macros), so history is immutable and renders without a join.
 *
 * Catalog: searchCatalog() merges the bundled FOOD_LIBRARY (Indian staples, always
 * offline) with the Supabase `foods` table (the 7.4k USDA catalog), deduped by name.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSupabaseClient } from '@/lib/supabase';
import {
  type MealType, type Food, type FoodDef, type FoodServing,
  nutrientsForAmount, resolveBaseAmount, searchFoods, foodCategoryOf,
} from '@/lib/foods';

type Supa = NonNullable<ReturnType<typeof useSupabaseClient>>;
/** A food the picker can log: a catalog Food (has id) or a bundled FoodDef (no id). */
export type PickerFood = FoodDef & { id?: string | null };

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => (v == null ? 0 : Number(v));

export interface LoggedEntry {
  id: string;
  meal_type: MealType;
  food_name: string;
  serving_unit: string;
  quantity: number;
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
}
export interface DayTotals { kcal: number; protein_g: number; carb_g: number; fat_g: number }
export interface DayData {
  byMeal: Record<MealType, LoggedEntry[]>;
  totals: DayTotals;
  loading: boolean;
  reload: () => void;
}

const emptyByMeal = (): Record<MealType, LoggedEntry[]> =>
  ({ breakfast: [], lunch: [], dinner: [], snack: [] });

/** Local-day [start,end] as UTC ISO strings, so a logged_at timestamptz filters
 *  by the user's calendar day rather than the server's. */
function todayRange(): { start: string; end: string } {
  const now = new Date();
  const s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const e = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { start: s.toISOString(), end: e.toISOString() };
}

export function useTodayNutrition(): DayData {
  const supabase = useSupabaseClient();
  const [byMeal, setByMeal] = useState<Record<MealType, LoggedEntry[]>>(emptyByMeal);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) { setLoading(false); return; }
      setLoading(true);
      const { start, end } = todayRange();
      const { data: meals } = await supabase
        .from('meals').select('id, meal_type')
        .gte('logged_at', start).lte('logged_at', end);
      if (cancelled) return;
      if (!meals || meals.length === 0) { setByMeal(emptyByMeal()); setLoading(false); return; }
      const typeOf = new Map<string, MealType>(meals.map((m: any) => [m.id, m.meal_type as MealType]));
      const { data: entries } = await supabase
        .from('meal_entries')
        .select('id, meal_id, food_name, quantity, serving_unit, kcal, protein_g, carb_g, fat_g')
        .in('meal_id', meals.map((m: any) => m.id))
        .order('position');
      if (cancelled) return;
      const grouped = emptyByMeal();
      for (const e of entries ?? []) {
        const mt = typeOf.get((e as any).meal_id) ?? 'snack';
        grouped[mt].push({
          id: (e as any).id, meal_type: mt, food_name: (e as any).food_name,
          serving_unit: (e as any).serving_unit, quantity: num((e as any).quantity),
          kcal: num((e as any).kcal), protein_g: num((e as any).protein_g),
          carb_g: num((e as any).carb_g), fat_g: num((e as any).fat_g),
        });
      }
      setByMeal(grouped);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [supabase, tick]);

  const totals = useMemo<DayTotals>(() => {
    const t = { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 };
    for (const mt of Object.keys(byMeal) as MealType[]) {
      for (const e of byMeal[mt]) {
        t.kcal += e.kcal; t.protein_g += e.protein_g; t.carb_g += e.carb_g; t.fat_g += e.fat_g;
      }
    }
    return t;
  }, [byMeal]);

  return { byMeal, totals, loading, reload };
}

/** Search the catalog: bundled FOOD_LIBRARY first (curated Indian staples), then the
 *  Supabase `foods` table, deduped by lowercased name. */
export async function searchCatalog(supabase: Supa | null, query: string): Promise<PickerFood[]> {
  const q = query.trim();
  const lib: PickerFood[] = searchFoods(q).map((f) => ({ ...f, id: null }));
  if (!q || !supabase) return lib.slice(0, 25);
  const { data } = await supabase
    .from('foods')
    .select('id, name, food_category, base_unit, kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg')
    .ilike('name', `%${q}%`)
    .limit(40);
  const catalog: PickerFood[] = (data ?? []).map((d: any) => ({
    id: d.id, name: d.name, food_category: foodCategoryOf(d.food_category),
    base_unit: d.base_unit === 'ml' ? 'ml' : 'g',
    kcal: num(d.kcal), protein_g: num(d.protein_g), carb_g: num(d.carb_g), fat_g: num(d.fat_g),
    fiber_g: num(d.fiber_g), sugar_g: num(d.sugar_g), sat_fat_g: num(d.sat_fat_g), sodium_mg: num(d.sodium_mg),
    servings: [],
  }));
  const seen = new Set(lib.map((f) => f.name.toLowerCase()));
  return [...lib, ...catalog.filter((c) => !seen.has(c.name.toLowerCase()))].slice(0, 50);
}

/** A food's serving options. Bundled foods carry them; catalog foods load from
 *  food_servings; everything always has a canonical "100 <base>" fallback. */
export async function loadServings(supabase: Supa | null, food: PickerFood): Promise<FoodServing[]> {
  const fallback: FoodServing = { label: `100 ${food.base_unit}`, grams: 100, is_default: true };
  if (food.servings && food.servings.length > 0) return food.servings;
  if (!food.id || !supabase) return [fallback];
  const { data } = await supabase
    .from('food_servings').select('label, grams, is_default, seq')
    .eq('food_id', food.id).order('seq');
  const servings: FoodServing[] = (data ?? []).map((s: any) => ({
    label: s.label, grams: num(s.grams), is_default: !!s.is_default,
  }));
  return servings.length > 0 ? servings : [fallback];
}

/** Log a food to today's meal of `mealType` (find-or-create the meal, insert the
 *  entry with the macro snapshot). Returns { error } on failure. */
export async function logFood(
  supabase: Supa,
  args: { mealType: MealType; food: PickerFood; servingLabel: string; quantity: number },
): Promise<{ error?: string }> {
  const { mealType, food, servingLabel, quantity } = args;
  const { start, end } = todayRange();

  const { data: existing } = await supabase
    .from('meals').select('id').eq('meal_type', mealType)
    .gte('logged_at', start).lte('logged_at', end).limit(1);
  let mealId = (existing?.[0] as any)?.id as string | undefined;
  if (!mealId) {
    const { data: created, error } = await supabase
      .from('meals').insert({ meal_type: mealType }).select('id').single();
    if (error || !created) return { error: error?.message ?? 'Could not create the meal' };
    mealId = (created as any).id;
  }

  const grams = resolveBaseAmount(food, servingLabel, quantity) ?? 100 * quantity;
  const n = nutrientsForAmount(food, grams);
  const { count } = await supabase
    .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', mealId);

  const { error } = await supabase.from('meal_entries').insert({
    meal_id: mealId,
    food_id: food.id ?? null,
    food_name: food.name,
    quantity,
    serving_unit: servingLabel,
    grams_logged: r1(grams),
    kcal: r0(n.kcal), protein_g: r1(n.protein_g), carb_g: r1(n.carb_g), fat_g: r1(n.fat_g),
    fiber_g: r1(n.fiber_g), sugar_g: r1(n.sugar_g), sat_fat_g: r1(n.sat_fat_g), sodium_mg: r0(n.sodium_mg),
    position: count ?? 0,
  });
  return { error: error?.message };
}
