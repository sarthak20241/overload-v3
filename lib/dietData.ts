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
import { fetch as expoFetch } from 'expo/fetch';
import { useSupabaseClient, getSupabaseAccessToken } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { coachInvokeErrorMessage, coachInvokeCapSignal } from '@/lib/coachErrors';
import { isMeasurementUnit } from '@/lib/units';
import { hydrateCache, readCache, writeCache } from '@/lib/localCache';
import { track } from '@/lib/analytics';
import { normalizeFuelDays, targetsOnDow, type FuelDay } from '@/lib/fuelDays';
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
  /** The day `byMeal`/`totals` actually describe. Lags `dayIso` by a render on a
   *  day switch (state carries the previous day until the refetch lands), so
   *  callers that mirror totals elsewhere must key off THIS, not their own iso. */
  totalsDayIso: string;
  loading: boolean;
  /** The day whose last fetch FAILED, or null. A failed fetch keeps the old
   *  day's numbers in state and never stamps totalsDayIso, so a screen that
   *  waits for totalsDayIso to catch up would wait forever: this is how it
   *  tells "still loading" from "gave up". Cleared by the next success. */
  failedDayIso: string | null;
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
interface DayCache { key: string; byMeal: Record<MealType, LoggedEntry[]> }
let _navCache: DayCache | null = null;

/** Session memory of PAST days, keyed `${userId}:${dayIso}`. Filled by the
 *  week prefetch and by every past-day load, so switching to a day you have
 *  seen (or that the prefetch loaded) paints at once and then revalidates.
 *  Today never lives here: it keeps its own cache and its own first-in-line
 *  fetch, so nothing in here can slow today down. Memory only, cleared with
 *  the process; keyed by user so an account switch cannot read another's. */
const _dayCache = new Map<string, Record<MealType, LoggedEntry[]>>();

type DayRangeResult = { ok: true; byDay: Map<string, Record<MealType, LoggedEntry[]>> } | { ok: false };

/**
 * Every day in [first, last] (local calendar days), grouped by meal, in ONE
 * request: meals with their entries embedded. The day load used to be two
 * round trips in a row (meals, then their entries), about 0.4 s each measured
 * on the simulator against the US database. Days with nothing logged come back
 * as empty, so an empty day is a known answer too, not a miss.
 */
async function fetchDayRange(supabase: Supa, first: Date, last: Date): Promise<DayRangeResult> {
  const { start } = dayRange(first);
  const { end } = dayRange(last);
  const { data, error } = await supabase
    .from('meals')
    .select('id, meal_type, logged_at, meal_entries(id, meal_id, food_name, quantity, serving_unit, grams_logged, kcal, protein_g, carb_g, fat_g, position)')
    .gte('logged_at', start).lte('logged_at', end);
  // A failed query is NOT "nothing logged": the caller keeps what it has.
  if (error || !data) return { ok: false };

  const byDay = new Map<string, Record<MealType, LoggedEntry[]>>();
  for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate()); d <= last; d.setDate(d.getDate() + 1)) {
    byDay.set(ymd(d), emptyByMeal());
  }
  // Collected per day first, then ordered by position across the whole day:
  // the two-query version ordered every entry of the day by position in one
  // list, and the diary should not reshuffle because the query changed.
  const rows = new Map<string, { mt: MealType; e: any }[]>();
  for (const m of data as any[]) {
    const iso = ymd(new Date(m.logged_at));
    if (!byDay.has(iso)) continue;
    const mt = (m.meal_type as MealType) ?? 'snack';
    for (const e of (m.meal_entries ?? []) as any[]) {
      if (!rows.has(iso)) rows.set(iso, []);
      rows.get(iso)!.push({ mt, e });
    }
  }
  for (const [iso, list] of rows) {
    const grouped = byDay.get(iso)!;
    list.sort((a, b) => num(a.e.position) - num(b.e.position));
    for (const { mt, e } of list) {
      grouped[mt].push({
        id: e.id, meal_id: e.meal_id, meal_type: mt, food_name: e.food_name,
        serving_unit: e.serving_unit, quantity: num(e.quantity),
        grams_logged: e.grams_logged == null ? null : num(e.grams_logged),
        kcal: num(e.kcal), protein_g: num(e.protein_g),
        carb_g: num(e.carb_g), fat_g: num(e.fat_g),
      });
    }
  }
  return { ok: true, byDay };
}

/** Grouped entries + totals for a single calendar day (dayIso = YYYY-MM-DD). */
export function useDayNutrition(dayIso: string): DayData {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const isToday = dayIso === ymd(new Date());
  const key = `${user?.id ?? 'anon'}:${dayIso}`;
  // Instant-paint cache is today-only (the dashboard preloads it); past days load fresh.
  // In-memory nav cache first, then the on-disk read cache, so a cold start
  // paints today's real totals instead of an empty ring that fills in later.
  const diskSeed = isToday ? readCache<DayCache>('dayNutrition', user?.id) : null;
  const seed = isToday
    ? (_navCache && _navCache.key === key ? _navCache.byMeal : diskSeed && diskSeed.key === key ? diskSeed.byMeal : null)
    : _dayCache.get(key) ?? null;
  const [byMeal, setByMeal] = useState<Record<MealType, LoggedEntry[]>>(seed ?? emptyByMeal());
  // The day `byMeal` belongs to. Seeded state is today's; every setByMeal below
  // is followed by stamping the day it was fetched for. With no seed, the empty
  // byMeal belongs to NO day yet: '' can never equal a real iso, so a screen
  // waiting for this to catch up keeps waiting (or shows the failure) instead
  // of reading an empty first render as "you logged nothing".
  const [totalsDayIso, setTotalsDayIso] = useState<string>(seed ? dayIso : '');
  const [loading, setLoading] = useState(!seed);
  const [failedDayIso, setFailedDayIso] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Every byMeal write goes through here so totalsDayIso can never drift from it.
  const setByMealForDay = useCallback((next: Record<MealType, LoggedEntry[]>, forDay: string) => {
    setByMeal(next);
    setTotalsDayIso(forDay);
    setFailedDayIso(null);
  }, []);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const fail = () => { if (!cancelled) { setFailedDayIso(dayIso); setLoading(false); } };
    // A new attempt is under way, so a failure from the LAST attempt is no
    // longer the news: Retry shows the loader, not the error, while it runs.
    setFailedDayIso(null);
    (async () => {
      if (isToday) {
        // Hydration may not have finished by first render; re-seed once it has.
        await hydrateCache(user?.id);
        if (cancelled) return;
        const disk = readCache<DayCache>('dayNutrition', user?.id);
        // Key-aware on BOTH sides: _navCache is a module global that survives an
        // account switch, so `!_navCache` alone would let a previous user's
        // entry block this user's disk restore.
        if (disk && disk.key === key && (!_navCache || _navCache.key !== key)) {
          _navCache = disk;
          setByMealForDay(disk.byMeal, dayIso);
          setLoading(false);
        }
      }
      if (!supabase) { fail(); return; }
      // A day already in memory (today's cache, or a past day this session)
      // painted real numbers at mount, so revalidate silently: no loader.
      const cached = isToday ? !!_navCache && _navCache.key === key : _dayCache.has(key);
      if (cached && !isToday) setByMealForDay(_dayCache.get(key)!, dayIso);
      if (!cached) setLoading(true);
      const day = dateFromYmd(dayIso);
      const res = await fetchDayRange(supabase, day, day);
      if (cancelled) return;
      // A FAILED query must not blank the day or be cached as "nothing logged":
      // an offline blip would keep painting an empty ring after the network
      // came back. Keep what we have and stop.
      if (!res.ok) { fail(); return; }
      const grouped = res.byDay.get(dayIso) ?? emptyByMeal();
      if (isToday) {
        _navCache = { key, byMeal: grouped };
        writeCache<DayCache>('dayNutrition', user?.id, _navCache);
      } else {
        _dayCache.set(key, grouped);
      }
      setByMealForDay(grouped, dayIso);
      setLoading(false);
    })().catch(fail);
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

  // On a switch to a past day already in memory, state still holds the day we
  // came from until the effect runs. Answer from memory in THIS render, so the
  // screen goes straight from the old day to the new one with no loader frame.
  const fromMemory = !isToday && totalsDayIso !== dayIso ? _dayCache.get(key) : undefined;
  const shownByMeal = fromMemory ?? byMeal;
  const shownDayIso = fromMemory ? dayIso : totalsDayIso;

  const totals = useMemo<DayTotals>(() => {
    const t = { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 };
    for (const mt of Object.keys(shownByMeal) as MealType[]) {
      for (const e of shownByMeal[mt]) {
        t.kcal += e.kcal; t.protein_g += e.protein_g; t.carb_g += e.carb_g; t.fat_g += e.fat_g;
      }
    }
    return t;
  }, [shownByMeal]);

  return {
    byMeal: shownByMeal, totals, totalsDayIso: shownDayIso,
    loading: fromMemory ? false : loading, failedDayIso, reload,
  };
}

