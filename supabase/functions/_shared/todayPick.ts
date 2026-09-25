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
 * A session counts as the program day it trained, however it was logged. One
 * of the phase's own routines counts as that routine. Any other session (no
 * routine, or the person's own) counts as the day whose muscle groups it
 * covers best, when it covers at least half of them. No tester had ever opened
 * an active program's routine, so without this the pick never moved.
 *
 * What comes next weighs the last 7 days first: a day at least half of whose
 * muscle groups were trained in them, by any mix of sessions, waits behind a
 * day whose muscles were left alone. Then "most due", then day order.
 *
 * Rest days come from the phase's week pattern (Day 1..Day 7, "Rest" for a day
 * off), and the pattern follows the user, not the calendar. The n-th session of
 * the phase sits on the n-th training day of the pattern; the rest days after
 * that training day must pass before the next session is due. A missed day
 * never piles up: once the rest has passed, the session simply stays due.
 *
 * Pure: no imports, no React, no network. Unit-tested in todayPick.test.ts.
 */

/**
 * An embedded exercise row: all the pick reads is its muscle group. PostgREST
 * sends a to-one embed as one object; supabase-js without generated types
 * calls it a list, so both are read.
 */
type PickExercise = { muscle_group?: string | null } | { muscle_group?: string | null }[] | null;
const muscleGroupOf = (e: PickExercise | undefined) => (Array.isArray(e) ? e[0] : e)?.muscle_group;

export interface PickRoutine {
  id: string;
  name?: string | null;
  created_at?: string | null;
  program_phase_id?: string | null;
  /** Its exercises, as `routine_exercises(exercises(...))` embeds them. Absent = muscles unknown. */
  routine_exercises?: { exercises?: PickExercise }[] | null;
}

export interface PickSet {
  completed?: boolean | null;
  set_type?: string | null;
  exercises?: PickExercise;
}

export interface PickWorkout {
  name?: string | null;
  routine_id?: string | null;
  started_at?: string | null;
  /** Null on a legacy row, or while a finished workout is still syncing. */
  finished_at?: string | null;
  created_at?: string | null;
  /** Its sets: the app names them `sets`, the database `workout_sets`. */
  sets?: PickSet[] | null;
  workout_sets?: PickSet[] | null;
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

// ── Muscles ─────────────────────────────────────────────────────────────────
// Compared at the parent group, so a day of Lats and a day of Back are the same
// work. Heads follow lib/exercises MUSCLE_GROUP_REFINEMENTS (Adductors, listed
// under three legs groups, goes to the first). An unknown name is its own group.
const PARENT_OF: Record<string, string> = {};
for (const [parent, heads] of Object.entries({
  chest: ['upper chest', 'mid chest', 'lower chest'],
  back: ['lats', 'upper back', 'lower back', 'traps'],
  shoulders: ['front delts', 'side delts', 'rear delts', 'neck'],
  biceps: ['biceps long head', 'biceps short head', 'brachialis'],
  triceps: ['triceps long head', 'triceps lateral head', 'triceps medial head'],
  forearms: ['wrist flexors', 'wrist extensors', 'brachioradialis', 'grip'],
  core: ['abs', 'lower abs', 'obliques'],
  quads: ['outer quads', 'inner quads', 'hip flexors', 'adductors'],
  glutes: ['glute max', 'glute medius'],
  calves: ['gastrocnemius', 'soleus', 'tibialis'],
})) {
  PARENT_OF[parent] = parent;
  for (const head of heads) PARENT_OF[head] ??= parent;
}

/** The parent group of a muscle, lower case. "Other" and blanks say nothing.
 *  Kept in step with lib/exercises by a test in todayPick.test.ts. */
export function muscleParent(group: string | null | undefined): string | null {
  const g = (group ?? '').trim().toLowerCase();
  if (!g || g === 'other') return null;
  return PARENT_OF[g] ?? g;
}

function routineMuscles(r: PickRoutine): Set<string> {
  const out = new Set<string>();
  for (const re of r.routine_exercises ?? []) {
    const p = muscleParent(muscleGroupOf(re?.exercises));
    if (p) out.add(p);
  }
  return out;
}

/** What a session trained: its completed working sets. Warm-ups train nothing. */
function workoutMuscles(w: PickWorkout): Set<string> {
  const out = new Set<string>();
  for (const s of w.sets ?? w.workout_sets ?? []) {
    if (!s || s.completed === false || s.set_type === 'warmup') continue;
    const p = muscleParent(muscleGroupOf(s.exercises));
    if (p) out.add(p);
  }
  return out;
}

/** Share of a day's muscle groups found in `trained`. */
const coverage = (day: Set<string>, trained: Set<string>) => {
  if (day.size === 0) return 0;
  let hit = 0;
  for (const m of day) if (trained.has(m)) hit += 1;
  return hit / day.size;
};

/** At least this share of a day's muscle groups is that day's work. */
const COVERS_DAY = 0.5;
/** How far back "trained lately" looks, in days before today. */
const LATELY_DAYS = 7;

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
  const muscles = new Map(candidates.map((r) => [r, routineMuscles(r)] as const));
  const startedAt = (w: PickWorkout) => ms(w.started_at || w.created_at);
  // Day order: a split's days by created_at; otherwise the list's own order
  // (the dashboard's routines arrive newest first, and onboarding staggers
  // created_at so Day A leads it).
  const dayOrder = (a: R, b: R) =>
    fromProgram ? ms(a.created_at) - ms(b.created_at) : candidates.indexOf(a) - candidates.indexOf(b);

