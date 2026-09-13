/**
 * Which session the dashboard's TODAY card offers.
 *
 * When the user follows a coach program, the pick comes from the split built
 * for the phase they are in today. A routine outside that split (an old one,
 * a one-off) is never offered over the program's own days. Without a program,
 * or before the phase's split is built, every saved routine is a candidate.
 *
 * Inside the candidates the rule is "most due": the routine done longest ago,
 * never-done first. In a program split, ties go to day order, which is
 * created_at ascending, because the coach saves a split one day at a time,
 * Day 1 first. So a fresh split opens on Day 1, and a skipped day stays due
 * instead of being jumped.
 *
 * Pure: no imports, no React, no network. Unit-tested in todayPick.test.ts.
 */

export interface PickRoutine {
  id: string;
  name?: string | null;
  created_at?: string | null;
  program_phase_id?: string | null;
}

export interface PickWorkout {
  name?: string | null;
  routine_id?: string | null;
  started_at?: string | null;
  created_at?: string | null;
}

/** The persisted program shape the pick needs: when it started, and its phases. */
export interface PickProgram {
  start_date: string; // YYYY-MM-DD, local
  phases: { id: string; duration_weeks: number; start_offset_weeks: number }[];
}

export type TodayPick<R extends PickRoutine> =
  | { kind: 'rest'; routine: null; fromProgram: false }
  | { kind: 'complete'; routine: null; completedWorkout: PickWorkout; fromProgram: false }
  | { kind: 'new'; routine: null; fromProgram: false }
  | { kind: 'planned'; routine: R; fromProgram: boolean };

export interface TodayPickInput<R extends PickRoutine> {
  routines: R[] | null | undefined;
  workouts: PickWorkout[] | null | undefined;
  program?: PickProgram | null;
  /** Defaults to now; injectable for tests. */
  now?: Date;
}

const ms = (iso: string | null | undefined) => {
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) ? t : 0;
};

/** Local-midnight day count from a YYYY-MM-DD to `now`. Never UTC. */
function daysSince(startISO: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startISO);
  if (!m) return null;
  const start = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((today - start) / 86_400_000);
}

/** The id of the phase today falls in, or null (not started, ended, or no program). */
export function currentPhaseId(program: PickProgram | null | undefined, now: Date = new Date()): string | null {
  if (!program) return null;
  const days = daysSince(program.start_date, now);
  if (days == null || days < 0) return null;
  for (const ph of program.phases) {
    if (days >= ph.start_offset_weeks * 7 && days < (ph.start_offset_weeks + ph.duration_weeks) * 7) {
      return ph.id;
    }
  }
  return null;
}

export function pickToday<R extends PickRoutine>(input: TodayPickInput<R>): TodayPick<R> {
  const now = input.now ?? new Date();
  const workouts = input.workouts ?? [];
  const routines = input.routines ?? [];

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const completedWorkout = workouts.reduce<PickWorkout | null>((latest, workout) => {
    const at = ms(workout.started_at || workout.created_at);
    if (at < startOfToday) return latest;
    const latestAt = latest ? ms(latest.started_at || latest.created_at) : -1;
    return at > latestAt ? workout : latest;
  }, null);
  if (completedWorkout) {
    return { kind: 'complete', routine: null, completedWorkout, fromProgram: false };
  }
  if (routines.length === 0) return { kind: 'new', routine: null, fromProgram: false };

  const phaseId = currentPhaseId(input.program, now);
  const phaseRoutines = phaseId ? routines.filter((r) => r.program_phase_id === phaseId) : [];
  const fromProgram = phaseRoutines.length > 0;
  const candidates = fromProgram ? phaseRoutines : routines;

  const lastDoneAt = (r: R) => {
    const name = (r.name ?? '').trim().toLowerCase();
    let last = 0; // never done -> most due
    for (const w of workouts) {
      const matches = (w.routine_id && w.routine_id === r.id)
        || (!!name && (w.name ?? '').trim().toLowerCase() === name);
      if (matches) last = Math.max(last, ms(w.started_at || w.created_at));
    }
    return last;
  };

  // Without a program, ties keep the list's own order (the dashboard's routines
  // arrive newest first, and onboarding staggers created_at so Day A leads it).
  const pick = [...candidates].sort(
    (a, b) => lastDoneAt(a) - lastDoneAt(b)
      || (fromProgram ? ms(a.created_at) - ms(b.created_at) : 0),
  )[0];
  return { kind: 'planned', routine: pick, fromProgram };
}
