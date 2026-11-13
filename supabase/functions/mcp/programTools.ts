// Programs from ChatGPT or Claude: list, create, edit, end and delete the
// user's Goal & Plan, the things Drona does with a program in the app.
//
// The rules are the app's (programRules.ts): a cut is labelled fat_loss, the
// four nutrition targets add up, the running phase's targets go live on the
// profile (lib/programData.ts saveProgram / applyPhaseTargets). Every write is
// one database function (migration 20261114120000) that also logs the change
// in plan_changes with source 'mcp', so Drona sees what the assistant did.
//
// Access: these tools need Overload Pro like every connector tool except
// ping (index.ts gate). Pro has no program-build limit in the app, so the free
// "one goal build" rule (ai-coach freeGoalBuild) never applies here. A cap of
// 10 programs a day per user stops a looping assistant.

import { DAY_NAMES } from "../_shared/fuelDays.ts";
import { addDays, todayIn } from "./days.ts";
import type { Tool, ToolResult } from "./protocol.ts";
import { answer, type Ctx, DATE_PROP, r1, refuse, UUID } from "./tools.ts";
import { planPosition } from "./planTools.ts";
import {
  type Diet,
  GOALS,
  mirrorOf,
  offsetsOf,
  phaseRow,
  type PhaseRow,
  programGoalFor,
  targetsChanged,
} from "./programRules.ts";
import { guarded, num, REQUEST_ID } from "./workoutWrites.ts";
import { isDay } from "./days.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const MAX_PHASES = 12;

// ── input schema: the shape Drona's generate_program uses ────────────────────

const DIET_SCHEMA = {
  type: "object",
  description: "Daily targets for this phase. Protein usually 1.6-2.2 g per kg of bodyweight. Leave carb_g or fat_g out and " +
    "Overload works them out so the four add up (protein and carbs 4 kcal/g, fat 9 kcal/g). If you send all four, they must add up.",
  properties: {
    calories: { type: "integer", minimum: 800, maximum: 6000 },
    protein_g: { type: "integer", minimum: 20, maximum: 400 },
    carb_g: { type: "integer", minimum: 0, maximum: 1000 },
    fat_g: { type: "integer", minimum: 0, maximum: 400 },
  },
  additionalProperties: false,
};

const PHASE_PROPS = {
  name: { type: "string", maxLength: 80, description: "e.g. \"Deficit block\", \"Deload week\", \"Lean bulk\"." },
  duration_weeks: { type: "integer", minimum: 1, maximum: 26 },
  diet: DIET_SCHEMA,
  fuel_days: {
    type: ["array", "null"],
    description: "Weekdays with extra calories (as carbs) for a hard session on a fixed day: a long run, a heavy leg day. " +
      "Only when the user named such a day. [] or null removes them.",
    items: {
      type: "object",
      properties: {
        day: { type: "string", enum: DAY_NAMES },
        extra_kcal: { type: "integer", minimum: 50, maximum: 1000, description: "50 kcal steps. Usually 150-500." },
        label: { type: "string", maxLength: 24, description: "What the day is for, e.g. \"Long run\"." },
      },
      required: ["day", "extra_kcal"],
      additionalProperties: false,
    },
  },
  activity: {
    type: ["object", "null"],
    description: "Movement goals. A cut usually gets a step goal; give cardio only when the user wants it. null removes both.",
    properties: {
      steps_per_day: { type: ["integer", "null"], minimum: 2000, maximum: 30000, description: "500 steps grid." },
      cardio_sessions_per_week: { type: ["integer", "null"], minimum: 1, maximum: 7 },
    },
    additionalProperties: false,
  },
  metrics: {
    type: ["array", "null"],
    description: "What this phase is judged on: ONE hero metric (hero true) and 2-4 supporting targets. Replaces the phase's metrics.",
    items: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["bodyweight", "lift_e1rm", "sets_per_muscle", "steps", "sessions_per_week", "cardio_sessions",
            "sleep_hours", "protein_days", "distance", "duration", "custom"],
          description: "bodyweight kg; lift_e1rm kg (needs exercise); sets_per_muscle a week (needs muscle); steps a day; " +
            "sessions_per_week; cardio_sessions a week; sleep_hours a night; protein_days a week at the protein target; " +
            "distance km and duration minutes (best single set; name the exercise); custom (needs name and unit).",
        },
        hero: { type: "boolean" },
        target: { type: "number", description: "Value to reach by the phase end, or to hit each week for weekly kinds." },
        start: { type: "number", description: "Today's value, when known." },
        direction: { type: "string", enum: ["up", "down", "hold"], description: "bodyweight and custom only." },
        exercise: { type: "string", description: "Exercise name as Overload knows it (search_exercises)." },
        muscle: { type: "string", enum: ["Chest", "Back", "Shoulders", "Quads", "Hamstrings", "Glutes", "Biceps", "Triceps", "Calves", "Core"] },
        name: { type: "string", maxLength: 30 },
        unit: { type: "string", maxLength: 24 },
      },
      required: ["kind", "target"],
      additionalProperties: false,
    },
  },
  job_text: { type: "string", maxLength: 80, description: "The phase's job in one line, e.g. \"Bring weight 78 to 75 kg\"." },
  diet_directive: { type: "string", description: "One line of diet guidance." },
  training_directive: { type: "string", description: "One line of training guidance and progression." },
  readiness_directive: { type: "string", description: "One line on adapting to low-recovery days." },
  training_block: {
    type: "object",
    description: "A short descriptor, NOT an exercise list. Save the actual workouts with save_routine.",
    properties: {
      split_type: { type: "string", description: "e.g. \"Upper/Lower\", \"Push/Pull/Legs\", \"Full Body x3\"." },
      days_per_week: { type: "integer", minimum: 1, maximum: 7 },
      emphasis: { type: "string" },
      note: { type: "string" },
      week_pattern: {
        type: "array", minItems: 7, maxItems: 7, items: { type: "string", maxLength: 18 },
        description: "Day 1 to Day 7 (numbered days, not weekday names). \"Rest\" for a day off. Training entries = days_per_week.",
      },
    },
    required: ["split_type", "days_per_week", "week_pattern"],
    additionalProperties: false,
  },
};

