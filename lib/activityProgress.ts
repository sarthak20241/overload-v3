/**
 * Today's steps and this week's cardio against the current phase's activity
 * goals (lib/activityGoals holds the rules). Read-only, for the dashboard.
 *
 * Fails open: no program, no goals, a database from before the goal columns,
 * or any read error all return null, and the dashboard simply shows nothing.
 * A wrong "0 steps" is worse than no row.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  cardioRowsFromWorkouts, clampCardioSessions, clampStepsTarget, countCardioSessions, goalProgress,
  stepsProgressFromReading, type GoalProgress, type WorkoutWithSets,
} from '@/lib/activityGoals';
import { computeActivePhaseSeq, todayLocalISO } from '@/lib/programData';
import { getPendingWorkouts } from '@/lib/syncQueue';
import { queuedCardioRows } from '@/lib/cardioLog';

export interface ActivityProgress {
  /** Today's steps vs the phase's step goal; null = no step goal. */
  steps: GoalProgress | null;
  /** This week's cardio sessions vs the phase's cardio goal; null = no cardio goal. */
  cardio: GoalProgress | null;
}

/**
 * Local midnight on the Monday of this week, as a Date. The DEVICE's week, like
 * every other dashboard read (todayLocalISO). The weekly facts use the stored
 * profile time zone, so the two can differ for a few hours after travel.
 */
function localWeekStart(now: Date = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export async function loadActivityProgress(
  supabase: SupabaseClient,
  clerkId: string,
): Promise<ActivityProgress | null> {
  try {
    const { data: prog, error: progErr } = await supabase
      .from('coach_programs')
      .select('id, start_date')
      .eq('user_id', clerkId)
      .eq('status', 'active')
      .maybeSingle();
    if (progErr || !prog) return null;

    // Its own read, so a database without the columns errors HERE and only
    // costs this row.
    const { data: phases, error: phErr } = await supabase
      .from('coach_program_phases')
      .select('seq, duration_weeks, start_offset_weeks, activity_steps_target, cardio_sessions_per_week')
      .eq('program_id', (prog as { id: string }).id)
      .order('seq', { ascending: true });
    if (phErr || !phases || phases.length === 0) return null;

    const today = todayLocalISO();
    // An index into `phases` (ordered by seq), not a seq value.
    const idx = computeActivePhaseSeq(String((prog as { start_date: string }).start_date), phases, today);
    if (idx == null) return null;
    const phase = phases[idx] as { activity_steps_target: unknown; cardio_sessions_per_week: unknown };
    const stepsTarget = clampStepsTarget(phase.activity_steps_target);
    const cardioTarget = clampCardioSessions(phase.cardio_sessions_per_week);
    if (stepsTarget == null && cardioTarget == null) return null;

    const [stepsRes, cardioRes] = await Promise.all([
      stepsTarget == null ? null : supabase
        .from('daily_metrics')
        .select('value')
        .eq('user_id', clerkId)
        .eq('metric_type', 'steps')
        .eq('metric_date', today)
        .maybeSingle(),
      cardioTarget == null ? null : supabase
        .from('workouts')
        .select('id, client_id, workout_sets(completed, set_type, exercises(muscle_group, metric_type))')
        .eq('user_id', clerkId)
        .not('finished_at', 'is', null)
        .gte('started_at', localWeekStart().toISOString()),
    ]);
    // A failed read hides that half rather than showing 0 done, and so does
    // no step reading yet today (no Health sync, or it has not run).
    const steps = stepsRes && !stepsRes.error
      ? stepsProgressFromReading((stepsRes.data as { value?: unknown } | null)?.value, stepsTarget)
      : null;
    // Saved but not yet synced workouts count too, so a cardio session moves
    // the card the moment it is saved (never gate on the flush landing).
    const cardio = cardioRes && !cardioRes.error
      ? (() => {
          const server = (cardioRes.data ?? []) as unknown as (WorkoutWithSets & { client_id?: string | null })[];
          const serverClientIds = new Set(server.map((w) => w.client_id).filter((c): c is string => !!c));
          const rows = [
            ...cardioRowsFromWorkouts(server),
            ...queuedCardioRows(getPendingWorkouts(clerkId), localWeekStart(), serverClientIds),
          ];
          return goalProgress(countCardioSessions(rows), cardioTarget);
        })()
      : null;
    if (!steps && !cardio) return null;
    return { steps, cardio };
  } catch (e) {
    console.warn('[activity] progress read failed', e);
    return null;
  }
}