  // Which day each session counts as, oldest first. A session of a candidate
  // counts as it. Any other counts as the day it covers best (at least half),
  // a tie going to the day that was due then.
  const lastDone = new Map<R, number>(); // never done -> absent -> most due
  const countsAs = new Map<PickWorkout, R>();
  for (const w of [...workouts].sort((a, b) => startedAt(a) - startedAt(b))) {
    let day = candidates.find((r) => isSessionOf(w, r));
    if (!day) {
      const trained = workoutMuscles(w);
      day = candidates
        .map((r) => ({ r, c: coverage(muscles.get(r)!, trained) }))
        .filter((x) => x.c >= COVERS_DAY)
        .sort((a, b) => b.c - a.c
          || (lastDone.get(a.r) ?? 0) - (lastDone.get(b.r) ?? 0)
          || dayOrder(a.r, b.r))[0]?.r;
    }
    if (!day) continue;
    countsAs.set(w, day);
    lastDone.set(day, Math.max(lastDone.get(day) ?? 0, startedAt(w)));
  }

  // Muscle groups trained in the last 7 days, by any session.
  const since = startOfToday - LATELY_DAYS * 86_400_000;
  const lately = new Set<string>();
  for (const w of workouts) {
    const at = doneAt(w);
    if (at >= since && at < startOfToday) for (const m of workoutMuscles(w)) lately.add(m);
  }
  // A day done in the window counts too: its sets may still be syncing, or it
  // has no muscles to read.
  const trainedLately = (r: R) =>
    ((lastDone.get(r) ?? 0) >= since || coverage(muscles.get(r)!, lately) >= COVERS_DAY ? 1 : 0);

