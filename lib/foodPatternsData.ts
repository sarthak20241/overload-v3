/**
 * Loads the diary history food patterns learn from, and writes a suggestion
 * or a copied meal back into the day.
 *
 * One request covers the pattern window before today plus every day the
 * diary can show ahead (latestLogDay), so the day on screen and the day
 * before it are both in hand for "copy yesterday's breakfast", whichever day
 * is showing. learnPatterns only reads days strictly before the day it is
 * asked about, so planned rows and today's own food never teach today.
 *
 * Paints from memory, then from disk, then revalidates: the suggestions are a
 * convenience and must never hold up the diary they sit in.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { hydrateCache, readCache, writeCache } from '@/lib/localCache';
import { latestLogDay } from '@/lib/logDay';
import { logParsedMeal, ymd, type LoggedParseRef, type ParsedMeal, type ParsedMealItem } from '@/lib/dietData';
import { PATTERN_WINDOW_DAYS, relogLabels, type HistoryEntry } from '@/lib/foodPatterns';
import type { MealType } from '@/lib/foods';

type Supa = NonNullable<ReturnType<typeof useSupabaseClient>>;
const num = (v: unknown) => (v == null ? 0 : Number(v));

/** Days of history before today. One extra so "yesterday" of the oldest
 *  pattern day is still in hand. */
const BACK_DAYS = PATTERN_WINDOW_DAYS + 1;

async function fetchHistory(supabase: Supa): Promise<HistoryEntry[] | null> {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACK_DAYS, 0, 0, 0, 0);
  const last = latestLogDay(now);
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59, 999);
  const { data, error } = await supabase
    .from('meals')
    .select('meal_type, logged_at, meal_entries(food_id, food_name, quantity, serving_unit, grams_logged, kcal, protein_g, carb_g, fat_g, fiber_g, source, logged_via, tier, position)')
    .gte('logged_at', first.toISOString())
    .lte('logged_at', end.toISOString())
    // Newest first, so if the row cap ever cuts this short, the oldest days
    // are what is lost, not an arbitrary set.
    .order('logged_at', { ascending: false });
  if (error || !data) return null;
  const out: (HistoryEntry & { position: number })[] = [];
  for (const m of data as any[]) {
    const dayIso = ymd(new Date(m.logged_at));
    for (const e of (m.meal_entries ?? []) as any[]) {
      out.push({
        dayIso, meal_type: (m.meal_type as MealType) ?? 'snack',
        food_id: e.food_id ?? null, food_name: String(e.food_name ?? ''),
        quantity: num(e.quantity) || 1, serving_unit: e.serving_unit ?? 'serving',
        grams_logged: e.grams_logged == null ? null : num(e.grams_logged),
        kcal: num(e.kcal), protein_g: num(e.protein_g), carb_g: num(e.carb_g), fat_g: num(e.fat_g),
        fiber_g: e.fiber_g == null ? null : num(e.fiber_g),
        source: e.source ?? null,
        logged_via: e.logged_via ?? null,
        tier: e.tier ?? null,
        position: num(e.position),
      });
    }
  }
  // Diary order within a day, so a copied meal lands in the order it was eaten.
  out.sort((a, b) => (a.dayIso < b.dayIso ? -1 : a.dayIso > b.dayIso ? 1 : a.position - b.position));
  return out.map(({ position: _p, ...e }) => e);
}

interface HistoryCache { key: string; entries: HistoryEntry[] }
let _mem: HistoryCache | null = null;

/**
 * The user's recent diary, for patterns and copying. `version` is anything
 * that changes when the diary does (the day's entry ids): a change refetches,
 * so a food logged a minute ago can be copied tomorrow without a restart.
 */
export function useFoodHistory(version: string | null): { history: HistoryEntry[] } {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  // v2: entries carry logged_via + tier. An older cache without them would
  // re-log with no label, so it is not read at all.
  const key = `v2:${user?.id ?? 'anon'}:${ymd(new Date())}`;
  const seed = _mem && _mem.key === key ? _mem.entries : null;
  const [history, setHistory] = useState<HistoryEntry[]>(seed ?? []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.id) return;
      if (!_mem || _mem.key !== key) {
        await hydrateCache(user.id);
        if (cancelled) return;
        const disk = readCache<HistoryCache>('foodHistory', user.id);
        if (disk && disk.key === key) { _mem = disk; setHistory(disk.entries); }
      }
      // null: the caller's diary is mid-load. Paint from cache, fetch once it lands.
      if (!supabase || version === null) return;
      const fresh = await fetchHistory(supabase);
      // A failed fetch keeps what is on screen: no suggestions beats wrong ones,
      // and stale ones from this morning are still this user's habits.
      if (cancelled || !fresh) return;
      _mem = { key, entries: fresh };
      writeCache<HistoryCache>('foodHistory', user.id, _mem);
      setHistory(fresh);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [supabase, user?.id, key, version]);

  return { history };
}

/** The lines of `dayIso`'s `meal`, in diary order. */
export function useDayMealLines(history: HistoryEntry[], dayIso: string) {
  return useMemo(() => {
    const by: Record<MealType, HistoryEntry[]> = { breakfast: [], lunch: [], dinner: [], snack: [] };
    for (const e of history) if (e.dayIso === dayIso) by[e.meal_type].push(e);
    return by;
  }, [history, dayIso]);
}

/** A past line as a parsed-meal line: the same numbers, nothing re-derived. */
export function lineAsItem(e: Omit<HistoryEntry, 'dayIso'>, mealType: MealType): ParsedMealItem {
  return {
    food_id: e.food_id, food_name: e.food_name,
    quantity: e.quantity, serving_label: e.serving_unit,
    grams: e.grams_logged ?? 0,
    kcal: e.kcal, protein_g: e.protein_g, carb_g: e.carb_g, fat_g: e.fat_g,
    fiber_g: e.fiber_g,
    // Kept as the original line's, null included: re-logging an estimate must
    // not promote it to a label or a user-checked number.
    source: (e.source ?? null) as ParsedMealItem['source'],
    assumption: null,
    confidence: 'high',
    meal_type: mealType,
    relog: relogLabels(e),
  };
}

/** Log past lines into `mealType` on `date`. Returns the ref Undo needs. */
export async function relogLines(
  supabase: Supa,
  lines: Omit<HistoryEntry, 'dayIso'>[],
  mealType: MealType,
  date: Date,
  via: 'pattern' | 'copy_day',
): Promise<{ ref?: LoggedParseRef; error?: string }> {
  if (lines.length === 0) return { error: 'Nothing to add' };
  const meal: ParsedMeal = {
    meal_type: mealType,
    items: lines.map((l) => lineAsItem(l, mealType)),
    drona_line: '',
  };
  return logParsedMeal(supabase, meal, date, via);
}
