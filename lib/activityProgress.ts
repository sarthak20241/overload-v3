/**
 * Today's steps and this week's cardio against the current phase's activity
 * goals (lib/activityGoals holds the rules). Read-only, for the dashboard.
 * The goals come from the program the dashboard already holds
 * (lib/dashboardProgram activityTargetsFrom); only the readings are read here.
 *
 * Fails open: a read error returns null, and the dashboard simply shows
 * nothing. A wrong "0 steps" is worse than no row.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  cardioRowsFromWorkouts, countCardioSessions, goalProgress,
  stepsProgressFromReading, type GoalProgress, type WorkoutWithSets,
} from '@/lib/activityGoals';
import { todayLocalISO } from '@/lib/programDates';
import type { ActivityTargets } from '@/lib/dashboardProgram';

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
  { stepsTarget, cardioTarget }: ActivityTargets,
): Promise<ActivityProgress | null> {
  try {
    const today = todayLocalISO();
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
        .select('id, workout_sets(completed, set_type, exercises(muscle_group, metric_type))')
        .eq('user_id', clerkId)
        .not('finished_at', 'is', null)
        .gte('started_at', localWeekStart().toISOString()),
    ]);
    // A failed read hides that half rather than showing 0 done, and so does
    // no step reading yet today (no Health sync, or it has not run).
    const steps = stepsRes && !stepsRes.error
      ? stepsProgressFromReading((stepsRes.data as { value?: unknown } | null)?.value, stepsTarget)
      : null;
    const cardio = cardioRes && !cardioRes.error
      ? goalProgress(
          countCardioSessions(cardioRowsFromWorkouts((cardioRes.data ?? []) as unknown as WorkoutWithSets[])),
          cardioTarget,
        )
      : null;
    if (!steps && !cardio) return null;
    return { steps, cardio };
  } catch (e) {
    console.warn('[activity] progress read failed', e);
    return null;
  }
}
