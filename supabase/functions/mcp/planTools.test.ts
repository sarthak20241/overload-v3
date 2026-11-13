// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Tool } from "./protocol.ts";
import type { Ctx } from "./tools.ts";
import { cleanSlot, PLAN_TOOLS, planPosition } from "./planTools.ts";
import { WriteRefused } from "./writes.ts";

const U = "user_1";
const P = "00000000-0000-4000-8000-0000000000c1";
const PH1 = "00000000-0000-4000-8000-0000000000c2";
const PH2 = "00000000-0000-4000-8000-0000000000c3";
const BENCH = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-11-10T12:00:00Z"); // Tuesday 17:30 in Kolkata
const tool = (n: string) => PLAN_TOOLS.find((t) => t.name === n) as Tool;

const PROGRAM = {
  id: P, title: "Cut to 72", objective: "Lose fat, keep strength", goal: "fat_loss",
  target_weight_kg: 72, target_date: "2027-01-05", start_date: "2026-10-20", total_weeks: 8,
  coach_program_phases: [
    // Out of order on purpose: the pick goes by seq and offset, not list place.
    {
      id: PH2, seq: 1, name: "Deload", duration_weeks: 1, start_offset_weeks: 6,
      diet_calorie_target: 2300, routines: [],
    },
    {
      id: PH1, seq: 0, name: "Deficit block", duration_weeks: 6, start_offset_weeks: 0,
      diet_calorie_target: 2100, diet_protein_g: 160, diet_carb_g: 200, diet_fat_g: 65,
      diet_fuel_days: [{ dow: 6, kcal: 300, label: "Long run" }],
      training_block: { split_type: "upper_lower", days_per_week: 4 },
      activity_steps_target: 9000, cardio_sessions_per_week: 2,
      job_text: "Bring weight 76 to 73 kg", coach_line: "Steps are carrying it.",
      routines: [{
        id: "r1", name: "Upper A",
        routine_exercises: [
          { order: 1, sets: 3, reps_min: 10, reps_max: 12, rest_seconds: 60, exercises: { name: "Row" } },
          { order: 0, sets: 4, reps_min: 5, reps_max: 5, rest_seconds: 150, note: "RIR 2", exercises: { name: "Bench" } },
        ],
      }],
    },
  ],
};

const METRICS = [
  { phase_id: PH1, seq: 1, is_hero: false, kind: "steps", direction: "up", target_value: 9000, current_value: 8100, status: "close" },
  { phase_id: PH1, seq: 0, is_hero: true, kind: "bodyweight", direction: "down", start_value: 76, target_value: 73, current_value: 74.6, unit: "kg", status: "on_track" },
  { phase_id: PH2, seq: 0, is_hero: true, kind: "sleep_hours", direction: "up", target_value: 8, status: "set" },
];

function ctxWith(data: Record<string, unknown> = {}, writes: Record<string, unknown> = {}): Ctx {
  return {
    userId: U, email: null, tz: "Asia/Kolkata", now: NOW, profile: {},
    data: {
      activeProgram: () => Promise.resolve(structuredClone(PROGRAM)),
      programMetrics: () => Promise.resolve(METRICS),
      searchExercises: () => Promise.resolve([]),
      ...data,
    } as any,
    writes: {
      saveRoutine: () => Promise.resolve({ id: "new", name: "Upper B", exercise_names: ["Bench"] }),
      ...writes,
    } as any,
  };
}

const body = async (name: string, args: Record<string, unknown>, ctx: Ctx) => {
  const r = await tool(name).run(args, ctx);
  return { r, out: r.isError ? null : JSON.parse(r.text) };
};

// ── planPosition ────────────────────────────────────────────────────────────

Deno.test("planPosition: phase and week by offset, not list place; before and after", () => {
  const ph = PROGRAM.coach_program_phases;
  const inFirst = planPosition("2026-10-20", ph, "2026-11-10", 7);
  assertEquals([inFirst.state, inFirst.week, inFirst.phase?.id, inFirst.weekInPhase], ["running", 4, PH1, 4]);
  const deload = planPosition("2026-10-20", ph, "2026-12-01", 7); // day 42
  assertEquals([deload.phase?.id, deload.week, deload.weekInPhase], [PH2, 7, 1]);
  const early = planPosition("2026-10-20", ph, "2026-10-19", 7);
  assertEquals([early.state, early.phase?.id, early.week], ["not_started", PH1, null]);
  const late = planPosition("2026-10-20", ph, "2026-12-08", 7); // day 49
  assertEquals([late.state, late.phase], ["finished", null]);
  assertEquals(planPosition("2026-10-20", ph, "2026-11-10").totalWeeks, 7, "no total_weeks: summed from phases");
});

