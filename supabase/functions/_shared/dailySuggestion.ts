/**
 * Build one user's saved TODAY pick for their local day. Run by the
 * daily-suggestion function at the user's local 00:00 (cron) and when the app
 * finds no pick, or a stale one, on open.
 *
 * "As of midnight": only workouts finished before the day began count, so a
 * pick made at 07:00 after a 06:00 session is the same pick 00:00 would have
 * made (the app shows that session as done; the saved pick is untouched).
 *
 * Pure: the rules come from todayPick/weekPattern, shared with the app.
 */
import { pickToday, planKey, suggestionBasis, type PickProgram } from './todayPick.ts';
import { weekPatternFor } from './weekPattern.ts';
import { wallClock } from './wallClock.ts';

export interface SuggestionRoutine {
  id: string;
  name: string | null;
  created_at: string | null;
  program_phase_id: string | null;
}
export interface SuggestionWorkout {
  name: string | null;
  routine_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
}
export interface SuggestionProgram {
  id: string;
  start_date: string;
  phases: { id: string; duration_weeks: number; start_offset_weeks: number; training_block: unknown }[];
}

export interface SuggestionRow {
  day: string; // YYYY-MM-DD in the user's zone
  kind: 'planned' | 'rest' | 'new';
  routine_id: string | null;
  resumes_on: string | null;
  scheduled: boolean;
  basis: string;
}

export function buildSuggestion(input: {
  routines: SuggestionRoutine[];
  workouts: SuggestionWorkout[];
  program: SuggestionProgram | null;
  timeZone: string;
  now: Date;
}): SuggestionRow | null {
  const { timeZone } = input;
  const nowWall = wallClock(input.now, timeZone);
  if (!nowWall) return null;
  const day = nowWall.slice(0, 10);
  const midnightWall = `${day}T00:00:00`;
  const wall = (iso: string | null) => (iso ? wallClock(iso, timeZone) : null);

  // Only sessions finished before the user's day began.
  const before = input.workouts
    .map((w) => ({ raw: w, doneWall: wall(w.finished_at || w.started_at || w.created_at) }))
    .filter((w) => w.doneWall !== null && w.doneWall < midnightWall);
  const latestMs = before.reduce((max, w) => {
    const t = Date.parse(w.raw.finished_at || w.raw.started_at || w.raw.created_at || '');
    return Number.isFinite(t) && t > max ? t : max;
  }, 0);

  const routines = input.routines.map((r) => ({ ...r, created_at: wall(r.created_at) }));
  const workouts = before.map(({ raw }) => ({
    name: raw.name,
    routine_id: raw.routine_id,
    started_at: wall(raw.started_at),
    finished_at: wall(raw.finished_at),
    created_at: wall(raw.created_at),
  }));
  const program: PickProgram | null = input.program
    ? {
        id: input.program.id,
        start_date: input.program.start_date,
        phases: input.program.phases.map((ph) => ({
          id: ph.id,
          duration_weeks: ph.duration_weeks,
          start_offset_weeks: ph.start_offset_weeks,
          week_pattern: weekPatternFor(ph.training_block as Parameters<typeof weekPatternFor>[0]) ?? null,
        })),
      }
    : null;

  // Runtime-local reading of the user's wall clock (see wallClock).
  const now = new Date(nowWall);
  const pick = pickToday({ routines, workouts, program, now });
  const basis = suggestionBasis(planKey(program, routines, now), latestMs);

  if (pick.kind === 'planned') {
    return { day, kind: 'planned', routine_id: pick.routine.id, resumes_on: null, scheduled: pick.scheduled, basis };
  }
  if (pick.kind === 'rest') {
    const r = pick.resumesOn;
    const resumes = `${r.getFullYear()}-${String(r.getMonth() + 1).padStart(2, '0')}-${String(r.getDate()).padStart(2, '0')}`;
    return { day, kind: 'rest', routine_id: pick.next.id, resumes_on: resumes, scheduled: true, basis };
  }
  // 'complete' cannot happen (today's sessions were filtered out); 'new' = no routines.
  return { day, kind: 'new', routine_id: null, resumes_on: null, scheduled: false, basis };
}
