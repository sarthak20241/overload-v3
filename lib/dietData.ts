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
import { FunctionRegion } from '@supabase/supabase-js';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { coachInvokeErrorMessage } from '@/lib/coachErrors';
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

// The calendar day new logs land on. Set alongside the meal target when the diet
// screen is showing a day other than today, so logging from food-search /
// food-detail / the builder writes to THAT day (same stale-param fix as _logMeal).
let _logDate: Date = new Date();
export const setLogDate = (d: Date) => { _logDate = d; };
export const getLogDate = (): Date => _logDate;

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => (v == null ? 0 : Number(v));

export interface LoggedEntry {
  id: string;
  meal_id: string;              // parent meal, for move + empty-meal cleanup
  meal_type: MealType;
  food_name: string;
  serving_unit: string;
  quantity: number;
  grams_logged: number | null;  // to rescale macros on a quantity edit
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
function dayRange(date: Date): { start: string; end: string } {
  const s = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const e = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  return { start: s.toISOString(), end: e.toISOString() };
}
/** YYYY-MM-DD in LOCAL time — the stable key the diet screen passes for a day. */
export function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** Parse a YYYY-MM-DD key back to a local Date. */
export function dateFromYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** logged_at for a NEW meal row on `date`: now() for today (keep the real time),
 *  else local noon so the row lands squarely inside dayRange(date). */
function loggedAtFor(date: Date): string {
  const now = new Date();
  if (isSameDay(date, now)) return now.toISOString();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0).toISOString();
}

/** Find the meal row of `mealType` on `date`, or create it (on the right day).
 *  Centralises the find-or-create every log path needs, and stamps a new row's
 *  logged_at so it lands on `date` rather than always today. */
async function findOrCreateMeal(
  supabase: Supa, mealType: MealType, date: Date,
): Promise<{ id?: string; created?: boolean; error?: string }> {
  const { start, end } = dayRange(date);
  const { data: existing } = await supabase
    .from('meals').select('id').eq('meal_type', mealType)
    .gte('logged_at', start).lte('logged_at', end).limit(1);
  const found = (existing?.[0] as any)?.id as string | undefined;
  if (found) return { id: found, created: false };
  const { data: created, error } = await supabase
    .from('meals').insert({ meal_type: mealType, logged_at: loggedAtFor(date) }).select('id').single();
  if (error || !created) return { error: error?.message ?? 'Could not create the meal' };
  return { id: (created as any).id, created: true };
}

/** Process-lifetime cache of TODAY's grouped entries, so opening the diary paints
 *  instantly from what the dashboard already loaded (no 5s cold re-fetch), then
 *  revalidates silently. Only today is cached (past days cold-load); keyed by user
 *  + day so it never bleeds across accounts or midnight. */
let _navCache: { key: string; byMeal: Record<MealType, LoggedEntry[]> } | null = null;

/** Grouped entries + totals for a single calendar day (dayIso = YYYY-MM-DD). */
export function useDayNutrition(dayIso: string): DayData {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const isToday = dayIso === ymd(new Date());
  const key = `${user?.id ?? 'anon'}:${dayIso}`;
  // Instant-paint cache is today-only (the dashboard preloads it); past days load fresh.
  const seed = isToday && _navCache && _navCache.key === key ? _navCache.byMeal : null;
  const [byMeal, setByMeal] = useState<Record<MealType, LoggedEntry[]>>(seed ?? emptyByMeal());
  const [loading, setLoading] = useState(!seed);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) { setLoading(false); return; }
      const cached = isToday && _navCache && _navCache.key === key;
      // Only show the loading state on a true cold load; a same-key cache means we
      // already painted real numbers, so revalidate silently (no zeros flash).
      if (!cached) setLoading(true);
      const { start, end } = dayRange(dateFromYmd(dayIso));
      const { data: meals } = await supabase
        .from('meals').select('id, meal_type')
        .gte('logged_at', start).lte('logged_at', end);
      if (cancelled) return;
      if (!meals || meals.length === 0) {
        const empty = emptyByMeal();
        if (isToday) _navCache = { key, byMeal: empty };
        setByMeal(empty); setLoading(false); return;
      }
      const typeOf = new Map<string, MealType>(meals.map((m: any) => [m.id, m.meal_type as MealType]));
      const { data: entries } = await supabase
        .from('meal_entries')
        .select('id, meal_id, food_name, quantity, serving_unit, grams_logged, kcal, protein_g, carb_g, fat_g')
        .in('meal_id', meals.map((m: any) => m.id))
        .order('position');
      if (cancelled) return;
      const grouped = emptyByMeal();
      for (const e of entries ?? []) {
        const mt = typeOf.get((e as any).meal_id) ?? 'snack';
        grouped[mt].push({
          id: (e as any).id, meal_id: (e as any).meal_id, meal_type: mt, food_name: (e as any).food_name,
          serving_unit: (e as any).serving_unit, quantity: num((e as any).quantity),
          grams_logged: (e as any).grams_logged == null ? null : num((e as any).grams_logged),
          kcal: num((e as any).kcal), protein_g: num((e as any).protein_g),
          carb_g: num((e as any).carb_g), fat_g: num((e as any).fat_g),
        });
      }
      if (isToday) _navCache = { key, byMeal: grouped };
      setByMeal(grouped);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [supabase, tick, key, dayIso, isToday]);

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

