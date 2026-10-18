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
 * No habit yet (habits need two days, so every new user starts here): a meal
 * is offered the day before's food for it instead, labelled as such
 * (withPreviousDay). It leaves as soon as the meal has food.
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
  /** 'weekday' when the habit belongs to this weekday more than to every day.
   *  'previous_day': not a habit at all, the day before's line, offered only
   *  while the meal has no learned habits yet (see withPreviousDay). */
  reason: 'daily' | 'weekday' | 'previous_day';
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
 * Only history strictly before both `forIso` and the real today counts, so
 * a row planned ahead, or the day's own food, never teaches the pattern it
 * is being compared with.
 */
export function learnPatterns(
  history: HistoryEntry[],
  forIso: string,
  /** The real today. Only days before BOTH it and `forIso` teach, so food
   *  planned ahead never becomes a habit, even when the day on screen is
   *  past the planned one. Defaults to `forIso`. */
  todayIso: string = forIso,
): Record<PatternMeal, FoodSuggestion[]> {
  const out: Record<PatternMeal, FoodSuggestion[]> = { breakfast: [], lunch: [], dinner: [], snack: [] };
  const weekday = dateOf(forIso).getDay();
  // Ages and weights count back from the earlier of the two, the last day
  // that can have been eaten rather than planned.
  const anchor = forIso < todayIso ? forIso : todayIso;
  const weight = (iso: string) => Math.pow(0.5, (daysBetween(iso, anchor) - 1) / HALF_LIFE_DAYS);

  const past = history.filter((e) => {
    const age = daysBetween(e.dayIso, anchor);
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
        // Label and numbers from the same row, so a name that differs only in
        // case or spacing can never sit over another row's portion.
        food_name: best.food_name.trim(),
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
      // "You usually have this too" is a habit's claim; the day before's
      // food makes no such claim, so it leaves once the meal has food.
      out[meal] = missing.filter((s) => s.usual && s.reason !== 'previous_day').slice(0, LOGGED_MEAL_LEFTOVERS);
      continue;
    }
    if (h != null && (h < OPENS[meal] || h >= STALE[meal])) continue;
    out[meal] = missing;
  }
  return out;
}

/**
 * Fill a meal that has no learned habits with the day before's lines for it,
 * so a new user (habits need two days) or a meal with no steady pattern still
 * starts from something. A meal with any habit keeps its habits only: the day
 * before's food is a weaker guess than a pattern. Each line is offered in its
 * own portion with its own numbers, in diary order, one row per food name.
 * They count as `usual`, so "Add all" logs the whole meal again.
 */
export function withPreviousDay(
  patterns: Record<PatternMeal, FoodSuggestion[]>,
  previous: Record<PatternMeal, HistoryEntry[]>,
): Record<PatternMeal, FoodSuggestion[]> {
  const out = { ...patterns };
  for (const meal of MEALS) {
    if (patterns[meal].length > 0) continue;
    const seen = new Set<string>();
    const rows: FoodSuggestion[] = [];
    for (const e of previous[meal] ?? []) {
      const k = nameKey(e.food_name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      rows.push({
        key: `${meal}:${k}`,
        meal_type: meal,
        food_id: e.food_id, food_name: e.food_name.trim(),
        quantity: e.quantity, serving_unit: e.serving_unit, grams_logged: e.grams_logged,
        kcal: e.kcal, protein_g: e.protein_g, carb_g: e.carb_g, fat_g: e.fat_g, fiber_g: e.fiber_g,
        source: e.source ?? null, logged_via: e.logged_via ?? null, tier: e.tier ?? null,
        score: 0, reason: 'previous_day', usual: true,
      });
    }
    out[meal] = rows.slice(0, MAX_PER_MEAL);
  }
  return out;
}

/** How a re-logged line is labelled. The food memory trusts 'manual' lines as
 *  the user's own numbers, so a copy must carry its original label or a
 *  copied AI estimate would be promoted. */
export interface RelogLabels { logged_via: 'ai' | 'manual' | null; tier: string | null }

/** The labels a past line carries into its copy. ai_auto means the server
 *  wrote the row itself; the copy is the client's, so it goes back as 'ai'.
 *  Anything unknown is null, the same as a picker log. */
export function relogLabels(e: { logged_via?: string | null; tier?: string | null }): RelogLabels {
  const v = e.logged_via;
  return {
    logged_via: v === 'manual' ? 'manual' : v === 'ai' || v === 'ai_auto' ? 'ai' : null,
    tier: e.tier ?? null,
  };
}

/** logged_via + tier to write for one line. A fresh parse is 'ai' with no
 *  tier (the stamp trigger fills it). A re-log keeps its labels, unless the
 *  user changed it in the review card (source 'manual'): then the numbers are
 *  theirs, and no parse tier describes them.
 *
 *  An 'ai' re-log with no tier can still be stamped by the trigger, when a
 *  parse in the last 6 hours produced the same food at the same kcal. That
 *  tier describes those exact numbers, so it is a fair label, and it can
 *  never make the line 'manual'. What this guarantees is the trust level:
 *  an estimate is never promoted to the user's own number. */
export function relogColumns(source: string | null | undefined, relog: RelogLabels | undefined): RelogLabels {
  if (!relog) return { logged_via: 'ai', tier: null };
  if (source === 'manual') return { logged_via: 'manual', tier: null };
  return relog;
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
