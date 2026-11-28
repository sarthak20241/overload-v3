/**
 * Session time: how long one workout may take, and a plan held to it.
 *
 * Why this exists. A user wrote "Home, 20 minutes" at onboarding and Drona
 * built four sessions of 27 to 35 minutes (14 to 19 sets, 60 to 120 s rests).
 * The time lived only in free text, the day fills that pick sets and rest
 * were never told a limit, and nothing added the minutes up. So:
 *
 *   1. sessionCap() finds the limit: the form's choice in this request, else
 *      the profile's session_minutes (onboarding asks it), else a time the
 *      user wrote in training_preferences.
 *   2. The builder tells the skeleton and every fill the limit.
 *   3. fitWorkoutToMinutes() is the safety net in code: it adds up a session
 *      and trims rest, then sets, then the last exercises until it fits.
 *
 * Pure on purpose (no imports), so `deno test` reaches every rule.
 */

export const SESSION_MINUTES_MIN = 10;
export const SESSION_MINUTES_MAX = 180;

export interface TimedExercise {
  sets: number;
  reps: string;
  rest_seconds: number;
}

export interface TimedWorkout<E extends TimedExercise = TimedExercise> {
  exercises: E[];
}

function valid(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const m = Math.round(n);
  return m >= SESSION_MINUTES_MIN && m <= SESSION_MINUTES_MAX ? m : null;
}

const MIN_UNIT = String.raw`(?:minutes?|mins?)\b`;
const HOUR_UNIT = String.raw`(?:hours?|hrs?|h)\b`;
const NUM = String.raw`(\d+(?:\.\d+)?)`;

/**
 * Every session length named in free text, in minutes: "20 minutes",
 * "45 min", "30-45 mins" (its top), "1 hour", "1.5 hrs", "an hour",
 * "half an hour". Out-of-range numbers are dropped.
 */
function durationsIn(text: string): number[] {
  const t = text.toLowerCase();
  const out: number[] = [];
  const push = (n: number) => { const v = valid(n); if (v != null) out.push(v); };
  const consumed: [number, number][] = [];
  const free = (i: number, j: number) => consumed.every(([a, b]) => j <= a || i >= b);
  const scan = (re: RegExp, f: (m: RegExpExecArray) => number) => {
    for (const m of t.matchAll(re)) {
      const i = m.index ?? 0;
      const j = i + m[0].length;
      if (!free(i, j)) continue;
      consumed.push([i, j]);
      push(f(m as RegExpExecArray));
    }
  };
  // Ranges first, so "30-45 min" is one length (45), not 30 and 45.
  scan(new RegExp(String.raw`${NUM}\s*(?:-|–|to)\s*${NUM}\s*${MIN_UNIT}`, "g"), (m) => parseFloat(m[2]));
  scan(new RegExp(String.raw`${NUM}\s*(?:-|–|to)\s*${NUM}\s*${HOUR_UNIT}`, "g"), (m) => parseFloat(m[2]) * 60);
  scan(new RegExp(String.raw`${NUM}\s*${MIN_UNIT}`, "g"), (m) => parseFloat(m[1]));
  scan(new RegExp(String.raw`${NUM}\s*${HOUR_UNIT}`, "g"), (m) => parseFloat(m[1]) * 60);
  scan(/\bhalf an? hour\b|\bhalf hour\b/g, () => 30);
  scan(/\b(?:an|one) hour\b/g, () => 60);
  return out;
}

/**
 * The session length a user wrote in free text ("Home, 20 minutes"), or null.
 * When it names several times ("45 min, 10 min warm-up"), the longest is the
 * session; the shorter ones are parts of it.
 */
export function sessionMinutesFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const all = durationsIn(text);
  return all.length ? Math.max(...all) : null;
}

/**
 * The session length the coach form put in this request, as a range. Only the
 * form's own two phrasings count ("Keep sessions about 45-60 min" and
 * "45-60 min sessions"): the rest of a build request carries phase
 * directives ("a 10 min finisher") that are not the session length.
 */
export function requestSessionRange(text: string | null | undefined): { lo: number; hi: number } | null {
  if (!text) return null;
  const m = /\bKeep sessions about (\d+)(?:-(\d+))? min\b/.exec(text)
    ?? /\b(\d+)(?:-(\d+))? min sessions\b/.exec(text);
  if (!m) return null;
  const lo = valid(parseInt(m[1], 10));
  const hi = valid(parseInt(m[2] ?? m[1], 10));
  if (lo == null || hi == null) return null;
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}

