// Step 3: log, change and remove workouts from ChatGPT or Claude.
//
// The assistant names exercises by id (search_exercises) or by exact name, and
// gives each set. Every write goes through writes.ts (one database function,
// one transaction each; 20261111140000). A connector workout earns no XP,
// like an imported one; changing the sets of a workout logged in the app moves
// XP the way the app's edit screen does.

import { addDays, dayOf, dayStart, isDay, localTime, todayIn } from "./days.ts";
import type { Tool, ToolResult } from "./protocol.ts";
import { answer, type Ctx, DATE_PROP, r1, refuse, TOOLS, UUID } from "./tools.ts";
import { WriteRefused } from "./writes.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const SET_TYPES = ["normal", "warmup", "dropset", "failure", "negative"];
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_BACK_DAYS = 365;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WriteRefused) return refuse(e.message);
    throw e;
  }
}

const SET_SCHEMA = {
  type: "object",
  properties: {
    weight_kg: { type: "number", minimum: 0, maximum: 1000, description: "kg on the bar / machine (added weight for weighted bodyweight)." },
    reps: { type: "number", minimum: 0, maximum: 1000 },
    duration_seconds: { type: "integer", minimum: 0, maximum: 21600 },
    distance_m: { type: "number", minimum: 0, maximum: 200000 },
    rpe: { type: "number", minimum: 1, maximum: 10 },
    set_type: { type: "string", enum: SET_TYPES, description: "Default normal. warmup sets do not count toward volume." },
    one_side_at_a_time: { type: "boolean", description: "A one-arm / one-leg set: reps is the left side, reps_right the right." },
    reps_right: { type: "number", minimum: 0, maximum: 1000 },
    weight_kg_right: { type: "number", minimum: 0, maximum: 1000 },
  },
  additionalProperties: false,
};

const EXERCISE_SCHEMA = {
  type: "object",
  properties: {
    exercise_id: { type: "string", description: "From search_exercises. Preferred." },
    exercise_name: { type: "string", description: "Exact exercise name, when there is no id." },
    sets: { type: "array", maxItems: 50, items: SET_SCHEMA },
  },
  required: ["sets"],
  additionalProperties: false,
};

/** One set from the assistant, checked. A string is the refusal. */
export function cleanSet(s: Row, where: string): Row | string {
  const x: Row = {};
  for (const k of ["weight_kg", "reps", "duration_seconds", "distance_m", "rpe", "reps_right", "weight_kg_right"]) {
    if (s[k] == null) continue;
    const n = num(s[k]);
    if (n == null || n < 0) return `${where}: ${k} must be a number of 0 or more.`;
    x[k] = n;
  }
  if ((x.weight_kg ?? 0) > 1000 || (x.weight_kg_right ?? 0) > 1000) return `${where}: weight above 1000 kg.`;
  if ((x.reps ?? 0) > 1000 || (x.reps_right ?? 0) > 1000) return `${where}: more than 1000 reps.`;
  if ((x.duration_seconds ?? 0) > 21600) return `${where}: a set longer than 6 hours.`;
  if ((x.distance_m ?? 0) > 200000) return `${where}: more than 200 km.`;
  if (x.rpe != null && (x.rpe < 1 || x.rpe > 10)) return `${where}: rpe must be 1 to 10.`;
  if (x.duration_seconds != null) x.duration_seconds = Math.round(x.duration_seconds);
  // Right-side fields belong to one-side sets only. Drop them first, so the
  // work check below never counts reps that will not be saved.
  if (s.one_side_at_a_time !== true) {
    delete x.reps_right;
    delete x.weight_kg_right;
  }
  if (!(x.reps > 0 || x.duration_seconds > 0 || x.distance_m > 0 || x.reps_right > 0)) {
    return `${where}: a set needs reps, a duration or a distance.`;
  }
  const t = s.set_type == null || s.set_type === "" ? "normal" : s.set_type;
  if (!SET_TYPES.includes(t)) return `${where}: set_type must be one of ${SET_TYPES.join(", ")}.`;
  x.set_type = t;
  if (s.one_side_at_a_time === true) x.one_side_at_a_time = true;
  return x;
}