  const pick = [...candidates].sort(
    (a, b) => trainedLately(a) - trainedLately(b)
      || (lastDone.get(a) ?? 0) - (lastDone.get(b) ?? 0)
      || (fromProgram ? dayOrder(a, b) : 0),
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
    .filter((w) => countsAs.has(w))
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

// ── The day's saved pick ─────────────────────────────────────────────────────
// The server makes each user's pick at their local 00:00 (daily-suggestion) and
// saves it. The app shows that saved pick all day, and asks for a new one only
// when the plan behind it changed: a new program or phase, the phase's split
// built or rebuilt, a workout from before today that synced late, or the saved
// routine gone. A session finished today still shows as done.

/** A saved day's pick, as the daily_suggestions row carries it. */
export interface SavedPick {
  day: string; // YYYY-MM-DD, local
  kind: 'planned' | 'rest' | 'new';
  routine_id: string | null;
  resumes_on: string | null;
  scheduled: boolean;
  basis: string;
}

const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const atNoon = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

/**
 * The plan a day's pick depends on: which program, which phase today falls
 * in, and which routines make up that phase's split.
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

/** Newest workout finished before `now`'s local day began (epoch ms, 0 if none). */
export function latestWorkoutBeforeDay(workouts: PickWorkout[] | null | undefined, now: Date): number {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let latest = 0;
  for (const w of workouts ?? []) {
    const t = ms(w.finished_at || w.started_at || w.created_at);
    if (t > 0 && t < startOfDay && t > latest) latest = t;
  }
  return latest;
}

export type TodayView<R extends PickRoutine> = TodayPick<R> | { kind: 'preparing'; routine: null; fromProgram: false };

/**
 * What the TODAY card shows, given the day's saved pick (if any).
 *
 * - `dataReady`: the dashboard's server reads of routines, program and
 *   workouts have settled. Before that its data may be a stale cache, so a
 *   saved pick is trusted as is and nothing is requested.
 * - `requesting`: a request for a new pick is in flight. With no usable saved
 *   pick the card says so ("preparing") instead of guessing.
 *
 * Returns the view, this device's basis, and whether a new pick is needed.
 * Without a usable saved pick and no request in flight, the phone's own pick
 * is shown, so the card is never empty offline.
 */
export function resolveToday<R extends PickRoutine>(input: TodayPickInput<R> & {
  saved: SavedPick | null | undefined;
  dataReady: boolean;
  requesting: boolean;
}): { view: TodayView<R>; basis: string; needsRequest: boolean } {
  const now = input.now ?? new Date();
  const routines = input.routines ?? [];
  const local = pickToday({ ...input, now });
  const basis = suggestionBasis(planKey(input.program, routines, now), latestWorkoutBeforeDay(input.workouts, now));

  if (local.kind === 'complete') return { view: local, basis, needsRequest: false };

  const saved = input.saved && input.saved.day === localISO(now) ? input.saved : null;
  const current = !!saved && (!input.dataReady || saved.basis === basis);
  let mapped: TodayPick<R> | null = null;
  if (saved && current) {
    const routine = saved.routine_id ? routines.find((r) => r.id === saved.routine_id) : undefined;
    const phaseId = currentPhaseId(input.program, now);
    if (saved.kind === 'new' && routines.length === 0) {
      mapped = { kind: 'new', routine: null, fromProgram: false };
    } else if (saved.kind === 'planned' && routine) {
      mapped = { kind: 'planned', routine, fromProgram: !!phaseId && routine.program_phase_id === phaseId, scheduled: saved.scheduled };
    } else if (saved.kind === 'rest' && routine && saved.resumes_on) {
      mapped = { kind: 'rest', routine: null, fromProgram: true, next: routine, resumesOn: atNoon(saved.resumes_on) };
    }
  }
  if (mapped) return { view: mapped, basis, needsRequest: false };

  const needsRequest = input.dataReady;
  if (input.requesting) return { view: { kind: 'preparing', routine: null, fromProgram: false }, basis, needsRequest };
  return { view: local, basis, needsRequest };
}

/**
 * What a saved day's pick was made from: the plan (planKey) plus the newest
 * workout finished before that day began, as epoch seconds. The app compares
 * its own basis with the saved row's; a mismatch (a workout that synced late,
 * a split built, a new program) asks the server to pick again.
 */
export function suggestionBasis(plan: string, latestWorkoutMs: number): string {
  return `${plan}#${latestWorkoutMs > 0 ? Math.floor(latestWorkoutMs / 1000) : 0}`;
}
