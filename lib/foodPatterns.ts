/**
 * Food patterns: what this user eats again and again, and when to offer it.
 *
 * Two kinds of habit, read off the last few weeks of the diary:
 *   - daily: the same food in the same meal on most days ("oats at breakfast")
 *   - weekly: the same food in the same meal on one weekday ("pizza on Sunday
 *     dinner"), which a daily rate would bury under the other six days
 *
 * Rates are taken over the days the user LOGGED that meal, not over calendar
 * days. Someone who logs four days a week and has eggs every one of them has
 * eggs 100% of the time, not 57%. Recent days count more (a 14-day half-life),
 * so a habit the user dropped a month ago fades instead of lingering.
 *
 * The portion offered is the one they log most often for that food, latest
 * wins a tie, with that entry's own numbers. Nothing is re-derived: a
 * suggestion is a copy of something they really logged.
 *
 * When to offer (mealsToSuggest): a meal opens at its usual hour and stays
 * open until it is logged or two meals later (breakfast is still offered at
 * lunch if it was skipped, but not at dinner). Once a meal has food in it,
 * only its strong usuals that are still missing stay ("the coffee you always
 * have with it"). Another day than today (backfill or planning ahead) has no
 * clock, so every meal is open.
 *
 * No imports, so Deno tests it directly: deno test --allow-all lib/foodPatterns.test.ts
 */