const NEW_PHASE_SCHEMA = {
  type: "object",
  properties: PHASE_PROPS,
  required: ["name", "duration_weeks", "diet", "training_block"],
  additionalProperties: false,
};

const PROGRAM_PROPS = {
  title: { type: "string", maxLength: 80, description: "Short name, e.g. \"12-Week Lean Cut\"." },
  objective: { type: "string", maxLength: 2000, description: "1-2 sentences: the goal in plain words." },
  goal: {
    type: "string", enum: GOALS,
    description: "What THIS program does. fat_loss when the target weight is below today's weight. Overload checks it against the latest weigh-in.",
  },
  target_weight_kg: { type: ["number", "null"], minimum: 30, maximum: 300 },
  target_date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
};

const REQUEST_ID_PROP = {
  type: "string",
  description: "A new id for this one change, e.g. a random string. If the call is retried with the same id, it is not saved twice.",
};

// ── helpers ─────────────────────────────────────────────────────────────────

/** The user's live targets: the base for anything a phase leaves out. */
function liveDiet(profile: Row | null): Diet {
  const n = (v: unknown, d: number) => (v == null || !Number.isFinite(Number(v)) ? d : Math.round(Number(v)));
  return {
    kcal: n(profile?.daily_calorie_target, 2000),
    protein: n(profile?.protein_target_g, 125),
    carb: n(profile?.carb_target_g, 250),
    fat: n(profile?.fat_target_g, 56),
  };
}

/** Today's weight: the newest weigh-in of the last 30 days, else the profile
 *  weight (lib/programData.ts currentWeightKg). */
async function currentWeight(ctx: Ctx, today: string): Promise<number | null> {
  try {
    const logged = await ctx.data.weights(ctx.userId, addDays(today, -30), today);
    const last = logged.length ? Number(logged[logged.length - 1].value) : NaN;
    if (Number.isFinite(last) && last > 0) return last;
  } catch (e) {
    console.error("[mcp] weight read for the goal label:", e);
  }
  const w = Number(ctx.profile?.weight_kg);
  return Number.isFinite(w) && w > 0 ? w : null;
}

/** Lift metrics get the exercise id when the name matches exactly one
 *  exercise of the catalog or the user's own (the app does the same; an
 *  unmatched name stays a name, and the weekly check looks it up). An id the
 *  assistant sent is never trusted. */
async function resolveMetricExercises(ctx: Ctx, phases: PhaseRow[]): Promise<void> {
  for (const p of phases) {
    for (const m of p.metrics ?? []) {
      if (!m.ref) continue;
      delete m.ref.exercise_id;
      const name = m.ref.exercise_name;
      if (!name) continue;
      const found = await ctx.data.searchExercises(ctx.userId, name, 15);
      const exact = found.filter((f) => String(f.name).toLowerCase() === name.toLowerCase());
      if (exact.length === 1) m.ref.exercise_id = exact[0].id;
    }
  }
}