/** Exercises with ids, names resolved, sets checked. `allowEmpty`: an empty
 *  set list means "remove this exercise" (update only). */
async function cleanExercises(ctx: Ctx, list: unknown, allowEmpty: boolean): Promise<Row[] | ToolResult> {
  if (!Array.isArray(list) || list.length < 1 || list.length > 30) return refuse("exercises must hold 1 to 30 exercises.");
  const out: Row[] = [];
  for (const [i, raw] of list.entries()) {
    const e = (raw ?? {}) as Row;
    let id: string | null = null;
    let label = `Exercise ${i + 1}`;
    if (typeof e.exercise_id === "string" && e.exercise_id) {
      if (!UUID.test(e.exercise_id)) return refuse(`${label}: exercise_id must be an id from search_exercises.`);
      id = e.exercise_id;
    } else if (typeof e.exercise_name === "string" && e.exercise_name.trim().length >= 2) {
      const name = e.exercise_name.trim();
      label = `"${name}"`;
      const found = await ctx.data.searchExercises(ctx.userId, name, 15);
      const exact = found.filter((f) => f.name.toLowerCase() === name.toLowerCase());
      if (exact.length !== 1) {
        return {
          text: JSON.stringify({
            matched: false,
            exercise: name,
            note: "No single exact exercise match. Pick an id and send exercise_id, or ask the user.",
            candidates: found.slice(0, 8).map((f) => ({ id: f.id, name: f.name, muscle_group: f.muscle_group })),
          }),
          isError: true,
        };
      }
      id = exact[0].id;
    } else {
      return refuse(`${label}: give exercise_id or exercise_name.`);
    }
    if (out.some((o) => o.exercise_id === id)) return refuse(`${label} appears twice. Put all its sets in one entry.`);
    if (!Array.isArray(e.sets) || e.sets.length > 50 || (!allowEmpty && e.sets.length < 1)) {
      return refuse(`${label}: sets must hold ${allowEmpty ? 0 : 1} to 50 sets.`);
    }
    const sets: Row[] = [];
    for (const [j, s] of e.sets.entries()) {
      const c = cleanSet((s ?? {}) as Row, `${label} set ${j + 1}`);
      if (typeof c === "string") return refuse(c);
      sets.push(c);
    }
    out.push({ exercise_id: id, sets });
  }
  return out;
}

/** A local day + "HH:MM" as a UTC instant. */
function at(day: string, time: string, tz: string): Date {
  const [, h, m] = time.match(TIME)!;
  return new Date(dayStart(day, tz).getTime() + (Number(h) * 60 + Number(m)) * 60_000);
}

async function detail(ctx: Ctx, id: string): Promise<Row> {
  const getWorkout = TOOLS.find((t) => t.name === "get_workout")!;
  const r = await getWorkout.run({ workout_id: id }, ctx);
  return r.isError ? { id } : JSON.parse(r.text);
}

// ── log_workout ─────────────────────────────────────────────────────────────

