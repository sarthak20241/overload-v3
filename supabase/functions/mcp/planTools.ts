// The Goal & Plan for ChatGPT and Claude: read the active program, and save a
// workout the assistant wrote as a new Overload routine.
//
// get_plan reads coach_programs + coach_program_phases + the phase metrics,
// all filtered to the user in data.ts. Which phase is current follows the app
// (lib/phasePick.ts activePhaseOn): phases sit at start_offset_weeks from the
// program's start_date, in the user's local days.
//
// save_routine only creates: one routine + its exercises in one database
// function (20261113120000 mcp_save_routine), marked source 'mcp'. It never
// changes or removes a routine the user already has.

import { DAY_NAMES, normalizeFuelDays } from "../_shared/fuelDays.ts";
import { type MetricKind, metricLabel, type MetricRef, STATUS_LABEL, type MetricStatus } from "../_shared/phaseMetrics.ts";
import { addDays, daysBetween, todayIn } from "./days.ts";
import type { Tool } from "./protocol.ts";
import { answer, type Ctx, r0, r1, refuse } from "./tools.ts";
import { guarded, num, REQUEST_ID, resolveExercise } from "./workoutWrites.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;


// ── where today sits in the plan ────────────────────────────────────────────

export interface PlanPosition {
  /** running: a phase covers today. not_started / finished: before or after.
   *  between_phases: a gap before a later phase (offsets are cumulative when
   *  the app saves them, so this is a guard). */
  state: "running" | "not_started" | "between_phases" | "finished";
  /** 1-based week of the whole plan (null unless running). */
  week: number | null;
  totalWeeks: number;
  /** The current phase, or the next one before the start or in a gap. */
  phase: Row | null;
  /** 1-based week inside that phase (null unless running). */
  weekInPhase: number | null;
}

/** Phases sorted by seq; the one covering `today` (the app's rule). */
export function planPosition(startDate: string, phases: Row[], today: string, totalWeeks?: number | null): PlanPosition {
  const sorted = [...phases].sort((a, b) => a.seq - b.seq);
  const sum = sorted.reduce((s, p) => Math.max(s, (p.start_offset_weeks ?? 0) + p.duration_weeks), 0);
  const total = Number(totalWeeks) || sum;
  const days = daysBetween(startDate, today);
  if (days < 0) return { state: "not_started", week: null, totalWeeks: total, phase: sorted[0] ?? null, weekInPhase: null };
  for (const p of sorted) {
    const from = (p.start_offset_weeks ?? 0) * 7;
    if (days >= from && days < from + p.duration_weeks * 7) {
      return {
        state: "running",
        week: Math.floor(days / 7) + 1,
        totalWeeks: total,
        phase: p,
        weekInPhase: Math.floor((days - from) / 7) + 1,
      };
    }
  }
  const next = sorted.find((p) => (p.start_offset_weeks ?? 0) * 7 > days);
  if (next) return { state: "between_phases", week: null, totalWeeks: total, phase: next, weekInPhase: null };
  return { state: "finished", week: null, totalWeeks: total, phase: null, weekInPhase: null };
}

// ── shaping ─────────────────────────────────────────────────────────────────

function metricOut(m: Row) {
  const kind = m.kind as MetricKind;
  return {
    what: metricLabel({ kind, ref: (m.ref ?? null) as MetricRef | null }),
    kind,
    direction: m.direction,
    ...(m.start_value != null ? { start: r1(m.start_value) } : {}),
    target: r1(m.target_value),
    ...(m.current_value != null ? { current: r1(m.current_value) } : {}),
    ...(m.unit ? { unit: m.unit } : {}),
    status: STATUS_LABEL[m.status as MetricStatus] ?? m.status,
    ...(m.status_note ? { note: m.status_note } : {}),
    ...(m.checked_at ? { last_checked: String(m.checked_at).slice(0, 10) } : {}),
  };
}

/** "5", "8-12", or null when the row has no rep target. */
export function repsText(lo: unknown, hi: unknown): string | null {
  if (lo == null && hi == null) return null;
  if (lo == null || hi == null || lo === hi) return `${lo ?? hi}`;
  return `${lo}-${hi}`;
}

