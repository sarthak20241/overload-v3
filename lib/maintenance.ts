/**
 * The maintenance estimate on the Nutrition screen: one quiet row in the
 * macros card ("Maintenance about 2,290 kcal · Learning"), and on tap a sheet
 * that says what it has learned from and what would sharpen it.
 *
 * The number comes from the adaptive estimate (drona_week_facts m_*, migration
 * 20261017115750_drona_energy_facts): it starts at the app's own formula and
 * moves toward the person's real maintenance as weigh-ins and full days of food
 * arrive. The running week's row is rebuilt every day, so it moves daily;
 * calorie changes themselves stay weekly (the calorie check-in card).
 *
 * Pure: no imports, so Deno can test it (maintenance.test.ts).
 */

export type MaintenanceSource = 'guess' | 'learning' | 'measured' | 'no_body';

/** The m_* columns of the newest week row that has an estimate. */
export interface MaintenanceFacts {
  m_estimate_kcal: number | null;
  m_guess_kcal?: number | null;
  m_source: MaintenanceSource | string | null;
  m_data_weeks: number | string | null;
  m_readings_28: number | null;
  m_whole_days_28: number | null;
  m_last_weigh_in: string | null;
}

export interface MaintenanceView {
  source: 'guess' | 'learning' | 'measured';
  /** "2,290": the estimate on tens. */
  kcal: string;
  /** "Maintenance about 2,290 kcal" */
  headline: string;
  /** "First guess" / "Learning" / "Measured" */
  label: string;
  /** One sentence on where the number stands. */
  detail: string;
  /** What would sharpen it next, or keep it current. */
  next: string;
  /** The formula's own number, on tens, when there is one: what it started from. */
  guess: string | null;
  /** Weigh-ins and full days of food in the last 4 weeks, each capped at what a read needs. */
  readings: number;
  wholeDays: number;
  /** 0..1, how far the learning has got: 3 full data weeks make it measured. */
  progress: number;
  /**
   * The two counters ("4/8 weigh-ins", "6/14 full days logged"), each counted
   * over the last 4 weeks. The sheet always shows them.
   */
  counters: MaintenanceCounter[];
  /** Whether the row shows the counters: not once measured, nothing left to fill. */
  rowCounters: boolean;
}

export interface MaintenanceCounter {
  key: 'weigh_ins' | 'full_days';
  have: number;
  need: number;
  /** Plural, after the "have/need": "weigh-ins", "full days logged". */
  label: string;
}

/** The same lines the engine uses, so the words never promise more than it does. */
export const WEIGH_INS_FOR_A_READ = 8;
export const WHOLE_DAYS_FOR_A_READ = 14;
export const DATA_WEEKS_TO_MEASURE = 3;
export const STALE_AFTER_DAYS = 10;

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// Ten-kcal steps: the engine moves in whole kcal, but a number that looks exact
// to the unit claims more than any maintenance estimate knows.
const tens = (n: number) => thousands(Math.round(n / 10) * 10);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null;
}

/**
 * The row and sheet to show, or null when there is nothing honest to say (no
 * estimate, or no body numbers for even a first guess).
 */
export function maintenanceView(f: MaintenanceFacts | null | undefined, todayISO: string): MaintenanceView | null {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const est = num(f?.m_estimate_kcal);
  const source = f?.m_source;
  if (est == null || (source !== 'guess' && source !== 'learning' && source !== 'measured')) return null;

  const kcal = tens(est);
  const guessKcal = num(f?.m_guess_kcal);
  const readings = Math.min(f?.m_readings_28 ?? 0, WEIGH_INS_FOR_A_READ);
  const wholeDays = Math.min(f?.m_whole_days_28 ?? 0, WHOLE_DAYS_FOR_A_READ);
  const weeks = Number(f?.m_data_weeks ?? 0);
  const since = f?.m_last_weigh_in ? daysBetween(f.m_last_weigh_in, todayISO) : null;
  const stale = since == null || since > STALE_AFTER_DAYS;
  const counters: MaintenanceCounter[] = [
    { key: 'weigh_ins', have: readings, need: WEIGH_INS_FOR_A_READ, label: 'weigh-ins' },
    { key: 'full_days', have: wholeDays, need: WHOLE_DAYS_FOR_A_READ, label: 'full days logged' },
  ];
  const base = {
    kcal, headline: `Maintenance about ${kcal} kcal`,
    guess: guessKcal == null ? null : tens(guessKcal), readings, wholeDays, counters,
    rowCounters: source !== 'measured',
  };

  if (source === 'guess') {
    return {
      ...base, source, label: 'First guess', progress: 0,
      detail: 'A first guess from your stats. Your weigh-ins and full days of food will make it your own.',
      next: 'Weigh in on a few mornings and log full days. That is where your own number starts.',
    };
  }

  if (source === 'learning') {
    const needWeighIns = WEIGH_INS_FOR_A_READ - readings;
    const needDays = WHOLE_DAYS_FOR_A_READ - wholeDays;
    const asks = [
      needWeighIns > 0 ? plural(needWeighIns, 'more weigh-in', 'more weigh-ins') : null,
      needDays > 0 ? plural(needDays, 'more full day of food', 'more full days of food') : null,
    ].filter(Boolean);
    return {
      ...base, source, label: 'Learning',
      progress: Math.max(0, Math.min(1, (Number.isFinite(weeks) ? weeks : 0) / DATA_WEEKS_TO_MEASURE)),
      detail: 'Learning from your own weigh-ins and food. It moves a little every day.',
      next: asks.length
        ? `Next: ${asks.join(' and ')} in the next few weeks.`
        : 'Keep weighing in and logging full days. A few more weeks and it is measured.',
    };
  }

  return {
    ...base, source, label: 'Measured', progress: 1,
    detail: 'Measured from your own weigh-ins and food.',
    next: stale
      ? (since == null
        ? 'A weigh-in this week keeps it current.'
        : `Your last weigh-in was ${since} days ago. A weigh-in this week keeps it current.`)
      : 'Keep weighing in now and then to keep it current.',
  };
}