function phaseOut(p: PhaseRow, i: number, start: string, offset: number) {
  return {
    seq: i,
    name: p.name,
    starts: addDays(start, offset * 7),
    weeks: p.duration_weeks,
    kcal: p.diet_calorie_target,
    protein_g: p.diet_protein_g,
    carb_g: p.diet_carb_g,
    fat_g: p.diet_fat_g,
    ...(p.diet_fuel_days?.length
      ? { fuel_days: p.diet_fuel_days.map((f) => `${DAY_NAMES[f.dow]} +${f.kcal}`) }
      : {}),
    ...(p.activity_steps_target ? { steps_per_day: p.activity_steps_target } : {}),
    ...(p.cardio_sessions_per_week ? { cardio_sessions_per_week: p.cardio_sessions_per_week } : {}),
    ...(p.metrics ? { metrics: p.metrics.length } : {}),
  };
}

const dbPhase = (p: PhaseRow) => {
  const { metrics, ...rest } = p;
  return {
    ...rest,
    ...(metrics ? { metrics: metrics.map((m) => ({ ...m, ref: m.ref && Object.keys(m.ref).length ? m.ref : null })) } : {}),
  };
};

function requestIdOf(a: Row): string | null | ToolResult {
  if (a.request_id == null) return null;
  return typeof a.request_id === "string" && REQUEST_ID.test(a.request_id)
    ? a.request_id
    : refuse("request_id must be 1-100 letters, digits, or _ . : -");
}

// ── list_programs ───────────────────────────────────────────────────────────

const listPrograms: Tool = {
  name: "list_programs",
  title: "List the user's programs",
  description: "Every Goal & Plan program of this user, newest first: the active one, ended ones (archived) and " +
    "finished ones (completed), with ids, dates and who made it (coach = Drona in the app, mcp = an assistant). " +
    "Use get_plan for the active program's detail.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async run(_a, raw) {
    const ctx = raw as Ctx;
    const list = await ctx.data.programs(ctx.userId);
    return answer({
      programs: list.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        goal: p.goal ?? null,
        start_date: p.start_date,
        weeks: p.total_weeks ?? null,
        made_by: p.source === "mcp" ? "assistant" : "drona",
        created: String(p.created_at).slice(0, 10),
      })),
    });
  },
};

// ── create_program ──────────────────────────────────────────────────────────