/** Weeks already prefetched this session, with when, keyed `${userId}:${weekStartIso}`. */
const _weekPrefetched = new Map<string, number>();
/** Past days change rarely and every visit revalidates anyway, so a week is
 *  worth re-reading only after a while. */
const WEEK_PREFETCH_TTL_MS = 60_000;

/**
 * Load the other days of the visible week into memory, in ONE request, once
 * `ready` says the day on screen has landed. Waiting for it is the point: the
 * day the user is looking at (usually today) keeps the network to itself and
 * its latency does not change; the rest of the week arrives behind it, so a
 * tap on any other day of the strip paints at once.
 *
 * Today and future days are skipped: today has its own cache and fetch, and a
 * future day has nothing to show.
 */
export function usePrefetchWeek(weekStartIso: string, ready: boolean) {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  useEffect(() => {
    if (!ready || !supabase || !user?.id) return;
    const wk = `${user.id}:${weekStartIso}`;
    const last = _weekPrefetched.get(wk);
    if (last && Date.now() - last < WEEK_PREFETCH_TTL_MS) return;
    _weekPrefetched.set(wk, Date.now());

    const todayIso = ymd(new Date());
    const first = dateFromYmd(weekStartIso);
    const lastDay = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 6);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const end = lastDay < yesterday ? lastDay : yesterday;
    if (end < first) return; // the week is all today-or-later
    void fetchDayRange(supabase, first, end).then((res) => {
      if (!res.ok) { _weekPrefetched.delete(wk); return; }
      for (const [iso, byMeal] of res.byDay) {
        if (iso === todayIso) continue;
        _dayCache.set(`${user.id}:${iso}`, byMeal);
      }
    }).catch(() => { _weekPrefetched.delete(wk); });
  }, [ready, supabase, user?.id, weekStartIso]);
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
  return loadNutritionRange(supabase, startDate, days);
}

/** Per-day macro totals for `days` calendar days starting at `startDate`
 *  (oldest → newest), zeros for unlogged days. Used by the diary week strip. */
