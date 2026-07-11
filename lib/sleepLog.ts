/**
 * Manual sleep logging (holistic tracking).
 *
 * The phone-only path to a readiness score: a user with no wearable logs last
 * night's sleep by hand (duration, plus an optional 1-5 quality rating) and gets
 * a score the same morning. Writes land in daily_metrics with source='manual', so
 * the healthSync manual-wins guard protects them from being overwritten by a later
 * hub sync. After writing we recompute + store today's readiness so the caller can
 * render the fresh score without a round trip.
 *
 * Sleep is attributed to the WAKE day (today's local date), matching how the
 * HealthKit / Health Connect adapters bucket a night's sleep.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeAndStoreReadiness } from './readinessSync';
import type { ReadinessResult } from './readiness';

function toLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayLocalISO(): string {
  return toLocalISO(new Date());
}
function shiftDaysISO(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return toLocalISO(new Date(y, m - 1, d + deltaDays));
}

export interface SleepEntry {
  minutes: number;
  quality: number | null;
  source: string;
}

/**
 * Write today's sleep by hand and recompute readiness. `quality` is optional
 * (1-5); when omitted, only the duration is stored. Returns the fresh readiness,
 * or null when there is no signed-in user (mirrors the other lib entry points).
 */
export async function logSleepForToday(
  supabase: SupabaseClient,
  userId: string,
  input: { minutes: number; quality?: number | null },
): Promise<ReadinessResult | null> {
  if (!userId) return null;
  const date = todayLocalISO();
  const rows: {
    user_id: string;
    metric_date: string;
    metric_type: string;
    value: number;
    unit: string;
    source: 'manual';
  }[] = [
    { user_id: userId, metric_date: date, metric_type: 'sleep_minutes', value: Math.round(input.minutes), unit: 'minutes', source: 'manual' },
  ];
  if (input.quality != null) {
    rows.push({ user_id: userId, metric_date: date, metric_type: 'sleep_quality', value: Math.round(input.quality), unit: 'score', source: 'manual' });
  }

  const { error } = await supabase
    .from('daily_metrics')
    .upsert(rows, { onConflict: 'user_id,metric_date,metric_type' });
  if (error) throw error;

  return computeAndStoreReadiness(supabase, userId);
}

/**
 * Today's and yesterday's sleep rows (each null when absent), for prefilling the
 * log sheet and deciding UI state. One query over the two-day window. Read-only.
 */
export async function loadRecentSleep(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ today: SleepEntry | null; yesterday: SleepEntry | null }> {
  if (!userId) return { today: null, yesterday: null };
  const today = todayLocalISO();
  const yesterday = shiftDaysISO(today, -1);

  const { data, error } = await supabase
    .from('daily_metrics')
    .select('metric_date, metric_type, value, source')
    .eq('user_id', userId)
    .in('metric_type', ['sleep_minutes', 'sleep_quality'])
    .gte('metric_date', yesterday)
    .lte('metric_date', today);
  if (error) throw error;

  const byDay: Record<string, { minutes: number | null; quality: number | null; source: string }> = {
    [today]: { minutes: null, quality: null, source: 'manual' },
    [yesterday]: { minutes: null, quality: null, source: 'manual' },
  };
  for (const r of (data ?? []) as { metric_date: string; metric_type: string; value: number | string; source: string }[]) {
    const bucket = byDay[r.metric_date];
    if (!bucket) continue;
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    if (r.metric_type === 'sleep_minutes') {
      bucket.minutes = v;
      bucket.source = r.source;
    } else if (r.metric_type === 'sleep_quality') {
      bucket.quality = v;
    }
  }

  const pick = (day: string): SleepEntry | null =>
    byDay[day].minutes != null ? { minutes: byDay[day].minutes!, quality: byDay[day].quality, source: byDay[day].source } : null;

  return { today: pick(today), yesterday: pick(yesterday) };
}
