/**
 * Bridges the pure readiness compute (lib/readiness.ts) to the database.
 *
 * Reads the user's recent daily_metrics (today's values + a trailing baseline),
 * computes readiness, and upserts today's readiness_score back into
 * daily_metrics. Past days are never recomputed (the upsert only targets the
 * current local day), so a stored historical readiness stays frozen as the user
 * saw it (plan .planning/holistic-tracking-plan.md s5).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeReadiness, type BaselineStat, type ReadinessResult } from './readiness';
import { syncHealthData } from './healthSync';

const BASELINE_DAYS = 28;
// sleep_quality rides along for today's read only; it is a subjective modifier, so
// it never enters a baseline (see the baseline loop below).
const RECOVERY_TYPES = ['sleep_minutes', 'sleep_quality', 'resting_hr_bpm', 'hrv_sdnn_ms'] as const;

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

function stat(values: number[]): BaselineStat {
  const n = values.length;
  if (n === 0) return { mean: null, sd: null, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, sd: Math.sqrt(variance), n };
}

/**
 * Compute today's readiness from daily_metrics WITHOUT writing. Read-only, so the
 * dashboard card can call it on render. Returns null when there is no user.
 * Acute training-load tempering is a documented TODO (read base
 * workouts/workout_sets, never the absent matviews).
 */
export async function loadReadiness(
  supabase: SupabaseClient,
  userId: string,
): Promise<ReadinessResult | null> {
  if (!userId) return null;
  const today = todayLocalISO();
  const since = shiftDaysISO(today, -BASELINE_DAYS);

  // The recovery-metrics, acute-load and nutrition reads are independent, so fire
  // them together: the hero waits on one round-trip instead of three in series.
  const [metricsRes, acuteLoad, nutrition] = await Promise.all([
    supabase
      .from('daily_metrics')
      .select('metric_date, metric_type, value')
      .eq('user_id', userId)
      .in('metric_type', RECOVERY_TYPES as unknown as string[])
      .gte('metric_date', since)
      .lte('metric_date', today),
    loadAcuteLoad(supabase, userId, today),
    loadNutritionFactor(supabase, userId, today),
  ]);
  const { data, error } = metricsRes;
  if (error) throw error;

  const rows = (data ?? []) as { metric_date: string; metric_type: string; value: number | string }[];
  const todayVal: Record<string, number | null> = { sleep_minutes: null, sleep_quality: null, resting_hr_bpm: null, hrv_sdnn_ms: null };
  // sleep_quality is intentionally absent here: it feeds today only, never a baseline.
  const baseline: Record<string, number[]> = { sleep_minutes: [], resting_hr_bpm: [], hrv_sdnn_ms: [] };

  for (const r of rows) {
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    if (r.metric_date === today) todayVal[r.metric_type] = v;
    else if (baseline[r.metric_type]) baseline[r.metric_type].push(v);
  }

  return computeReadiness({
    today: {
      sleepMinutes: todayVal.sleep_minutes,
      sleepQuality: todayVal.sleep_quality,
      restingHrBpm: todayVal.resting_hr_bpm,
      hrvMs: todayVal.hrv_sdnn_ms,
    },
    baseline: {
      sleepMinutes: stat(baseline.sleep_minutes),
      restingHrBpm: stat(baseline.resting_hr_bpm),
      hrvMs: stat(baseline.hrv_sdnn_ms),
    },
    acuteLoad,
    nutrition,
  });
}

/** Fallback daily targets, mirroring lib/dietData DEFAULT_TARGETS. */
const DEFAULT_PROTEIN_TARGET = 125;
const DEFAULT_KCAL_TARGET = 2000;
/** How many COMPLETED days back to average nutrition over (excludes today). */
const NUTRITION_LOOKBACK = 3;

/**
 * Nutrition recovery signal: average intake over the last few COMPLETED days
 * (yesterday back NUTRITION_LOOKBACK), as ratios to the user's targets. Today is
 * excluded on purpose (it is still being eaten, and overnight recovery ran on
 * fuel already consumed). Returns null when the user logged no food in that
 * window, so readiness stays neutral for non-loggers. Reads the trigger-maintained
 * user_nutrition_stats table + targets from user_profiles. Defensive: any failure
 * returns null so nutrition never blocks the score.
 */