// ── get_plan ────────────────────────────────────────────────────────────────

Deno.test("get_plan: week N of M, the current phase's targets, metrics and routines", async () => {
  let metricsAsked: unknown[] = [];
  const ctx = ctxWith({ programMetrics: (...a: unknown[]) => { metricsAsked = a; return Promise.resolve(METRICS); } });
  const { out } = await body("get_plan", {}, ctx);
  assertEquals(metricsAsked, [U, P], "metrics read for this user and this program");
  assertEquals([out.has_plan, out.today, out.state, out.week_of_plan, out.week_of_phase], [true, "2026-11-10", "running", 4, 4]);
  assertEquals(out.plan.total_weeks, 8);
  assertEquals(out.plan.end_date, "2026-12-14");
  const c = out.current_phase;
  assertEquals(c.name, "Deficit block");
  assertEquals(c.nutrition, {
    kcal: 2100, protein_g: 160, carb_g: 200, fat_g: 65,
    fuel_days: [{ day: "Saturday", extra_kcal: 300, for: "Long run" }],
  });
  assertEquals(c.training, { split: "upper_lower", days_per_week: 4 });
  assertEquals(c.activity, { steps_per_day: 9000, cardio_sessions_per_week: 2 });
  assertEquals(c.hero_metric.what, "Bodyweight");
  assertEquals([c.hero_metric.start, c.hero_metric.current, c.hero_metric.target, c.hero_metric.status], [76, 74.6, 73, "On track"]);
  assertEquals(c.supporting_metrics.map((m: any) => m.what), ["Steps a day"], "other phases' metrics stay out");
  assertEquals(c.routines[0].exercises.map((e: any) => [e.name, e.reps]), [["Bench", "5"], ["Row", "10-12"]]);
  assertEquals(out.phases.map((p: any) => [p.seq, p.starts, p.ends, !!p.current]),
    [[0, "2026-10-20", "2026-11-30", true], [1, "2026-12-01", "2026-12-07", false]]);
});

Deno.test("get_plan: no active plan says so, without an error", async () => {
  const { r, out } = await body("get_plan", {}, ctxWith({ activeProgram: () => Promise.resolve(null) }));
  assertEquals(r.isError, undefined);
  assertEquals(out.has_plan, false);
});

// ── save_routine ────────────────────────────────────────────────────────────

Deno.test("cleanSlot: defaults, one rep target, ranges, and bad values", () => {
  assertEquals(cleanSlot({}, "x"), { sets: 3, reps_min: 8, reps_max: 12, rest_seconds: 90 });
  assertEquals(cleanSlot({ sets: 5, reps: 5, rest_seconds: 180 }, "x"), { sets: 5, reps_min: 5, reps_max: 5, rest_seconds: 180 });
  assertEquals(cleanSlot({ reps_min: 15 }, "x"), { sets: 3, reps_min: 15, reps_max: 15, rest_seconds: 90 });
  assertEquals(cleanSlot({ duration_seconds: 45, note: " hold " }, "x"),
    { sets: 3, reps_min: 8, reps_max: 12, rest_seconds: 90, target_duration_seconds: 45, note: "hold" });
  assert(typeof cleanSlot({ reps_min: 12, reps_max: 8 }, "x") === "string");
  assert(typeof cleanSlot({ reps: 5, reps_min: 5 }, "x") === "string");
  assert(typeof cleanSlot({ sets: 0 }, "x") === "string");
  assert(typeof cleanSlot({ sets: 2.5 }, "x") === "string");
  assert(typeof cleanSlot({ rest_seconds: 1000 }, "x") === "string");
  assert(typeof cleanSlot({ distance_m: 0 }, "x") === "string");
});

