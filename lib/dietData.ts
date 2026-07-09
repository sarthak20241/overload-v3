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
  source: 'catalog' | 'off' | 'web' | 'estimate';
  assumption: string | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface ParsedMeal {
  meal_type: MealType;
  items: ParsedMealItem[];
  drona_line: string;
}

/** parse_meal outcome: either a parsed meal to log, or a decline (non-food
 *  input) carrying Drona's redirect line, or a transport/parse error. */
export type ParseMealResult =
  | { kind: 'parsed'; meal: ParsedMeal }
  | { kind: 'declined'; message: string }
  | { kind: 'error'; message: string };

/** Call the ai-coach edge function in parse_meal mode. The Clerk JWT rides on
 *  the client's fetch wrapper automatically, so a signed-out client (base anon
 *  client) would 401 — callers gate on isSignedIn before invoking. */
export async function parseMeal(
  supabase: Supa,
  args: { text: string; mealHint?: MealType | null },
): Promise<ParseMealResult> {
  const text = args.text.trim();
  if (!text) return { kind: 'error', message: 'Type what you ate first.' };

  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let data: any;
  try {
    const res = await supabase.functions.invoke('ai-coach', {
      body: {
        mode: 'parse_meal',
        text,
        local_hour: now.getHours(),
        local_date: localDate,
        ...(args.mealHint ? { meal_hint: args.mealHint } : {}),
      },
    });
    if (res.error) return { kind: 'error', message: res.error.message ?? 'Drona could not reach the kitchen. Try again.' };
    data = res.data;
  } catch (e) {
    return { kind: 'error', message: 'No connection. Type it again when you are back online.' };
  }

  if (data?.declined?.message) {
    return { kind: 'declined', message: String(data.declined.message) };
  }
  const parsed = data?.parsed;
  if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    return { kind: 'error', message: 'Drona could not read that one. Give it another shot.' };
  }
  const mealType: MealType =
    parsed.meal_type === 'breakfast' || parsed.meal_type === 'lunch' ||
    parsed.meal_type === 'dinner' || parsed.meal_type === 'snack'
      ? parsed.meal_type : 'snack';
  const items: ParsedMealItem[] = (parsed.items as any[]).map((i) => ({
    food_id: typeof i.food_id === 'string' && i.food_id ? i.food_id : null,
    food_name: String(i.food_name ?? 'Food'),
    quantity: num(i.quantity) || 1,
    serving_label: String(i.serving_label ?? 'serving'),
    grams: num(i.grams),
    kcal: num(i.kcal), protein_g: num(i.protein_g), carb_g: num(i.carb_g), fat_g: num(i.fat_g),
    fiber_g: i.fiber_g == null ? null : num(i.fiber_g),
    source: i.source === 'catalog' || i.source === 'off' || i.source === 'web' ? i.source : 'estimate',
    assumption: typeof i.assumption === 'string' && i.assumption.trim() ? i.assumption.trim() : null,
    confidence: i.confidence === 'high' || i.confidence === 'low' ? i.confidence : 'medium',
  }));
  return {
    kind: 'parsed',
    meal: { meal_type: mealType, items, drona_line: String(parsed.drona_line ?? 'Logged. Keep the protein coming.') },
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
): Promise<{ ref?: LoggedParseRef; error?: string }> {
  const { start, end } = todayRange();
  const { data: existing } = await supabase
    .from('meals').select('id').eq('meal_type', meal.meal_type)
    .gte('logged_at', start).lte('logged_at', end).limit(1);
  let mealId = (existing?.[0] as any)?.id as string | undefined;
  let createdMeal = false;
  if (!mealId) {
    const { data: created, error } = await supabase
      .from('meals').insert({ meal_type: meal.meal_type }).select('id').single();
    if (error || !created) return { error: error?.message ?? 'Could not create the meal' };
    mealId = (created as any).id;
    createdMeal = true;
  }

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
): Promise<{ error?: string }> {
  const { start, end } = todayRange();
  const { data: existing } = await supabase
    .from('meals').select('id').eq('meal_type', mealType)
    .gte('logged_at', start).lte('logged_at', end).limit(1);
  let mealId = (existing?.[0] as any)?.id as string | undefined;
  let createdMeal = false;
  if (!mealId) {
    const { data: created, error } = await supabase
      .from('meals').insert({ meal_type: mealType }).select('id').single();
    if (error || !created) return { error: error?.message ?? 'Could not create the meal' };
    mealId = (created as any).id; createdMeal = true;
  }
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
): Promise<{ error?: string }> {
  if (target === entry.meal_type) return {};
  const { start, end } = todayRange();
  const { data: existing } = await supabase
    .from('meals').select('id').eq('meal_type', target)
    .gte('logged_at', start).lte('logged_at', end).limit(1);
  let targetMealId = (existing?.[0] as any)?.id as string | undefined;
  if (!targetMealId) {
    const { data: created, error } = await supabase
      .from('meals').insert({ meal_type: target }).select('id').single();
    if (error || !created) return { error: error?.message ?? 'Could not create the meal' };
    targetMealId = (created as any).id;
  }
  const { error } = await supabase.from('meal_entries').update({ meal_id: targetMealId }).eq('id', entry.id);
  if (error) return { error: error.message };
  const { count } = await supabase
    .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', entry.meal_id);
  if ((count ?? 0) === 0) await supabase.from('meals').delete().eq('id', entry.meal_id);
  return {};
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