const logWorkout: Tool = {
  name: "log_workout",
  title: "Log a workout",
  description: "Saves a finished workout to the user's Overload history: name, when, how long, and " +
    "each exercise's sets in the order done. Use exercise ids from search_exercises (or exact names). " +
    "Weights are kg. Log only what the user said they did. Workouts logged here earn no XP. " +
    "Returns the saved workout with its id (for update_workout / delete_workout).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80, description: "e.g. Push day, Legs, 5k run." },
      date: { ...DATE_PROP, description: "YYYY-MM-DD, the user's local day. Default: today." },
      start_time: { type: "string", pattern: "^\\d{1,2}:\\d{2}$", description: "HH:MM local, 24-hour. Default: today it ended now; another day 18:00." },
      duration_minutes: { type: "integer", minimum: 1, maximum: 360, description: "Default 60." },
      notes: { type: "string", maxLength: 2000 },
      exercises: { type: "array", minItems: 1, maxItems: 30, items: EXERCISE_SCHEMA },
      request_id: { type: "string", maxLength: 100, description: "Optional. Sending the same id again returns the first result instead of logging twice." },
    },
    required: ["name", "exercises"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  run(a, raw) {
    return guarded(async () => {
      const ctx = raw as Ctx;
      if (!ctx.writes) throw new Error("writes missing from context");
      const name = typeof a.name === "string" ? a.name.trim() : "";
      if (!name || name.length > 80) return refuse("name must be 1 to 80 letters.");
      const minutes = a.duration_minutes == null ? 60 : num(a.duration_minutes);
      if (minutes == null || minutes < 1 || minutes > 360) return refuse("duration_minutes must be 1 to 360.");
      const today = todayIn(ctx.tz, ctx.now);
      if (a.date != null && !isDay(a.date)) return refuse("date must be YYYY-MM-DD.");
      const day = (a.date as string | undefined) ?? today;
      if (a.start_time != null && (typeof a.start_time !== "string" || !TIME.test(a.start_time))) {
        return refuse("start_time must be HH:MM, 24-hour.");
      }
      if (day < addDays(today, -MAX_BACK_DAYS)) return refuse(`Overload logs workouts at most ${MAX_BACK_DAYS} days back.`);
      const start = a.start_time
        ? at(day, a.start_time as string, ctx.tz)
        : day === today
        ? new Date(ctx.now.getTime() - minutes * 60_000)
        : at(day, "18:00", ctx.tz);
      if (start.getTime() > ctx.now.getTime() + 5 * 60_000) return refuse("That start time is in the future. Log a workout once it is done.");
      let requestId: string | null = null;
      if (a.request_id != null && a.request_id !== "") {
        if (typeof a.request_id !== "string" || !REQUEST_ID.test(a.request_id)) {
          return refuse("request_id may use letters, digits and _ . : - only (at most 100).");
        }
        requestId = a.request_id;
      }
      const notes = typeof a.notes === "string" && a.notes.trim() ? a.notes.trim().slice(0, 2000) : null;
      const exercises = await cleanExercises(ctx, a.exercises, false);
      if (!Array.isArray(exercises)) return exercises;

      const saved = await ctx.writes.logWorkout(
        ctx.userId,
        { name, startedAt: start.toISOString(), durationSeconds: Math.round(minutes * 60), notes },
        exercises,
        requestId,
      );
      return answer({
        ...(saved.replayed ? { note: "This request_id was already logged; nothing new was saved." } : {}),
        workout: await detail(ctx, saved.id),
        xp: "Workouts logged from ChatGPT or Claude earn no XP.",
      });
    });
  },
};

// ── update_workout ──────────────────────────────────────────────────────────

