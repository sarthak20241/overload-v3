// The tools ChatGPT and Claude can call. Plan: .planning/mcp-tools-plan.md.
// Step 1: the connection check plus 9 read tools. Writes come in steps 2-3.
//
// Every tool reads through ctx.data (data.ts), which filters every query to
// ctx.userId. Days are the user's local days (days.ts). Answers are JSON text
// (the assistant reads it) plus the same object as structuredContent.

import { normalizeFuelDays, dowOfISO, type DayTargets } from "../_shared/fuelDays.ts";
import { targetsForDay, type DayTargetRow, type TargetHistoryRow } from "../_shared/targetHistory.ts";
import type { Data } from "./data.ts";
import { addDays, dayOf, dayRange, daysBetween, isDay, localTime, todayIn, weekStart } from "./days.ts";
import type { Tool, ToolContext, ToolResult } from "./protocol.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** What index.ts puts in the context for every call. */
export interface Ctx extends ToolContext {
  data: Data;
  profile: Row | null;
  tz: string;
  now: Date;
}

// The app's fallback when a user never set a goal (lib/dietData.ts DEFAULT_TARGETS).
const DEFAULT_TARGETS: DayTargets = { kcal: 2000, protein: 125, carb: 250, fat: 56 };
const MEALS = ["breakfast", "lunch", "dinner", "snack"];

const r0 = (n: unknown) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n)));
const r1 = (n: unknown) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);

function answer(data: Record<string, unknown>): ToolResult {
  return { text: JSON.stringify(data), data };
}

function refuse(text: string): ToolResult {
  return { text, isError: true };
}

const DATE_PROP = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

/** A day argument: absent -> fallback, present -> must be a real date. */
function dayArg(v: unknown, fallback: string, name: string): string | ToolResult {
  if (v == null || v === "") return fallback;
  return isDay(v) ? v : refuse(`${name} must be a date written YYYY-MM-DD.`);
}