export type PatternMeal = 'breakfast' | 'lunch' | 'dinner' | 'snack';
const MEALS: PatternMeal[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/** One logged diary line, as the history loader hands it over. */
export interface HistoryEntry {
  /** Local calendar day, YYYY-MM-DD. */
  dayIso: string;
  meal_type: PatternMeal;
  food_id: string | null;
  food_name: string;
  quantity: number;
  serving_unit: string;
  grams_logged: number | null;
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null;
  source?: string | null;
  /** How the original line was written, and the tier its numbers came from.
   *  A re-log carries both over, so an estimate stays an estimate. */
  logged_via?: string | null;
  tier?: string | null;
}

export interface FoodSuggestion {
  /** Stable across renders: meal + food name key. */
  key: string;
  meal_type: PatternMeal;
  food_id: string | null;
  food_name: string;
  quantity: number;
  serving_unit: string;
  grams_logged: number | null;
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null;
  source: string | null;
  logged_via: string | null;
  tier: string | null;
  /** 0..1, the larger of the daily and weekday rates. Sorts the list. */
  score: number;
  /** 'weekday' when the habit belongs to this weekday more than to every day. */
  reason: 'daily' | 'weekday';
  /** Had in more than half of this meal's logged days: part of "your usual". */
  usual: boolean;
}

export const PATTERN_WINDOW_DAYS = 28;
const HALF_LIFE_DAYS = 14;
/** Seen on fewer days than this is a one-off, not a habit. */
const MIN_DAYS = 2;
const DAILY_MIN_RATE = 0.3;
const WEEKDAY_MIN_RATE = 0.5;
const USUAL_RATE = 0.5;
const MAX_PER_MEAL = 8;

const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const portionKey = (e: { quantity: number; serving_unit: string }) =>
  `${Math.round(e.quantity * 100) / 100}|${(e.serving_unit ?? '').trim().toLowerCase()}`;

function dateOf(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
/** Whole days from `a` to `b` (local dates, DST-safe by rounding). */
function daysBetween(a: string, b: string): number {
  return Math.round((dateOf(b).getTime() - dateOf(a).getTime()) / 86_400_000);
}

/**
 * Suggestions for `forIso` (the day on screen), grouped by meal, best first.
 * Only history strictly BEFORE `forIso` counts, so a planned future row or
 * today's own food never teaches the pattern it is being compared with.
 */
export function learnPatterns(
  history: HistoryEntry[],
  forIso: string,
): Record<PatternMeal, FoodSuggestion[]> {
  const out: Record<PatternMeal, FoodSuggestion[]> = { breakfast: [], lunch: [], dinner: [], snack: [] };
  const weekday = dateOf(forIso).getDay();
  const weight = (iso: string) => Math.pow(0.5, (daysBetween(iso, forIso) - 1) / HALF_LIFE_DAYS);

  const past = history.filter((e) => {
    const age = daysBetween(e.dayIso, forIso);
    return age >= 1 && age <= PATTERN_WINDOW_DAYS && nameKey(e.food_name) !== '';
  });

  for (const meal of MEALS) {
    const rows = past.filter((e) => e.meal_type === meal);
    const mealDays = new Set(rows.map((e) => e.dayIso));
    const mealWeight = [...mealDays].reduce((t, d) => t + weight(d), 0);
    const sameWdDays = [...mealDays].filter((d) => dateOf(d).getDay() === weekday);
    if (mealDays.size === 0) continue;

    const byFood = new Map<string, HistoryEntry[]>();
    for (const e of rows) {
      const k = nameKey(e.food_name);
      if (!byFood.has(k)) byFood.set(k, []);
      byFood.get(k)!.push(e);
    }

    const list: FoodSuggestion[] = [];
    for (const [k, entries] of byFood) {
      const days = new Set(entries.map((e) => e.dayIso));
      if (days.size < MIN_DAYS) continue;
      const dailyRate = [...days].reduce((t, d) => t + weight(d), 0) / (mealWeight || 1);
      const wdSeen = [...days].filter((d) => dateOf(d).getDay() === weekday).length;
      const weekdayRate = sameWdDays.length >= 2 ? wdSeen / sameWdDays.length : 0;
      const weeklyHabit = wdSeen >= 2 && weekdayRate >= WEEKDAY_MIN_RATE;
      if (dailyRate < DAILY_MIN_RATE && !weeklyHabit) continue;
      const score = Math.max(dailyRate, weeklyHabit ? weekdayRate : 0);

      // Most-logged portion; the latest entry breaks a tie and supplies the numbers.
      const latestFirst = [...entries].sort((a, b) => (a.dayIso < b.dayIso ? 1 : a.dayIso > b.dayIso ? -1 : 0));
      const counts = new Map<string, number>();
      for (const e of latestFirst) counts.set(portionKey(e), (counts.get(portionKey(e)) ?? 0) + 1);
      let best = latestFirst[0];
      for (const e of latestFirst) {
        if ((counts.get(portionKey(e)) ?? 0) > (counts.get(portionKey(best)) ?? 0)) best = e;
      }

      list.push({
        key: `${meal}:${k}`,
        meal_type: meal,
        food_id: best.food_id,
        food_name: latestFirst[0].food_name.trim(),
        quantity: best.quantity,
        serving_unit: best.serving_unit,
        grams_logged: best.grams_logged,
        kcal: best.kcal, protein_g: best.protein_g, carb_g: best.carb_g, fat_g: best.fat_g,
        fiber_g: best.fiber_g,
        source: best.source ?? null,
        logged_via: best.logged_via ?? null,
        tier: best.tier ?? null,
        score,
        reason: weeklyHabit && weekdayRate > dailyRate + 0.15 ? 'weekday' : 'daily',
        usual: score >= USUAL_RATE,
      });
    }
    list.sort((a, b) => b.score - a.score || a.food_name.localeCompare(b.food_name));
    out[meal] = list.slice(0, MAX_PER_MEAL);
  }
  return out;
}

/** The hour each meal starts being offered, and the hour it goes stale if
 *  it was never logged (the window two meals later opens). Snacks have no
 *  fixed time, so they open mid-morning and stay until the night ends. */
const OPENS: Record<PatternMeal, number> = { breakfast: 4, lunch: 11, dinner: 16, snack: 10 };
const STALE: Record<PatternMeal, number> = { breakfast: 16, lunch: 22, dinner: 28, snack: 28 };
/** How many still-missing usuals a meal that already has food keeps showing. */
const LOGGED_MEAL_LEFTOVERS = 2;

/**
 * What to show in each meal section right now. `logged` is the day's entries
 * by meal (names only matter); `hour` is the local clock for today, or null
 * for any other day, where every meal is open.
 */
export function mealsToSuggest(
  patterns: Record<PatternMeal, FoodSuggestion[]>,
  logged: Record<PatternMeal, { food_name: string }[]>,
  hour: number | null,
): Record<PatternMeal, FoodSuggestion[]> {
  const out: Record<PatternMeal, FoodSuggestion[]> = { breakfast: [], lunch: [], dinner: [], snack: [] };
  // 00:00-03:59 still belongs to the night before: dinner and snacks, nothing new.
  const h = hour == null ? null : hour < 4 ? hour + 24 : hour;
  for (const meal of MEALS) {
    const have = new Set((logged[meal] ?? []).map((e) => nameKey(e.food_name)));
    const missing = patterns[meal].filter((s) => !have.has(nameKey(s.food_name)));
    if (have.size > 0) {
      out[meal] = missing.filter((s) => s.usual).slice(0, LOGGED_MEAL_LEFTOVERS);
      continue;
    }
    if (h != null && (h < OPENS[meal] || h >= STALE[meal])) continue;
    out[meal] = missing;
  }
  return out;
}

/** The previous day's lines for one meal that are not already in it today,
 *  for "copy yesterday's breakfast". Matched by name, so copying twice does
 *  not double the food. */
export function copyableFromDay(
  previous: { food_name: string }[],
  current: { food_name: string }[],
): number[] {
  const have = new Set(current.map((e) => nameKey(e.food_name)));
  const idx: number[] = [];
  previous.forEach((e, i) => { if (!have.has(nameKey(e.food_name))) idx.push(i); });
  return idx;
}