/** Today's diary — the dashboard + default diet view. Thin wrapper so existing
 *  callers don't change; ymd(new Date()) is a stable string per render. */
export function useTodayNutrition(): DayData {
  return useDayNutrition(ymd(new Date()));
}

export interface DayNutrition { dayIso: string; kcal: number; protein_g: number; carb_g: number; fat_g: number }

/** Per-day macro totals for the last `days` calendar days (oldest → newest), for
 *  the Analytics nutrition trends. Days with no log come back as zeros so the
 *  chart has a continuous x-axis. */
export async function loadNutritionHistory(supabase: Supa | null, days = 14): Promise<DayNutrition[]> {
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  // Empty per-day skeleton first, so gaps render as zeros in order.
  const out: DayNutrition[] = [];
  const idx = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
    const iso = ymd(d);
    idx.set(iso, out.length);
    out.push({ dayIso: iso, kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 });
  }
  if (!supabase) return out;
  const { start } = dayRange(startDate);
  const { end } = dayRange(today);
  const { data: meals } = await supabase
    .from('meals').select('id, logged_at')
    .gte('logged_at', start).lte('logged_at', end);
  if (!meals || meals.length === 0) return out;
  const mealDay = new Map<string, string>();
  for (const m of meals as any[]) mealDay.set(m.id, ymd(new Date(m.logged_at)));
  const { data: entries } = await supabase
    .from('meal_entries').select('meal_id, kcal, protein_g, carb_g, fat_g')
    .in('meal_id', (meals as any[]).map((m) => m.id));
  for (const e of (entries ?? []) as any[]) {
    const iso = mealDay.get(e.meal_id);
    const i = iso == null ? undefined : idx.get(iso);
    if (i == null) continue;
    out[i].kcal += num(e.kcal); out[i].protein_g += num(e.protein_g);
    out[i].carb_g += num(e.carb_g); out[i].fat_g += num(e.fat_g);
  }
  return out;
}

/** Consecutive days (ending today) on which the user logged at least one meal.
 *  Today not-yet-logged does NOT break the streak (mirrors the workout streak):
 *  we start the count from yesterday in that case. Derived from meals.logged_at,
 *  grouped by the user's LOCAL calendar day. */
