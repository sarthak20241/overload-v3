/**
 * The readings behind a phase metric's chart (components/program/
 * PhaseMetricChart), from the tables the app already has. A number kind
 * (line) is every reading since the program started; a weekly kind (bars) is
 * one number per program week, bucketed from the program's own start date,
 * not from Mondays, so the bars line up with the phase bar above them.
 *
 * Every read is best-effort: a failed read is an empty series, never a thrown
 * error, because the chart is a nicety under a number that is already shown.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { daysBetweenISO, loadMetricLogs, todayLocalISO, type ActiveProgram } from '@/lib/programData';
import { chartKindOf, type PhaseMetricRow } from '@/lib/phaseMetrics';
import { MUSCLE_GROUP_REFINEMENTS } from '../supabase/functions/_shared/exerciseVocab';

export interface MetricSeries {
  chart: 'line' | 'bars';
  /** Line: readings as (program week, value). */
  points: { x: number; y: number }[];
  /** Bars: one entry per program week so far; null = nothing that week. */
  weekly: (number | null)[];
}

const EMPTY: MetricSeries = { chart: 'line', points: [], weekly: [] };

function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Program week (fractional) of a local ISO day. */
const weekOf = (startISO: string, iso: string) => daysBetweenISO(startISO, iso) / 7;
/** Program week index (0-based) of a local ISO day. */
const weekIdx = (startISO: string, iso: string) => Math.floor(daysBetweenISO(startISO, iso) / 7);

function epley(weightKg: number, reps: number): number {
  return weightKg * (1 + reps / 30);
}

/** The total program weeks, from the stored count or the phases. */
export function programWeeks(program: ActiveProgram): number {
  return program.total_weeks ?? program.phases.reduce((a, p) => a + p.duration_weeks, 0);
}

