/**
 * Signed-in weigh-ins, on the server.
 *
 * Binds the sync core in lib/bodyweightLog.ts to AsyncStorage and the Supabase
 * client. Rows land in daily_metrics as bodyweight_kg with source 'manual', so
 * the manual-wins guard in lib/healthSync.ts keeps a later HealthKit or Health
 * Connect sync from overwriting a hand-typed weight for the same day.
 *
 * Guests keep the device log in lib/bodyStats.ts. When they sign in, the next
 * flush uploads it to the account and clears it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clearWeightLog, loadBasicInfo, loadWeightLog } from './bodyStats';
import {
  flushWeights,
  type WeightDb,
  type WeightDeps,
  type WeightUnit,
} from './bodyweightLog';

export { deleteWeight, loadWeights, localDayISO, logWeight } from './bodyweightLog';

const TYPE = 'bodyweight_kg';

function weightDb(supabase: SupabaseClient, userId: string): WeightDb {
  return {
    async upsert(rows, { keepExisting }) {
      if (rows.length === 0) return;
      const { error } = await supabase.from('daily_metrics').upsert(
        rows.map((r) => ({
          user_id: userId,
          metric_date: r.day,
          metric_type: TYPE,
          value: r.kg,
          unit: 'kg',
          source: 'manual',
        })),
        { onConflict: 'user_id,metric_date,metric_type', ignoreDuplicates: keepExisting },
      );
      if (error) throw error;
    },
    async deleteDay(day) {
      const { error } = await supabase
        .from('daily_metrics')
        .delete()
        .eq('user_id', userId)
        .eq('metric_type', TYPE)
        .eq('metric_date', day);
      if (error) throw error;
    },
    async loadRows() {
      const { data, error } = await supabase
        .from('daily_metrics')
        .select('metric_date, value')
        .eq('user_id', userId)
        .eq('metric_type', TYPE)
        .order('metric_date', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  };
}

export function weightDeps(supabase: SupabaseClient, userId: string, unit: WeightUnit): WeightDeps {
  return {
    userId,
    unit,
    store: AsyncStorage,
    db: weightDb(supabase, userId),
    legacy: { load: loadWeightLog, clear: clearWeightLog },
  };
}

/**
 * App-open flush: pushes pending weigh-ins and uploads the old device log, so
 * weights reach the server even when the user never opens Profile or
 * Analytics. The saved unit converts the old log, which never recorded one.
 */
export async function flushWeightsOnOpen(supabase: SupabaseClient, userId: string): Promise<void> {
  const info = await loadBasicInfo();
  const unit: WeightUnit = info.weightUnit === 'lbs' ? 'lbs' : 'kg';
  await flushWeights(weightDeps(supabase, userId, unit));
}