const createProgram: Tool = {
  name: "create_program",
  title: "Create a Goal & Plan program",
  description: "Save a NEW multi-week program as the user's active Goal & Plan, the way Drona builds one in the app. " +
    "It REPLACES the current active program (that one is ended, not deleted). Read get_plan, get_insights and the " +
    "planning guide (get_planning_guide) first. Show the user the phases and targets and get a clear yes before saving. " +
    "The running phase's calories and macros become the user's daily targets at once. Overload sets goal to fat_loss " +
    "when the target weight is 1 kg or more under today's weight. Send a new request_id.",
  inputSchema: {
    type: "object",
    properties: {
      ...PROGRAM_PROPS,
      start_date: { ...DATE_PROP, description: "YYYY-MM-DD. Default today (the user's day)." },
      phases: { type: "array", minItems: 1, maxItems: MAX_PHASES, items: NEW_PHASE_SCHEMA, description: "In order, earliest first. Usually 2-6." },
      request_id: REQUEST_ID_PROP,
    },
    required: ["title", "objective", "phases"],
    additionalProperties: false,
  },
  annotations: { destructiveHint: false, idempotentHint: false },
  run: (a, raw) => guarded(async () => {
    const ctx = raw as Ctx;
    const requestId = requestIdOf(a);
    if (requestId && typeof requestId === "object") return requestId;
    const title = typeof a.title === "string" ? a.title.trim().slice(0, 80) : "";
    if (!title) return refuse("A program needs a title.");
    if (!Array.isArray(a.phases) || a.phases.length < 1 || a.phases.length > MAX_PHASES) {
      return refuse(`phases must hold 1 to ${MAX_PHASES} phases.`);
    }
    const today = todayIn(ctx.tz, ctx.now);
    const start = a.start_date == null ? today : a.start_date;
    if (!isDay(start)) return refuse("start_date must be a date written YYYY-MM-DD.");
    if (start < addDays(today, -28) || start > addDays(today, 90)) {
      return refuse("start_date must be within the last 4 weeks or the next 90 days.");
    }
    if (a.target_date != null && !isDay(a.target_date)) return refuse("target_date must be YYYY-MM-DD.");
    if (a.target_date != null && a.target_date < start) return refuse("target_date must be on or after start_date.");
    const target = a.target_weight_kg == null ? null : num(a.target_weight_kg);
    if (a.target_weight_kg != null && (target == null || target < 30 || target > 300)) {
      return refuse("target_weight_kg must be 30-300.");
    }

    const base = liveDiet(ctx.profile);
    const phases: PhaseRow[] = [];
    for (const [i, p] of (a.phases as Row[]).entries()) {
      const r = phaseRow(p ?? {}, `Phase ${i + 1}`, base);
      if (typeof r === "string") return refuse(r);
      phases.push(r);
    }
    await resolveMetricExercises(ctx, phases);

    const weight = await currentWeight(ctx, today);
    const goal = programGoalFor(a.goal, target, weight);
    const offsets = offsetsOf(phases);
    const pos = planPosition(start, phases.map((p, i) => ({ ...p, seq: i, start_offset_weeks: offsets[i] })), today);
    const runningSeq = pos.state === "running" ? (pos.phase!.seq as number) : null;
    const mirror = runningSeq == null ? null : mirrorOf(runningSeq, phases[runningSeq]);

    const program = {
      title,
      objective: typeof a.objective === "string" ? a.objective.trim().replace(/—/g, ", ").slice(0, 2000) : null,
      goal,
      target_weight_kg: target,
      target_date: a.target_date ?? null,
      start_date: start,
    };
    const saved = await ctx.writes!.saveProgram(ctx.userId, program, phases.map(dbPhase), mirror, requestId as string | null);
    if (saved.replayed) {
      return answer({ saved: true, replayed: true, program_id: saved.id, title: saved.title, note: "This request was already saved. Nothing new was written." });
    }
    return answer({
      saved: true,
      program_id: saved.id,
      title,
      goal,
      ...(a.goal && a.goal !== goal ? { goal_note: `Saved as ${goal}: the target weight is ${r1(target)} kg and today's is ${r1(weight)} kg.` } : {}),
      start_date: start,
      total_weeks: saved.total_weeks,
      phases: phases.map((p, i) => phaseOut(p, i, start, offsets[i])),
      targets_now: mirror
        ? { from_phase: phases[runningSeq!].name, kcal: mirror.kcal, protein_g: mirror.protein_g, carb_g: mirror.carb_g, fat_g: mirror.fat_g }
        : null,
      ...(mirror ? {} : { note: `The plan starts on ${start}. The user's daily targets change when phase 1 starts.` }),
      ...(saved.archived_program_id ? { replaced_program_id: saved.archived_program_id } : {}),
      next: "Save each training day of the running phase with save_routine (add_to_plan true).",
    });
  }),
};

// ── update_program ──────────────────────────────────────────────────────────

