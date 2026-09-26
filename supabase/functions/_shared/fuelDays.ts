/**
 * Fuel days: a bigger calorie target on the days the user works hardest.
 *
 * A phase has one daily target. Real weeks do not: a Sunday long run or a
 * Saturday heavy leg day burns far more than a desk day, and holding those
 * days to the same number reads as "you went over" when the user ate right.
 * A fuel day adds calories on top of the base target for one weekday.
 *
 *   - Keyed by the REAL weekday (0 Sunday .. 6 Saturday, the same numbering as
 *     Date.getDay() and Postgres extract(dow)). Unlike the Day 1..7 training
 *     line, a long run lives on a calendar day, not a slot in a rotation.
 *   - The extra comes as carbs. Protein and fat hold, so the four targets
 *     still add up (4 kcal per gram of carbohydrate).
 *   - On top, not shifted: the other days keep their number. The work on a
 *     fuel day burns what it adds.
 *
 * Two layers, like the calorie target itself:
 *   - coach_program_phases.diet_fuel_days: what the coach PLANNED for a phase,
 *     set in conversation ("my long run is Sunday") via generate_program.
 *   - user_profiles.calorie_day_boosts: what is LIVE. Every reader uses this.
 *     A phase's fuel days are mirrored here when the phase starts, and the
 *     user can edit them by hand. A phase that says nothing (null) leaves the
 *     live ones alone; an empty list clears them.
 *
 * Pure on purpose: no imports, so `deno test` reaches it and the app and the
 * edge functions share one set of rules.
 */

export interface FuelDay {
  /** 0 Sunday .. 6 Saturday. */
  dow: number;
  /** Extra calories on this day, on top of the base target. */
  kcal: number;
  /** What the day is for, in the user's words: "Long run", "Heavy legs". */
  label?: string;
}

export interface DayTargets { kcal: number; protein: number; carb: number; fat: number }

export const FUEL_STEP = 50;
export const FUEL_MIN = 50;
export const FUEL_MAX = 1000;
/** What a newly picked day starts at. */
export const FUEL_DEFAULT = 300;
const MAX_LABEL = 24;

/** Monday first: the order people read a week in. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Only what the app can stand behind: one entry per weekday, a whole weekday,
 * extra calories on the 50 grid inside 50..1000, a short label. Anything else
 * is dropped rather than guessed at, so a hand-edited row can never push a
 * target somewhere the UI could not have put it.
 */
export function normalizeFuelDays(v: unknown): FuelDay[] {
  if (!Array.isArray(v)) return [];
  const byDow = new Map<number, FuelDay>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const dow = typeof r.dow === 'number' ? r.dow : Number.NaN;
    const kcal = typeof r.kcal === 'number' ? r.kcal : Number.NaN;
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    if (!Number.isFinite(kcal)) continue;
    const snapped = Math.round(kcal / FUEL_STEP) * FUEL_STEP;
    if (snapped < FUEL_MIN) continue;
    const day: FuelDay = { dow, kcal: Math.min(FUEL_MAX, snapped) };
    const label = typeof r.label === 'string' ? r.label.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) : '';
    if (label) day.label = label;
    byDow.set(dow, day);
  }
  return WEEK_ORDER.flatMap((d) => (byDow.has(d) ? [byDow.get(d)!] : []));
}

/** The fuel day on a weekday, if there is one. */
export function fuelOn(days: FuelDay[], dow: number): FuelDay | null {
  return days.find((d) => d.dow === dow) ?? null;
}

/** 0 Sunday .. 6 Saturday for a YYYY-MM-DD date, with no time zone involved. */
export function dowOfISO(iso: string): number {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The targets for one weekday: the base, plus that day's fuel as carbs. */
export function targetsOnDow(base: DayTargets, days: FuelDay[], dow: number): DayTargets {
  const fuel = fuelOn(days, dow);
  if (!fuel) return base;
  return {
    kcal: base.kcal + fuel.kcal,
    protein: base.protein,
    carb: base.carb + Math.round(fuel.kcal / 4),
    fat: base.fat,
  };
}

/** The calorie target on one weekday. */
export function kcalOnDow(baseKcal: number, days: FuelDay[], dow: number): number {
  return baseKcal + (fuelOn(days, dow)?.kcal ?? 0);
}

/** A whole week of eating to plan: seven base days plus every fuel day. */
export function weekKcal(baseKcal: number, days: FuelDay[]): number {
  return baseKcal * 7 + days.reduce((s, d) => s + d.kcal, 0);
}

/** A short line for a label-less day: "Sat +300". With a label: "Sat Long run +300". */
export function fuelDayText(d: FuelDay): string {
  return [DAY_SHORT[d.dow], d.label, `+${d.kcal}`].filter(Boolean).join(' ');
}

/**
 * The coach's emission (generate_program, per phase) as fuel days. The model
 * names days ("Sunday") and says `extra_kcal`, because it should never have to
 * count weekdays from zero. Returns undefined when the field is absent or not a
 * list: the phase says nothing about fuel days, so the live ones are kept. A
 * list, even an empty one, is an answer.
 */
export function fuelDaysFromCoach(v: unknown): FuelDay[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const raw = v.map((e) => {
    if (!e || typeof e !== 'object') return null;
    const r = e as Record<string, unknown>;
    const name = typeof r.day === 'string' ? r.day.trim().toLowerCase() : '';
    const full = DAY_NAMES.findIndex((d) => d.toLowerCase() === name);
    const dow = full >= 0 ? full : DAY_SHORT.findIndex((d) => d.toLowerCase() === name);
    return { dow, kcal: r.extra_kcal ?? r.kcal, label: r.label };
  });
  return normalizeFuelDays(raw);
}

/** One line for a prompt or a card: "Sat Heavy legs +300, Sun Long run +300", or "none". */
export function fuelDaysText(days: FuelDay[]): string {
  return days.length === 0 ? 'none' : days.map(fuelDayText).join(', ');
}