async function loadNutritionFactor(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<{ proteinRatio: number; energyRatio: number } | null> {
  try {
    const from = shiftDaysISO(today, -NUTRITION_LOOKBACK);
    const to = shiftDaysISO(today, -1);
    const [statsRes, profileRes] = await Promise.all([
      supabase
        .from('user_nutrition_stats')
        .select('day, kcal, protein_g')
        .eq('user_id', userId)
        .gte('day', from)
        .lte('day', to),
      supabase
        .from('user_profiles')
        .select('protein_target_g, daily_calorie_target')
        .eq('clerk_user_id', userId)
        .maybeSingle(),
    ]);
    // Either query erroring means we can't trust the ratios; skip the factor
    // rather than silently scoring against fallback targets (the "any failure
    // returns null" contract). A profile that simply has no custom targets set is
    // NOT an error, and legitimately uses the defaults below.
    if (statsRes.error || profileRes.error) return null;
    const days = (statsRes.data ?? []) as { kcal: number | string; protein_g: number | string }[];
    // Only days with actual food logged count toward the average.
    const logged = days
      .map((d) => ({ kcal: Number(d.kcal), protein: Number(d.protein_g) }))
      .filter((d) => (Number.isFinite(d.kcal) && d.kcal > 0) || (Number.isFinite(d.protein) && d.protein > 0));
    if (logged.length === 0) return null;

    const avgProtein = logged.reduce((a, d) => a + d.protein, 0) / logged.length;
    const avgKcal = logged.reduce((a, d) => a + d.kcal, 0) / logged.length;

    const prof = (profileRes.data ?? {}) as { protein_target_g?: number | string | null; daily_calorie_target?: number | string | null };
    const proteinTarget = Number(prof.protein_target_g) || DEFAULT_PROTEIN_TARGET;
    const kcalTarget = Number(prof.daily_calorie_target) || DEFAULT_KCAL_TARGET;
    if (proteinTarget <= 0 || kcalTarget <= 0) return null;

    return { proteinRatio: avgProtein / proteinTarget, energyRatio: avgKcal / kcalTarget };
  } catch {
    return null;
  }
}

/**
 * Recent training load vs typical, from base workouts/workout_sets (never the
 * absent stats matviews). Defensive: returns null on any issue so readiness
 * still computes without the load temper. RLS scopes workouts to the user.
 */
async function loadAcuteLoad(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<{ last7dSets: number; typicalWeeklySets: number } | null> {
  try {
    const since28 = shiftDaysISO(today, -28);
    // Parse as LOCAL midnight (append T00:00:00) — new Date('YYYY-MM-DD') is UTC
    // midnight, which on non-UTC offsets pushes late workouts into the wrong
    // 7-day bucket and skews the persisted readiness_score.
    const since7Ms = new Date(shiftDaysISO(today, -7) + 'T00:00:00').getTime();
    const { data, error } = await supabase
      .from('workouts')
      .select('started_at, workout_sets(count)')
      .eq('user_id', userId)
      .gte('started_at', since28);
    if (error || !data) return null;
    let last7 = 0;
    let total = 0;
    for (const w of data as { started_at: string; workout_sets: { count: number }[] }[]) {
      const c = Array.isArray(w.workout_sets) ? (w.workout_sets[0]?.count ?? 0) : 0;
      total += c;
      if (new Date(w.started_at).getTime() >= since7Ms) last7 += c;
    }
    const typicalWeeklySets = total / 4;
    if (typicalWeeklySets <= 0) return null;
    return { last7dSets: last7, typicalWeeklySets };
  } catch {
    return null;
  }
}

/**
 * Stored readiness scores over the last `days`, ascending. Drives the hub trend
 * chart (hidden until >= 2 points). Read-only.
 */
export async function loadReadinessHistory(
  supabase: SupabaseClient,
  userId: string,
  days = 14,
): Promise<{ date: string; value: number }[]> {
  if (!userId) return [];
  const today = todayLocalISO();
  // Both ends inclusive, so subtract days-1 to return exactly `days` points
  // (today plus the days-1 prior dates) instead of overfetching a 15th.
  const since = shiftDaysISO(today, -(days - 1));
  const { data, error } = await supabase
    .from('daily_metrics')
    .select('metric_date, value')
    .eq('metric_type', 'readiness_score')
    .eq('user_id', userId)
    .gte('metric_date', since)
    .lte('metric_date', today)
    .order('metric_date', { ascending: true });
  if (error) throw error;
  return (data ?? [])
    .map((r: { metric_date: string; value: number | string }) => ({ date: r.metric_date, value: Number(r.value) }))
    .filter((p) => Number.isFinite(p.value));
}

/**
 * Compute today's readiness and STORE it (current day only; past days frozen).
 * Thin wrapper over loadReadiness used by the foreground sync.
 */
export async function computeAndStoreReadiness(
  supabase: SupabaseClient,
  userId: string,
): Promise<ReadinessResult | null> {
  const result = await loadReadiness(supabase, userId);
  if (result && result.score != null) {
    const { error: upErr } = await supabase.from('daily_metrics').upsert(
      { user_id: userId, metric_date: todayLocalISO(), metric_type: 'readiness_score', value: result.score, unit: 'score', source: 'manual' },
      { onConflict: 'user_id,metric_date,metric_type' },
    );
    if (upErr) throw upErr;
  }
  return result;
}

/**
 * Foreground entry point: pull the latest hub data, then recompute today's
 * readiness from it. Safe to call on every app-open; both steps are idempotent.
 */
export async function runHealthSyncAndReadiness(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ synced: number | null; readiness: ReadinessResult | null }> {
  let synced: number | null = null;
  try {
    const r = await syncHealthData(supabase, userId);
    synced = r?.written ?? null;
  } catch {
    // A mirror failure should not block readiness from recomputing on cached data.
  }
  const readiness = await computeAndStoreReadiness(supabase, userId);
  return { synced, readiness };
}