function routineOut(r: Row) {
  const list = [...(r.routine_exercises ?? [])].sort((a: Row, b: Row) => (a.order ?? 0) - (b.order ?? 0));
  return {
    id: r.id,
    name: r.name,
    exercises: list.map((e: Row) => ({
      name: e.exercises?.name ?? "Unknown exercise",
      sets: e.sets,
      ...(repsText(e.reps_min, e.reps_max) ? { reps: repsText(e.reps_min, e.reps_max) } : {}),
      rest_seconds: e.rest_seconds,
      ...(e.target_duration_seconds ? { seconds_per_set: e.target_duration_seconds } : {}),
      ...(e.target_distance_m ? { meters_per_set: r1(e.target_distance_m) } : {}),
      ...(e.note ? { note: e.note } : {}),
    })),
  };
}

function phaseDetail(p: Row, metrics: Row[]) {
  const mine = metrics.filter((m) => m.phase_id === p.id).sort((a, b) => a.seq - b.seq);
  const hero = mine.find((m) => m.is_hero) ?? null;
  const tb = (p.training_block ?? {}) as Row;
  const fuel = normalizeFuelDays(p.diet_fuel_days);
  return {
    seq: p.seq,
    name: p.name,
    weeks: p.duration_weeks,
    ...(p.job_text ? { job: p.job_text } : {}),
    ...(p.coach_line ? { coach_this_week: p.coach_line } : {}),
    nutrition: {
      kcal: r0(p.diet_calorie_target),
      protein_g: r0(p.diet_protein_g),
      carb_g: r0(p.diet_carb_g),
      fat_g: r0(p.diet_fat_g),
      ...(fuel.length
        ? { fuel_days: fuel.map((f) => ({ day: DAY_NAMES[f.dow], extra_kcal: f.kcal, ...(f.label ? { for: f.label } : {}) })) }
        : {}),
      ...(p.diet_directive ? { guidance: p.diet_directive } : {}),
    },
    training: {
      ...(tb.split_type ? { split: tb.split_type } : {}),
      ...(tb.days_per_week ? { days_per_week: tb.days_per_week } : {}),
      ...(tb.emphasis ? { emphasis: tb.emphasis } : {}),
      ...(tb.note ? { note: tb.note } : {}),
      ...(p.training_directive ? { guidance: p.training_directive } : {}),
    },
    activity: {
      steps_per_day: p.activity_steps_target ?? null,
      cardio_sessions_per_week: p.cardio_sessions_per_week ?? null,
    },
    hero_metric: hero ? metricOut(hero) : null,
    supporting_metrics: mine.filter((m) => m !== hero).map(metricOut),
    routines: (p.routines ?? []).map(routineOut),
  };
}

// ── get_plan ────────────────────────────────────────────────────────────────

const getPlan: Tool = {
  name: "get_plan",
  title: "Get the Goal & Plan",
  description: "The user's active Overload plan (Goal & Plan): the goal, where today sits " +
    "(week N of M, current phase and its week), and the current phase's targets: calories and " +
    "macros (with fuel days), training split and days a week, step and cardio goals, the hero " +
    "metric and supporting targets with progress, and the phase's routines. Also lists every " +
    "phase with its dates. Read this before advice on training or diet, and before writing a workout.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async run(_a, raw) {
    const ctx = raw as Ctx;
    const prog = await ctx.data.activeProgram(ctx.userId);
    if (!prog) {
      return answer({
        has_plan: false,
        note: "No active plan. The user can build one with Drona in the Overload app (Goal & Plan).",
      });
    }
    const today = todayIn(ctx.tz, ctx.now);
    const phases = [...(prog.coach_program_phases ?? [])].sort((a: Row, b: Row) => a.seq - b.seq);
    const pos = planPosition(prog.start_date, phases, today, prog.total_weeks);
    const metrics = await ctx.data.programMetrics(ctx.userId, prog.id);
    return answer({
      has_plan: true,
      today,
      plan: {
        title: prog.title,
        ...(prog.objective ? { objective: prog.objective } : {}),
        goal: prog.goal ?? null,
        target_weight_kg: r1(prog.target_weight_kg),
        target_date: prog.target_date ?? null,
        start_date: prog.start_date,
        end_date: addDays(prog.start_date, pos.totalWeeks * 7 - 1),
        total_weeks: pos.totalWeeks,
      },
      state: pos.state,
      ...(pos.state === "running"
        ? { week_of_plan: pos.week, week_of_phase: pos.weekInPhase }
        : pos.state === "not_started"
        ? { note: `The plan starts on ${prog.start_date}. current_phase is its first phase.` }
        : pos.state === "between_phases"
        ? { note: "Today falls between two phases. current_phase is the next one." }
        : { note: "Every phase has ended. The user can start a new goal in the app." }),
      current_phase: pos.phase ? phaseDetail(pos.phase, metrics) : null,
      phases: phases.map((p: Row) => ({
        seq: p.seq,
        name: p.name,
        starts: addDays(prog.start_date, (p.start_offset_weeks ?? 0) * 7),
        ends: addDays(prog.start_date, ((p.start_offset_weeks ?? 0) + p.duration_weeks) * 7 - 1),
        weeks: p.duration_weeks,
        ...(pos.phase?.id === p.id ? { current: true } : {}),
        kcal: r0(p.diet_calorie_target),
        routines: (p.routines ?? []).map((r: Row) => r.name),
      })),
    });
  },
};