/**
 * The most minutes one session of this build may take, or null for no limit.
 * The form's choice in this request wins: the user just picked it. When the
 * profile's time sits inside that range, the profile is the more exact
 * number. With no form choice, the profile's session_minutes, then a time in
 * training_preferences.
 */
export function sessionCap(input: {
  profileMinutes?: number | null;
  preferences?: string | null;
  request?: string | null;
}): number | null {
  const profile = valid(input.profileMinutes ?? null) ?? sessionMinutesFromText(input.preferences);
  const range = requestSessionRange(input.request);
  if (range) return profile != null && profile >= range.lo && profile <= range.hi ? profile : range.hi;
  return profile;
}

/** Seconds one set of this prescription takes, before its rest. */
export function setWorkSeconds(reps: string): number {
  const r = (reps ?? "").trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)\s*s$/.exec(r);
  if (m) return parseFloat(m[1]);
  m = /^(\d+(?:\.\d+)?)\s*min$/.exec(r);
  if (m) return parseFloat(m[1]) * 60;
  if (/^\d+(?:\.\d+)?\s*m$/.test(r)) return 45; // a carry for distance
  m = /^(\d+)\s*-\s*(\d+)$/.exec(r);
  // About 3 s a rep, from the middle of the range, and never under 20 s.
  if (m) return Math.max(20, ((parseInt(m[1], 10) + parseInt(m[2], 10)) / 2) * 3);
  m = /^(\d+)$/.exec(r);
  if (m) return Math.max(20, parseInt(m[1], 10) * 3);
  return 30;
}

/**
 * Minutes a session takes: every set's work, plus the rest after every set
 * but the last (the rest after an exercise's last set is the walk to the
 * next one).
 */
export function estimateWorkoutMinutes(w: TimedWorkout): number {
  let s = 0;
  for (const e of w.exercises) s += e.sets * (setWorkSeconds(e.reps) + e.rest_seconds);
  const last = w.exercises[w.exercises.length - 1];
  if (last) s -= last.rest_seconds;
  return Math.max(0, s) / 60;
}

/** The longest rest that still leaves room to train in a session this short. */
export function restCeiling(capMinutes: number): number {
  if (capMinutes <= 20) return 60;
  if (capMinutes <= 30) return 75;
  if (capMinutes <= 45) return 90;
  return 300;
}

/** How many exercises fit in one session, for the skeleton's prompt. */
export function maxExercisesFor(capMinutes: number): number {
  return Math.min(8, Math.max(3, Math.round(capMinutes / 5)));
}

/**
 * The same session, cut to fit `capMinutes`. In order, and only as far as it
 * takes: rest down to restCeiling, then a set off the exercise with the most
 * sets (above 2; the later one on a tie, so the main lifts keep theirs), then
 * the last exercise while more than 3 remain, then sets down to 1, then
 * exercises down to 1. A session that already fits comes back unchanged.
 */
export function fitWorkoutToMinutes<E extends TimedExercise, W extends TimedWorkout<E>>(
  w: W,
  capMinutes: number,
): { workout: W; trimmed: boolean } {
  if (estimateWorkoutMinutes(w) <= capMinutes) return { workout: w, trimmed: false };
  const exercises = w.exercises.map((e) => ({ ...e }));
  const over = () => estimateWorkoutMinutes({ exercises }) > capMinutes;
  const ceiling = restCeiling(capMinutes);
  for (const e of exercises) e.rest_seconds = Math.min(e.rest_seconds, ceiling);
  const dropSet = (floor: number) => {
    let pick = -1;
    for (let i = 0; i < exercises.length; i++) {
      if (exercises[i].sets > floor && (pick < 0 || exercises[i].sets >= exercises[pick].sets)) pick = i;
    }
    if (pick < 0) return false;
    exercises[pick].sets -= 1;
    return true;
  };
  while (over() && dropSet(2)) { /* trim */ }
  while (over() && exercises.length > 3) exercises.pop();
  while (over() && dropSet(1)) { /* trim */ }
  while (over() && exercises.length > 1) exercises.pop();
  return { workout: { ...w, exercises }, trimmed: true };
}