const updateProgram: Tool = {
  name: "update_program",
  title: "Edit the active program",
  description: "Change the ACTIVE program in place: its title, objective, goal, target weight or date, and any phase " +
    "(name, weeks, calories and macros, fuel days, step and cardio goals, metrics, split, guidance). Also add phases at " +
    "the end, or remove phases that have not started. Use phase ids from get_plan. Only the fields you send change. " +
    "Tell the user what will change and get a clear yes first. If the running phase's targets change, the user's daily " +
    "targets change at once. Send a new request_id.",
  inputSchema: {
    type: "object",
    properties: {
      program_id: { type: "string", description: "The active program's id (get_plan plan.id)." },
      ...PROGRAM_PROPS,
      phases: {
        type: "array",
        maxItems: MAX_PHASES,
        description: "Changes to existing phases. Each needs phase_id plus only the fields to change.",
        items: { type: "object", properties: { phase_id: { type: "string" }, ...PHASE_PROPS }, required: ["phase_id"], additionalProperties: false },
      },
      add_phases: { type: "array", maxItems: MAX_PHASES, items: NEW_PHASE_SCHEMA, description: "New phases, added after the last one." },
      remove_phase_ids: { type: "array", maxItems: MAX_PHASES, items: { type: "string" }, description: "Phases to remove. Only ones that have not started." },
      request_id: REQUEST_ID_PROP,
    },
    required: ["program_id"],
    additionalProperties: false,
  },
  annotations: { destructiveHint: false, idempotentHint: false },
  run: (a, raw) => guarded(async () => {
    const ctx = raw as Ctx;
    const requestId = requestIdOf(a);
    if (requestId && typeof requestId === "object") return requestId;
    if (typeof a.program_id !== "string" || !UUID.test(a.program_id)) return refuse("program_id must be the id from get_plan.");
    const prog = await ctx.data.activeProgram(ctx.userId);
    if (!prog || prog.id !== a.program_id) {
      return refuse("That is not the user's active program. Only the active program can be edited; read get_plan for its id.");
    }
    const today = todayIn(ctx.tz, ctx.now);
    const before = [...(prog.coach_program_phases ?? [])].sort((x: Row, y: Row) => x.seq - y.seq);
    const byId = new Map(before.map((p: Row) => [p.id, p]));
    const base = liveDiet(ctx.profile);

    // Program fields.
    const fields: Row = {};
    if (a.title !== undefined) {
      const t = typeof a.title === "string" ? a.title.trim().slice(0, 80) : "";
      if (!t) return refuse("title cannot be empty.");
      fields.title = t;
    }
    if (a.objective !== undefined) {
      fields.objective = typeof a.objective === "string" ? a.objective.trim().replace(/—/g, ", ").slice(0, 2000) : null;
    }
    if (a.target_date !== undefined) {
      if (a.target_date !== null && !isDay(a.target_date)) return refuse("target_date must be YYYY-MM-DD or null.");
      fields.target_date = a.target_date;
    }
    let target = prog.target_weight_kg == null ? null : Number(prog.target_weight_kg);
    if (a.target_weight_kg !== undefined) {
      target = a.target_weight_kg === null ? null : num(a.target_weight_kg);
      if (a.target_weight_kg !== null && (target == null || target < 30 || target > 300)) return refuse("target_weight_kg must be 30-300.");
      fields.target_weight_kg = target;
    }
    if (a.goal !== undefined || a.target_weight_kg !== undefined) {
      const goal = programGoalFor(a.goal ?? prog.goal, target, await currentWeight(ctx, today));
      if (goal !== prog.goal) fields.goal = goal;
    }

    // Phases: edits, removals, additions, in order.
    const removeIds = new Set<string>(Array.isArray(a.remove_phase_ids) ? a.remove_phase_ids.map(String) : []);
    for (const id of removeIds) if (!byId.has(id)) return refuse(`remove_phase_ids: ${id} is not a phase of this program.`);
    const edits = new Map<string, Row>();
    for (const e of (Array.isArray(a.phases) ? a.phases : []) as Row[]) {
      const id = String(e?.phase_id ?? "");
      if (!byId.has(id)) return refuse(`phases: ${id || "a change"} has no phase_id of this program. Read get_plan.`);
      if (removeIds.has(id)) return refuse(`Phase ${id} is both changed and removed.`);
      if (edits.has(id)) return refuse(`Phase ${id} appears twice in phases.`);
      const { phase_id: _, ...rest } = e;
      edits.set(id, rest);
    }
    const next: PhaseRow[] = [];
    for (const p of before) {
      if (removeIds.has(p.id)) continue;
      const r = phaseRow(edits.get(p.id) ?? {}, `"${p.name}"`, base, p);
      if (typeof r === "string") return refuse(r);
      next.push(r);
    }
    for (const [i, p] of ((Array.isArray(a.add_phases) ? a.add_phases : []) as Row[]).entries()) {
      const r = phaseRow(p ?? {}, `New phase ${i + 1}`, base);
      if (typeof r === "string") return refuse(r);
      next.push(r);
    }
    if (next.length < 1) return refuse("A program needs at least one phase. To stop the plan, use end_program.");
    if (next.length > MAX_PHASES) return refuse(`A program holds at most ${MAX_PHASES} phases.`);
    if (!Object.keys(fields).length && !edits.size && !removeIds.size && !next.some((p) => !p.id)) {
      return refuse("Nothing to change. Send the fields to change.");
    }
    await resolveMetricExercises(ctx, next);

    // The running phase after the edit: its targets go live when they changed,
    // or when a different phase now covers today.
    const offsets = offsetsOf(next);
    const posBefore = planPosition(prog.start_date, before, today, prog.total_weeks);
    const posAfter = planPosition(prog.start_date, next.map((p, i) => ({ ...p, seq: i, start_offset_weeks: offsets[i] })), today);
    let mirror: Row | null = null;
    if (posAfter.state === "running") {
      const seq = posAfter.phase!.seq as number;
      const nowPhase = next[seq];
      const samePhase = posBefore.state === "running" && posBefore.phase?.id && posBefore.phase.id === nowPhase.id;
      if (!samePhase || targetsChanged(byId.get(nowPhase.id ?? ""), nowPhase)) mirror = mirrorOf(seq, nowPhase);
    }

    const saved = await ctx.writes!.updateProgram(ctx.userId, prog.id, fields, next.map(dbPhase), today, mirror, requestId as string | null);
    if (saved.replayed) return answer({ saved: true, replayed: true, program_id: prog.id, note: "This request was already saved. Nothing new was written." });
    return answer({
      saved: true,
      program_id: prog.id,
      changed_fields: Object.keys(fields),
      ...(fields.goal ? { goal: fields.goal } : {}),
      total_weeks: saved.total_weeks,
      removed_phases: saved.removed_phases ?? [],
      phases: next.map((p, i) => phaseOut(p, i, prog.start_date, offsets[i])),
      targets_now: mirror ? { kcal: mirror.kcal, protein_g: mirror.protein_g, carb_g: mirror.carb_g, fat_g: mirror.fat_g } : "unchanged",
    });
  }),
};