function intArg(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── targets ─────────────────────────────────────────────────────────────────

function liveTargets(p: Row | null): DayTargets {
  return {
    kcal: Number(p?.daily_calorie_target) || DEFAULT_TARGETS.kcal,
    protein: Number(p?.protein_target_g) || DEFAULT_TARGETS.protein,
    carb: Number(p?.carb_target_g) || DEFAULT_TARGETS.carb,
    fat: Number(p?.fat_target_g) || DEFAULT_TARGETS.fat,
  };
}

/** A function giving each day's goal, the way the app draws it. */
async function targetReader(ctx: Ctx, from: string, to: string) {
  const [history, overrides] = await Promise.all([
    ctx.data.targetHistory(ctx.userId),
    ctx.data.dayTargets(ctx.userId, from, to),
  ]);
  const live = liveTargets(ctx.profile);
  const liveFuel = normalizeFuelDays(ctx.profile?.calorie_day_boosts);
  const today = todayIn(ctx.tz, ctx.now);
  return (day: string): DayTargets =>
    targetsForDay({
      dayISO: day,
      todayISO: today,
      dow: dowOfISO(day),
      live,
      liveFuel,
      history: history as TargetHistoryRow[],
      defaults: DEFAULT_TARGETS,
      overrides: overrides as DayTargetRow[],
    });
}

function targetOut(t: DayTargets) {
  return { kcal: r0(t.kcal), protein_g: r0(t.protein), carb_g: r0(t.carb), fat_g: r0(t.fat) };
}

// ── food ────────────────────────────────────────────────────────────────────

interface Totals { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number }
const zero = (): Totals => ({ kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: 0 });

function addTo(t: Totals, e: Row) {
  t.kcal += Number(e.kcal) || 0;
  t.protein_g += Number(e.protein_g) || 0;
  t.carb_g += Number(e.carb_g) || 0;
  t.fat_g += Number(e.fat_g) || 0;
  t.fiber_g += Number(e.fiber_g) || 0;
}

function totalsOut(t: Totals) {
  return { kcal: r0(t.kcal), protein_g: r1(t.protein_g), carb_g: r1(t.carb_g), fat_g: r1(t.fat_g), fiber_g: r1(t.fiber_g) };
}

// ── workouts ────────────────────────────────────────────────────────────────

function setOut(s: Row) {
  const out: Row = { set_type: s.set_type };
  if (Number(s.weight_kg)) out.weight_kg = r1(s.weight_kg);
  if (s.reps != null && Number(s.reps)) out.reps = Number(s.reps);
  if (s.duration_seconds) out.duration_seconds = s.duration_seconds;
  if (s.distance_m) out.distance_m = r1(s.distance_m);
  if (s.resistance) out.resistance = r1(s.resistance);
  if (s.rpe != null) out.rpe = Number(s.rpe);
  if (s.is_unilateral) {
    out.one_side_at_a_time = true;
    if (s.reps_right != null) out.reps_right = Number(s.reps_right);
    if (s.weight_kg_right != null) out.weight_kg_right = r1(s.weight_kg_right);
    if (s.rpe_right != null) out.rpe_right = Number(s.rpe_right);
  }
  return out;
}

/** Exercise ids by name, in workout order. */
function exercisesOf(sets: Row[]): string[] {
  const names: string[] = [];
  for (const s of sets) {
    const n = s.exercises?.name;
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

// ── the tools ───────────────────────────────────────────────────────────────

export const ping: Tool = {
  name: "ping",
  title: "Check the Overload connection",
  description: "Checks that Overload is connected and says which account is signed in. " +
    "Use it when the user asks if the connection works.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  free: true,
  run(_args, ctx) {
    const c = ctx as Ctx;
    const who = c.profile?.name || ctx.email || "your Overload account";
    return Promise.resolve(answer({ connected: true, name: c.profile?.name || null, text: `Connected to Overload as ${who}.` }));
  },
};

const getProfile: Tool = {
  name: "get_profile",
  title: "Get profile and goals",
  description: "The user's Overload profile: goal, experience, body stats, time zone, " +
    "weekly training target, and today's calorie and macro targets. Read this first " +
    "when advice depends on who the user is.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async run(_a, raw) {
    const ctx = raw as Ctx;
    const p = ctx.profile;
    if (!p) return refuse("No Overload profile found for this account. The user should open the Overload app once.");
    const today = todayIn(ctx.tz, ctx.now);
    const target = (await targetReader(ctx, today, today))(today);
    return answer({
      name: p.name || null,
      goals: p.goals ?? (p.goal ? [p.goal] : []),
      experience_level: p.experience_level ?? null,
      height_cm: r1(p.height_cm),
      weight_kg: r1(p.weight_kg),
      goal_weight_kg: r1(p.goal_weight_kg),
      body_fat_percent: r1(p.body_fat_percent),
      weekly_target_sessions: p.weekly_target_sessions ?? null,
      time_zone: ctx.tz,
      today,
      today_targets: targetOut(target),
      targets_set_by_user: p.daily_calorie_target != null,
      units: "kg, cm, kcal, grams",
    });
  },
};

const getDayNutrition: Tool = {
  name: "get_day_nutrition",
  title: "Get one day of food",
  description: "Everything the user logged on one day, by meal (breakfast, lunch, dinner, snack), " +
    "with each line's id, amount and macros, the day's totals, its calorie and macro target, " +
    "and what is left. Days are the user's local days. Defaults to today.",
  inputSchema: {
    type: "object",
    properties: { date: { ...DATE_PROP, description: "YYYY-MM-DD, the user's local day. Default: today." } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(a, raw) {
    const ctx = raw as Ctx;
    const today = todayIn(ctx.tz, ctx.now);
    const day = dayArg(a.date, today, "date");
    if (typeof day !== "string") return day;
    const { start, end } = dayRange(day, day, ctx.tz);
    const [meals, targetOn] = await Promise.all([ctx.data.meals(ctx.userId, start, end), targetReader(ctx, day, day)]);
    const total = zero();
    const byMeal: Record<string, { lines: Row[]; totals: Totals }> = {};
    for (const m of meals) {
      const slot = byMeal[m.meal_type] ??= { lines: [], totals: zero() };
      const entries = [...(m.meal_entries ?? [])].sort((x: Row, y: Row) => (x.position ?? 0) - (y.position ?? 0));
      for (const e of entries) {
        addTo(total, e);
        addTo(slot.totals, e);
        slot.lines.push({
          id: e.id,
          name: e.food_name,
          quantity: Number(e.quantity),
          unit: e.serving_unit,
          grams: r1(e.grams_logged),
          kcal: r0(e.kcal),
          protein_g: r1(e.protein_g),
          carb_g: r1(e.carb_g),
          fat_g: r1(e.fat_g),
          ...(e.fiber_g != null ? { fiber_g: r1(e.fiber_g) } : {}),
        });
      }
    }
    const target = targetOn(day);
    return answer({
      date: day,
      meals: MEALS.filter((k) => byMeal[k]?.lines.length).map((k) => ({
        meal: k,
        lines: byMeal[k].lines,
        totals: totalsOut(byMeal[k].totals),
      })),
      totals: totalsOut(total),
      target: targetOut(target),
      left: {
        kcal: r0(target.kcal - total.kcal),
        protein_g: r1(target.protein - total.protein_g),
        carb_g: r1(target.carb - total.carb_g),
        fat_g: r1(target.fat - total.fat_g),
      },
    });
  },
};

const getNutritionHistory: Tool = {
  name: "get_nutrition_history",
  title: "Get daily food totals",
  description: "Daily calorie and macro totals against each day's target, for a range of the user's " +
    "local days (at most 90). Days with nothing logged are listed with logged: false, so they are " +
    "not mistaken for zero-calorie days. Default: the last 14 days.",
  inputSchema: {
    type: "object",
    properties: {
      start_date: { ...DATE_PROP, description: "First day, YYYY-MM-DD." },
      end_date: { ...DATE_PROP, description: "Last day, YYYY-MM-DD. Default: today." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(a, raw) {
    const ctx = raw as Ctx;
    const today = todayIn(ctx.tz, ctx.now);
    const to = dayArg(a.end_date, today, "end_date");
    if (typeof to !== "string") return to;
    const from = dayArg(a.start_date, addDays(to, -13), "start_date");
    if (typeof from !== "string") return from;
    const span = daysBetween(from, to);
    if (span < 0) return refuse("start_date must be on or before end_date.");
    if (span > 89) return refuse("At most 90 days at a time. Ask for a shorter range.");
    const { start, end } = dayRange(from, to, ctx.tz);
    const [meals, targetOn] = await Promise.all([ctx.data.meals(ctx.userId, start, end), targetReader(ctx, from, to)]);
    const byDay = new Map<string, Totals>();
    for (const m of meals) {
      const d = dayOf(m.logged_at, ctx.tz);
      const t = byDay.get(d) ?? zero();
      for (const e of m.meal_entries ?? []) addTo(t, e);
      if ((m.meal_entries ?? []).length) byDay.set(d, t);
    }
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const t = byDay.get(d);
      days.push({ date: d, logged: !!t, ...(t ? totalsOut(t) : {}), target: targetOut(targetOn(d)) });
    }
    const logged = days.filter((d) => d.logged) as Row[];
    const avg = (k: string) => (logged.length ? r0(logged.reduce((s, d) => s + (d[k] ?? 0), 0) / logged.length) : null);
    return answer({
      start_date: from,
      end_date: to,
      days,
      logged_days: logged.length,
      average_on_logged_days: { kcal: avg("kcal"), protein_g: avg("protein_g"), carb_g: avg("carb_g"), fat_g: avg("fat_g") },
    });
  },
};

const listWorkouts: Tool = {
  name: "list_workouts",
  title: "List workouts",
  description: "The user's workouts in a range of local days, newest first: id, name, start time, " +
    "minutes, total volume, sets and exercises. Use get_workout with an id for every set. " +
    "Default: the last 14 days.",
  inputSchema: {
    type: "object",
    properties: {
      start_date: { ...DATE_PROP, description: "First day, YYYY-MM-DD." },
      end_date: { ...DATE_PROP, description: "Last day, YYYY-MM-DD. Default: today." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Most workouts to return. Default 20." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(a, raw) {
    const ctx = raw as Ctx;
    const today = todayIn(ctx.tz, ctx.now);
    const to = dayArg(a.end_date, today, "end_date");
    if (typeof to !== "string") return to;
    const from = dayArg(a.start_date, addDays(to, -13), "start_date");
    if (typeof from !== "string") return from;
    if (daysBetween(from, to) < 0) return refuse("start_date must be on or before end_date.");
    if (daysBetween(from, to) > 365) return refuse("At most one year at a time.");
    const limit = intArg(a.limit, 20, 1, 50);
    const { start, end } = dayRange(from, to, ctx.tz);
    const list = await ctx.data.workouts(ctx.userId, start, end, limit);
    return answer({
      start_date: from,
      end_date: to,
      workouts: list.map((w) => {
        const sets = (w.workout_sets ?? []) as Row[];
        return {
          id: w.id,
          name: w.name,
          started: localTime(w.started_at, ctx.tz),
          minutes: w.duration_seconds ? Math.round(w.duration_seconds / 60) : null,
          total_volume_kg: r0(w.total_volume_kg),
          working_sets: sets.filter((s) => s.set_type !== "warmup").length,
          exercises: exercisesOf(sets),
          ...(w.source && w.source !== "app" ? { source: w.source } : {}),
        };
      }),
      more_may_exist: list.length === limit,
    });
  },
};

const getWorkout: Tool = {
  name: "get_workout",
  title: "Get one workout",
  description: "One workout with every set, grouped by exercise in the order done. Weights are kg. " +
    "Warmup sets are marked set_type: warmup. Get the id from list_workouts.",
  inputSchema: {
    type: "object",
    properties: { workout_id: { type: "string", description: "The workout id from list_workouts." } },
    required: ["workout_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(a, raw) {
    const ctx = raw as Ctx;
    if (typeof a.workout_id !== "string" || !UUID.test(a.workout_id)) {
      return refuse("workout_id must be an id from list_workouts.");
    }
    const w = await ctx.data.workout(ctx.userId, a.workout_id);
    if (!w) return refuse("No workout with that id in this account.");
    const sets = [...(w.workout_sets ?? [])].sort((x: Row, y: Row) => (x.order ?? 0) - (y.order ?? 0));
    const groups: Row[] = [];
    for (const s of sets) {
      let g = groups.find((x) => x.exercise_id === s.exercise_id);
      if (!g) {
        g = {
          exercise_id: s.exercise_id,
          exercise: s.exercises?.name ?? "Unknown exercise",
          metric: s.exercises?.metric_type ?? null,
          ...(s.superset_group != null ? { superset_group: s.superset_group } : {}),
          sets: [],
        };
        groups.push(g);
      }
      g.sets.push(setOut(s));
    }
    return answer({
      id: w.id,
      name: w.name,
      started: localTime(w.started_at, ctx.tz),
      minutes: w.duration_seconds ? Math.round(w.duration_seconds / 60) : null,
      total_volume_kg: r0(w.total_volume_kg),
      notes: w.notes || null,
      exercises: groups,
    });
  },
};

const searchExercises: Tool = {
  name: "search_exercises",
  title: "Search exercises",
  description: "Finds exercises by name in Overload's list and the user's own custom exercises. " +
    "Returns ids for get_exercise_history (and, later, for logging workouts).",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", minLength: 2, maxLength: 60, description: "Part of the name, e.g. bench press." } },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(a, raw) {
    const ctx = raw as Ctx;
    const q = typeof a.query === "string" ? a.query.trim() : "";
    if (q.length < 2) return refuse("query must be at least 2 letters.");
    const found = await ctx.data.searchExercises(ctx.userId, q, 15);
    const lower = q.toLowerCase();
    found.sort((x, y) => rank(x.name, lower) - rank(y.name, lower) || x.name.length - y.name.length);
    return answer({
      query: q,
      exercises: found.slice(0, 10).map((e) => ({
        id: e.id,
        name: e.name,
        muscle_group: e.muscle_group,
        metric: e.metric_type,
        ...(e.created_by ? { custom: true } : {}),
      })),
    });
  },
};

function rank(name: string, q: string): number {
  const n = name.toLowerCase();
  return n === q ? 0 : n.startsWith(q) ? 1 : 2;
}

const getExerciseHistory: Tool = {
  name: "get_exercise_history",
  title: "Get one exercise's history",
  description: "The user's history on one exercise: best estimated 1RM, top set, last set, " +
    "sessions in the last 28 days, and each recent session's sets (newest first). " +
    "Pass exercise_id (from search_exercises) or an exact exercise_name.",
  inputSchema: {
    type: "object",
    properties: {
      exercise_id: { type: "string", description: "From search_exercises." },
      exercise_name: { type: "string", description: "Used when there is no id; must match one exercise." },
      sessions: { type: "integer", minimum: 1, maximum: 20, description: "Recent sessions to include. Default 5." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(a, raw) {
    const ctx = raw as Ctx;
    let ex: Row | null = null;
    if (typeof a.exercise_id === "string" && a.exercise_id) {
      if (!UUID.test(a.exercise_id)) return refuse("exercise_id must be an id from search_exercises.");
      ex = await ctx.data.exerciseById(ctx.userId, a.exercise_id);
      if (!ex) return refuse("No exercise with that id.");
    } else if (typeof a.exercise_name === "string" && a.exercise_name.trim().length >= 2) {
      const name = a.exercise_name.trim().toLowerCase();
      const found = await ctx.data.searchExercises(ctx.userId, name, 15);
      const exact = found.filter((e) => e.name.toLowerCase() === name);
      if (exact.length === 1) ex = exact[0];
      else {
        return {
          ...answer({
            matched: false,
            candidates: found.slice(0, 10).map((e) => ({ id: e.id, name: e.name, muscle_group: e.muscle_group })),
          }),
          text: JSON.stringify({
            matched: false,
            note: "No single exact match. Pick an id from candidates and call again with exercise_id.",
            candidates: found.slice(0, 10).map((e) => ({ id: e.id, name: e.name, muscle_group: e.muscle_group })),
          }),
        };
      }
    } else {
      return refuse("Give exercise_id or exercise_name.");
    }
    const sessionsWanted = intArg(a.sessions, 5, 1, 20);
    const [stat, sets] = await Promise.all([
      ctx.data.liftStat(ctx.userId, ex.id),
      ctx.data.exerciseSets(ctx.userId, ex.id),
    ]);
    const byWorkout = new Map<string, { started_at: string; sets: Row[] }>();
    for (const s of sets) {
      const w = s.workouts;
      if (!w?.id) continue;
      const g = byWorkout.get(w.id) ?? { started_at: w.started_at as string, sets: [] as Row[] };
      g.sets.push(s);
      byWorkout.set(w.id, g);
    }
    const sessions = [...byWorkout.entries()]
      .sort((x, y) => Date.parse(y[1].started_at) - Date.parse(x[1].started_at))
      .slice(0, sessionsWanted)
      .map(([id, g]) => ({
        workout_id: id,
        date: dayOf(g.started_at, ctx.tz),
        sets: g.sets.sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map(setOut),
      }));
    return answer({
      exercise: { id: ex.id, name: ex.name, muscle_group: ex.muscle_group, metric: ex.metric_type },
      stats: stat
        ? {
          estimated_1rm_kg: r1(stat.estimated_1rm),
          top_set: stat.top_set_weight != null ? { weight_kg: r1(stat.top_set_weight), reps: Number(stat.top_set_reps) } : null,
          last_set: stat.last_set_weight != null ? { weight_kg: r1(stat.last_set_weight), reps: Number(stat.last_set_reps) } : null,
          last_done: stat.last_performed_at ? dayOf(stat.last_performed_at, ctx.tz) : null,
          sessions_last_28_days: stat.sessions_last_28d,
        }
        : null,
      recent_sessions: sessions,
      total_sessions_found: byWorkout.size,
    });
  },
};

const getWeeklyVolume: Tool = {
  name: "get_weekly_volume",
  title: "Get weekly volume by muscle",
  description: "Working sets and volume (kg x reps) per muscle group per week (weeks start Monday), " +
    "for the last few weeks. Warmups do not count.",
  inputSchema: {
    type: "object",
    properties: { weeks: { type: "integer", minimum: 1, maximum: 12, description: "Weeks back, this week included. Default 4." } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(a, raw) {
    const ctx = raw as Ctx;
    const weeks = intArg(a.weeks, 4, 1, 12);
    const thisWeek = weekStart(todayIn(ctx.tz, ctx.now));
    const from = addDays(thisWeek, -7 * (weeks - 1));
    const rowsIn = await ctx.data.volume(ctx.userId, from);
    const byWeek = new Map<string, Row[]>();
    for (const r of rowsIn) {
      if (!r.set_count) continue;
      const list = byWeek.get(r.week_start) ?? [];
      list.push({ muscle_group: r.muscle_group, sets: r.set_count, volume_kg: r0(r.total_volume_kg) });
      byWeek.set(r.week_start, list);
    }
    const out = [];
    for (let w = from; w <= thisWeek; w = addDays(w, 7)) {
      const m = (byWeek.get(w) ?? []).sort((x, y) => y.sets - x.sets);
      out.push({ week_start: w, ...(w === thisWeek ? { this_week: true } : {}), muscles: m });
    }
    return answer({ weeks: out });
  },
};

const getBodyWeight: Tool = {
  name: "get_body_weight",
  title: "Get body weight",
  description: "The user's weigh-ins (kg) for a range of local days, with the change from first to last. " +
    "Default: the last 30 days. At most 365 days.",
  inputSchema: {
    type: "object",
    properties: {
      start_date: { ...DATE_PROP, description: "First day, YYYY-MM-DD." },
      end_date: { ...DATE_PROP, description: "Last day, YYYY-MM-DD. Default: today." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(a, raw) {
    const ctx = raw as Ctx;
    const today = todayIn(ctx.tz, ctx.now);
    const to = dayArg(a.end_date, today, "end_date");
    if (typeof to !== "string") return to;
    const from = dayArg(a.start_date, addDays(to, -29), "start_date");
    if (typeof from !== "string") return from;
    const span = daysBetween(from, to);
    if (span < 0) return refuse("start_date must be on or before end_date.");
    if (span > 365) return refuse("At most 365 days at a time.");
    const list = await ctx.data.weights(ctx.userId, from, to);
    const w = list.map((r) => ({ date: r.metric_date, kg: r1(r.value), source: r.source }));
    return answer({
      start_date: from,
      end_date: to,
      weigh_ins: w,
      change_kg: w.length >= 2 ? r1((w[w.length - 1].kg ?? 0) - (w[0].kg ?? 0)) : null,
      goal_weight_kg: r1(ctx.profile?.goal_weight_kg),
    });
  },
};

export const TOOLS: Tool[] = [
  ping,
  getProfile,
  getDayNutrition,
  getNutritionHistory,
  listWorkouts,
  getWorkout,
  searchExercises,
  getExerciseHistory,
  getWeeklyVolume,
  getBodyWeight,
];