Deno.test("save_routine: sends checked slots; not linked to the plan unless asked", async () => {
  const calls: any[] = [];
  const ctx = ctxWith({}, { saveRoutine: (...a: any[]) => { calls.push(a); return Promise.resolve({ id: "new", name: "Upper B", exercise_names: ["Bench"] }); } });
  const { out } = await body("save_routine", {
    name: " Upper B ", exercises: [{ exercise_id: BENCH, sets: 4, reps: 6, note: "RIR 2" }], request_id: "r-1",
  }, ctx);
  assertEquals(calls[0][0], U);
  assertEquals(calls[0][1], { name: "Upper B", description: null, phaseId: null });
  assertEquals(calls[0][2], [{ exercise_id: BENCH, sets: 4, reps_min: 6, reps_max: 6, rest_seconds: 90, note: "RIR 2" }]);
  assertEquals(calls[0][3], "r-1");
  assertEquals(out.routine.exercises[0].exercise, "Bench");
  assertEquals(out.added_to_phase, undefined);
});

Deno.test("save_routine: add_to_plan links the current phase; no plan or an ended plan is refused", async () => {
  const calls: any[] = [];
  const saveRoutine = (...a: any[]) => { calls.push(a); return Promise.resolve({ id: "new", exercise_names: ["Bench"] }); };
  const ex = [{ exercise_id: BENCH }];
  const { out } = await body("save_routine", { name: "Upper B", exercises: ex, add_to_plan: true }, ctxWith({}, { saveRoutine }));
  assertEquals(calls[0][1].phaseId, PH1);
  assertEquals(out.added_to_phase, "Deficit block");

  const none = await tool("save_routine").run({ name: "U", exercises: ex, add_to_plan: true },
    ctxWith({ activeProgram: () => Promise.resolve(null) }, { saveRoutine }));
  assert(none.isError);
  const ended = await tool("save_routine").run({ name: "U", exercises: ex, add_to_plan: true },
    ctxWith({ activeProgram: () => Promise.resolve({ ...structuredClone(PROGRAM), start_date: "2026-01-05" }) }, { saveRoutine }));
  assert(ended.isError);
  assertEquals(calls.length, 1, "a refused call writes nothing");
});

Deno.test("save_routine: bad input is refused before any write", async () => {
  let wrote = 0;
  const ctx = ctxWith({}, { saveRoutine: () => { wrote++; return Promise.resolve({ id: "x" }); } });
  const cases = [
    { name: "", exercises: [{ exercise_id: BENCH }] },
    { name: "A", exercises: [] },
    { name: "A", exercises: [{ exercise_id: BENCH }, { exercise_id: BENCH }] },
    { name: "A", exercises: [{ exercise_id: "not-a-uuid" }] },
    { name: "A", exercises: [{ sets: 3 }] },
    { name: "A", exercises: [{ exercise_id: BENCH, reps_min: 12, reps_max: 6 }] },
    { name: "A", exercises: [{ exercise_id: BENCH }], request_id: "has space" },
  ];
  for (const c of cases) assert((await tool("save_routine").run(c, ctx)).isError, JSON.stringify(c));
  assertEquals(wrote, 0);
});

Deno.test("save_routine: a name with one exact match is used; otherwise candidates come back", async () => {
  const calls: any[] = [];
  const ctx = ctxWith(
    { searchExercises: () => Promise.resolve([{ id: BENCH, name: "Bench Press" }, { id: "x", name: "Incline Bench Press" }]) },
    { saveRoutine: (...a: any[]) => { calls.push(a); return Promise.resolve({ id: "new" }); } },
  );
  await tool("save_routine").run({ name: "A", exercises: [{ exercise_name: "bench press" }] }, ctx);
  assertEquals(calls[0][2][0].exercise_id, BENCH);
  const loose = await tool("save_routine").run({ name: "A", exercises: [{ exercise_name: "bench" }] }, ctx);
  assert(loose.isError);
  assertEquals(JSON.parse(loose.text).candidates.length, 2);
});

Deno.test("save_routine: a database refusal comes back as the tool's answer", async () => {
  const ctx = ctxWith({}, { saveRoutine: () => Promise.reject(new WriteRefused("Overload refused a value: 50 routines")) });
  const r = await tool("save_routine").run({ name: "A", exercises: [{ exercise_id: BENCH }] }, ctx);
  assert(r.isError);
  assert(r.text.includes("50 routines"));
});

Deno.test("save_routine only creates: no plan tool edits or removes a routine", () => {
  for (const t of PLAN_TOOLS) {
    assertEquals(t.annotations?.destructiveHint ?? false, false, t.name);
    assert(!/update|delete|remove|edit/.test(t.name), t.name);
  }
  assert(tool("save_routine").description.includes("get a clear yes"), "the tool asks for the user's yes");
});
