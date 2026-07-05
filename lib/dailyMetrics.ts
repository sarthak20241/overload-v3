/**
 * Holistic tracking descriptor layer (integration-first). The analog of the
 * METRIC_TYPES table in lib/exercises.ts, but for daily HEALTH metrics that are
 * READ from Apple HealthKit / Android Health Connect (with a manual fallback)
 * and mirrored into the `daily_metrics` table (migration 0071).
 *
 * One closed vocabulary, one descriptor list, safe normalizers. The DB mirrors
 * this in the daily_metrics.metric_type check constraint. Plan:
 * .planning/holistic-tracking-plan.md.
 */
import { abbreviateNumber, formatSleepMinutes, formatWeight } from './format';

/** The stored scalar metrics. Mirrors the daily_metrics.metric_type check. */
export type DailyMetricType =
  | 'steps'
  | 'sleep_minutes'
  | 'bodyweight_kg'
  | 'resting_hr_bpm'
  | 'hrv_sdnn_ms'
  | 'active_energy_kcal'
  | 'readiness_score';

/** Where a row came from. Mirrors the daily_metrics.source check. */
export type MetricSource = 'healthkit' | 'health_connect' | 'manual';

/**
 * How same-day samples collapse to the single stored daily value. The platform
 * read does the actual aggregation (HKStatisticsCollectionQuery /
 * aggregateGroupByPeriod); this is metadata for trend math + UI labels.
 *  - 'sum'  cumulative across the day (steps, active energy)
 *  - 'last' a daily point value (bodyweight, RHR, HRV, the night's sleep total,
 *           the derived readiness score)
 */
export type DailyAggregation = 'sum' | 'last';

export interface DailyMetricDef {
  type: DailyMetricType;
  /** TrendCard / card title. */
  label: string;
  /** Compact label for dense rows. */
  shortLabel: string;
  /** Unit shown to the user. */
  unit: string;
  /** Canonical stored unit; what daily_metrics.value holds for this type. */
  storedUnit: string;
  /** Feather glyph (provisional; revisit in the icon polish pass). */
  icon: string;
  /** Key to add to Colors.stat in constants/theme.ts in the UI phase (one color per metric). */
  colorKey: string;
  aggregation: DailyAggregation;
  /** Daily metrics never grant XP; engagement is via streaks (plan section 7). */
  grantsXp: false;
  /** True for app-computed values (readiness) rather than mirrored/manual ones. */
  derived: boolean;
  /** Format a stored value for display, unit included. */
  format: (value: number) => string;
}

const intUnit = (unit: string) => (v: number) => `${Math.round(v)} ${unit}`;

/** Authoritative descriptor list, drives the TrendCards and any metric pickers. */
export const DAILY_METRICS: DailyMetricDef[] = [
  {
    type: 'steps', label: 'Steps', shortLabel: 'Steps', unit: 'steps', storedUnit: 'count',
    icon: 'activity', colorKey: 'steps', aggregation: 'sum', grantsXp: false, derived: false,
    format: (v) => `${abbreviateNumber(v)} steps`,
  },
  {
    type: 'sleep_minutes', label: 'Sleep', shortLabel: 'Sleep', unit: 'h:m', storedUnit: 'minutes',
    icon: 'moon', colorKey: 'sleep', aggregation: 'last', grantsXp: false, derived: false,
    format: (v) => formatSleepMinutes(v),
  },
  {
    type: 'bodyweight_kg', label: 'Bodyweight', shortLabel: 'Weight', unit: 'kg', storedUnit: 'kg',
    icon: 'trending-up', colorKey: 'bodyweight', aggregation: 'last', grantsXp: false, derived: false,
    format: (v) => `${formatWeight(v)} kg`,
  },
  {
    type: 'resting_hr_bpm', label: 'Resting heart rate', shortLabel: 'RHR', unit: 'bpm', storedUnit: 'bpm',
    icon: 'heart', colorKey: 'resting_hr', aggregation: 'last', grantsXp: false, derived: false,
    format: intUnit('bpm'),
  },
  {
    type: 'hrv_sdnn_ms', label: 'Heart rate variability', shortLabel: 'HRV', unit: 'ms', storedUnit: 'ms',
    icon: 'wind', colorKey: 'hrv', aggregation: 'last', grantsXp: false, derived: false,
    format: intUnit('ms'),
  },
  {
    type: 'active_energy_kcal', label: 'Active energy', shortLabel: 'Energy', unit: 'kcal', storedUnit: 'kcal',
    icon: 'zap', colorKey: 'active_energy', aggregation: 'sum', grantsXp: false, derived: false,
    format: (v) => `${abbreviateNumber(v)} kcal`,
  },
  {
    type: 'readiness_score', label: 'Readiness', shortLabel: 'Readiness', unit: '/100', storedUnit: 'score',
    icon: 'sun', colorKey: 'readiness', aggregation: 'last', grantsXp: false, derived: true,
    format: (v) => `${Math.round(v)}`,
  },
];

const BY_TYPE: Record<DailyMetricType, DailyMetricDef> = Object.fromEntries(
  DAILY_METRICS.map((m) => [m.type, m]),
) as Record<DailyMetricType, DailyMetricDef>;

/** Is this string a known daily metric type? */
export function isDailyMetricType(v: string | null | undefined): v is DailyMetricType {
  return !!v && Object.hasOwn(BY_TYPE, v);
}

/** Descriptor for a metric type, or undefined if unknown (callers decide the fallback). */
export function dailyMetricDef(type: string | null | undefined): DailyMetricDef | undefined {
  return type && Object.hasOwn(BY_TYPE, type) ? BY_TYPE[type as DailyMetricType] : undefined;
}

/** Format a stored value for a given metric type; empty string if the type/value is unusable. */
export function formatDailyMetric(
  type: string | null | undefined,
  value: number | null | undefined,
): string {
  const def = dailyMetricDef(type);
  if (!def || value == null || !Number.isFinite(value)) return '';
  return def.format(value);
}