// ── end_program ─────────────────────────────────────────────────────────────

const endProgram: Tool = {
  name: "end_program",
  title: "End the active program",
  description: "Stop the active Goal & Plan, the app's \"End program\". It is kept in the history (list_programs), " +
    "and the user's daily targets stay as they are now. Ask the user for a clear yes first. To remove a program " +
    "completely, use delete_program.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { destructiveHint: false, idempotentHint: true },
  run: (_a, raw) => guarded(async () => {
    const ctx = raw as Ctx;
    const r = await ctx.writes!.endProgram(ctx.userId);
    return answer({ ended: true, program_id: r.id, title: r.title, note: "The user's daily targets stay as they are." });
  }),
};

// ── delete_program ──────────────────────────────────────────────────────────

const deleteProgram: Tool = {
  name: "delete_program",
  title: "Delete a program",
  description: "Delete one program for good: its phases, targets history and phase metrics. This cannot be undone. " +
    "Two steps: call without confirm_title to see what will be deleted, show that to the user, and only after the " +
    "user says yes, call again with confirm_title set to the program's exact title. The title is a check against " +
    "deleting the wrong program; the user's yes is yours to get. Routines linked to it stay. " +
    "The user's daily targets stay as they are. To only stop a plan, use end_program.",
  inputSchema: {
    type: "object",
    properties: {
      program_id: { type: "string", description: "From list_programs or get_plan." },
      confirm_title: { type: "string", description: "The program's exact title, sent only after the user said yes." },
    },
    required: ["program_id"],
    additionalProperties: false,
  },
  annotations: { destructiveHint: true, idempotentHint: true },
  run: (a, raw) => guarded(async () => {
    const ctx = raw as Ctx;
    if (typeof a.program_id !== "string" || !UUID.test(a.program_id)) return refuse("program_id must be an id from list_programs.");
    const prog = await ctx.data.programById(ctx.userId, a.program_id);
    if (!prog) return refuse("No such program in this account. Use list_programs for ids.");
    const phases = [...(prog.coach_program_phases ?? [])].sort((x: Row, y: Row) => x.seq - y.seq);
    const routines = phases.flatMap((p: Row) => (p.routines ?? []).map((r: Row) => r.name));
    if (typeof a.confirm_title !== "string" || a.confirm_title.trim() !== prog.title) {
      return answer({
        deleted: false,
        needs_confirmation: true,
        will_delete: {
          program_id: prog.id,
          title: prog.title,
          status: prog.status,
          start_date: prog.start_date,
          weeks: prog.total_weeks ?? null,
          phases: phases.map((p: Row) => p.name),
        },
        kept: { routines, daily_targets: "unchanged" },
        note: "Nothing was deleted. Show this to the user. Only after a clear yes, call delete_program again with " +
          `confirm_title "${prog.title}".`,
      });
    }
    const r = await ctx.writes!.deleteProgram(ctx.userId, prog.id);
    return answer({
      deleted: true,
      program_id: prog.id,
      title: r.title,
      was: r.was,
      routines_kept: routines,
      note: r.was === "active" ? "The user now has no active plan. Their daily targets stay as they are." : undefined,
    });
  }),
};

export const PROGRAM_TOOLS: Tool[] = [listPrograms, createProgram, updateProgram, endProgram, deleteProgram];