export async function nutritionStreak(supabase: Supa | null): Promise<number> {
  if (!supabase) return 0;
  // 1000 rows of just logged_at is a tiny payload and, at ≤4 meals/day, covers a
  // ~250-day streak — well beyond any realistic run before it would undercount.
  const { data } = await supabase
    .from('meals').select('logged_at')
    .order('logged_at', { ascending: false })
    .limit(1000);
  if (!data || data.length === 0) return 0;
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const logged = new Set<string>();
  for (const m of data as { logged_at: string }[]) logged.add(key(new Date(m.logged_at)));

  const cursor = new Date();
  if (!logged.has(key(cursor))) cursor.setDate(cursor.getDate() - 1); // today unlogged: don't break it
  let streak = 0;
  while (logged.has(key(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** Reactive nutrition streak for the day header. Reloads whenever the caller's
 *  `dep` changes (pass the day totals so a first-log-of-today bumps it) + on focus. */
export function useNutritionStreak(dep?: unknown): number {
  const supabase = useSupabaseClient();
  const [streak, setStreak] = useState(0);
  const load = useCallback(() => {
    if (supabase) nutritionStreak(supabase).then(setStreak).catch(() => {});
  }, [supabase]);
  useEffect(() => { load(); }, [load, dep]);
  // Skip the first focus — mount's effect already loaded — so we don't double-query.
  const firstFocus = useRef(true);
  useFocusEffect(useCallback(() => {
    if (firstFocus.current) { firstFocus.current = false; return; }
    load();
  }, [load]));
  return streak;
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

/** Per-100-base-unit macros, the basis every catalog line is scaled from. */
export interface Per100Macros {
  kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number;
}

/** Everything the parsed-item editor needs for one food: its real serving
 *  options and per-100 macros, so switching "1 regular/large" to "1 small"
 *  recomputes the line locally with the SAME basis the parser used. Fetched on
 *  demand (only when a user actually taps a line to edit), so the parse
 *  response stays lean. Returns null for estimate/web lines (food_id null),
 *  where the editor falls back to free-form grams + macros. */
export async function loadFoodForEdit(
  supabase: Supa | null,
  foodId: string | null,
): Promise<{ servings: FoodServing[]; per100: Per100Macros; baseUnit: string } | null> {
  if (!foodId || !supabase) return null;
  const [foodRes, servRes] = await Promise.all([
    supabase.from('foods')
      .select('base_unit, kcal, protein_g, carb_g, fat_g, fiber_g')
      .eq('id', foodId).maybeSingle(),
    supabase.from('food_servings')
      .select('label, grams, is_default, seq').eq('food_id', foodId).order('seq'),
  ]);
  const f: any = foodRes.data;
  if (!f) return null;
  const baseUnit = String(f.base_unit ?? 'g');
  const servings: FoodServing[] = (servRes.data ?? []).map((s: any) => ({
    label: s.label, grams: num(s.grams), is_default: !!s.is_default,
  }));
  if (!servings.some((s) => s.grams === 100)) {
    servings.push({ label: `100 ${baseUnit}`, grams: 100, is_default: servings.length === 0 });
  }
  return {
    servings,
    per100: {
      kcal: num(f.kcal), protein_g: num(f.protein_g),
      carb_g: num(f.carb_g), fat_g: num(f.fat_g), fiber_g: num(f.fiber_g),
    },
    baseUnit,
  };
}

// ── AI food logging (Drona parse) ───────────────────────────────────────────
// The nutrition bar's free text ("2 roti and dal") is parsed by the ai-coach
// edge function's parse_meal mode, which resolves each item against the catalog
// and returns FINAL per-line macros. The client just calls it, then writes the
// returned entries straight to meal_entries with logged_via='ai' — no re-derive.

/** One resolved food line from the parser. Macros are the totals for this line
 *  (already scaled to grams), not per-100. Mirrors the edge ParsedItem. */
export interface ParsedMealItem {
  food_id: string | null;
  food_name: string;
  quantity: number;
  serving_label: string;
  grams: number;
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null;
  // 'manual' = the user corrected this line in the review card before adding
  // it, so the numbers are theirs and nothing should recompute over them.
  source: 'catalog' | 'off' | 'web' | 'estimate' | 'manual';
  assumption: string | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface ParsedMeal {
  meal_type: MealType;
  items: ParsedMealItem[];
  drona_line: string;
  /** These items are a corrected version of the meal that was on screen and
   *  REPLACE it. When false/absent they are new food, so a caller showing a
   *  pending meal appends them instead of throwing the old lines away. */
  corrects_previous?: boolean;
}

/** parse_meal outcome: either a parsed meal to log, or a decline (non-food
 *  input) carrying Drona's redirect line, or a transport/parse error. */
export type ParseMealResult =
  | { kind: 'parsed'; meal: ParsedMeal }
  // `proposal` carries researched numbers that materially disagree with what is
  // on screen (usually a different product variant). The user chooses; applying
  // is local, so it costs nothing.
  | { kind: 'declined'; message: string; proposal?: { items: ParsedMealItem[]; note: string } | null }
  | { kind: 'error'; message: string };

/** One raw item from the edge function -> a ParsedMealItem. Shared by the
 *  parsed path and the researched-proposal path so both stay in step. */
function toParsedItem(i: any): ParsedMealItem {
  return {
    food_id: typeof i.food_id === 'string' && i.food_id ? i.food_id : null,
    food_name: String(i.food_name ?? 'Food'),
    quantity: num(i.quantity) || 1,
    serving_label: String(i.serving_label ?? 'serving'),
    grams: num(i.grams),
    kcal: num(i.kcal), protein_g: num(i.protein_g), carb_g: num(i.carb_g), fat_g: num(i.fat_g),
    fiber_g: i.fiber_g == null ? null : num(i.fiber_g),
    source: i.source === 'catalog' || i.source === 'off' || i.source === 'web' || i.source === 'manual' ? i.source : 'estimate',
    assumption: typeof i.assumption === 'string' && i.assumption.trim() ? i.assumption.trim() : null,
    confidence: i.confidence === 'high' || i.confidence === 'low' ? i.confidence : 'medium',
  };
}

/** Call the ai-coach edge function in parse_meal mode. The Clerk JWT rides on
 *  the client's fetch wrapper automatically, so a signed-out client (base anon
 *  client) would 401 — callers gate on isSignedIn before invoking. */
export async function parseMeal(
  supabase: Supa,
  args: {
    text: string;
    mealHint?: MealType | null;
    /** The still-unlogged parse on screen, if any. Sending it lets a follow-up
     *  ("make it a small one", "actually 2") correct that meal instead of being
     *  read as a brand new one. The server resolves a pure serving/quantity
     *  change without a second model call, so refining is cheaper than parsing. */
    previous?: { text: string; items: ParsedMealItem[] } | null;
    /** Recent turns of this logging conversation, oldest first. Lets a bare
     *  "yes" answer whatever Drona just offered. */
    turns?: { role: 'user' | 'drona'; text: string }[];
  },
): Promise<ParseMealResult> {
  const text = args.text.trim();
  if (!text) return { kind: 'error', message: 'Type what you ate first.' };

  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let data: any;
  try {
    const res = await supabase.functions.invoke('ai-coach', {
      // Pin execution to us-east-1 (the DB + Anthropic region). By default the
      // function runs nearest the USER (ap-south-1 for India), so every DB query
      // and both model calls cross India->US; co-locating removes that on the
      // many internal round trips, at the cost of one cross-ocean user hop.
      // Measured: pre_parse 1.3s -> 0.34s, total ~8s -> ~5s for a 2-item meal.
      region: FunctionRegion.UsEast1,
      body: {
        mode: 'parse_meal',
        text,
        local_hour: now.getHours(),
        local_date: localDate,
        ...(args.mealHint ? { meal_hint: args.mealHint } : {}),
        ...(args.turns && args.turns.length > 0
          ? { recent_turns: args.turns.slice(-4).map((t) => ({ role: t.role, text: t.text.slice(0, 240) })) }
          : {}),
        ...(args.previous && args.previous.items.length > 0
          ? {
            previous_text: args.previous.text,
            // Only what the server needs to re-target a line: identity, the
            // amount, and where the numbers came from. Macros stay server-side.
            // Macros ride along so the server can hand an UNTOUCHED line back
            // verbatim: a correction replaces the whole meal, so anything it
            // cannot reconstruct would be silently dropped.
            previous_items: args.previous.items.slice(0, 12).map((it) => ({
              food_id: it.food_id,
              food_name: it.food_name,
              quantity: it.quantity,
              serving_label: it.serving_label,
              grams: it.grams,
              kcal: it.kcal,
              protein_g: it.protein_g,
              carb_g: it.carb_g,
              fat_g: it.fat_g,
              fiber_g: it.fiber_g,
              source: it.source,
              assumption: it.assumption,
              confidence: it.confidence,
            })),
          }
          : {}),
      },
    });
    // Never hand the raw edge-function error to the card — it carries HTTP
    // statuses and provider error bodies. The helper pulls the real reason off
    // error.context for the log and returns user-safe copy.
    if (res.error) return { kind: 'error', message: await coachInvokeErrorMessage(res.error) };
    data = res.data;
  } catch (e) {
    return { kind: 'error', message: 'No connection. Type it again when you are back online.' };
  }

  if (data?.declined?.message) {
    const p = data?.proposal;
    const proposal = p && Array.isArray(p.items) && p.items.length > 0
      ? { items: (p.items as any[]).map(toParsedItem), note: String(p.note ?? 'Use these numbers') }
      : null;
    return { kind: 'declined', message: String(data.declined.message), proposal };
  }
  const parsed = data?.parsed;
  if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    return { kind: 'error', message: 'Drona could not read that one. Give it another shot.' };
  }
  const mealType: MealType =
    parsed.meal_type === 'breakfast' || parsed.meal_type === 'lunch' ||
    parsed.meal_type === 'dinner' || parsed.meal_type === 'snack'
      ? parsed.meal_type : 'snack';
  const items: ParsedMealItem[] = (parsed.items as any[]).map(toParsedItem);
  return {
    kind: 'parsed',
    meal: {
      meal_type: mealType,
      items,
      drona_line: String(parsed.drona_line ?? 'Logged. Keep the protein coming.'),
      corrects_previous: parsed.corrects_previous === true,
    },
  };
}

/** The result of writing a parsed meal — carries the ids needed to Undo. */
export interface LoggedParseRef {
  mealId: string;
  entryIds: string[];
  createdMeal: boolean; // true if we created the meal row (so Undo can remove it)
}

/** Write a parsed meal to today's log: find-or-create the meal of parsed.meal_type,
 *  then batch-insert each item as a meal_entry with the parser's FINAL macros and
 *  logged_via='ai'. Returns ids for Undo, or { error }. */
export async function logParsedMeal(
  supabase: Supa,
  meal: ParsedMeal,
  date: Date = getLogDate(),
): Promise<{ ref?: LoggedParseRef; error?: string }> {
  const m = await findOrCreateMeal(supabase, meal.meal_type, date);
  if (m.error || !m.id) return { error: m.error ?? 'Could not create the meal' };
  const mealId = m.id;
  const createdMeal = !!m.created;

  const { count } = await supabase
    .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', mealId);
  const base = count ?? 0;

  const rows = meal.items.map((it, idx) => ({
    meal_id: mealId,
    food_id: it.food_id,
    food_name: it.food_name,
    quantity: it.quantity,
    serving_unit: it.serving_label,
    grams_logged: r1(it.grams),
    kcal: r0(it.kcal), protein_g: r1(it.protein_g), carb_g: r1(it.carb_g), fat_g: r1(it.fat_g),
    // The parser returns fiber per line; sugar/sat_fat/sodium aren't parsed, so
    // they stay null (meal_entries snapshot columns are nullable as of 0069).
    fiber_g: it.fiber_g == null ? null : r1(it.fiber_g),
    sugar_g: null, sat_fat_g: null, sodium_mg: null,
    position: base + idx,
    logged_via: 'ai',
    // Where the macros came from (catalog / off / web / estimate) so the diary can
    // later tell a real label/web hit from a pure estimate (migration 0076).
    source: it.source,
  }));

  const { data: inserted, error } = await supabase
    .from('meal_entries').insert(rows).select('id');
  if (error) {
    // If we created an empty meal and the entries failed, don't leave the
    // orphan meal behind.
    if (createdMeal) await supabase.from('meals').delete().eq('id', mealId);
    return { error: error.message };
  }
  const entryIds = (inserted ?? []).map((r: any) => String(r.id));
  return { ref: { mealId: mealId!, entryIds, createdMeal } };
}

/** Undo an AI-logged meal: delete the inserted entries, and the meal too if we
 *  created it for this log and it is now empty. Best-effort. */
export async function undoParsedMeal(supabase: Supa, ref: LoggedParseRef): Promise<void> {
  if (ref.entryIds.length > 0) {
    await supabase.from('meal_entries').delete().in('id', ref.entryIds);
  }
  if (ref.createdMeal) {
    const { count } = await supabase
      .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', ref.mealId);
    if ((count ?? 0) === 0) await supabase.from('meals').delete().eq('id', ref.mealId);
  }
}

// ── Daily targets (the lifter framing: protein ring + calorie band) ─────────
// Stored as nullable columns on user_profiles; the ai-coach parse_meal fn reads
// them too. When unset we fall back to DEFAULT_TARGETS per-field so the ring
// always has a goal to draw against.
export interface NutritionTargets { kcal: number; protein: number; carb: number; fat: number }
export const DEFAULT_TARGETS: NutritionTargets = { kcal: 2000, protein: 125, carb: 250, fat: 56 };

/** Read the user's daily targets. isCustom = they've set at least one real goal
 *  (vs pure defaults), so the UI can nudge first-timers to set theirs. */
export function useNutritionTargets(): {
  targets: NutritionTargets; isCustom: boolean; reload: () => void;
  apply: (t: NutritionTargets) => void;
} {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const clerkId = user?.id ?? null;
  const [targets, setTargets] = useState<NutritionTargets>(DEFAULT_TARGETS);
  const [isCustom, setIsCustom] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // Optimistic update so the ring/pill reflect a saved goal instantly, without
  // waiting out read-after-write lag on the refetch.
  const apply = useCallback((t: NutritionTargets) => { setTargets(t); setIsCustom(true); }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) return;
      const cols = 'daily_calorie_target, protein_target_g, carb_target_g, fat_target_g';
      const { data } = clerkId
        ? await supabase.from('user_profiles').select(cols).eq('clerk_user_id', clerkId).maybeSingle()
        : await supabase.from('user_profiles').select(cols).limit(1).maybeSingle();
      if (cancelled || !data) return;
      const d = data as Record<string, unknown>;
      const pick = (v: unknown, def: number) => (v == null ? def : Number(v));
      setTargets({
        kcal: pick(d.daily_calorie_target, DEFAULT_TARGETS.kcal),
        protein: pick(d.protein_target_g, DEFAULT_TARGETS.protein),
        carb: pick(d.carb_target_g, DEFAULT_TARGETS.carb),
        fat: pick(d.fat_target_g, DEFAULT_TARGETS.fat),
      });
      setIsCustom(
        d.daily_calorie_target != null || d.protein_target_g != null ||
        d.carb_target_g != null || d.fat_target_g != null,
      );
    })();
    return () => { cancelled = true; };
  }, [supabase, clerkId, tick]);

  // Refetch when a consuming screen regains focus, so the dashboard FUEL card
  // reflects a goal set on the nutrition screen the moment the user returns.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) { firstFocus.current = false; return; }
      reload();
    }, [reload]),
  );

  return { targets, isCustom, reload, apply };
}

