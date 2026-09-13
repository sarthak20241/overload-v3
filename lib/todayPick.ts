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
 * Rest days come from the phase's week pattern (Day 1..Day 7, "Rest" for a day
 * off), and the pattern follows the user, not the calendar. The n-th session of
 * the phase sits on the n-th training day of the pattern; the rest days after
 * that training day must pass before the next session is due. A missed day
 * never piles up: once the rest has passed, the session simply stays due.
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
  /** Null on a legacy row, or while a finished workout is still syncing. */
  finished_at?: string | null;
  created_at?: string | null;
}

/** The persisted program shape the pick needs: when it started, and its phases. */
export interface PickProgram {
  start_date: string; // YYYY-MM-DD, local
  phases: {
    id: string;
    duration_weeks: number;
    start_offset_weeks: number;
    /** 7 labels, Day 1 first, "Rest" for a day off. Already normalized by the
     *  caller (lib/weekPattern weekPatternFor); absent = no rest days known. */
    week_pattern?: string[] | null;
  }[];
}

export const REST_LABEL = 'Rest';

export type TodayPick<R extends PickRoutine> =
  /** A rest day in the phase's week. `next` is the session due after it, on `resumesOn`. */
  | { kind: 'rest'; routine: null; fromProgram: true; next: R; resumesOn: Date }
  | { kind: 'complete'; routine: null; completedWorkout: PickWorkout; fromProgram: false }
  | { kind: 'new'; routine: null; fromProgram: false }
  /** `scheduled`: a week pattern was applied, so this session is due on this very day. */
  | { kind: 'planned'; routine: R; fromProgram: boolean; scheduled: boolean };

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

/** The phase today falls in, or null (not started, ended, or no program). */
function currentPhase(program: PickProgram | null | undefined, now: Date) {
  if (!program) return null;
  const days = daysSince(program.start_date, now);
  if (days == null || days < 0) return null;
  for (const ph of program.phases) {
    if (days >= ph.start_offset_weeks * 7 && days < (ph.start_offset_weeks + ph.duration_weeks) * 7) {
      return ph;
    }
  }
  return null;
}

/** The id of the phase today falls in, or null (not started, ended, or no program). */
export function currentPhaseId(program: PickProgram | null | undefined, now: Date = new Date()): string | null {
  return currentPhase(program, now)?.id ?? null;
}

/** A local calendar day as a whole number, so day arithmetic never meets DST. */
const dayNumber = (d: Date) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
const fromDayNumber = (n: number) => {
  const u = new Date(n * 86_400_000);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 12);
};

export function pickToday<R extends PickRoutine>(input: TodayPickInput<R>): TodayPick<R> {
  const now = input.now ?? new Date();
  const workouts = input.workouts ?? [];
  const routines = input.routines ?? [];

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // "Done today" means FINISHED today: a session that ran past midnight still
  // counts. Rows without finished_at fall back to when they started.
  const doneAt = (w: PickWorkout) => ms(w.finished_at || w.started_at || w.created_at);
  const completedWorkout = workouts.reduce<PickWorkout | null>((latest, workout) => {
    const at = doneAt(workout);
    if (at < startOfToday) return latest;
    const latestAt = latest ? doneAt(latest) : -1;
    return at > latestAt ? workout : latest;
  }, null);
  if (completedWorkout) {
    return { kind: 'complete', routine: null, completedWorkout, fromProgram: false };
  }
  if (routines.length === 0) return { kind: 'new', routine: null, fromProgram: false };

  const phase = currentPhase(input.program, now);
  const phaseRoutines = phase ? routines.filter((r) => r.program_phase_id === phase.id) : [];
  const fromProgram = phaseRoutines.length > 0;
  const candidates = fromProgram ? phaseRoutines : routines;

  const isSessionOf = (w: PickWorkout, r: R) => {
    const name = (r.name ?? '').trim().toLowerCase();
    return (!!w.routine_id && w.routine_id === r.id)
      || (!!name && (w.name ?? '').trim().toLowerCase() === name);
  };
  const lastDoneAt = (r: R) => {
    let last = 0; // never done -> most due
    for (const w of workouts) {
      if (isSessionOf(w, r)) last = Math.max(last, ms(w.started_at || w.created_at));
    }
    return last;
  };

  // Without a program, ties keep the list's own order (the dashboard's routines
  // arrive newest first, and onboarding staggers created_at so Day A leads it).
  const pick = [...candidates].sort(
    (a, b) => lastDoneAt(a) - lastDoneAt(b)
      || (fromProgram ? ms(a.created_at) - ms(b.created_at) : 0),
  )[0];

  // Rest days: only for a built split with a usable week pattern.
  const pattern = fromProgram && phase?.week_pattern?.length === 7 ? phase.week_pattern : null;
  const trainingSlots = pattern ? pattern.flatMap((label, i) => (label === REST_LABEL ? [] : [i])) : [];
  if (!pattern || trainingSlots.length === 0 || !input.program) {
    return { kind: 'planned', routine: pick, fromProgram, scheduled: false };
  }

  // This phase's sessions so far, oldest first.
  // (currentPhase found a phase, so the start date parsed.)
  const programStartDay = dayNumber(now) - (daysSince(input.program.start_date, now) ?? 0);
  const phaseStartDay = programStartDay + phase!.start_offset_weeks * 7;
  const sessions = workouts
    .filter((w) => phaseRoutines.some((r) => isSessionOf(w, r)))
    .map((w) => doneAt(w))
    .filter((t) => t > 0 && dayNumber(new Date(t)) >= phaseStartDay)
    .sort((a, b) => a - b);
  if (sessions.length === 0) {
    return { kind: 'planned', routine: pick, fromProgram, scheduled: true };
  }

  // The last session sat on training slot k; the next one is k + 1 (wrapping
  // into the next week). The days between them in the pattern are rest.
  const T = trainingSlots.length;
  const k = (sessions.length - 1) % T;
  const here = trainingSlots[k];
  const there = trainingSlots[(k + 1) % T];
  const restDays = T === 1 ? 6 : (there - here - 1 + 7) % 7;
  const dueDay = dayNumber(new Date(sessions[sessions.length - 1])) + restDays + 1;

  if (dayNumber(now) < dueDay) {
    return { kind: 'rest', routine: null, fromProgram: true, next: pick, resumesOn: fromDayNumber(dueDay) };
  }
  return { kind: 'planned', routine: pick, fromProgram, scheduled: true };
}

/**
 * The session after today's, for the "up next" line once today is done.
 * It is the same pick run from tomorrow: today's workout is then in the past,
 * so its routine drops to the back of the rotation. Noon, not now + 24h, so a
 * DST change can never land it on the wrong calendar day.
 */
export function pickUpNext<R extends PickRoutine>(
  input: TodayPickInput<R>,
): { tomorrow: Date; pick: TodayPick<R> } {
  const now = input.now ?? new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12);
  return { tomorrow, pick: pickToday({ ...input, now: tomorrow }) };
}