// ── save_routine ────────────────────────────────────────────────────────────

const ROUTINE_EXERCISE_SCHEMA = {
  type: "object",
  properties: {
    exercise_id: { type: "string", description: "From search_exercises. Preferred." },
    exercise_name: { type: "string", description: "Exact exercise name, when there is no id." },
    sets: { type: "integer", minimum: 1, maximum: 20, description: "Default 3." },
    reps: { type: "integer", minimum: 1, maximum: 100, description: "One rep target, e.g. 5. Or give reps_min and reps_max." },
    reps_min: { type: "integer", minimum: 1, maximum: 100 },
    reps_max: { type: "integer", minimum: 1, maximum: 100 },
    rest_seconds: { type: "integer", minimum: 0, maximum: 900, description: "Default 90." },
    duration_seconds: { type: "integer", minimum: 1, maximum: 86400, description: "Time per set, for holds and cardio." },
    distance_m: { type: "number", exclusiveMinimum: 0, maximum: 1000000, description: "Distance per set in meters." },
    note: { type: "string", maxLength: 200, description: "A short cue, e.g. RIR 2, pause at the bottom." },
  },
  additionalProperties: false,
};

const saveRoutine: Tool = {
  name: "save_routine",
  title: "Save a workout as a routine",
  description: "Saves a workout you wrote as a NEW routine in the user's Overload app (Routines), " +
    "so they can start it there. Each exercise gets sets, a rep target or range, rest, and an " +
    "optional cue. Use exercise ids from search_exercises (or exact names). Show the user the " +
    "workout and get a clear yes before saving. add_to_plan: true also puts it in the current " +
    "phase of their plan (get_plan), or its next phase if none is running yet. Send a request_id, " +
    "so a retry after a timeout does not save it twice. This never changes or removes a routine the user already has.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80, description: "e.g. Upper A, Leg day." },
      description: { type: "string", maxLength: 500 },
      exercises: { type: "array", minItems: 1, maxItems: 30, items: ROUTINE_EXERCISE_SCHEMA },
      add_to_plan: { type: "boolean", description: "Link it to the current phase of the active plan. Default false." },
      request_id: { type: "string", maxLength: 100, description: "Optional. Sending the same id again returns the first result instead of saving twice." },
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
      if (!name || name.length > 80) return refuse("name must be 1 to 80 characters.");
      const description = typeof a.description === "string" && a.description.trim() ? a.description.trim().slice(0, 500) : null;
      let requestId: string | null = null;
      if (a.request_id != null && a.request_id !== "") {
        if (typeof a.request_id !== "string" || !REQUEST_ID.test(a.request_id)) {
          return refuse("request_id may use letters, digits and _ . : - only (at most 100).");
        }
        requestId = a.request_id;
      }
      const list = a.exercises;
      if (!Array.isArray(list) || list.length < 1 || list.length > 30) return refuse("exercises must hold 1 to 30 exercises.");

      const out: Row[] = [];
      for (const [i, rawEx] of list.entries()) {
        const e = (rawEx ?? {}) as Row;
        const r = await resolveExercise(ctx, e, i);
        if ("text" in r) return r;
        const c = cleanSlot(e, r.label);
        if (typeof c === "string") return refuse(c);
        if (out.some((o) => o.exercise_id === r.id)) return refuse(`${r.label} appears twice. Give it once with its sets.`);
        out.push({ exercise_id: r.id, ...c });
      }

      let phaseId: string | null = null;
      let phaseName: string | null = null;
      if (a.add_to_plan === true) {
        const prog = await ctx.data.activeProgram(ctx.userId);
        if (!prog) return refuse("The user has no active plan, so there is no phase to add it to. Save it without add_to_plan.");
        const pos = planPosition(prog.start_date, prog.coach_program_phases ?? [], todayIn(ctx.tz, ctx.now), prog.total_weeks);
        if (!pos.phase) return refuse("The user's plan has ended, so there is no current phase. Save it without add_to_plan.");
        phaseId = pos.phase.id;
        phaseName = pos.phase.name;
      }

      const saved = await ctx.writes.saveRoutine(ctx.userId, { name, description, phaseId }, out, requestId);
      // A replay wrote nothing: answer only with what the first save stored,
      // never this call's sets or phase.
      if (saved.replayed) {
        return answer({
          note: "This request_id was already saved; nothing new was saved. This is the routine it saved.",
          routine: { id: saved.id, name: saved.name, exercises: saved.exercise_names ?? [] },
          added_to_plan: !!saved.program_phase_id,
          where: "In the Overload app: Routines. The user can edit or remove it there.",
        });
      }
      return answer({
        routine: {
          id: saved.id,
          name: saved.name ?? name,
          exercises: out.map((o, i) => ({
            exercise: saved.exercise_names?.[i] ?? o.exercise_id,
            sets: o.sets,
            reps: o.reps_min === o.reps_max ? `${o.reps_min}` : `${o.reps_min}-${o.reps_max}`,
            rest_seconds: o.rest_seconds,
            ...(o.target_duration_seconds ? { seconds_per_set: o.target_duration_seconds } : {}),
            ...(o.target_distance_m ? { meters_per_set: o.target_distance_m } : {}),
            ...(o.note ? { note: o.note } : {}),
          })),
        },
        ...(phaseName ? { added_to_phase: phaseName } : {}),
        where: "In the Overload app: Routines. The user can edit or remove it there.",
      });
    });
  },
};

