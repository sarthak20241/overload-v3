/**
 * The maintenance line on the Nutrition screen: what Drona has learned about
 * the calories this body burns, in words a person can read in one glance.
 *
 * The number comes from the adaptive estimate (drona_week_facts m_*, migration
 * 20261017115750_drona_energy_facts): it starts at the app's own formula and
 * moves toward the person's real maintenance as weigh-ins and whole food days
 * arrive. The running week's row is rebuilt every day, so the line moves daily;
 * calorie changes themselves stay weekly (the calorie check-in card).
 *
 * Pure: no imports, so Deno can test it (maintenance.test.ts).
 */

export type MaintenanceSource = 'guess' | 'learning' | 'measured' | 'no_body';

/** The m_* columns of the newest week row that has an estimate. */
export interface MaintenanceFacts {
  m_estimate_kcal: number | null;
  m_source: MaintenanceSource | string | null;
  m_data_weeks: number | string | null;
  m_readings_28: number | null;
  m_whole_days_28: number | null;
  m_last_weigh_in: string | null;
}

export interface MaintenanceView {
  source: 'guess' | 'learning' | 'measured';
  /** "Maintenance about 2,290 kcal" */
  headline: string;
  /** "First guess" / "Learning" / "Measured" */
  label: string;
  detail: string;
  /** 0..1, how far the learning has got: 3 full data weeks make it measured. */
  progress: number;
}

/** The same lines the engine uses, so the words never promise more than it does. */
export const WEIGH_INS_FOR_A_READ = 8;
export const WHOLE_DAYS_FOR_A_READ = 14;
export const DATA_WEEKS_TO_MEASURE = 3;
export const STALE_AFTER_DAYS = 10;

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null;
}

/**
 * The line to show, or null when there is nothing honest to say (no estimate,
 * or no body numbers for even a first guess).
 */
export function maintenanceView(f: MaintenanceFacts | null | undefined, todayISO: string): MaintenanceView | null {
  const est = typeof f?.m_estimate_kcal === 'number' && Number.isFinite(f.m_estimate_kcal) ? f.m_estimate_kcal : null;
  const source = f?.m_source;
  if (est == null || (source !== 'guess' && source !== 'learning' && source !== 'measured')) return null;

  // Ten-kcal steps: the engine moves in whole kcal, but a number that looks
  // exact to the unit claims more than any maintenance estimate knows.
  const headline = `Maintenance about ${thousands(Math.round(est / 10) * 10)} kcal`;
  const readings = Math.min(f?.m_readings_28 ?? 0, WEIGH_INS_FOR_A_READ);
  const whole = Math.min(f?.m_whole_days_28 ?? 0, WHOLE_DAYS_FOR_A_READ);
  const weeks = Number(f?.m_data_weeks ?? 0);
  const since = f?.m_last_weigh_in ? daysBetween(f.m_last_weigh_in, todayISO) : null;

  if (source === 'guess') {
    return {
      source, headline, label: 'First guess', progress: 0,
      detail: 'From your stats. Weigh-ins and whole food days will make it your own.',
    };
  }
  if (source === 'learning') {
    return {
      source, headline, label: 'Learning',
      progress: Math.max(0, Math.min(1, (Number.isFinite(weeks) ? weeks : 0) / DATA_WEEKS_TO_MEASURE)),
      detail: `Learning from your body: ${readings} of ${WEIGH_INS_FOR_A_READ} weigh-ins and ${whole} of ${WHOLE_DAYS_FOR_A_READ} whole food days in the last 4 weeks.`,
    };
  }
  return {
    source, headline, label: 'Measured', progress: 1,
    detail: since == null || since > STALE_AFTER_DAYS
      ? (since == null
        ? 'Measured from your own weigh-ins and food. A weigh-in this week keeps it current.'
        : `Measured from your own weigh-ins and food. Your last weigh-in was ${since} days ago.`)
      : 'Measured from your own weigh-ins and food.',
  };
}
