/**
 * What the dashboard's TODAY card and movement-goals row need from the active
 * program, taken from the program lib/programData already reads and caches
 * (loadActiveProgram / peekActiveProgram) instead of two reads of their own on
 * every focus. Pure, so `deno test lib/dashboardProgram.test.ts` covers it.
 */
import { computeActivePhaseSeq, todayLocalISO } from '@/lib/programDates';
import { clampCardioSessions, clampStepsTarget } from '@/lib/activityGoals';
import { weekPatternFor } from '@/lib/weekPattern';
import type { PickProgram } from '@/lib/todayPick';

/** The fields read here; lib/programData's ActiveProgram has them all, phases in seq order. */
export interface DashboardProgramSource {
  id: string;
  start_date: string;
  phases: {
    id: string;
    seq: number;
    duration_weeks: number;
    start_offset_weeks: number;
    training_block: unknown;
    activity_steps_target: unknown;
    cardio_sessions_per_week: unknown;
  }[];
}

/**
 * The program as the TODAY pick takes it, in the shape the dashboard's own
 * read built (and cached on disk as 'activeProgram'). A program with no phases
 * comes back as null from loadActiveProgram; the pick reads both the same
 * ('no-program').
 */
export function pickProgramFrom(p: DashboardProgramSource | null): PickProgram | null {
  if (!p) return null;
  return {
    id: String(p.id),
    start_date: String(p.start_date),
    // The week pattern is resolved here (coach's if it holds up, else the one
    // built from days_per_week) so lib/todayPick stays import-free.
    phases: p.phases.map((ph) => ({
      id: ph.id,
      duration_weeks: ph.duration_weeks,
      start_offset_weeks: ph.start_offset_weeks,
      week_pattern: weekPatternFor(ph.training_block as Parameters<typeof weekPatternFor>[0]) ?? null,
    })),
  };
}

export interface ActivityTargets {
  /** Steps a day; null = no step goal. */
  stepsTarget: number | null;
  /** Cardio sessions a week; null = no cardio goal. */
  cardioTarget: number | null;
}

/**
 * The movement goals of the phase active on `today`, or null when there is
 * nothing to show (no program, not started, ended, no goals). By date, not by
 * the program's stored current phase: a cached program may have been read
 * on another day.
 */
export function activityTargetsFrom(
  p: DashboardProgramSource | null,
  today: string = todayLocalISO(),
): ActivityTargets | null {
  if (!p || p.phases.length === 0) return null;
  // An index into `phases` (ordered by seq), not a seq value.
  const idx = computeActivePhaseSeq(String(p.start_date), p.phases, today);
  if (idx == null) return null;
  const phase = p.phases[idx];
  const stepsTarget = clampStepsTarget(phase.activity_steps_target);
  const cardioTarget = clampCardioSessions(phase.cardio_sessions_per_week);
  if (stepsTarget == null && cardioTarget == null) return null;
  return { stepsTarget, cardioTarget };
}
