/**
 * Which goal a day is held to.
 *
 * user_profiles holds ONE goal, so every reader used to draw every day against
 * today's number: lower the calories and last week's rings were redrawn, days
 * that were hit turning into days that were over. A goal change applies from
 * the day it is made. user_target_history (0150) keeps a snapshot per day the
 * goal changed; a past day reads the snapshot in force on it, today and later
 * read the live goal.
 *
 * Pure on purpose: no imports beyond the fuel-day rules, so `deno test` reaches
 * it and the app and the edge functions share one answer.
 */
import { type DayTargets, type FuelDay, normalizeFuelDays, targetsOnDow } from './fuelDays.ts';

export interface TargetHistoryRow {
  /** YYYY-MM-DD, the user's local day the snapshot starts. */
  effective_from: string;
  kcal: number | string | null;
  protein_g: number | string | null;
  carb_g: number | string | null;
  fat_g: number | string | null;
  calorie_day_boosts?: unknown;
}

/** The snapshot in force on a day: the latest one that started on or before it. */
export function historyRowOn(rows: TargetHistoryRow[], dayISO: string): TargetHistoryRow | null {
  let best: TargetHistoryRow | null = null;
  for (const r of rows) {
    if (r.effective_from <= dayISO && (!best || r.effective_from > best.effective_from)) best = r;
  }
  return best;
}

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};

/**
 * The targets for one day, fuel days included.
 *   - today or later: the live goal and live fuel days
 *   - a past day: the snapshot in force on it; a field it never set falls back
 *     to `defaults`, the same way a profile without that target does
 *   - a past day with no history to read (not loaded, or older than every row):
 *     the live goal, which is what every day showed before 0150
 */
export function targetsForDay(input: {
  dayISO: string;
  todayISO: string;
  dow: number;
  live: DayTargets;
  liveFuel: FuelDay[];
  history: TargetHistoryRow[] | null | undefined;
  defaults: DayTargets;
}): DayTargets {
  const { dayISO, todayISO, dow, live, liveFuel, history, defaults } = input;
  if (dayISO >= todayISO || !history || history.length === 0) {
    return targetsOnDow(live, liveFuel, dow);
  }
  const row = historyRowOn(history, dayISO);
  if (!row) return targetsOnDow(live, liveFuel, dow);
  const base: DayTargets = {
    kcal: num(row.kcal, defaults.kcal),
    protein: num(row.protein_g, defaults.protein),
    carb: num(row.carb_g, defaults.carb),
    fat: num(row.fat_g, defaults.fat),
  };
  return targetsOnDow(base, normalizeFuelDays(row.calorie_day_boosts), dow);
}
