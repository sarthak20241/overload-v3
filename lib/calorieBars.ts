/**
 * The Analytics calorie bars: one bar per day against that day's own goal.
 *
 * Users found the old line chart unhelpful: it scaled to the period's own
 * lowest and highest day, so a 150 kcal dip read like a cliff, and it never
 * showed the goal. Bars against a range answer the question they actually ask
 * ("did I land where I meant to?"), the way MyFitnessPal's weekly view does.
 *
 * Pure (no React, no Supabase) so it is tested with Deno.
 */

/** The range around a day's goal that counts as on target: goal ±10%. */
export const RANGE_PCT = 0.1;

export type BarStatus = 'none' | 'under' | 'in' | 'over';

export interface CalorieBar {
  dayIso: string;
  kcal: number;
  goal: number;
  lo: number;
  hi: number;
  /** none: nothing logged that day. */
  status: BarStatus;
  /** Today is still going: drawn lighter, and left out of the summary. */
  today: boolean;
}

export interface CalorieBarSummary {
  /** Finished days with food logged and a goal to judge them by (today is
   *  not finished; a day with no goal has no range to land in). */
  logged: number;
  /** Of those, the days that landed inside their range. */
  inRange: number;
  /** Mean kcal over every finished logged day, goal or not. Null when none. */
  avgKcal: number | null;
}

export function rangeFor(goal: number): { lo: number; hi: number } {
  const g = Number.isFinite(goal) && goal > 0 ? goal : 0;
  return { lo: Math.round(g * (1 - RANGE_PCT)), hi: Math.round(g * (1 + RANGE_PCT)) };
}

export function statusFor(kcal: number, goal: number): BarStatus {
  const k = Math.round(kcal);
  if (!(k > 0)) return 'none';
  const { lo, hi } = rangeFor(goal);
  // No goal to judge against: the day is logged, and nothing more can be said.
  if (hi <= 0) return 'in';
  if (k < lo) return 'under';
  if (k > hi) return 'over';
  return 'in';
}

/**
 * One bar per day, oldest first, each judged against `goalFor(dayIso)` (the
 * goal as it stood that day: fuel days, one-day goals and past changes all
 * differ). Today is drawn but not counted: half a day under its goal is not a
 * miss.
 */
export function calorieBars(
  days: Array<{ dayIso: string; kcal: number }>,
  goalFor: (dayIso: string) => number,
  todayIso: string,
): { bars: CalorieBar[]; summary: CalorieBarSummary } {
  const bars = days.map((d) => {
    const goal = Math.round(goalFor(d.dayIso));
    const kcal = Math.round(d.kcal);
    return { dayIso: d.dayIso, kcal, goal, ...rangeFor(goal), status: statusFor(kcal, goal), today: d.dayIso === todayIso };
  });
  const done = bars.filter((b) => !b.today && b.status !== 'none');
  const judged = done.filter((b) => b.hi > 0);
  return {
    bars,
    summary: {
      logged: judged.length,
      inRange: judged.filter((b) => b.status === 'in').length,
      avgKcal: done.length ? Math.round(done.reduce((a, b) => a + b.kcal, 0) / done.length) : null,
    },
  };
}

/** The periods the card can show, in days. */
export const PERIODS = [7, 14, 30] as const;
export type PeriodDays = (typeof PERIODS)[number];

/** How far back the card can step: about a year. */
export const MAX_DAYS_BACK = 365;

/**
 * The days a period covers. offset 0 ends today; offset 1 is the period just
 * before it, and so on. Local calendar days, oldest first.
 */
export function periodFor(today: Date, days: number, offset: number): { start: Date; end: Date } {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset * days);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1));
  return { start, end };
}

/** Whether one more step back stays inside MAX_DAYS_BACK. */
export function canStepBack(days: number, offset: number): boolean {
  return (offset + 1) * days + days - 1 <= MAX_DAYS_BACK;
}

/** Show every nth day label so about seven fit: 7 days every day, 14 every
 *  other day, 30 every fifth. Counted back from the newest day, so it always
 *  has its label. */
export function labelEvery(n: number): number {
  return Math.max(1, Math.ceil(n / 7));
}
