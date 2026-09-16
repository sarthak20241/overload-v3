/**
 * Signed-in body logs, on the server.
 *
 * Binds the logs in lib/bodyLog.ts to AsyncStorage and the Supabase client:
 *   weight       daily_metrics      bodyweight_kg     (kg)
 *   body fat     daily_metrics      body_fat_percent  (%)
 *   measurements body_measurements  one row per (day, site), cm
 * Manual rows carry source 'manual', so the hub sync's manual-wins guard in
 * lib/healthSync.ts never overwrites them. A database trigger copies the latest
 * weight and body fat onto user_profiles (migration 0118).
 *
 * Guests keep the device logs in lib/bodyStats.ts. When they sign in, the next
 * flush uploads them to the account and clears them.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  clearBodyFatLog,
  clearMeasurementEntries,
  clearWeightLog,
  loadBasicInfo,
  loadBodyFatLog,
  loadMeasurements,
  loadWeightLog,
  type MeasurementEntry,
} from './bodyStats';
import {
  bodyFatLog as makeBodyFatLog,
  type DayValueDb,
  type LengthUnit,
  type MeasurementDb,
  type MeasurementKey,
  measurementLog as makeMeasurementLog,
  weightLog as makeWeightLog,
  type WeightUnit,
} from './bodyLog';

export { legacyDayOf, localDayISO } from './bodyLog';

// Compile-time guard: the pure module's field list must match the app's type.
type AppMeasurementKey = keyof Omit<MeasurementEntry, 'id' | 'date'>;
const _keysMatch: [AppMeasurementKey] extends [MeasurementKey]
  ? [MeasurementKey] extends [AppMeasurementKey] ? true : never
  : never = true;
void _keysMatch;

/**
 * PostgREST errors with a Postgres data or constraint code (class 22 data
 * exception, class 23 integrity violation, e.g. 23514 check) mean the server
 * rejected this entry's data. Retrying can never fix that, so the queue drops
 * it. Everything else (network, 401, RLS 42501, a table not there yet) stays
 * retryable.
 */
function asBodyLogError(error: { code?: string | null; message?: string }): Error {
  const code = error?.code ?? '';
  return Object.assign(new Error(error?.message ?? 'body log upload failed'), {
    code,
    permanent: /^2[23]/.test(code),
  });
}

function dailyMetricDb(supabase: SupabaseClient, userId: string, type: 'bodyweight_kg' | 'body_fat_percent'): DayValueDb {
  const unit = type === 'bodyweight_kg' ? 'kg' : 'percent';
  return {
    async upsert(rows, { keepExisting }) {
      if (rows.length === 0) return;
      const { error } = await supabase.from('daily_metrics').upsert(
        rows.map((r) => ({ user_id: userId, metric_date: r.day, metric_type: type, value: r.value, unit, source: 'manual' })),
        { onConflict: 'user_id,metric_date,metric_type', ignoreDuplicates: keepExisting },
      );
      if (error) throw asBodyLogError(error);
    },
    async deleteDay(day) {
      const { error } = await supabase
        .from('daily_metrics')
        .delete()
        .eq('user_id', userId)
        .eq('metric_type', type)
        .eq('metric_date', day);
      if (error) throw asBodyLogError(error);
    },
    async loadRows() {
      const { data, error } = await supabase
        .from('daily_metrics')
        .select('metric_date, value')
        .eq('user_id', userId)
        .eq('metric_type', type)
        .order('metric_date', { ascending: false })
        .limit(1000);
      if (error) throw asBodyLogError(error);
      return data ?? [];
    },
  };
}

function measurementDb(supabase: SupabaseClient, userId: string): MeasurementDb {
  return {
    async upsert(rows, { keepExisting }) {
      if (rows.length === 0) return;
      const { error } = await supabase.from('body_measurements').upsert(
        rows.map((r) => ({ user_id: userId, measured_on: r.day, site: r.site, value_cm: r.cm, source: 'manual' })),
        { onConflict: 'user_id,measured_on,site', ignoreDuplicates: keepExisting },
      );
      if (error) throw asBodyLogError(error);
    },
    async deleteDay(day, keepSites) {
      let q = supabase.from('body_measurements').delete().eq('user_id', userId).eq('measured_on', day);
      if (keepSites && keepSites.length > 0) q = q.not('site', 'in', `(${keepSites.join(',')})`);
      const { error } = await q;
      if (error) throw asBodyLogError(error);
    },
    async loadRows() {
      const { data, error } = await supabase
        .from('body_measurements')
        .select('measured_on, site, value_cm')
        .eq('user_id', userId)
        .order('measured_on', { ascending: false })
        .limit(5000);
      if (error) throw asBodyLogError(error);
      return data ?? [];
    },
  };
}

export function weightLog(supabase: SupabaseClient, userId: string, unit: WeightUnit) {
  return makeWeightLog({
    userId,
    unit,
    store: AsyncStorage,
    db: dailyMetricDb(supabase, userId, 'bodyweight_kg'),
    legacy: { load: loadWeightLog, clear: clearWeightLog },
  });
}

export function bodyFatLog(supabase: SupabaseClient, userId: string) {
  return makeBodyFatLog({
    userId,
    store: AsyncStorage,
    db: dailyMetricDb(supabase, userId, 'body_fat_percent'),
    legacy: { load: loadBodyFatLog, clear: clearBodyFatLog },
  });
}

export function measurementLog(supabase: SupabaseClient, userId: string, unit: LengthUnit) {
  return makeMeasurementLog({
    userId,
    unit,
    store: AsyncStorage,
    db: measurementDb(supabase, userId),
    legacy: {
      load: async () => (await loadMeasurements()).entries as unknown as Record<string, unknown>[],
      clear: clearMeasurementEntries,
    },
  });
}

/**
 * App-open flush: pushes pending entries and uploads the old device logs, so
 * they reach the server even when the user never opens Profile or Analytics.
 * The saved units convert the old logs, which never recorded one per entry.
 */
export async function flushBodyLogsOnOpen(supabase: SupabaseClient, userId: string): Promise<void> {
  const [info, measurements] = await Promise.all([loadBasicInfo(), loadMeasurements()]);
  const weightUnit: WeightUnit = info.weightUnit === 'lbs' ? 'lbs' : 'kg';
  await Promise.all([
    weightLog(supabase, userId, weightUnit).flush(),
    bodyFatLog(supabase, userId).flush(),
    measurementLog(supabase, userId, measurements.unit === 'in' ? 'in' : 'cm').flush(),
  ]);
}
