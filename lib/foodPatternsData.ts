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

/** Days of history before the anchor day. One extra so "yesterday" of the
 *  oldest pattern day is still in hand. */
const BACK_DAYS = PATTERN_WINDOW_DAYS + 1;

/**
 * The window counts back from `anchorIso`: today, or the day on screen when
 * that is in the past, so a day looked at months later still gets its own
 * four weeks and its day before. From today it runs ahead to latestLogDay
 * (planned days, for copying while planning); from a past day it stops at
 * that day, since nothing after it can teach it.
 */
async function fetchHistory(supabase: Supa, anchorIso: string): Promise<HistoryEntry[] | null> {
  const now = new Date();
  const [y, m, d] = anchorIso.split('-').map(Number);
  const anchor = new Date(y, (m || 1) - 1, d || 1);
  const past = anchorIso < ymd(now);
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - BACK_DAYS, 0, 0, 0, 0);
  const last = past ? anchor : latestLogDay(now);
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

/** `fetched`: these entries came from the server in this app session, not
 *  only from the disk cache. Never written to disk as true. */
interface HistoryCache { key: string; entries: HistoryEntry[]; fetched?: boolean }
/** One shared empty list, so an empty history keeps its identity. */
const NO_ENTRIES: HistoryEntry[] = [];
let _mem: HistoryCache | null = null;

/**
 * The user's recent diary, for patterns and copying. `version` is anything
 * that changes when the diary does (the day's entry ids): a change refetches,
 * so a food logged a minute ago can be copied tomorrow without a restart.
 */
export function useFoodHistory(version: string | null, anchorIso: string): {
  history: HistoryEntry[];
  /** A fresh fetch for this window has landed. Until then an empty history
   *  may just mean "not here yet", which a caller deciding "this user has
   *  never done X" must not read as "never". */
  loaded: boolean;
} {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  // v2: entries carry logged_via + tier. An older cache without them would
  // re-log with no label, so it is not read at all.
  const key = `v2:${user?.id ?? 'anon'}:${ymd(new Date())}:${anchorIso}`;
  const seedMem = _mem && _mem.key === key ? _mem : null;
  const seed = seedMem ? seedMem.entries : null;
  // Entries are kept with the window they belong to. On a day change the old
  // window's entries are never shown for the new one, so no suggestion from
  // the wrong four weeks flashes up while the new window loads.
  const [state, setState] = useState<HistoryCache>({ key, entries: seed ?? [], fetched: !!seedMem?.fetched });
  const setHistory = (entries: HistoryEntry[], fetched: boolean) => setState({ key, entries, fetched });
  const history = state.key === key ? state.entries : seed ?? NO_ENTRIES;
  const loaded = state.key === key ? !!state.fetched : !!seedMem?.fetched;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.id) return;
      if (!_mem || _mem.key !== key) {
        await hydrateCache(user.id);
        if (cancelled) return;
        const disk = readCache<HistoryCache>('foodHistory', user.id);
        if (disk && disk.key === key) { _mem = { key: disk.key, entries: disk.entries }; setHistory(disk.entries, false); }
      }
      // null: the caller's diary is mid-load. Paint from cache, fetch once it lands.
      if (!supabase || version === null) return;
      const fresh = await fetchHistory(supabase, anchorIso);
      // A failed fetch keeps what is on screen: no suggestions beats wrong ones,
      // and stale ones from this morning are still this user's habits.
      if (cancelled || !fresh) return;
      _mem = { key, entries: fresh, fetched: true };
      // Disk holds one slot, and a cold start always opens on today, so only
      // today's window is worth keeping there. Browsing past days would
      // otherwise overwrite it on every day change.
      if (anchorIso === ymd(new Date())) writeCache<HistoryCache>('foodHistory', user.id, { key, entries: fresh });
      setHistory(fresh, true);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [supabase, user?.id, key, version, anchorIso]);

  return { history, loaded };
}

/** The lines of `dayIso`'s `meal`, in diary order. History runs ahead to
 *  latestLogDay, so when the day on screen is two or more days out, the day
 *  before it is a planned day and these are planned lines. That is on purpose:
 *  planning a week means copying the day you just planned. Learning never
 *  reads planned days (learnPatterns stops at today). */
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