const updateWorkout: Tool = {
  name: "update_workout",
  title: "Change a logged workout",
  description: "Changes one workout (also ones logged in the app): name, notes, date, start time, " +
    "duration, and the sets of chosen exercises. Each exercise in replace_exercises gets exactly the " +
    "sets given (an empty list removes that exercise); exercises not listed stay as they are. " +
    "Get the id from list_workouts. Returns the workout before and after.",
  inputSchema: {
    type: "object",
    properties: {
      workout_id: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 80 },
      notes: { type: "string", maxLength: 2000, description: "Replaces the notes. Empty text clears them." },
      date: { ...DATE_PROP, description: "Move to this local day." },
      start_time: { type: "string", pattern: "^\\d{1,2}:\\d{2}$", description: "HH:MM local, 24-hour." },
      duration_minutes: { type: "integer", minimum: 1, maximum: 360 },
      replace_exercises: { type: "array", maxItems: 30, items: EXERCISE_SCHEMA },
    },
    required: ["workout_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  run(a, raw) {
    return guarded(async () => {
      const ctx = raw as Ctx;
      if (!ctx.writes) throw new Error("writes missing from context");
      if (typeof a.workout_id !== "string" || !UUID.test(a.workout_id)) return refuse("workout_id must be an id from list_workouts.");
      const cur = await ctx.data.workout(ctx.userId, a.workout_id);
      if (!cur) return refuse("No such workout in this account.");

      const set: Row = {};
      if (a.name != null) {
        const n = typeof a.name === "string" ? a.name.trim() : "";
        if (!n || n.length > 80) return refuse("name must be 1 to 80 letters.");
        set.name = n;
      }
      if (a.notes != null) {
        if (typeof a.notes !== "string") return refuse("notes must be text.");
        set.notes = a.notes.slice(0, 2000);
      }
      if (a.duration_minutes != null) {
        const m = num(a.duration_minutes);
        if (m == null || m < 1 || m > 360) return refuse("duration_minutes must be 1 to 360.");
        set.duration_seconds = Math.round(m * 60);
      }
      if (a.date != null || a.start_time != null) {
        if (a.date != null && !isDay(a.date)) return refuse("date must be YYYY-MM-DD.");
        if (a.start_time != null && (typeof a.start_time !== "string" || !TIME.test(a.start_time))) {
          return refuse("start_time must be HH:MM, 24-hour.");
        }
        const curLocal = localTime(cur.started_at, ctx.tz); // 2026-11-10T08:30
        const day = (a.date as string | undefined) ?? dayOf(cur.started_at, ctx.tz);
        const time = (a.start_time as string | undefined) ?? curLocal.slice(11, 16);
        const start = at(day, time, ctx.tz);
        if (start.getTime() > ctx.now.getTime() + 5 * 60_000) return refuse("That start time is in the future.");
        if (day < addDays(todayIn(ctx.tz, ctx.now), -MAX_BACK_DAYS)) return refuse(`At most ${MAX_BACK_DAYS} days back.`);
        set.started_at = start.toISOString();
      }
      let replace: Row[] | null = null;
      if (a.replace_exercises != null) {
        const r = await cleanExercises(ctx, a.replace_exercises, true);
        if (!Array.isArray(r)) return r;
        replace = r;
      }
      if (!Object.keys(set).length && !replace) return refuse("Nothing to change.");

      const r = await ctx.writes.updateWorkout(ctx.userId, a.workout_id, set, replace);
      return answer({
        before: {
          name: r.before?.name,
          started: r.before?.started_at ? localTime(r.before.started_at, ctx.tz) : null,
          sets: r.before?.sets,
          total_volume_kg: r1(r.before?.total_volume_kg),
        },
        after: await detail(ctx, a.workout_id),
        ...(r.xp_change ? { xp_change: r.xp_change } : {}),
      });
    });
  },
};

// ── delete_workout ──────────────────────────────────────────────────────────

const deleteWorkout: Tool = {
  name: "delete_workout",
  title: "Remove a logged workout",
  description: "Removes a workout that was logged from ChatGPT or Claude. A workout logged in the " +
    "app is never removed here; ask the user to remove it in the app. Confirm with the user first.",
  inputSchema: {
    type: "object",
    properties: { workout_id: { type: "string" } },
    required: ["workout_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  run(a, raw) {
    return guarded(async () => {
      const ctx = raw as Ctx;
      if (!ctx.writes) throw new Error("writes missing from context");
      if (typeof a.workout_id !== "string" || !UUID.test(a.workout_id)) return refuse("workout_id must be an id from list_workouts.");
      const r = await ctx.writes.deleteWorkout(ctx.userId, a.workout_id);
      const d = r.deleted ?? {};
      return answer({
        deleted: { id: d.id, name: d.name, started: d.started_at ? localTime(d.started_at, ctx.tz) : null, sets: d.sets },
      });
    });
  },
};

export const WORKOUT_WRITE_TOOLS: Tool[] = [logWorkout, updateWorkout, deleteWorkout];