/** Persist daily targets to user_profiles (upsert on clerk_user_id, like the
 *  profile screen). Pass the Clerk id from useClerkUser().user?.id. */
export async function saveNutritionTargets(
  supabase: Supa,
  clerkId: string,
  t: NutritionTargets,
): Promise<{ error?: string }> {
  const { error } = await supabase.from('user_profiles').upsert({
    clerk_user_id: clerkId,
    daily_calorie_target: t.kcal,
    protein_target_g: t.protein,
    carb_target_g: t.carb,
    fat_target_g: t.fat,
  }, { onConflict: 'clerk_user_id' });
  return error ? { error: error.message } : {};
}

// ── Saved meals + recipes (P3: create once, re-log in one tap) ──────────────
// A 'meal' is a named bundle of foods (logging expands to one meal_entry each);
// a 'recipe' is a batch you portion out (logging inserts a single per-serving
// entry named after the recipe). Cached macros are the WHOLE-batch totals, so
// per-serving = totals / servings for both (meal servings = 1).

export interface SavedMealItem {
  food_id: string | null;
  food_name: string;
  quantity: number;
  serving_unit: string;
  grams_logged: number | null;
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null;
}
export interface SavedMeal {
  id: string;
  name: string;
  kind: 'meal' | 'recipe';
  servings: number;
  serving_label: string | null;
  kcal: number; protein_g: number; carb_g: number; fat_g: number; // whole-batch totals
  items: SavedMealItem[];
  created_at: string;
}

