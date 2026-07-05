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
  requestPermission,
  readRecords,
  aggregateGroupByPeriod,
  SdkAvailabilityStatus,
  SleepStageType,
  type Permission,
} from 'react-native-health-connect';
import type { DailyReading, HealthAdapter } from '../healthSync';

const READ_PERMISSIONS: Permission[] = [
  { accessType: 'read', recordType: 'Steps' },
  { accessType: 'read', recordType: 'ActiveCaloriesBurned' },
  { accessType: 'read', recordType: 'RestingHeartRate' },
  { accessType: 'read', recordType: 'HeartRateVariabilityRmssd' },
  { accessType: 'read', recordType: 'Weight' },
  { accessType: 'read', recordType: 'SleepSession' },
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
      const granted = await requestPermission(READ_PERMISSIONS);
      return READ_PERMISSIONS.some((req) =>
        granted.some((g) => g.accessType === req.accessType && g.recordType === req.recordType),
      );
    } catch {
      return false;
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
    ) => {
      try {
        const groups = (await aggregateGroupByPeriod({
          recordType: recordType as never,
          timeRangeFilter,
          timeRangeSlicer: slicer,
        })) as ReadonlyArray<{ startTime: string; result: Record<string, unknown> }>;
        for (const g of groups) {
          const v = extract(g.result);
          // Skip only missing/invalid readings, not a legitimate 0 — a real
          // 0-step or 0-active-energy day should record as 0, otherwise it reads
          // as a sync gap in "Your signals" instead of a real sedentary day.
          if (v == null || !Number.isFinite(v)) continue;
          out.push({ type: metric, date: localISO(new Date(g.startTime)), value: Math.round(v), source: 'health_connect' });
        }
      } catch {
        // Skip this metric on failure.
      }
    };

    await pushAgg('Steps', 'steps', (r) => (r.COUNT_TOTAL as number) ?? null);
    await pushAgg('ActiveCaloriesBurned', 'active_energy_kcal', (r) => (r.ACTIVE_CALORIES_TOTAL as { inKilocalories?: number })?.inKilocalories ?? null);
    await pushAgg('RestingHeartRate', 'resting_hr_bpm', (r) => (r.BPM_AVG as number) ?? null);

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

    // Sleep: sum asleep-stage durations per session, attributed to the wake (end) day.
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
      const minutesByDay = new Map<string, number>();
      for (const s of records) {
        let ms = 0;
        if (s.stages?.length) {
          for (const st of s.stages) {
            if (asleep.has(st.stage)) ms += Date.parse(st.endTime) - Date.parse(st.startTime);
          }
        } else {
          ms += Date.parse(s.endTime) - Date.parse(s.startTime);
        }
        if (ms <= 0) continue;
        const day = localISO(new Date(Date.parse(s.endTime)));
        minutesByDay.set(day, (minutesByDay.get(day) ?? 0) + ms);
      }
      for (const [day, ms] of minutesByDay) {
        out.push({ type: 'sleep_minutes', date: day, value: Math.round(ms / 60000), source: 'health_connect' });
      }
    } catch {
      // ignore
    }

    return out;
  },
};
