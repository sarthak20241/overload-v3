/**
 * Android Health Connect adapter (read-only) for the holistic healthSync pipeline.
 *
 * APIs verified against react-native-health-connect v3.5.3 installed types.
 * Cumulative/averaged metrics (steps, active energy, resting HR) use
 * aggregateGroupByPeriod (platform de-dupes overlapping sources); HRV, weight
 * and per-stage sleep use readRecords because no aggregate fits.
 *
 * NOTE: Android exposes HRV as RMSSD, not SDNN. We store it in the same hrv
 * column but it is RMSSD on Android vs SDNN on iOS (not interchangeable).
 * Plan: .planning/holistic-tracking-plan.md.
 */
import {
  initialize,
  getSdkStatus,
  getGrantedPermissions,
  requestPermission,
  readRecords,
  aggregateRecord,
  aggregateGroupByPeriod,
  SdkAvailabilityStatus,
  SleepStageType,
  type Permission,
} from 'react-native-health-connect';
import * as Application from 'expo-application';
import type { DailyReading, HealthAdapter, ReadableMetric } from '../healthSync';
import type { HubWorkout } from '../healthCardio';

const READ_PERMISSIONS: Permission[] = [
  { accessType: 'read', recordType: 'Steps' },
  { accessType: 'read', recordType: 'ActiveCaloriesBurned' },
  { accessType: 'read', recordType: 'RestingHeartRate' },
  { accessType: 'read', recordType: 'HeartRateVariabilityRmssd' },
  { accessType: 'read', recordType: 'Weight' },
  { accessType: 'read', recordType: 'SleepSession' },
];

/**
 * Workouts (and their distance) for the cardio import. Health Connect only
 * grants what the manifest declares, and READ_EXERCISE / READ_DISTANCE first
 * ship in the binary after 1.0.3: on an older binary (reached by an OTA) the
 * ask would show nothing new, so these stay out of every request there.
 */
const WORKOUT_PERMISSIONS: Permission[] = [
  { accessType: 'read', recordType: 'ExerciseSession' },
  { accessType: 'read', recordType: 'Distance' },
];
const WORKOUTS_FROM_VERSION = [1, 0, 4];

function binaryDeclaresWorkouts(): boolean {
  const parts = (Application.nativeApplicationVersion ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < WORKOUTS_FROM_VERSION.length; i++) {
    const a = parts[i] ?? 0;
    if (a !== WORKOUTS_FROM_VERSION[i]) return a > WORKOUTS_FROM_VERSION[i];
  }
  return true;
}

const requestedPermissions = (): Permission[] =>
  binaryDeclaresWorkouts() ? [...READ_PERMISSIONS, ...WORKOUT_PERMISSIONS] : READ_PERMISSIONS;

async function hasGrant(recordType: string): Promise<boolean> {
  const granted = (await getGrantedPermissions()) as ReadonlyArray<{ accessType?: string; recordType?: string }>;
  return granted.some((g) => g.accessType === 'read' && g.recordType === recordType);
}

/** Record type -> the daily_metrics metric it feeds, for permission read-back. */
const RECORD_TO_METRIC: Record<string, ReadableMetric> = {
  Steps: 'steps',
  ActiveCaloriesBurned: 'active_energy_kcal',
  RestingHeartRate: 'resting_hr_bpm',
  HeartRateVariabilityRmssd: 'hrv_sdnn_ms',
  Weight: 'bodyweight_kg',
  SleepSession: 'sleep_minutes',
};

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