/** Create a saved meal/recipe from parsed items. Header caches the summed
 *  whole-batch macros; items copy the parse snapshot. */
export async function createSavedMeal(
  supabase: Supa,
  args: { name: string; kind: 'meal' | 'recipe'; servings: number; serving_label: string | null; items: ParsedMealItem[] },
): Promise<{ id?: string; error?: string }> {
  const items = args.items;
  if (items.length === 0) return { error: 'Nothing to save' };
  const sum = items.reduce(
    (a, it) => ({
      kcal: a.kcal + num(it.kcal), protein: a.protein + num(it.protein_g),
      carb: a.carb + num(it.carb_g), fat: a.fat + num(it.fat_g),
    }),
    { kcal: 0, protein: 0, carb: 0, fat: 0 },
  );
  const { data: created, error } = await supabase.from('saved_meals').insert({
    name: args.name.trim().slice(0, 80) || 'Saved meal',
    kind: args.kind,
    servings: Math.max(num(args.servings) || 1, 0.5),
    serving_label: args.kind === 'recipe' ? (args.serving_label?.trim().slice(0, 40) || 'serving') : null,
    kcal: r0(sum.kcal), protein_g: r1(sum.protein), carb_g: r1(sum.carb), fat_g: r1(sum.fat),
  }).select('id').single();
  if (error || !created) return { error: error?.message ?? 'Could not save' };
  const savedId = (created as any).id as string;

  const rows = items.map((it, i) => ({
    saved_meal_id: savedId,
    food_id: it.food_id,
    food_name: it.food_name,
    quantity: num(it.quantity) || 1,
    serving_unit: it.serving_label,
    grams_logged: it.grams == null ? null : r1(num(it.grams)),
    kcal: r0(num(it.kcal)), protein_g: r1(num(it.protein_g)), carb_g: r1(num(it.carb_g)), fat_g: r1(num(it.fat_g)),
    fiber_g: it.fiber_g == null ? null : r1(num(it.fiber_g)),
    position: i,
  }));
  const { error: itemsErr } = await supabase.from('saved_meal_items').insert(rows);
  if (itemsErr) {
    await supabase.from('saved_meals').delete().eq('id', savedId); // no orphan header
    return { error: itemsErr.message };
  }
  return { id: savedId };
}

