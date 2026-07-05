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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import {
  type MealType, type FoodDef, type FoodServing,
  nutrientsForAmount, resolveBaseAmount, foodCategoryOf, searchFoods,
} from '@/lib/foods';

type Supa = NonNullable<ReturnType<typeof useSupabaseClient>>;
/** A food the picker can log: a catalog Food (has id) or a bundled FoodDef (no id). */
export type PickerFood = FoodDef & { id?: string | null };

/**
 * The meal the logging flow is targeting. food-search / food-detail are RETAINED
 * Tabs screens, so router params went stale across re-opens and every log landed
 * in breakfast. This module-level target is set right before navigating and read
 * on screen focus, so it can never go stale regardless of param threading.
 */
let _logMeal: MealType = 'breakfast';
export const setLogMeal = (m: MealType) => { _logMeal = m; };
export const getLogMeal = (): MealType => _logMeal;

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

/** Local-day key so a cached read can't bleed across midnight. */
function dayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Cache key scoped to BOTH the signed-in user and the local day, so signing out
 *  and back in as someone else on the same day can't seed the second session with
 *  the first user's meals. */
function cacheKey(userId: string | null): string {
  return `${userId ?? 'anon'}:${dayKey()}`;
}

/** Process-lifetime cache of today's grouped entries, so opening the diary paints
 *  instantly from what the dashboard already loaded (no 5s cold re-fetch), then
 *  revalidates silently. Keyed by user + local day so it never bleeds across
 *  accounts or midnight. */
let _navCache: { key: string; byMeal: Record<MealType, LoggedEntry[]> } | null = null;

export function useTodayNutrition(): DayData {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const key = cacheKey(user?.id ?? null);
  const seed = _navCache && _navCache.key === key ? _navCache.byMeal : null;
  const [byMeal, setByMeal] = useState<Record<MealType, LoggedEntry[]>>(seed ?? emptyByMeal());
  const [loading, setLoading] = useState(!seed);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) { setLoading(false); return; }
      // Only show the loading state on a true cold load; a same-key cache means we
      // already painted real numbers, so revalidate silently (no zeros flash).
      if (!(_navCache && _navCache.key === key)) setLoading(true);
      const { start, end } = todayRange();
      const { data: meals } = await supabase
        .from('meals').select('id, meal_type')
        .gte('logged_at', start).lte('logged_at', end);
      if (cancelled) return;
      if (!meals || meals.length === 0) {
        const empty = emptyByMeal();
        _navCache = { key, byMeal: empty };
        setByMeal(empty); setLoading(false); return;
      }
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
      _navCache = { key, byMeal: grouped };
      setByMeal(grouped);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [supabase, tick, key]);

  // Refetch when the consuming screen regains focus, so the dashboard FUEL card
  // reflects a food logged on the nutrition screen the moment the user returns.
  // Skip the first focus — mount already loads — to avoid a double-fetch on open.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) { firstFocus.current = false; return; }
      reload();
    }, [reload]),
  );

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

/** Tidy a raw USDA catalog name for display: de-SHOUT all-caps brand fragments
 *  ("SNICKERS" -> "Snickers", "HERSHEY'S" -> "Hershey's") while leaving normal
 *  mixed-case words and possessives intact. Applied so logged history reads clean. */
