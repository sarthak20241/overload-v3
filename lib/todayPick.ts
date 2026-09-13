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
  /** The program row id. A new program is a new plan, so it re-picks the day. */
  id?: string;
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

// ── The day's pick, held for the day ─────────────────────────────────────────
// The TODAY card should not change its mind every time the home screen loads.
// The first pick of the day is saved and shown all day. It is re-picked only
// when the plan behind it changes: a new day, a new program, a new phase, a
// split built or rebuilt for the phase, or the saved routine gone. A session
// finished today still shows as done; that is status, not a new pick.

/** What is saved for the day. Plain JSON, so it survives a restart. */
export interface DailyPickMemo {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** The plan the pick was made against (see planKey). */
  plan: string;
  kind: 'planned' | 'rest' | 'new';
  /** planned: the routine. rest: the session due after the rest. */
  routineId: string | null;
  scheduled?: boolean;
  /** rest only: local YYYY-MM-DD the next session is due. */
  resumesOn?: string | null;
}

const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const atNoon = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

/**
 * The plan a day's pick depends on: which program, which phase today falls
 * in, and which routines make up that phase's split. Any change here is a
 * trigger to pick again.
 */
export function planKey<R extends PickRoutine>(
  program: PickProgram | null | undefined,
  routines: R[] | null | undefined,
  now: Date,
): string {
  const phase = currentPhase(program, now);
  if (!program || !phase) return 'no-program';
  const split = (routines ?? [])
    .filter((r) => r.program_phase_id === phase.id)
    .map((r) => r.id)
    .sort()
    .join(',');
  return `${program.id ?? program.start_date}|${phase.id}|${split}`;
}

/**
 * Today's pick, held for the day. Returns the pick to show and the memo to
 * save (the same object back when nothing changed, so callers can skip a
 * write by identity).
 */
export function dailyPick<R extends PickRoutine>(
  input: TodayPickInput<R> & { memo: DailyPickMemo | null | undefined },
): { pick: TodayPick<R>; memo: DailyPickMemo | null } {
  const now = input.now ?? new Date();
  const routines = input.routines ?? [];
  const fresh = pickToday({ ...input, now });
  const memo = input.memo ?? null;

  // Done today wins, and leaves the day's memo alone (if the workout is
  // deleted, the day's pick comes back as it was).
  if (fresh.kind === 'complete') return { pick: fresh, memo };

  const day = localISO(now);
  const plan = planKey(input.program, routines, now);
  const phaseId = currentPhaseId(input.program, now);

  if (memo && memo.day === day && memo.plan === plan) {
    if (memo.kind === 'new' && routines.length === 0) {
      return { pick: { kind: 'new', routine: null, fromProgram: false }, memo };
    }
    const held = memo.routineId ? routines.find((r) => r.id === memo.routineId) : undefined;
    if (held && memo.kind === 'planned') {
      const fromProgram = !!phaseId && held.program_phase_id === phaseId;
      return { pick: { kind: 'planned', routine: held, fromProgram, scheduled: !!memo.scheduled }, memo };
    }
    if (held && memo.kind === 'rest' && memo.resumesOn) {
      return { pick: { kind: 'rest', routine: null, fromProgram: true, next: held, resumesOn: atNoon(memo.resumesOn) }, memo };
    }
    // Held routine gone, or "new" with routines now saved: fall through and pick again.
  }

  const next: DailyPickMemo =
    fresh.kind === 'planned'
      ? { day, plan, kind: 'planned', routineId: fresh.routine.id, scheduled: fresh.scheduled }
      : fresh.kind === 'rest'
        ? { day, plan, kind: 'rest', routineId: fresh.next.id, resumesOn: localISO(fresh.resumesOn) }
        : { day, plan, kind: 'new', routineId: null };
  return { pick: fresh, memo: next };
}