export const healthConnectAdapter: HealthAdapter = {
  hub: 'health_connect',

  async isAvailable() {
    try {
      const status = await getSdkStatus();
      if (status !== SdkAvailabilityStatus.SDK_AVAILABLE) return false;
      return await initialize();
    } catch {
      return false;
    }
  },

  async requestAuthorization() {
    try {
      // requestPermission returns ONLY the permissions actually allowed (a cancel
      // returns none), so gate on the result instead of assuming success. Report
      // connected if at least one requested read was granted — a full cancel then
      // can't advance the connect flow into a half-synced state, and partial
      // grants still connect the metrics that were allowed (per-metric connection
      // is inferred downstream from data presence). No history permission: the
      // backfill only reaches 28 days, well inside the 30-day no-history window.
      let granted;
      try {
        granted = await requestPermission(requestedPermissions());
      } catch {
        // A binary that refuses the workout permissions must still connect
        // the daily metrics.
        granted = await requestPermission(READ_PERMISSIONS);
      }
      return READ_PERMISSIONS.some((req) =>
        granted.some((g) => g.accessType === req.accessType && g.recordType === req.recordType),
      );
    } catch {
      return false;
    }
  },

  async getGrantedReadTypes() {
    try {
      // The client must be initialized before this call, and getGrantedPermissions
      // can throw if Health Connect is not ready. Any failure returns null (unknown)
      // rather than a false "denied", so we never lock a truly-connected user out.
      if (!(await this.isAvailable())) return null;
      const granted = (await getGrantedPermissions()) as ReadonlyArray<{ accessType?: string; recordType?: string }>;
      const out: ReadableMetric[] = [];
      for (const g of granted) {
        if (g.accessType !== 'read' || !g.recordType) continue;
        const metric = RECORD_TO_METRIC[g.recordType];
        if (metric && !out.includes(metric)) out.push(metric);
      }
      return out;
    } catch {
      return null;
    }
  },

  // Health Connect reports grants, so "the sheet would show" is "workouts
  // are declared but not granted". A user who said no once is asked again
  // only when they tap, never on their own.
  async needsAuthorization() {
    try {
      if (!binaryDeclaresWorkouts()) return false;
      return !(await hasGrant('ExerciseSession'));
    } catch {
      return null;
    }
  },

  async readWorkouts(sinceMs) {
    try {
      if (!binaryDeclaresWorkouts() || !(await hasGrant('ExerciseSession'))) return [];
      const { records } = (await readRecords('ExerciseSession', {
        timeRangeFilter: { operator: 'between', startTime: new Date(sinceMs).toISOString(), endTime: new Date().toISOString() },
        pageSize: 1000,
      })) as unknown as {
        records: Array<{ startTime: string; endTime: string; exerciseType: number; metadata?: { id?: string; dataOrigin?: string } }>;
      };
      const distanceAllowed = await hasGrant('Distance').catch(() => false);
      const out: HubWorkout[] = [];
      for (const r of records) {
        const id = r.metadata?.id;
        if (!id) continue;
        let distanceM: number | null = null;
        if (distanceAllowed) {
          try {
            // Only the app that recorded the session: a phone and a watch
            // both writing distance would otherwise add up (see pushAgg).
            const origin = r.metadata?.dataOrigin;
            const agg = (await aggregateRecord({
              recordType: 'Distance',
              timeRangeFilter: { operator: 'between', startTime: r.startTime, endTime: r.endTime },
              ...(origin ? { dataOriginFilter: [origin] } : {}),
            } as never)) as { DISTANCE?: { inMeters?: number } };
            distanceM = agg.DISTANCE?.inMeters ?? null;
          } catch {
            // Distance is a nice-to-have; the session still counts without it.
          }
        }
        out.push({
          hub: 'health_connect',
          externalId: id,
          activityType: Number(r.exerciseType),
          startMs: Date.parse(r.startTime),
          endMs: Date.parse(r.endTime),
          distanceM,
        });
      }
      return out;
    } catch {
      return [];
    }
  },

  async readDaily(sinceDate) {
    const startTime = localMidnight(sinceDate).toISOString();
    const endTime = new Date().toISOString();
    const timeRangeFilter = { operator: 'between', startTime, endTime } as const;
    const slicer = { period: 'DAYS', length: 1 } as const;
    const out: DailyReading[] = [];

    const pushAgg = async (
      recordType: 'Steps' | 'ActiveCaloriesBurned' | 'RestingHeartRate',
      metric: DailyReading['type'],
      extract: (result: Record<string, unknown>) => number | null,
      // Cumulative metrics (steps, active energy) SUM across data origins, so a
      // day with both a phone step source and a watch double-counts. Averages
      // (resting HR -> BPM_AVG) don't inflate that way, so they skip the guard.
      dedupeSources: boolean,
    ) => {
      try {
        const groups = (await aggregateGroupByPeriod({
          recordType: recordType as never,
          timeRangeFilter,
          timeRangeSlicer: slicer,
        })) as ReadonlyArray<{
          startTime: string;
          endTime: string;
          result: Record<string, unknown> & { dataOrigins?: string[] };
        }>;
        for (const g of groups) {
          let v = extract(g.result);
          // Skip only missing/invalid readings, not a legitimate 0 — a real
          // 0-step or 0-active-energy day should record as 0, otherwise it reads
          // as a sync gap in "Your signals" instead of a real sedentary day.
          if (v == null || !Number.isFinite(v)) continue;

          // Cross-source double-count guard. Health Connect's aggregate SUMS
          // overlapping records from different apps (it only de-dupes updates
          // within one app), so a bucket fed by 2+ origins over-reports. Unlike
          // HealthKit's cumulativeSum query, it won't merge a phone + watch for
          // us. Re-aggregate the day per origin and keep the single most complete
          // source instead of the inflated sum. Only runs on the rare multi-origin
          // day; single-origin days pass through untouched.
          const origins = g.result.dataOrigins ?? [];
          if (dedupeSources && origins.length > 1) {
            // Re-query each origin concurrently — a multi-origin day is rare, but
            // on an initial backfill for a watch+phone user this is one call per
            // origin per day, so running them in parallel keeps that off the
            // critical path. A failed per-origin query contributes 0; if all fail
            // we fall back to the summed value below.
            const perOriginTotals = await Promise.all(
              origins.map(async (origin) => {
                try {
                  const perOrigin = (await aggregateRecord({
                    recordType: recordType as never,
                    timeRangeFilter: { operator: 'between', startTime: g.startTime, endTime: g.endTime },
                    dataOriginFilter: [origin],
                  } as never)) as Record<string, unknown>;
                  const pv = extract(perOrigin);
                  return pv != null && Number.isFinite(pv) ? pv : 0;
                } catch {
                  return 0;
                }
              }),
            );
            const best = Math.max(0, ...perOriginTotals);
            if (best > 0) v = best;
          }

          out.push({ type: metric, date: localISO(new Date(g.startTime)), value: Math.round(v), source: 'health_connect' });
        }
      } catch {
        // Skip this metric on failure.
      }
    };

    await pushAgg('Steps', 'steps', (r) => (r.COUNT_TOTAL as number) ?? null, true);
    await pushAgg('ActiveCaloriesBurned', 'active_energy_kcal', (r) => (r.ACTIVE_CALORIES_TOTAL as { inKilocalories?: number })?.inKilocalories ?? null, true);
    await pushAgg('RestingHeartRate', 'resting_hr_bpm', (r) => (r.BPM_AVG as number) ?? null, false);

    // HRV (RMSSD): no aggregate type, read raw and take the latest reading per day.
    try {
      const { records } = (await readRecords('HeartRateVariabilityRmssd', { timeRangeFilter })) as {
        records: Array<{ time: string; heartRateVariabilityMillis: number }>;
      };
      const latestByDay = new Map<string, { t: number; v: number }>();
      for (const r of records) {
        const t = Date.parse(r.time);
        const day = localISO(new Date(t));
        const prev = latestByDay.get(day);
        if (!prev || t > prev.t) latestByDay.set(day, { t, v: r.heartRateVariabilityMillis });
      }
      for (const [day, { v }] of latestByDay) {
        if (Number.isFinite(v)) out.push({ type: 'hrv_sdnn_ms', date: day, value: Math.round(v), source: 'health_connect' });
      }
    } catch {
      // ignore
    }

    // Bodyweight: latest reading per day.
    try {
      const { records } = (await readRecords('Weight', { timeRangeFilter })) as {
        records: Array<{ time: string; weight: { inKilograms: number } }>;
      };
      const latestByDay = new Map<string, { t: number; v: number }>();
      for (const r of records) {
        const t = Date.parse(r.time);
        const day = localISO(new Date(t));
        const prev = latestByDay.get(day);
        if (!prev || t > prev.t) latestByDay.set(day, { t, v: r.weight.inKilograms });
      }
      for (const [day, { v }] of latestByDay) {
        if (Number.isFinite(v)) out.push({ type: 'bodyweight_kg', date: day, value: v, source: 'health_connect' });
      }
    } catch {
      // ignore
    }

    // Sleep: union asleep intervals per day, attributed to the wake (end) day.
    //
    // Same cross-source hazard as steps: a watch and a phone app can each log the
    // SAME night, and a naive sum-of-durations would double the night's sleep.
    // readRecords has no aggregate to lean on, so we de-dupe by merging overlapping
    // asleep intervals (union) instead of summing them — this also collapses
    // fragmented/overlapping stages within a single app. Overlapping duplicates
    // from two apps merge into one interval; genuinely separate naps stay additive.
    try {
      const asleep = new Set<number>([
        SleepStageType.SLEEPING,
        SleepStageType.LIGHT,
        SleepStageType.DEEP,
        SleepStageType.REM,
      ]);
      const { records } = (await readRecords('SleepSession', { timeRangeFilter })) as {
        records: Array<{
          startTime: string;
          endTime: string;
          stages?: Array<{ startTime: string; endTime: string; stage: number }>;
        }>;
      };
      // Collect [start, end] asleep intervals, bucketed by the session's wake day.
      const intervalsByDay = new Map<string, Array<[number, number]>>();
      const addInterval = (day: string, start: number, end: number) => {
        if (!(end > start)) return;
        (intervalsByDay.get(day) ?? intervalsByDay.set(day, []).get(day)!).push([start, end]);
      };
      for (const s of records) {
        const day = localISO(new Date(Date.parse(s.endTime)));
        if (s.stages?.length) {
          for (const st of s.stages) {
            if (asleep.has(st.stage)) addInterval(day, Date.parse(st.startTime), Date.parse(st.endTime));
          }
        } else {
          addInterval(day, Date.parse(s.startTime), Date.parse(s.endTime));
        }
      }
      for (const [day, intervals] of intervalsByDay) {
        // Merge overlapping intervals, then sum the merged spans (union length).
        intervals.sort((a, b) => a[0] - b[0]);
        let ms = 0;
        let curStart = intervals[0][0];
        let curEnd = intervals[0][1];
        for (let i = 1; i < intervals.length; i++) {
          const [s0, e0] = intervals[i];
          if (s0 <= curEnd) {
            if (e0 > curEnd) curEnd = e0; // overlap: extend the current span
          } else {
            ms += curEnd - curStart; // gap: close the span, start a new one
            curStart = s0;
            curEnd = e0;
          }
        }
        ms += curEnd - curStart;
        if (ms <= 0) continue;
        out.push({ type: 'sleep_minutes', date: day, value: Math.round(ms / 60000), source: 'health_connect' });
      }
    } catch {
      // ignore
    }

    return out;
  },
};