/** All of the user's saved meals + recipes, newest first, with their items. */
export async function listSavedMeals(supabase: Supa): Promise<SavedMeal[]> {
  const { data: heads, error } = await supabase
    .from('saved_meals')
    .select('id, name, kind, servings, serving_label, kcal, protein_g, carb_g, fat_g, created_at')
    .order('created_at', { ascending: false });
  if (error || !heads || heads.length === 0) return [];
  const ids = (heads as any[]).map((h) => h.id);
  const { data: items } = await supabase
    .from('saved_meal_items')
    .select('saved_meal_id, food_id, food_name, quantity, serving_unit, grams_logged, kcal, protein_g, carb_g, fat_g, fiber_g')
    .in('saved_meal_id', ids)
    .order('position');
  const byMeal = new Map<string, SavedMealItem[]>();
  for (const it of (items ?? []) as any[]) {
    const arr = byMeal.get(it.saved_meal_id) ?? [];
    arr.push({
      food_id: it.food_id ?? null, food_name: it.food_name, quantity: num(it.quantity),
      serving_unit: it.serving_unit, grams_logged: it.grams_logged == null ? null : num(it.grams_logged),
      kcal: num(it.kcal), protein_g: num(it.protein_g), carb_g: num(it.carb_g), fat_g: num(it.fat_g),
      fiber_g: it.fiber_g == null ? null : num(it.fiber_g),
    });
    byMeal.set(it.saved_meal_id, arr);
  }
  return (heads as any[]).map((h) => ({
    id: h.id, name: h.name, kind: h.kind, servings: num(h.servings), serving_label: h.serving_label ?? null,
    kcal: num(h.kcal), protein_g: num(h.protein_g), carb_g: num(h.carb_g), fat_g: num(h.fat_g),
    items: byMeal.get(h.id) ?? [], created_at: h.created_at,
  }));
}