export function cleanFoodName(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    // De-SHOUT any run of 2+ caps (brand fragments, even with trailing punctuation
    // like "APPLEBEE'S,") to Title case; mixed-case words + single letters untouched.
    .replace(/[A-Z][A-Z'&.]+/g, (w) => w[0] + w.slice(1).toLowerCase());
}

function rowToPickerFood(d: any): PickerFood {
  return {
    id: d.id ?? null,
    name: cleanFoodName(String(d.name ?? '')),
    brand: d.brand ?? undefined,
    food_category: foodCategoryOf(d.food_category),
    base_unit: d.base_unit === 'ml' ? 'ml' : 'g',
    kcal: num(d.kcal), protein_g: num(d.protein_g), carb_g: num(d.carb_g), fat_g: num(d.fat_g),
    // Keep null (genuinely unknown) distinct from a real 0 so logging can persist
    // it instead of collapsing unknown extended nutrients to 0 (migration 0069).
    fiber_g: d.fiber_g == null ? null : Number(d.fiber_g),
    sugar_g: d.sugar_g == null ? null : Number(d.sugar_g),
    sat_fat_g: d.sat_fat_g == null ? null : Number(d.sat_fat_g),
    sodium_mg: d.sodium_mg == null ? null : Number(d.sodium_mg),
    servings: [],
  };
}

/** Search the catalog: the bundled FOOD_LIBRARY (Indian staples, always offline)
 *  merged with the Supabase `foods` table (relevance-ranked via the
 *  search_foods_ranked RPC, migration 0068), deduped by name with the curated
 *  bundled matches first. The bundled set is always included, so search still
 *  works offline or when the RPC fails. Empty query returns nothing — the picker
 *  shows Recents for that case (see recentFoods). */
export async function searchCatalog(supabase: Supa | null, query: string): Promise<PickerFood[]> {
  const q = query.trim();
  if (!q) return [];
  const bundled: PickerFood[] = searchFoods(q);
  let remote: PickerFood[] = [];
  if (supabase) {
    const { data, error } = await supabase.rpc('search_foods_ranked', { q, lim: 40 });
    if (!error && data) remote = (data as any[]).map(rowToPickerFood);
  }
  const seen = new Set<string>();
  const out: PickerFood[] = [];
  for (const f of [...bundled, ...remote]) {
    const name = f.name.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(f);
  }
  return out;
}

/** The user's recently-logged foods, most recent first, deduped by name — the
 *  default picker list (global, no regional seed). Each is rebuilt as a loggable
 *  food: the per-100 basis is reconstructed from the stored snapshot + grams, and
 *  the serving they used is carried so re-logging is one tap at the same portion. */
export async function recentFoods(supabase: Supa | null, limit = 20): Promise<PickerFood[]> {
  if (!supabase) return [];
  const { data: meals } = await supabase
    .from('meals').select('id, logged_at')
    .order('logged_at', { ascending: false }).limit(40);
  if (!meals || meals.length === 0) return [];
  const order = new Map<string, number>(meals.map((m: any) => [m.id, new Date(m.logged_at).getTime()]));
  const { data: entries } = await supabase
    .from('meal_entries')
    .select('food_id, food_name, serving_unit, grams_logged, quantity, kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg, meal_id')
    .in('meal_id', meals.map((m: any) => m.id));
  if (!entries || entries.length === 0) return [];
  const sorted = [...entries].sort(
    (a: any, b: any) => (order.get(b.meal_id) ?? 0) - (order.get(a.meal_id) ?? 0),
  );
  const seen = new Set<string>();
  const out: PickerFood[] = [];
  for (const e of sorted as any[]) {
    const key = (e.food_name ?? '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const grams = num(e.grams_logged);
    const qty = num(e.quantity) || 1;
    const per100 = grams > 0 ? 100 / grams : 0; // entry snapshot -> per-100 basis
    const unitGrams = qty > 0 ? grams / qty : grams; // grams of one serving_unit
    out.push({
      id: e.food_id ?? null,
      name: e.food_name,
      food_category: 'other',
      base_unit: 'g',
      kcal: num(e.kcal) * per100, protein_g: num(e.protein_g) * per100,
      carb_g: num(e.carb_g) * per100, fat_g: num(e.fat_g) * per100,
      fiber_g: num(e.fiber_g) * per100, sugar_g: num(e.sugar_g) * per100,
      sat_fat_g: num(e.sat_fat_g) * per100, sodium_mg: num(e.sodium_mg) * per100,
      servings: unitGrams > 0 ? [{ label: e.serving_unit || '100 g', grams: unitGrams, is_default: true }] : [],
    });
    if (out.length >= limit) break;
  }
  return out;
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
  // Extended nutrients scale per-100 -> grams while PRESERVING null: an unknown
  // value on the food stays unknown in the snapshot (meal_entries is nullable as
  // of 0069) instead of being logged as a real 0.
  const scaleExt = (per100: number | null | undefined, round0 = false): number | null => {
    if (per100 == null) return null;
    const v = per100 * (grams / 100);
    return round0 ? r0(v) : r1(v);
  };
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
    fiber_g: scaleExt(food.fiber_g), sugar_g: scaleExt(food.sugar_g),
    sat_fat_g: scaleExt(food.sat_fat_g), sodium_mg: scaleExt(food.sodium_mg, true),
    position: count ?? 0,
  });
  return { error: error?.message };
}