/** One routine slot from the assistant, checked. A string is the refusal. */
export function cleanSlot(e: Row, where: string): Row | string {
  const int = (k: string, min: number, max: number, dflt: number | null): number | null | string => {
    if (e[k] == null || e[k] === "") return dflt;
    const n = num(e[k]);
    if (n == null || !Number.isInteger(n) || n < min || n > max) return `${where}: ${k} must be a whole number from ${min} to ${max}.`;
    return n;
  };
  const sets = int("sets", 1, 20, 3);
  if (typeof sets === "string") return sets;
  const reps = int("reps", 1, 100, null);
  if (typeof reps === "string") return reps;
  let lo = int("reps_min", 1, 100, null);
  if (typeof lo === "string") return lo;
  let hi = int("reps_max", 1, 100, null);
  if (typeof hi === "string") return hi;
  if (reps != null) {
    if (lo != null || hi != null) return `${where}: give reps, or reps_min and reps_max, not both.`;
    lo = hi = reps;
  }
  lo ??= hi ?? 8;
  hi ??= Math.max(lo, 12);
  if (lo > hi) return `${where}: reps_min is above reps_max.`;
  const rest = int("rest_seconds", 0, 900, 90);
  if (typeof rest === "string") return rest;
  const dur = int("duration_seconds", 1, 86400, null);
  if (typeof dur === "string") return dur;
  let dist: number | null = null;
  if (e.distance_m != null && e.distance_m !== "") {
    dist = num(e.distance_m);
    if (dist == null || dist <= 0 || dist > 1_000_000) return `${where}: distance_m must be above 0 and at most 1000000.`;
  }
  const note = typeof e.note === "string" && e.note.trim() ? e.note.trim().slice(0, 200) : null;
  return {
    sets, reps_min: lo, reps_max: hi, rest_seconds: rest,
    ...(dur != null ? { target_duration_seconds: dur } : {}),
    ...(dist != null ? { target_distance_m: dist } : {}),
    ...(note ? { note } : {}),
  };
}

export const PLAN_TOOLS: Tool[] = [getPlan, saveRoutine];