/** Log a saved meal/recipe into today's meal of `mealType`. A MEAL expands its
 *  items (scaled by `servings`, default 1×); a RECIPE inserts one entry with
 *  per-serving macros times `servings` eaten. */
export async function logSavedMeal(
  supabase: Supa,
  saved: SavedMeal,
  mealType: MealType,
  servings = 1,
  date: Date = getLogDate(),
): Promise<{ error?: string }> {
  const m = await findOrCreateMeal(supabase, mealType, date);
  if (m.error || !m.id) return { error: m.error ?? 'Could not create the meal' };
  const mealId = m.id;
  const createdMeal = !!m.created;
  const { count } = await supabase
    .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', mealId);
  const base = count ?? 0;

  let rows: Record<string, unknown>[];
  if (saved.kind === 'recipe') {
    // Fraction of the whole batch eaten = servings / recipe yield.
    const f = saved.servings > 0 ? servings / saved.servings : servings;
    rows = [{
      meal_id: mealId, food_id: null, food_name: saved.name,
      quantity: servings, serving_unit: saved.serving_label ?? 'serving', grams_logged: null,
      kcal: r0(saved.kcal * f), protein_g: r1(saved.protein_g * f), carb_g: r1(saved.carb_g * f), fat_g: r1(saved.fat_g * f),
      fiber_g: null, sugar_g: null, sat_fat_g: null, sodium_mg: null,
      position: base, logged_via: 'manual',
    }];
  } else {
    rows = saved.items.map((it, i) => ({
      meal_id: mealId, food_id: it.food_id, food_name: it.food_name,
      quantity: r1(it.quantity * servings), serving_unit: it.serving_unit,
      grams_logged: it.grams_logged == null ? null : r1(it.grams_logged * servings),
      kcal: r0(it.kcal * servings), protein_g: r1(it.protein_g * servings), carb_g: r1(it.carb_g * servings), fat_g: r1(it.fat_g * servings),
      fiber_g: it.fiber_g == null ? null : r1(it.fiber_g * servings), sugar_g: null, sat_fat_g: null, sodium_mg: null,
      position: base + i, logged_via: 'manual',
    }));
  }
  const { error } = await supabase.from('meal_entries').insert(rows);
  if (error) {
    if (createdMeal) await supabase.from('meals').delete().eq('id', mealId);
    return { error: error.message };
  }
  return {};
}

/** Update a saved meal in place: rename + replace its items (whole-batch macros
 *  recomputed from the new items). Items are a small list, so we replace them
 *  wholesale rather than diffing. */