export async function loadNutritionRange(supabase: Supa | null, startDate: Date, days: number): Promise<DayNutrition[]> {
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
  const lastDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + (days - 1));
  const { start } = dayRange(startDate);
  const { end } = dayRange(lastDate);
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
    const qty = num(e.quantity) || 1;
    const loggedGrams = num(e.grams_logged);
    // A parsed entry often has NO gram weight: Drona knew a scoop of whey was
    // 130 kcal without knowing what it weighed, so grams_logged is null. The
    // old `grams > 0 ? 100 / grams : 0` turned that into a per-100 basis of
    // ZERO, which multiplied every macro to nothing. The row then read
    // "0 cal · 0g P", and re-logging it from Recent wrote those zeros into a
    // real diary entry, so the bug laundered itself into the user's day.
    //
    // With no mass to scale by, treat one serving_unit as the 100-unit basis.
    // The per-UNIT macros are preserved exactly, which is all this list feeds:
    // the picker re-logs by serving, not by weight.
    const unitGrams = loggedGrams > 0 && qty > 0 ? loggedGrams / qty : 100;
    const totalGrams = unitGrams * qty;
    const per100 = totalGrams > 0 ? 100 / totalGrams : 0;
    out.push({
      id: e.food_id ?? null,
      name: e.food_name,
      food_category: 'other',
      base_unit: 'g',
      kcal: num(e.kcal) * per100, protein_g: num(e.protein_g) * per100,
      carb_g: num(e.carb_g) * per100, fat_g: num(e.fat_g) * per100,
      fiber_g: num(e.fiber_g) * per100, sugar_g: num(e.sugar_g) * per100,
      sat_fat_g: num(e.sat_fat_g) * per100, sodium_mg: num(e.sodium_mg) * per100,
      // A weightless entry keeps its own label ("scoop", "bowl") instead of
      // dropping to the generic "100 g". But NOT when that label is itself a
      // measurement unit: resolveBaseAmount matches a food's own servings
      // BEFORE the mass/volume tables, so a synthetic {label:'g', grams:100}
      // makes "1 g" resolve to 100 g. The weighed branch above is immune by
      // accident (grams/qty is already the right per-unit conversion); this
      // 100 fallback is not, so measurement labels keep the real converter.
      servings: isMeasurementUnit(e.serving_unit ?? '')
        ? []
        : [{ label: e.serving_unit || '100 g', grams: unitGrams, is_default: true }],
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
  source: 'catalog' | 'off' | 'fatsecret' | 'web' | 'estimate' | 'manual';
  assumption: string | null;
  confidence: 'high' | 'medium' | 'low';
  /** Precise tier only: two INDEPENDENT sources landed within tolerance of this
   *  line's energy. Not "we are confident" - `confidence` already says that -
   *  but "more than one place off our own shelf agrees", which is the one claim
   *  worth putting a mark on the card for. */
  verified?: boolean;

  /** The name of the user's saved meal this line came from, when the server
   *  logged a saved meal's own rows. The card labels these "saved meal"
   *  instead of "edited": the numbers are the user's, from My Meals. */
  saved_meal?: string | null;

  /** The diary section THIS line goes to. One message can cover a whole day
   *  ("eggs for breakfast, dal at lunch"), so lines in one parsed meal can
   *  belong to different sections. The server stamps every line; the client
   *  never infers it. */
  meal_type: MealType;
}

export interface ParsedMeal {
  /** The first line's section. Kept for the single-meal card, whose chip row
   *  moves EVERY line together; a multi-section meal is read off the lines. */
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
/** Why the server did NOT write the diary on a "Just log it" send. The client
 *  falls back to the review card in every case; the value picks the notice. */
export type AutoLogSkipped = 'declined' | 'implausible' | 'write_error';

/** What this build's food bar can render, sent with every parse. A list rather
 *  than a boolean so the next capability (improvise, challenge) is one more
 *  string, not a second flag the server has to learn to read. */
export const FOOD_BAR_CAPABILITIES = ['food_create'] as const;

export type ParseMealResult =
  | {
    kind: 'parsed';
    meal: ParsedMeal;
    /** "Just log it": the server already wrote these lines. The card goes
     *  straight to "Added" and Undo uses this ref. */
    logged?: LoggedParseRef | null;
    /** "Just log it" was asked for and the server declined to write. */
    autoLogSkipped?: AutoLogSkipped | null;
    /** Saved meals to offer as a one-tap swap. Empty from an older server. */
    savedSuggestions?: SavedSuggestion[];
  }
  // "Just log it" only: the request left and no answer came back (a dropped
  // stream). The server keeps working without us, so this is NOT retried
  // here; the pending list and the diary settle it.
  | { kind: 'sent'; message: string }
  // `proposal` carries researched numbers that materially disagree with what is
  // on screen (usually a different product variant). The user chooses; applying
  // is local, so it costs nothing.
  // `cleared` means the user emptied the meal by removing its last line. It is
  // the one decline the card must NOT survive.
  | {
    kind: 'declined';
    message: string;
    proposal?: { items: ParsedMealItem[]; note: string } | null;
    cleared?: boolean;
  }
  | { kind: 'error'; message: string }
  // The user asked to SAVE a food or meal. Drona drafted it with the same tools
  // the coach chat uses, so this is the chat's tool name and raw input, and the
  // card normalizes it with parseCoachFoodCreate exactly as the chat does.
  | { kind: 'create'; tool: string; input: Record<string, unknown> }
  // A 402 the paywall answers, not an error. `scope` says WHICH wall was hit:
  // 'free' is the daily allowance spent, 'pro' is a Pro-only feature. Both open
  // /upgrade, on different copy, instead of the app blaming itself.
  | { kind: 'cap'; scope: 'free' | 'pro'; used?: number; limit?: number };

/** Drona's line for a cap result. Shared so every parse call site says the same
 *  thing: this copy was written three times and a fourth site would drift. */
export function capNotice(cap: { scope: 'free' | 'pro'; limit?: number }): string {
  if (cap.scope === 'pro') return 'That one is Overload Pro. Your logging stays free.';
  return cap.limit != null
    ? `That is your ${cap.limit} free logs for today. Pro logs as much as you eat.`
    : 'That is your free logs for today. Pro logs as much as you eat.';
}

/** Which paywall a cap result opens. */
export function capUpgradeContext(cap: { scope: 'free' | 'pro' }): 'pro_feature' | 'cap_parse' {
  return cap.scope === 'pro' ? 'pro_feature' : 'cap_parse';
}

/** One raw item from the edge function -> a ParsedMealItem. Shared by the
 *  parsed path and the researched-proposal path so both stay in step. */
const isMealType = (v: unknown): v is MealType =>
  v === 'breakfast' || v === 'lunch' || v === 'dinner' || v === 'snack';

/** `fallbackMeal` is the section to use for a line that carries none - the
 *  meal-level one for a parsed meal, and NULL for a proposal, whose lines
 *  belong wherever the lines they replace are.
 *
 *  NO DEFAULT, deliberately. It had one, and `toParsedItem(i, undefined)` was
 *  written to mean "no fallback" - but a JS default fires on an explicitly
 *  passed undefined too, so that call still produced 'snack' and the opt-out
 *  did nothing at all. Requiring the argument makes the mistake unsayable
 *  rather than merely caught, which is worth more than a test here: lib/ has
 *  no test harness, so a test could not have run anyway. */
function toParsedItem(i: any, fallbackMeal: MealType | null): ParsedMealItem {
  return {
    // NULL is how a caller says "this line has no section of its own": a
    // proposal line belongs wherever the line it replaces is, and
    // onAcceptProposal fills it in. `??` treats null the same as undefined
    // downstream, so the inheritance chain reads naturally.
    meal_type: isMealType(i.meal_type) ? i.meal_type : (fallbackMeal as MealType),
    food_id: typeof i.food_id === 'string' && i.food_id ? i.food_id : null,
    food_name: String(i.food_name ?? 'Food'),
    quantity: num(i.quantity) || 1,
    serving_label: String(i.serving_label ?? 'serving'),
    grams: num(i.grams),
    kcal: num(i.kcal), protein_g: num(i.protein_g), carb_g: num(i.carb_g), fat_g: num(i.fat_g),
    fiber_g: i.fiber_g == null ? null : num(i.fiber_g),
    // 'fatsecret' MUST be listed. Leaving it out coerced every FatSecret-backed
    // line to 'estimate', so the card labelled a real sourced row "Drona's
    // estimate" - undersells a number that came off a label. Same missing-enum
    // shape as the server's sanitizeItems bug; a new source has to be added in
    // BOTH whitelists or it silently degrades.
    source: i.source === 'catalog' || i.source === 'off' || i.source === 'fatsecret' ||
        i.source === 'web' || i.source === 'manual'
      ? i.source
      : 'estimate',
    assumption: typeof i.assumption === 'string' && i.assumption.trim() ? i.assumption.trim() : null,
    confidence: i.confidence === 'high' || i.confidence === 'low' ? i.confidence : 'medium',
    // Only ever true when the server says so. Absent on every tier but Precise,
    // and absent from an older server build, so the badge simply does not
    // render rather than claiming a cross-check that never happened.
    verified: i.verified === true,
    ...(typeof i.saved_meal === 'string' && i.saved_meal.trim() ? { saved_meal: i.saved_meal.trim() } : {}),
  };
}

/** A saved meal to OFFER as a swap for one line on the card: the line names a
 *  food that is only part of a saved meal ("oats", saved "Oats with milk"). */
export interface SavedSuggestion { food_name: string; saved_id: string; saved_name: string }

/** A saved meal as card lines, one serving, the same numbers logSavedMeal
 *  writes. Marked as the user's own (manual) and named after the saved meal. */
export function savedMealAsItems(saved: SavedMeal, mealType: MealType): ParsedMealItem[] {
  const base = { source: 'manual' as const, assumption: null, confidence: 'high' as const, meal_type: mealType, saved_meal: saved.name };
  if (saved.kind === 'recipe' || saved.items.length === 0) {
    const f = saved.kind === 'recipe' && saved.servings > 0 ? 1 / saved.servings : 1;
    return [{
      food_id: null, food_name: saved.name, quantity: 1, serving_label: saved.serving_label ?? 'serving', grams: 0,
      kcal: Math.round(saved.kcal * f), protein_g: r1(saved.protein_g * f), carb_g: r1(saved.carb_g * f), fat_g: r1(saved.fat_g * f),
      fiber_g: null, ...base,
    }];
  }
  return saved.items.map((it) => ({
    food_id: it.food_id, food_name: it.food_name, quantity: num(it.quantity) || 1, serving_label: it.serving_unit,
    grams: num(it.grams_logged), kcal: num(it.kcal), protein_g: num(it.protein_g), carb_g: num(it.carb_g), fat_g: num(it.fat_g),
    fiber_g: it.fiber_g == null ? null : num(it.fiber_g), ...base,
  }));
}

/**
 * Shape an edge response into a ParseMealResult.
 *
 * Extracted so the JSON path and the SSE `end` frame cannot drift: they carry
 * the SAME payload, and two copies of this mapping is how a new field ends up
 * honoured on one path and silently dropped on the other.
 */
function toParseResult(data: any): ParseMealResult {
  if (data?.create && typeof data.create.tool === 'string' && data.create.input && typeof data.create.input === 'object') {
    return { kind: 'create', tool: data.create.tool, input: data.create.input };
  }
  if (data?.declined?.message) {
    const p = data?.proposal;
    const proposal = p && Array.isArray(p.items) && p.items.length > 0
      // null fallback on purpose. A proposal line has no section of its own:
      // it REPLACES a line on the card and belongs wherever that line is, so
      // guessing here (the default is 'snack') would re-file a breakfast item
      // the moment the user accepted better numbers for it. onAcceptProposal
      // does the inheriting; a null section is how it knows to.
      ? { items: (p.items as any[]).map((i) => toParsedItem(i, null)), note: String(p.note ?? 'Use these numbers') }
      : null;
    return {
      kind: 'declined',
      message: String(data.declined.message),
      proposal,
      cleared: data.declined.cleared === true,
    };
  }
  const parsed = data?.parsed;
  if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    return { kind: 'error', message: 'Drona could not read that one. Give it another shot.' };
  }
  const mealType: MealType =
    parsed.meal_type === 'breakfast' || parsed.meal_type === 'lunch' ||
    parsed.meal_type === 'dinner' || parsed.meal_type === 'snack'
      ? parsed.meal_type : 'snack';
  // "Just log it": the server wrote the diary and says which rows, or says why
  // it did not. Absent on a review-mode response.
  const rawLogged = data?.logged;
  const logged: LoggedParseRef | null = rawLogged && Array.isArray(rawLogged.sections)
    ? {
      sections: (rawLogged.sections as any[]).flatMap((s) => (
        typeof s?.meal_id === 'string' && Array.isArray(s.entry_ids)
          ? [{
            mealType: isMealType(s.meal_type) ? s.meal_type : mealType,
            mealId: String(s.meal_id),
            entryIds: (s.entry_ids as unknown[]).map(String),
            createdMeal: s.created_meal === true,
          }]
          : []
      )),
    }
    : null;
  const skipped = data?.auto_log_skipped;
  return {
    kind: 'parsed',
    meal: {
      meal_type: mealType,
      items: (parsed.items as any[]).map((i) => toParsedItem(i, mealType)),
      drona_line: String(parsed.drona_line ?? 'Here it is. Keep the protein coming.'),
      corrects_previous: parsed.corrects_previous === true,
    },
    logged,
    autoLogSkipped: skipped === 'declined' || skipped === 'implausible' || skipped === 'write_error' ? skipped : null,
    savedSuggestions: Array.isArray(data?.saved_suggestions)
      ? (data.saved_suggestions as any[]).flatMap((x) => (
        typeof x?.food_name === 'string' && typeof x?.saved_id === 'string' && typeof x?.saved_name === 'string'
          ? [{ food_name: x.food_name, saved_id: x.saved_id, saved_name: x.saved_name }]
          : []
      ))
      : [],
  };
}

/** What the card can show before the meal is finished. */
export interface StreamedItem {
  name: string;
  quantity: number;
  unit: string;
  /** The model's own guess for the whole line, from the naming call. The
   *  shimmering numbers animate toward THESE, so they approach something true
   *  rather than spinning at nothing. Null when the model gave no usable
   *  estimate, in which case the row shimmers without a target.
   *
   *  All four move together. A row that settles a calorie count while its
   *  macros sit blank reads as broken, and showing the same four fields the
   *  final row shows is what stops the card resizing when the catalog answers. */
  est_kcal: number | null;
  est_protein_g: number | null;
  est_carb_g: number | null;
  est_fat_g: number | null;
}

/** "Just log it" request fields. `tz_offset_min` lets the server turn the
 *  diary day into the user's local window for its meals lookup, the same
 *  window dayRange() draws here. */
function autoLogFields(auto: { clientId: string; logDate: string } | null | undefined, now: Date) {
  return auto
    ? { auto_log: true, client_id: auto.clientId, log_date: auto.logDate, tz_offset_min: now.getTimezoneOffset() }
    : {};
}

/** The stream dropped after the request left. In "Just log it" the server
 *  keeps working without us, so re-sending here would only race it; the
 *  pending list settles it on the next look at the diary. */
const sentResult = (): ParseMealResult => ({
  kind: 'sent',
  message: 'Sent. Drona is adding it to your diary; give it a moment.',
});

/**
 * Fast mode over SSE: rows appear as soon as the names are known (~1.2s),
 * numbers settle when the catalog answers (~300ms later).
 *
 * Falls back to the plain JSON parseMeal on ANY streaming failure - no body,
 * a malformed frame, a mid-stream disconnect, or a server `error` event. A
 * user whose network dislikes long-lived responses gets the old behaviour
 * rather than an error, and the only cost is the wait they would have had
 * anyway.
 *
 * ONE EXCEPTION: a "Just log it" send (args.autoLog) whose stream drops AFTER
 * the request left comes back as `sent`, not as a second parse. The server
 * keeps working after the client hangs up in that mode and writes the diary
 * itself, so re-sending would race it; the pending list (lib/autoLog) settles
 * what happened on the next look at the diary.
 *
 * ABANDONED PARSES ARE CANCELLED, ON BOTH SIDES. Pass an AbortSignal and
 * navigating away (or discarding the card) aborts the request; the edge
 * function's stream has a `cancel()` handler that turns that disconnect into an
 * AbortSignal on its own model calls (see index.ts and ParseMealDeps.abortSignal).
 * Client-side abort alone was only half of it: the app stopped reading while
 * the server finished every Anthropic call, spending real tokens on a result
 * nobody would ever see.
 *
 * The server also emits a `fill` event, deliberately ignored here: it carries
 * the same payload as `end` and is sent immediately before it, so handling it
 * would repaint the card twice with identical data.
 */
export async function parseMealStreaming(
  supabase: Supa,
  args: Parameters<typeof parseMeal>[1],
  onItems: (items: StreamedItem[]) => void,
  signal?: AbortSignal,
  /** What Drona is doing right now on a multi-step message ("Checking
   *  yesterday's breakfast"). Only the food agent sends these. */
  onStatus?: (label: string) => void,
): Promise<ParseMealResult> {
  const text = args.text.trim();
  if (!text) return { kind: 'error', message: 'Type what you ate first.' };

  // A correction, question or removal must NOT take the fast path: it needs the
  // full pipeline to read intent. Same rule the server enforces; checked here
  // too so we do not even open a stream we know will be ignored.
  if (args.previous && args.previous.items.length > 0) return parseMeal(supabase, args);

  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  try {
    // Clerk owns the session; nothing is ever written to Supabase auth, so
    // `supabase.auth.getSession()` returns null for a signed-in user and every
    // stream fell back to the JSON path below without a trace.
    const token = await getSupabaseAccessToken();
    if (!token) return parseMeal(supabase, args);

    // Region pin, matching what supabase-js sends for FunctionRegion.UsEast1:
    // the x-region header below AND this query parameter. VERIFIED working
    // (curl shows x-sb-edge-region flip to us-east-1 with either one, and the
    // device trace agrees: pre_parse 1290->442ms, verifyItems 255->30ms).
    // An earlier round concluded "the pin does not work" - that test ran on a
    // stale bundle from a dead Metro watcher, not on this code.
    const res = await expoFetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/ai-coach?forceFunctionRegion=us-east-1`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-region': 'us-east-1',
      },
      signal,
      body: JSON.stringify({
        mode: 'parse_meal',
        // `mode` dispatches the handler; `speed` picks the tier inside it. They
        // are separate fields on purpose - folding the tier into `mode` is what
        // made streaming unreachable, since `mode` is always 'parse_meal' here.
        speed: 'fast',
        stream: true,
        // This build can draw a save card in the food bar. Builds without this
        // flag get a create served as a log, because they have nothing to draw
        // one with (see clientSupportsFoodCreate in the edge function).
        supports: FOOD_BAR_CAPABILITIES,
        text,
        local_hour: now.getHours(),
        local_date: localDate,
        ...(args.mealHint ? { meal_hint: args.mealHint } : {}),
        ...(args.turns && args.turns.length > 0
          ? { recent_turns: args.turns.slice(-4).map((t) => ({ role: t.role, text: t.text.slice(0, 240) })) }
          : {}),
        ...autoLogFields(args.autoLog, now),
      }),
    });
    // A non-2xx is decided before any parse starts (auth, cap, rate limit), so
    // the JSON path can take over safely even in "Just log it": nothing has
    // been written and nothing is still running.
    if (!res.ok || !res.body) return parseMeal(supabase, args);

    // Abort releases the socket, which is what tells the edge function nobody
    // is listening. Without it the server finishes the whole model call for a
    // client that walked away - billed compute for a result no one sees.
    const reader = res.body.getReader();
    signal?.addEventListener('abort', () => { void reader.cancel().catch(() => {}); }, { once: true });
    const dec = new TextDecoder();
    let buf = '';
    let final: ParseMealResult | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = frame.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
        const raw = frame.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
        if (!ev || !raw) continue;
        let payload: any;
        try { payload = JSON.parse(raw); } catch { continue; }
        if (ev === 'items' && Array.isArray(payload.items)) {
          const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : null);
          onItems(payload.items.map((i: any) => ({
            name: String(i.name ?? ''),
            quantity: Number(i.quantity) || 1,
            unit: String(i.unit ?? 'serving'),
            est_kcal: num(i.est_kcal),
            est_protein_g: num(i.est_protein_g),
            est_carb_g: num(i.est_carb_g),
            est_fat_g: num(i.est_fat_g),
          })));
        } else if (ev === 'status' && typeof payload.label === 'string') {
          onStatus?.(payload.label.slice(0, 80));
        } else if (ev === 'end') {
          final = toParseResult(payload);
        } else if (ev === 'error') {
          // Fall back like every other stream failure does. The docstring has
          // always claimed "ANY streaming failure" falls back, and this branch
          // was the one exception: a transient mid-stream error that the
          // buffered path would have answered fine became a dead end for the
          // user. The 200 is already sent, so this costs the wait again - the
          // same cost the truncated-stream path below already accepts.
          return parseMeal(supabase, args);
        }
      }
    }
    // A stream that ended without an `end` frame is a truncated response, not a
    // parse. Re-running costs a wait; showing a half-meal costs trust. Both
    // outcomes take the same road - a stream that never produced a final frame
    // is unusable whether or not it painted rows first - so this is one call,
    // not a ternary onto itself.
    // In "Just log it" the server is still working on the parse we just lost
    // sight of, so a second send would only race it; see sentResult.
    if (!final) return args.autoLog ? sentResult() : parseMeal(supabase, args);
    return final;
  } catch (e) {
    // A deliberate abort is not a failure to retry: the caller has moved on, so
    // falling back would start a SECOND full parse for a card nobody is
    // watching - the exact waste the abort exists to prevent.
    //
    // But "the caller moved on" does NOT mean the send did. In "Just log it"
    // the request has already left and the server finishes without us, so an
    // abort answers `sent` like every other exit here rather than "Cancelled."
    // - a word that promises nothing was logged while the diary fills anyway.
    // Masked today because every deliberate abort in auto mode is preceded by a
    // parseTokenRef bump, so the stale result is dropped before it is read. The
    // asymmetry was still a footgun: it made this one branch depend on ordering
    // three files away rather than on the rule the comment beside it states.
    if (signal?.aborted || (e as { name?: string })?.name === 'AbortError') {
      return args.autoLog ? sentResult() : { kind: 'error', message: 'Cancelled.' };
    }
    // Same rule as the truncated stream above: in "Just log it" the request
    // may well have reached the server, which finishes without us.
    if (args.autoLog) return sentResult();
    return parseMeal(supabase, args);
  }
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
    /** "Just log it": ask the server to write the diary itself. `clientId` is
     *  a fresh uuid per send (the idempotency key: a Retry re-uses it and the
     *  server writes once), `logDate` the diary day (YYYY-MM-DD) to land on. */
    autoLog?: { clientId: string; logDate: string } | null;
    /** This caller can draw a save card. ONLY the food bar sets it. Food
     *  search's "Ask Drona" is a one-food lookup with nowhere to put a save
     *  card, so it must not claim it can and gets a create served as a log. */
    canCreate?: boolean;
    /** Pipeline tier. Omitted means smart, which is what every existing caller
     *  wants and what the server assumes when the field is absent. 'super' is
     *  Precise. 'fast' is passed only on a Quick FOLLOW-UP: the correction
     *  itself still runs the full pipeline, but a fresh re-parse it triggers
     *  ("not from saved meals") must come back in the user's tier. */
    speed?: 'super' | 'fast';
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
        ...(args.canCreate ? { supports: FOOD_BAR_CAPABILITIES } : {}),
        text,
        local_hour: now.getHours(),
        local_date: localDate,
        // Tier rides its OWN field: `mode` is the dispatch value and reading the
        // tier off it is the gate that could never open (see index.ts). Absent
        // = smart, which is every caller that does not ask.
        ...(args.speed ? { speed: args.speed } : {}),
        ...(args.mealHint ? { meal_hint: args.mealHint } : {}),
        ...(args.turns && args.turns.length > 0
          ? { recent_turns: args.turns.slice(-4).map((t) => ({ role: t.role, text: t.text.slice(0, 240) })) }
          : {}),
        ...autoLogFields(args.autoLog, now),
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
              // Sent so a correction does not collapse a full-day log into one
              // section: the server rebuilds every line from these.
              meal_type: it.meal_type,
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
    if (res.error) {
      // A 402 is the paywall, not a breakage. Checked BEFORE the message
      // helper, which buckets every non-2xx into "something broke on my end".
      const cap = await coachInvokeCapSignal(res.error);
      // Both kinds are paywalls. Handling only 'cap' would let a pro_required
      // 402 fall through to the generic "something broke" line, which is the
      // exact bug this branch exists to fix.
      if (cap) return { kind: 'cap', scope: cap.kind === 'pro' ? 'pro' : 'free', used: cap.used, limit: cap.limit };
      return { kind: 'error', message: await coachInvokeErrorMessage(res.error) };
    }
    data = res.data;
  } catch (e) {
    return { kind: 'error', message: 'No connection. Type it again when you are back online.' };
  }

  return toParseResult(data);
}

/** One diary section written by a parsed meal — the ids needed to Undo it. */
export interface LoggedSectionRef {
  mealType: MealType;
  mealId: string;
  entryIds: string[];
  createdMeal: boolean; // true if we created the meal row (so Undo can remove it)
}

/** The result of writing a parsed meal. One entry per section it touched:
 *  a single-meal message has one, "eggs for breakfast, dal at lunch" has two. */
export interface LoggedParseRef {
  sections: LoggedSectionRef[];
}

/** The sections a parsed meal's lines fall into, in first-seen order. Each
 *  line carries its own meal_type (server-stamped); the meal-level field is
 *  only the fallback for a line that somehow lacks one. */
export function sectionsOfItems(items: ParsedMealItem[], fallback: MealType): MealType[] {
  const seen: MealType[] = [];
  for (const it of items) {
    const m = it.meal_type ?? fallback;
    if (!seen.includes(m)) seen.push(m);
  }
  return seen.length ? seen : [fallback];
}

/** The same rule for a whole parsed meal, whose own meal_type is the fallback. */
export function sectionsOf(meal: ParsedMeal): MealType[] {
  return sectionsOfItems(meal.items, meal.meal_type);
}

/** Write a parsed meal to the day's log, one section at a time: group the
 *  lines by their meal_type, find-or-create each section's meal row, then
 *  batch-insert that group's lines with the parser's FINAL macros and
 *  logged_via='ai'. Returns ids for Undo, or { error }.
 *
 *  Sections are written in sequence and a failure part-way undoes what
 *  already landed, so the day never ends up with breakfast logged and lunch
 *  missing from a message that named both. */
export async function logParsedMeal(
  supabase: Supa,
  meal: ParsedMeal,
  date: Date = getLogDate(),
  /** How the user got here. Food detail reuses this writer for a single
   *  catalog item, which is a search log, not an AI parse. */
  via: 'ai' | 'search' | 'drona_search' = 'ai',
): Promise<{ ref?: LoggedParseRef; error?: string }> {
  const done: LoggedSectionRef[] = [];
  for (const section of sectionsOf(meal)) {
    const lines = meal.items.filter((it) => (it.meal_type ?? meal.meal_type) === section);
    const r = await logSection(supabase, section, lines, date);
    if (r.error || !r.ref) {
      await undoParsedMeal(supabase, { sections: done });
      return { error: r.error ?? 'Could not add that' };
    }
    done.push(r.ref);
  }
  track('meal_logged', {
    method: via,
    item_count: meal.items.length,
    kcal: Math.round(meal.items.reduce((t, it) => t + (it.kcal ?? 0), 0)),
    meal_type: meal.meal_type ?? null,
    section_count: done.length,
  });
  return { ref: { sections: done } };
}

async function logSection(
  supabase: Supa,
  mealType: MealType,
  items: ParsedMealItem[],
  date: Date,
): Promise<{ ref?: LoggedSectionRef; error?: string }> {
  const m = await findOrCreateMeal(supabase, mealType, date);
  if (m.error || !m.id) return { error: m.error ?? 'Could not create the meal' };
  const mealId = m.id;
  const createdMeal = !!m.created;

  const { count } = await supabase
    .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', mealId);
  const base = count ?? 0;

  const rows = items.map((it, idx) => ({
    meal_id: mealId,
    food_id: it.food_id,
    food_name: it.food_name,
    quantity: it.quantity,
    serving_unit: it.serving_label,
    // 0 means "no weight known" (a saved line from a quick add or a recipe).
    // The column allows null or > 0, never 0 (migration 0069), so 0 is null here.
    grams_logged: it.grams > 0 ? r1(it.grams) : null,
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
  return { ref: { mealType, mealId, entryIds, createdMeal } };
}

/** Undo an AI-logged meal: delete the inserted entries in every section it
 *  wrote, and each meal row too if we created it for this log and it is now
 *  empty. Best-effort. */
export async function undoParsedMeal(supabase: Supa, ref: LoggedParseRef): Promise<void> {
  for (const s of ref.sections) {
    if (s.entryIds.length > 0) {
      await supabase.from('meal_entries').delete().in('id', s.entryIds);
    }
    if (s.createdMeal) {
      const { count } = await supabase
        .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', s.mealId);
      if ((count ?? 0) === 0) await supabase.from('meals').delete().eq('id', s.mealId);
    }
  }
}

// ── Daily targets (the lifter framing: protein ring + calorie band) ─────────
// Stored as nullable columns on user_profiles; the ai-coach parse_meal fn reads
// them too. When unset we fall back to DEFAULT_TARGETS per-field so the ring
// always has a goal to draw against.
export interface NutritionTargets { kcal: number; protein: number; carb: number; fat: number }
export const DEFAULT_TARGETS: NutritionTargets = { kcal: 2000, protein: 125, carb: 250, fat: 56 };

// Macros carry the calories, so a new calorie goal has to move them with it.
// We keep the user's ENERGY SPLIT (the share of the day's kcal from each macro)
// and re-derive grams for the new total, rather than leaving stale grams that
// still add up to the old goal. Shared by the goal sheet and by the coach
// program sync, so both write a consistent set.
export const KCAL_PER_G = { protein: 4, carb: 4, fat: 9 } as const;

export interface EnergySplit { p: number; c: number; f: number }

/** Share of total energy from each macro. Falls back to the default split when
 *  the grams are all zero (nothing to take a ratio of). */
export function energySplit(t: { protein: number; carb: number; fat: number }): EnergySplit {
  const p = t.protein * KCAL_PER_G.protein;
  const c = t.carb * KCAL_PER_G.carb;
  const f = t.fat * KCAL_PER_G.fat;
  const total = p + c + f;
  if (!(total > 0)) {
    const dp = DEFAULT_TARGETS.protein * KCAL_PER_G.protein;
    const dc = DEFAULT_TARGETS.carb * KCAL_PER_G.carb;
    const df = DEFAULT_TARGETS.fat * KCAL_PER_G.fat;
    const dt = dp + dc + df;
    return { p: dp / dt, c: dc / dt, f: df / dt };
  }
  return { p: p / total, c: c / total, f: f / total };
}

/** Grams that hold `split` and add up to `kcal`. Protein and fat round first;
 *  carbs take the leftover so the three land on the goal, not near it. */
export function macrosForKcal(kcal: number, split: EnergySplit): { protein: number; carb: number; fat: number } {
  const protein = Math.max(0, Math.round((kcal * split.p) / KCAL_PER_G.protein));
  const fat = Math.max(0, Math.round((kcal * split.f) / KCAL_PER_G.fat));
  const carb = Math.max(
    0,
    Math.round((kcal - protein * KCAL_PER_G.protein - fat * KCAL_PER_G.fat) / KCAL_PER_G.carb),
  );
  return { protein, carb, fat };
}

/** Calories the three gram targets actually add up to. */
export function macroKcal(t: { protein: number; carb: number; fat: number }): number {
  return t.protein * KCAL_PER_G.protein + t.carb * KCAL_PER_G.carb + t.fat * KCAL_PER_G.fat;
}

/**
 * Fill in only the macros a caller left out, so all four targets add up to
 * `kcal`. Whatever the caller specified is kept EXACTLY; the omitted ones share
 * the calories left over, in the same proportion they had to each other before.
 *
 * This is the partial case `macrosForKcal` cannot express. A coach phase that
 * says "1300 kcal, keep protein at 100" must not have its 100 g overwritten,
 * and must not have carbs and fat derived from a split that still counts the
 * old protein: that lands back on four numbers that do not add up.
 */
export function fillMissingMacros(
  kcal: number,
  given: { protein?: number | null; carb?: number | null; fat?: number | null },
  current: { protein: number; carb: number; fat: number },
): { protein: number; carb: number; fat: number } {
  const KEYS = ['protein', 'carb', 'fat'] as const;
  const out = {
    protein: given.protein ?? current.protein,
    carb: given.carb ?? current.carb,
    fat: given.fat ?? current.fat,
  };
  const missing = KEYS.filter((k) => given[k] == null);
  if (missing.length === 0) return out;

  const fixedKcal = KEYS
    .filter((k) => given[k] != null)
    .reduce((sum, k) => sum + (given[k] as number) * KCAL_PER_G[k], 0);
  // A phase whose explicit macros already exceed its calorie target leaves
  // nothing to share out; zero beats a negative gram target.
  const remaining = Math.max(0, kcal - fixedKcal);

  const raw = missing.map((k) => current[k] * KCAL_PER_G[k]);
  const rawTotal = raw.reduce((a, b) => a + b, 0);
  const weights = rawTotal > 0 ? raw : missing.map((k) => DEFAULT_TARGETS[k] * KCAL_PER_G[k]);
  const wTotal = weights.reduce((a, b) => a + b, 0);
  const share = wTotal > 0 ? weights.map((w) => w / wTotal) : missing.map(() => 1 / missing.length);

  // The last omitted macro takes whatever is left rather than its own rounded
  // share, so the four land ON the target instead of near it.
  let used = 0;
  missing.forEach((k, i) => {
    if (i < missing.length - 1) {
      const grams = Math.max(0, Math.round((remaining * share[i]) / KCAL_PER_G[k]));
      out[k] = grams;
      used += grams * KCAL_PER_G[k];
    } else {
      out[k] = Math.max(0, Math.round((remaining - used) / KCAL_PER_G[k]));
    }
  });
  return out;
}

interface CachedTargets { targets: NutritionTargets; isCustom: boolean; fuelDays?: FuelDay[] }

/** Read the user's daily targets. isCustom = they've set at least one real goal
 *  (vs pure defaults), so the UI can nudge first-timers to set theirs.
 *
 *  `targets` is the BASE day. Fuel days (lib/fuelDays) add calories on top on
 *  their weekday, so anything that draws a specific day's ring or bars reads
 *  `targetsOn(date)`, never `targets` directly. */
export function useNutritionTargets(): {
  targets: NutritionTargets; isCustom: boolean; reload: () => void;
  apply: (t: NutritionTargets) => void;
  fuelDays: FuelDay[];
  applyFuelDays: (days: FuelDay[]) => void;
  targetsOn: (date: Date) => NutritionTargets;
} {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const clerkId = user?.id ?? null;
  // Seed from the read cache so a cold start paints the user's real goal, not
  // the 2000 kcal default that then snaps to (say) 1600 once the fetch lands.
  const cachedSeed = readCache<CachedTargets>('nutritionTargets', clerkId);
  const [targets, setTargets] = useState<NutritionTargets>(cachedSeed?.targets ?? DEFAULT_TARGETS);
  const [isCustom, setIsCustom] = useState(cachedSeed?.isCustom ?? false);
  const [fuelDays, setFuelDays] = useState<FuelDay[]>(cachedSeed?.fuelDays ?? []);
  const fuelRef = useRef(fuelDays);
  fuelRef.current = fuelDays;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // Optimistic update so the ring/pill reflect a saved goal instantly, without
  // waiting out read-after-write lag on the refetch.
  const apply = useCallback((t: NutritionTargets) => {
    setTargets(t); setIsCustom(true);
    writeCache<CachedTargets>('nutritionTargets', clerkId, { targets: t, isCustom: true, fuelDays: fuelRef.current });
  }, [clerkId]);
  const applyFuelDays = useCallback((days: FuelDay[]) => {
    setFuelDays(days);
    const cur = readCache<CachedTargets>('nutritionTargets', clerkId);
    if (cur) writeCache<CachedTargets>('nutritionTargets', clerkId, { ...cur, fuelDays: days });
  }, [clerkId]);
  const targetsOn = useCallback(
    (date: Date) => targetsOnDow(targets, fuelDays, date.getDay()),
    [targets, fuelDays],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The synchronous seed above misses when the cache hasn't hydrated from
      // disk yet (first render after launch), so re-read once it has.
      await hydrateCache(clerkId);
      if (cancelled) return;
      const cached = readCache<CachedTargets>('nutritionTargets', clerkId);
      if (cached) { setTargets(cached.targets); setIsCustom(cached.isCustom); setFuelDays(cached.fuelDays ?? []); }

      if (!supabase) return;
      const cols = 'daily_calorie_target, protein_target_g, carb_target_g, fat_target_g';
      const { data } = clerkId
        ? await supabase.from('user_profiles').select(cols).eq('clerk_user_id', clerkId).maybeSingle()
        : await supabase.from('user_profiles').select(cols).limit(1).maybeSingle();
      if (cancelled || !data) return;
      const d = data as Record<string, unknown>;
      const pick = (v: unknown, def: number) => (v == null ? def : Number(v));
      const next: NutritionTargets = {
        kcal: pick(d.daily_calorie_target, DEFAULT_TARGETS.kcal),
        protein: pick(d.protein_target_g, DEFAULT_TARGETS.protein),
        carb: pick(d.carb_target_g, DEFAULT_TARGETS.carb),
        fat: pick(d.fat_target_g, DEFAULT_TARGETS.fat),
      };
      const nextIsCustom =
        d.daily_calorie_target != null || d.protein_target_g != null ||
        d.carb_target_g != null || d.fat_target_g != null;
      // Fuel days in their own read: a build that ships before the column
      // exists (0139) must still paint the base targets, so a failure here
      // keeps whatever fuel days we had instead of taking the targets with it.
      let nextFuel = fuelRef.current;
      if (clerkId) {
        const fuelRes = await supabase
          .from('user_profiles').select('calorie_day_boosts').eq('clerk_user_id', clerkId).maybeSingle();
        if (cancelled) return;
        if (!fuelRes.error) nextFuel = normalizeFuelDays((fuelRes.data as { calorie_day_boosts?: unknown } | null)?.calorie_day_boosts);
      }
      setTargets(next);
      setIsCustom(nextIsCustom);
      setFuelDays(nextFuel);
      writeCache<CachedTargets>('nutritionTargets', clerkId, { targets: next, isCustom: nextIsCustom, fuelDays: nextFuel });
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

  return { targets, isCustom, reload, apply, fuelDays, applyFuelDays, targetsOn };
}

/** Persist the user's fuel days (an empty list clears them). With `phaseId`
 *  (an edit made on Goal & Plan) the current phase's plan is updated too, so
 *  the plan and the live days say the same thing and Drona refines from it. */
export async function saveFuelDays(
  supabase: Supa,
  clerkId: string,
  days: FuelDay[],
  phaseId?: string | null,
): Promise<{ error?: string }> {
  const clean = normalizeFuelDays(days);
  const { error } = await supabase.from('user_profiles').upsert({
    clerk_user_id: clerkId,
    calorie_day_boosts: clean.length > 0 ? clean : null,
  }, { onConflict: 'clerk_user_id' });
  if (error) return { error: error.message };
  if (phaseId) {
    const { error: phaseErr } = await supabase
      .from('coach_program_phases')
      .update({ diet_fuel_days: clean })
      .eq('id', phaseId);
    if (phaseErr) return { error: phaseErr.message };
  }
  return {};
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
    grams_logged: num(it.grams) > 0 ? r1(num(it.grams)) : null, // 0 = weightless (a quick add); the log CHECK wants null, not 0
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
  /** Which surface logged it. The builder can log a meal that was never saved,
   *  which is a different behaviour from re-logging a saved one. 'drona_create'
   *  is a meal Drona built from what the user said and logged in the same tap,
   *  so it is both a create and a log and deserves to be tellable from either. */
  source: 'search_tab' | 'saved_sheet' | 'builder' | 'drona_create' = 'search_tab',
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
      grams_logged: num(it.grams_logged) > 0 ? r1(num(it.grams_logged) * servings) : null,
      kcal: r0(it.kcal * servings), protein_g: r1(it.protein_g * servings), carb_g: r1(it.carb_g * servings), fat_g: r1(it.fat_g * servings),
      fiber_g: it.fiber_g == null ? null : r1(it.fiber_g * servings), sugar_g: null, sat_fat_g: null, sodium_mg: null,
      position: base + i, logged_via: 'manual',
    }));
  }
  const { error } = await supabase.from('meal_entries').insert(rows);
  if (!error) {
    track('meal_logged', {
      method: 'saved',
      item_count: rows.length,
      kcal: Math.round(saved.kcal * (saved.kind === 'recipe' && saved.servings > 0 ? servings / saved.servings : servings)),
      meal_type: mealType,
      saved_kind: saved.kind,
      source,
      is_saved: !!saved.id,
    });
  }
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
    grams_logged: num(it.grams) > 0 ? r1(num(it.grams)) : null, // 0 = weightless (a quick add); the log CHECK wants null, not 0
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
  // Cap only. Every CREATE path (the picker, a parse, a saved meal) writes an
  // unbounded quantity and the column has no CHECK, so clamping the EDIT path
  // to 50 made portions you could log but could not adjust: editing a 200 x
  // entry silently rewrote it to 50. The floor is an epsilon, not a quarter,
  // for the same reason — 0.1 of something is a real portion, and rounding it
  // up to 0.25 without saying so is the bug this pair used to have.
  const q1 = Math.min(Math.max(newQuantity, 0.01), 999);
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
  if (!error) {
    track('meal_logged', { method: 'search', item_count: 1, kcal: r0(n.kcal), meal_type: mealType });
  }
  return { error: error?.message };
}

// ── Quick add (calories you know, no catalog match) ──────────────────────────
// The escape hatch every tracker needs: a restaurant plate, a homemade dish, a
// label you are holding. The user types what they know — calories, and macros
// only if they have them — and it lands in the diary like any other entry. The
// row is a plain manual entry with NO food_id: nothing to re-derive from, so
// the typed numbers are the numbers, forever.

/** The title a quick add falls back to when the user names nothing. */
export const QUICK_ADD_NAME = 'Quick add';

/** Quick adds carry no weight, so the portion is one abstract serving. That keeps
 *  the entry rescalable (quantity × the snapshot) without inventing grams. */
export const QUICK_ADD_SERVING = 'serving';

/** A title to prefill the quick-add form with (the search that came up empty),
 *  handed over the same way as the meal target: /quick-add is a retained Tabs
 *  screen, so a router param would still be there — and stale — next time.
 *  Reading it consumes it. */
let _quickAddSeed = '';
export const setQuickAddSeed = (name: string) => { _quickAddSeed = name.trim().slice(0, 60); };
export const takeQuickAddSeed = (): string => { const v = _quickAddSeed; _quickAddSeed = ''; return v; };

/** What the meal builder should open with: a saved meal to EDIT, or null for a
 *  blank "create a meal". /meal-builder is a retained Tabs screen, so its route
 *  params are read once at mount and then stay frozen for the session — the
 *  first visit's mode won a whole session in both directions. Set this right
 *  before navigating; the builder consumes it on focus.
 *
 *  Reading it CONSUMES it, which is also how the builder tells "entered afresh
 *  from search" (reset the form) from "regained focus" (keep unsaved edits). */
let _builderMeal: SavedMeal | null = null;
let _builderPending = false;
export const setBuilderMeal = (m: SavedMeal | null) => { _builderMeal = m; _builderPending = true; };
/** `pending` false means no fresh entry happened — leave the form alone. */
export const takeBuilderMeal = (): { pending: boolean; meal: SavedMeal | null } => {
  const out = { pending: _builderPending, meal: _builderMeal };
  _builderMeal = null; _builderPending = false;
  return out;
};

export interface QuickAddDraft {
  /** Blank falls back to QUICK_ADD_NAME. */
  name: string;
  kcal: number;
  /** Optional — null means the user did not say. The diary's core macro columns
   *  are NOT NULL, so a blank lands as 0; the distinction lives in the form,
   *  where it decides whether the calorie cross-check has anything to compare. */
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
}

/** The title a draft will actually be logged under. */
export function quickAddName(draft: { name: string }): string {
  return draft.name.trim().slice(0, 80) || QUICK_ADD_NAME;
}

/** A quick-add draft as a one-line ParsedMealItem, so "save it as a meal" can go
 *  through the same createSavedMeal path the builder and the parse card use.
 *  `source: 'manual'` — the numbers are the user's own. */
export function quickAddToItem(draft: QuickAddDraft, mealType: MealType): ParsedMealItem {
  return {
    food_id: null,
    food_name: quickAddName(draft),
    quantity: 1,
    serving_label: QUICK_ADD_SERVING,
    grams: 0, // no weight was given; the entry is a serving, not a portion of one
    kcal: num(draft.kcal),
    protein_g: num(draft.protein_g), carb_g: num(draft.carb_g), fat_g: num(draft.fat_g),
    fiber_g: null,
    source: 'manual', assumption: null, confidence: 'high',
    meal_type: mealType,
  };
}

/** Log a quick add to the day's meal of `mealType`: one manual entry, no
 *  food_id, no grams — the typed numbers, stored as they were typed. Returns
 *  { error } on failure, and cleans up a meal row it created for an insert that
 *  then failed, so no empty section is left behind. */
export async function logQuickAdd(
  supabase: Supa,
  args: { mealType: MealType; draft: QuickAddDraft; date?: Date },
): Promise<{ error?: string }> {
  const { mealType, draft } = args;
  const kcal = num(draft.kcal);
  if (!(kcal > 0)) return { error: 'Enter the calories first' };

  const m = await findOrCreateMeal(supabase, mealType, args.date ?? getLogDate());
  if (m.error || !m.id) return { error: m.error ?? 'Could not create the meal' };
  const mealId = m.id;
  const createdMeal = !!m.created;

  const { count } = await supabase
    .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', mealId);

  // Core macros are NOT NULL on meal_entries (0069: kcal/protein/carb/fat are
  // "always known" and the day-total trigger sums them), so a macro the user
  // left blank is written as 0. The null in the draft is the UI's business —
  // it drives the "macros add up to" hint — and stops at this boundary.
  const macro = (v: number | null) => r1(Math.max(num(v), 0));
  const { error } = await supabase.from('meal_entries').insert({
    meal_id: mealId,
    food_id: null,
    food_name: quickAddName(draft),
    quantity: 1,
    serving_unit: QUICK_ADD_SERVING,
    grams_logged: null,
    kcal: r0(kcal),
    protein_g: macro(draft.protein_g), carb_g: macro(draft.carb_g), fat_g: macro(draft.fat_g),
    fiber_g: null, sugar_g: null, sat_fat_g: null, sodium_mg: null,
    position: count ?? 0,
    logged_via: 'manual',
  });
  if (error) {
    if (createdMeal) await supabase.from('meals').delete().eq('id', mealId);
    return { error: error.message };
  }
  track('meal_logged', {
    method: 'quick_add',
    item_count: 1,
    kcal: r0(kcal),
    meal_type: mealType,
    has_macros: draft.protein_g != null || draft.carb_g != null || draft.fat_g != null,
  });
  return {};
}
