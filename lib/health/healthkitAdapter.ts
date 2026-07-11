/**
 * iOS HealthKit adapter (read-only) for the holistic healthSync pipeline.
 *
 * APIs verified against @kingstinct/react-native-healthkit v14.0.2 installed
 * types. Cumulative metrics (steps, active energy) use statistics collection
 * (which de-dupes overlapping iPhone/Watch samples); discrete metrics use the
 * daily average or latest. Sleep is a category type summed from asleep stages.
 *
 * iOS never reports whether READ access was granted, so we always query and
 * treat empty results as "no data" (see plan section 4, the read-denial quirk).
 * Plan: .planning/holistic-tracking-plan.md.
 */
import {
  isHealthDataAvailableAsync,
  requestAuthorization,
  queryStatisticsCollectionForQuantity,
  queryCategorySamples,
  CategoryValueSleepAnalysis,
} from '@kingstinct/react-native-healthkit';
import type { DailyReading, HealthAdapter, ReadableMetric } from '../healthSync';

const READ_TYPES = [
  'HKQuantityTypeIdentifierStepCount',
  'HKQuantityTypeIdentifierActiveEnergyBurned',
  'HKQuantityTypeIdentifierRestingHeartRate',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  'HKQuantityTypeIdentifierBodyMass',
  'HKCategoryTypeIdentifierSleepAnalysis',
] as const;

type Stat = 'cumulativeSum' | 'discreteAverage' | 'mostRecent';
type StatField = 'sumQuantity' | 'averageQuantity' | 'mostRecentQuantity';

interface QuantitySpec {
  metric: Exclude<ReadableMetric, 'sleep_minutes'>;
  identifier: string;
  unit: string;
  stat: Stat;
  field: StatField;
  round: boolean;
}

// Steps/energy are cumulative (sum, cross-source de-duped); RHR/HRV are discrete
// (daily average); bodyweight is latest-of-day. HRV SDNN's unit type is plain
// `string`, so the explicit unit is required.
const QUANTITY_SPECS: QuantitySpec[] = [
  { metric: 'steps', identifier: 'HKQuantityTypeIdentifierStepCount', unit: 'count', stat: 'cumulativeSum', field: 'sumQuantity', round: true },
  { metric: 'active_energy_kcal', identifier: 'HKQuantityTypeIdentifierActiveEnergyBurned', unit: 'kcal', stat: 'cumulativeSum', field: 'sumQuantity', round: true },
  { metric: 'resting_hr_bpm', identifier: 'HKQuantityTypeIdentifierRestingHeartRate', unit: 'count/min', stat: 'discreteAverage', field: 'averageQuantity', round: true },
  { metric: 'hrv_sdnn_ms', identifier: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', unit: 'ms', stat: 'discreteAverage', field: 'averageQuantity', round: true },
  { metric: 'bodyweight_kg', identifier: 'HKQuantityTypeIdentifierBodyMass', unit: 'kg', stat: 'mostRecent', field: 'mostRecentQuantity', round: false },
];

function localISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localMidnight(iso: string): Date {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export const healthkitAdapter: HealthAdapter = {
  hub: 'healthkit',

  async isAvailable() {
    try {
      return await isHealthDataAvailableAsync();
    } catch {
      return false;
    }
  },

  async requestAuthorization() {
    try {
      // v14 takes an object { toRead, toShare }. Read-only: omit toShare.
      await requestAuthorization({ toRead: READ_TYPES as unknown as never });
      return true;
    } catch {
      return false;
    }
  },

  // iOS deliberately hides whether READ access was granted (a privacy feature), so
  // there is nothing truthful to report. Return null; connection is inferred from
  // the presence of fresh data plus the local "we asked" flag instead.
  async getGrantedReadTypes() {
    return null;
  },

  async readDaily(sinceDate) {
    const startDate = localMidnight(sinceDate);
    const endDate = new Date();
    const anchorDate = localMidnight(sinceDate);
    const out: DailyReading[] = [];

    for (const spec of QUANTITY_SPECS) {
      try {
        const res = (await queryStatisticsCollectionForQuantity(
          spec.identifier as never,
          [spec.stat] as never,
          anchorDate,
          { day: 1 } as never,
          { unit: spec.unit, filter: { date: { startDate, endDate } } } as never,
        )) as unknown as ReadonlyArray<Record<string, unknown>>;

        for (const bucket of res) {
          const q = (bucket[spec.field] as { quantity?: number } | undefined)?.quantity;
          if (q == null || !Number.isFinite(q)) continue;
          out.push({
            type: spec.metric,
            date: localISO(new Date(bucket.startDate as string)),
            value: spec.round ? Math.round(q) : q,
            source: 'healthkit',
          });
        }
      } catch {
        // One metric failing (e.g. unsupported on this device) must not sink the rest.
      }
    }

    // Sleep: sum asleep-stage durations, attributed to the wake-up (end) day.
    try {
      const asleep = new Set<number>([
        CategoryValueSleepAnalysis.asleepUnspecified,
        CategoryValueSleepAnalysis.asleepCore,
        CategoryValueSleepAnalysis.asleepDeep,
        CategoryValueSleepAnalysis.asleepREM,
      ]);
      const samples = (await queryCategorySamples(
        'HKCategoryTypeIdentifierSleepAnalysis' as never,
        { limit: 0, ascending: true, filter: { date: { startDate, endDate } } } as never,
      )) as ReadonlyArray<{ value: number; startDate: string | Date; endDate: string | Date }>;

      const minutesByDay = new Map<string, number>();
      for (const s of samples) {
        if (!asleep.has(s.value)) continue;
        const ms = new Date(s.endDate).getTime() - new Date(s.startDate).getTime();
        if (ms <= 0) continue;
        const day = localISO(new Date(s.endDate));
        minutesByDay.set(day, (minutesByDay.get(day) ?? 0) + ms);
      }
      for (const [day, ms] of minutesByDay) {
        out.push({ type: 'sleep_minutes', date: day, value: Math.round(ms / 60000), source: 'healthkit' });
      }
    } catch {
      // Sleep unavailable / denied: skip, leave the other metrics intact.
    }

    return out;
  },
};