export async function updateSavedMeal(
  supabase: Supa,
  id: string,
  args: { name: string; items: ParsedMealItem[] },
): Promise<{ error?: string }> {
  const items = args.items;
  if (items.length === 0) return { error: 'Nothing to save' };
  const sum = items.reduce(
    (a, it) => ({
      kcal: a.kcal + num(it.kcal), protein: a.protein + num(it.protein_g),
      carb: a.carb + num(it.carb_g), fat: a.fat + num(it.fat_g),
    }),
    { kcal: 0, protein: 0, carb: 0, fat: 0 },
  );
  const { error: headErr } = await supabase.from('saved_meals').update({
    name: args.name.trim().slice(0, 80) || 'Saved meal',
    kcal: r0(sum.kcal), protein_g: r1(sum.protein), carb_g: r1(sum.carb), fat_g: r1(sum.fat),
  }).eq('id', id);
  if (headErr) return { error: headErr.message };
  const { error: delErr } = await supabase.from('saved_meal_items').delete().eq('saved_meal_id', id);
  if (delErr) return { error: delErr.message };
  const rows = items.map((it, i) => ({
    saved_meal_id: id,
    food_id: it.food_id,
    food_name: it.food_name,
    quantity: num(it.quantity) || 1,
    serving_unit: it.serving_label,
    grams_logged: it.grams == null ? null : r1(num(it.grams)),
    kcal: r0(num(it.kcal)), protein_g: r1(num(it.protein_g)), carb_g: r1(num(it.carb_g)), fat_g: r1(num(it.fat_g)),
    fiber_g: it.fiber_g == null ? null : r1(num(it.fiber_g)),
    position: i,
  }));
  const { error: insErr } = await supabase.from('saved_meal_items').insert(rows);
  if (insErr) return { error: insErr.message };
  return {};
}

/** Delete a saved meal/recipe (its items cascade). */
export async function deleteSavedMeal(supabase: Supa, id: string): Promise<{ error?: string }> {
  const { error } = await supabase.from('saved_meals').delete().eq('id', id);
  return error ? { error: error.message } : {};
}

// ── Editing logged entries (P2 fix-it affordances) ──────────────────────────

/** Delete a logged entry. If its parent meal is now empty, delete the meal too
 *  (so an emptied section collapses back to its "Add" prompt). Best-effort. */
export async function deleteMealEntry(
  supabase: Supa,
  entry: { id: string; meal_id: string },
): Promise<{ error?: string }> {
  const { error } = await supabase.from('meal_entries').delete().eq('id', entry.id);
  if (error) return { error: error.message };
  const { count } = await supabase
    .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', entry.meal_id);
  if ((count ?? 0) === 0) await supabase.from('meals').delete().eq('id', entry.meal_id);
  return {};
}

/** Rescale a logged entry to a new quantity, scaling grams + the macro snapshot
 *  linearly from the current values (macros are linear in amount). Clamps to a
 *  sane range so a fat-fingered stepper can't write absurd rows. */
export async function updateEntryQuantity(
  supabase: Supa,
  entry: LoggedEntry,
  newQuantity: number,
): Promise<{ error?: string }> {
  const q1 = Math.min(Math.max(newQuantity, 0.25), 50);
  const q0 = entry.quantity > 0 ? entry.quantity : 1;
  const f = q1 / q0;
  const patch: Record<string, number> = {
    quantity: q1,
    kcal: r0(entry.kcal * f),
    protein_g: r1(entry.protein_g * f),
    carb_g: r1(entry.carb_g * f),
    fat_g: r1(entry.fat_g * f),
  };
  if (entry.grams_logged != null) patch.grams_logged = r1(entry.grams_logged * f);
  const { error } = await supabase.from('meal_entries').update(patch).eq('id', entry.id);
  return error ? { error: error.message } : {};
}

/** Move an entry to a different meal section for today: find-or-create the target
 *  meal, reassign the entry, and delete the source meal if it empties. No-op when
 *  the entry is already in the target section. */
export async function moveEntry(
  supabase: Supa,
  entry: LoggedEntry,
  target: MealType,
  date: Date = getLogDate(),
): Promise<{ error?: string }> {
  if (target === entry.meal_type) return {};
  const m = await findOrCreateMeal(supabase, target, date);
  if (m.error || !m.id) return { error: m.error ?? 'Could not create the meal' };
  const targetMealId = m.id;
  const { error } = await supabase.from('meal_entries').update({ meal_id: targetMealId }).eq('id', entry.id);
  if (error) return { error: error.message };
  const { count } = await supabase
    .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', entry.meal_id);
  if ((count ?? 0) === 0) await supabase.from('meals').delete().eq('id', entry.meal_id);
  return {};
}

/** Log a food to the day's meal of `mealType` (find-or-create the meal, insert the
 *  entry with the macro snapshot). Targets getLogDate() so a food logged while
 *  viewing a past day lands on that day. Returns { error } on failure. */
export async function logFood(
  supabase: Supa,
  args: { mealType: MealType; food: PickerFood; servingLabel: string; quantity: number; date?: Date },
): Promise<{ error?: string }> {
  const { mealType, food, servingLabel, quantity } = args;
  const m = await findOrCreateMeal(supabase, mealType, args.date ?? getLogDate());
  if (m.error || !m.id) return { error: m.error ?? 'Could not create the meal' };
  const mealId = m.id;

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