export async function loadMetricSeries(
  supabase: SupabaseClient,
  clerkId: string,
  program: ActiveProgram,
  metric: PhaseMetricRow,
  /** The phase's protein target, for protein days. */
  proteinTargetG: number | null,
): Promise<MetricSeries> {
  const chart = chartKindOf(metric.kind);
  const start = program.start_date;
  const today = todayLocalISO();
  const weeksSoFar = Math.min(programWeeks(program), weekIdx(start, today) + 1);
  const bucket = (iso: string) => weekIdx(start, iso);
  const empty: MetricSeries = { ...EMPTY, chart };
  try {
    switch (metric.kind) {
      case 'bodyweight': {
        const { data } = await supabase
          .from('daily_metrics').select('metric_date, value')
          .eq('user_id', clerkId).eq('metric_type', 'bodyweight_kg')
          .gte('metric_date', start).lte('metric_date', today)
          .order('metric_date', { ascending: true });
        return { chart, weekly: [], points: (data ?? []).map((r) => ({ x: weekOf(start, String(r.metric_date)), y: Number(r.value) })).filter((p) => Number.isFinite(p.y)) };
      }
      case 'custom': {
        const logs = await loadMetricLogs(supabase, metric.id);
        return { chart, weekly: [], points: logs.map((l) => ({ x: weekOf(start, l.logged_on), y: l.value })) };
      }
      case 'lift_e1rm': {
        const exerciseId = metric.ref?.exercise_id;
        if (!exerciseId) return empty;
        const { data } = await supabase
          .from('workout_sets')
          .select('weight_kg, reps, completed, set_type, workouts!inner(user_id, started_at, finished_at)')
          .eq('exercise_id', exerciseId)
          .eq('workouts.user_id', clerkId)
          .gte('workouts.started_at', `${start}T00:00:00`)
          .eq('completed', true);
        // The best Epley estimate per session day.
        const best = new Map<string, number>();
        for (const s of (data ?? []) as unknown as { weight_kg: number; reps: number; set_type: string | null; workouts: { started_at: string; finished_at: string | null } }[]) {
          if (s.set_type === 'warmup' || !s.workouts?.finished_at) continue;
          const w = Number(s.weight_kg); const r = Number(s.reps);
          if (!(w > 0) || !(r > 0)) continue;
          const day = localISO(new Date(s.workouts.started_at));
          best.set(day, Math.max(best.get(day) ?? 0, epley(w, r)));
        }
        return { chart, weekly: [], points: [...best.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, v]) => ({ x: weekOf(start, day), y: Math.round(v * 10) / 10 })) };
      }
      case 'distance':
      case 'duration': {
        // Only sets that carry the measure, longest first, so strength sets
        // never fill the row cap and hide a real point.
        const col = metric.kind === 'distance' ? 'distance_m' : 'duration_seconds';
        const { data } = await supabase
          .from('workout_sets')
          .select('distance_m, duration_seconds, completed, workouts!inner(user_id, started_at, finished_at)')
          .eq('workouts.user_id', clerkId)
          .gte('workouts.started_at', `${start}T00:00:00`)
          .eq('completed', true)
          .gt(col, 0)
          .order(col, { ascending: false })
          .limit(500);
        const best = new Map<string, number>();
        for (const s of (data ?? []) as unknown as { distance_m: number | null; duration_seconds: number | null; workouts: { started_at: string; finished_at: string | null } }[]) {
          if (!s.workouts?.finished_at) continue;
          const v = metric.kind === 'distance' ? (Number(s.distance_m) || 0) / 1000 : (Number(s.duration_seconds) || 0) / 60;
          if (!(v > 0)) continue;
          const day = localISO(new Date(s.workouts.started_at));
          best.set(day, Math.max(best.get(day) ?? 0, v));
        }
        return { chart, weekly: [], points: [...best.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, v]) => ({ x: weekOf(start, day), y: Math.round(v * 10) / 10 })) };
      }
      case 'sessions_per_week': {
        const { data } = await supabase
          .from('workouts').select('started_at, finished_at')
          .eq('user_id', clerkId).not('finished_at', 'is', null)
          .gte('started_at', `${start}T00:00:00`);
        const weekly: (number | null)[] = Array.from({ length: weeksSoFar }, () => 0);
        for (const w of (data ?? []) as { started_at: string }[]) {
          const i = bucket(localISO(new Date(w.started_at)));
          if (i >= 0 && i < weekly.length) weekly[i] = (weekly[i] ?? 0) + 1;
        }
        return { chart, points: [], weekly };
      }
      case 'steps':
      case 'sleep_hours': {
        const { data } = await supabase
          .from('daily_metrics').select('metric_date, value')
          .eq('user_id', clerkId).eq('metric_type', metric.kind === 'steps' ? 'steps' : 'sleep_minutes')
          .gte('metric_date', start).lte('metric_date', today);
        const sums: { n: number; total: number }[] = Array.from({ length: weeksSoFar }, () => ({ n: 0, total: 0 }));
        for (const r of (data ?? []) as { metric_date: string; value: number }[]) {
          const v = Number(r.value);
          if (!(v > 0)) continue;
          const i = bucket(r.metric_date);
          if (i >= 0 && i < sums.length) { sums[i].n += 1; sums[i].total += v; }
        }
        const scale = metric.kind === 'steps' ? 1 : 1 / 60;
        return { chart, points: [], weekly: sums.map((s) => (s.n > 0 ? Math.round((s.total / s.n) * scale * 10) / 10 : null)) };
      }
      case 'protein_days': {
        if (proteinTargetG == null) return empty;
        const { data } = await supabase
          .from('user_nutrition_stats').select('day, protein_g')
          .eq('user_id', clerkId).gte('day', start).lt('day', today);
        const weekly: (number | null)[] = Array.from({ length: weeksSoFar }, () => null);
        for (const r of (data ?? []) as { day: string; protein_g: number }[]) {
          const i = bucket(r.day);
          if (i < 0 || i >= weekly.length) continue;
          if (Number(r.protein_g) >= proteinTargetG) weekly[i] = (weekly[i] ?? 0) + 1;
          else weekly[i] = weekly[i] ?? 0;
        }
        return { chart, points: [], weekly };
      }
      case 'sets_per_muscle': {
        const muscle = metric.ref?.muscle;
        if (!muscle) return empty;
        const names = new Set<string>([muscle, ...(MUSCLE_GROUP_REFINEMENTS[muscle] ?? [])]);
        const { data } = await supabase
          .from('user_volume_stats').select('week_start, muscle_group, set_count')
          .eq('user_id', clerkId).gte('week_start', start);
        const weekly: (number | null)[] = Array.from({ length: weeksSoFar }, () => null);
        for (const r of (data ?? []) as { week_start: string; muscle_group: string; set_count: number }[]) {
          if (!names.has(r.muscle_group)) continue;
          const i = bucket(r.week_start);
          if (i >= 0 && i < weekly.length) weekly[i] = (weekly[i] ?? 0) + Number(r.set_count);
        }
        return { chart, points: [], weekly };
      }
      case 'cardio_sessions': {
        const { data } = await supabase
          .from('drona_week_facts').select('week_start, a_cardio_sessions')
          .eq('user_id', clerkId).gte('week_start', start);
        const weekly: (number | null)[] = Array.from({ length: weeksSoFar }, () => null);
        for (const r of (data ?? []) as { week_start: string; a_cardio_sessions: number | null }[]) {
          const i = bucket(r.week_start);
          if (i >= 0 && i < weekly.length && r.a_cardio_sessions != null) weekly[i] = (weekly[i] ?? 0) + Number(r.a_cardio_sessions);
        }
        return { chart, points: [], weekly };
      }
    }
  } catch (e) {
    console.warn('[programs] metric series failed', e);
  }
  return empty;
}
