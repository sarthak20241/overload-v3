// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Tool } from "./protocol.ts";
import type { Ctx } from "./tools.ts";
import { PROGRAM_TOOLS } from "./programTools.ts";
import { WriteRefused } from "./writes.ts";

const U = "user_1";
const P = "00000000-0000-4000-8000-0000000000c1";
const PH1 = "00000000-0000-4000-8000-0000000000c2";
const PH2 = "00000000-0000-4000-8000-0000000000c3";
const NOW = new Date("2026-11-10T12:00:00Z"); // Tuesday in Kolkata
const TODAY = "2026-11-10";
const tool = (n: string) => PROGRAM_TOOLS.find((t) => t.name === n) as Tool;
const WEEK = ["Upper", "Lower", "Rest", "Upper", "Lower", "Rest", "Rest"];
const BLOCK = { split_type: "Upper/Lower", days_per_week: 4, week_pattern: WEEK };
const PHASE = (over: Record<string, unknown> = {}) =>
  ({ name: "Cut", duration_weeks: 4, diet: { calories: 2000, protein_g: 170 }, training_block: BLOCK, ...over });

// Started 2026-10-20: phase 1 (4 weeks) runs today, phase 2 starts 2026-11-17.
const PROGRAM = {
  id: P, title: "Cut to 76", goal: "fat_loss", target_weight_kg: 76, start_date: "2026-10-20", total_weeks: 6,
  coach_program_phases: [
    { id: PH1, seq: 0, name: "Block 1", duration_weeks: 4, start_offset_weeks: 0, diet_calorie_target: 2000,
      diet_protein_g: 170, diet_carb_g: 180, diet_fat_g: 64, training_block: BLOCK, diet_fuel_days: null },
    { id: PH2, seq: 1, name: "Diet break", duration_weeks: 2, start_offset_weeks: 4, diet_calorie_target: 2400,
      diet_protein_g: 170, diet_carb_g: 280, diet_fat_g: 70, training_block: BLOCK, diet_fuel_days: null },
  ],
};

function ctxWith(data: Record<string, unknown> = {}, writes: Record<string, unknown> = {}): Ctx {
  return {
    userId: U, email: null, tz: "Asia/Kolkata", now: NOW,
    profile: { daily_calorie_target: 2400, protein_target_g: 160, carb_target_g: 270, fat_target_g: 75, weight_kg: 82 },
    data: {
      weights: () => Promise.resolve([{ metric_date: "2026-11-08", value: 80 }]),
      searchExercises: () => Promise.resolve([]),
      activeProgram: () => Promise.resolve(structuredClone(PROGRAM)),
      programById: () => Promise.resolve({ ...structuredClone(PROGRAM), status: "archived" }),
      programs: () => Promise.resolve([{ id: P, title: "Cut to 76", status: "active", source: "mcp", start_date: "2026-10-20", created_at: "2026-10-20T00:00:00Z" }]),
      ...data,
    } as any,
    writes: {
      saveProgram: () => Promise.resolve({ id: "new", title: "x", phase_ids: [], total_weeks: 4 }),
      updateProgram: () => Promise.resolve({ id: P, total_weeks: 6, removed_phases: [] }),
      endProgram: () => Promise.resolve({ id: P, title: "Cut to 76" }),
      deleteProgram: () => Promise.resolve({ id: P, title: "Cut to 76", was: "archived" }),
      ...writes,
    } as any,
  };
}
const body = (r: any) => JSON.parse(r.text);

// ── create_program ──────────────────────────────────────────────────────────

Deno.test("create: a 'muscle' plan with a lower target weight is saved as fat_loss, and today's targets go live", async () => {
  const calls: any[] = [];
  const ctx = ctxWith({}, { saveProgram: (...a: any[]) => { calls.push(a); return Promise.resolve({ id: "new", total_weeks: 6 }); } });
  const r = await tool("create_program").run({
    title: "Lean out", objective: "Drop to 76 kg", goal: "hypertrophy", target_weight_kg: 76,
    phases: [PHASE(), PHASE({ name: "Break", duration_weeks: 2, diet: { calories: 2400, protein_g: 170 } })],
    request_id: "req-1",
  }, ctx);
  assert(!r.isError, r.text);
  const [u, program, phases, mirror, req] = calls[0];
  assertEquals(u, U);
  assertEquals(program.goal, "fat_loss", "80 kg today, 76 target");
  assertEquals(program.start_date, TODAY);
  assertEquals(phases.length, 2);
  for (const p of phases) {
    assert(Math.abs(p.diet_protein_g * 4 + p.diet_carb_g * 4 + p.diet_fat_g * 9 - p.diet_calorie_target) <= 9, JSON.stringify(p));
  }
  assertEquals(mirror.seq, 0);
  assertEquals(mirror.kcal, 2000);
  assertEquals(Object.hasOwn(mirror, "fuel_days"), false, "no fuel days planned: the live ones stay");
  assertEquals(req, "req-1");
  assert(body(r).goal_note.includes("fat_loss"));
});

Deno.test("create: a plan that starts later changes no targets today", async () => {
  let mirror: unknown = "unset";
  const ctx = ctxWith({}, { saveProgram: (_u: any, _p: any, _ph: any, m: any) => { mirror = m; return Promise.resolve({ id: "n", total_weeks: 4 }); } });
  const r = await tool("create_program").run({ title: "Later", objective: "x", start_date: "2026-11-23", phases: [PHASE()] }, ctx);
  assert(!r.isError, r.text);
  assertEquals(mirror, null);
  assert(body(r).note.includes("2026-11-23"));
});

Deno.test("create: bad input is refused before any write", async () => {
  let wrote = 0;
  const ctx = ctxWith({}, { saveProgram: () => { wrote++; return Promise.resolve({}); } });
  for (const args of [
    { title: "", objective: "x", phases: [PHASE()] },
    { title: "A", objective: "x", phases: [] },
    { title: "A", objective: "x", phases: [PHASE({ diet: { calories: 2000, protein_g: 150, carb_g: 400, fat_g: 90 } })] },
    { title: "A", objective: "x", phases: [PHASE()], start_date: "2027-06-01" },
    { title: "A", objective: "x", phases: [PHASE()], target_weight_kg: 900 },
    { title: "A", objective: "x", phases: [PHASE()], request_id: "has space" },
  ]) {
    const r = await tool("create_program").run(args, ctx);
    assert(r.isError, JSON.stringify(args));
  }
  assertEquals(wrote, 0);
});

Deno.test("create: a lift metric's exercise id comes from the user's catalog, never from the assistant", async () => {
  let phases: any[] = [];
  const ctx = ctxWith(
    { searchExercises: () => Promise.resolve([{ id: "bench-id", name: "Bench Press" }, { id: "x", name: "Bench Press (Close)" }]) },
    { saveProgram: (_u: any, _p: any, ph: any[]) => { phases = ph; return Promise.resolve({ id: "n", total_weeks: 4 }); } },
  );
  await tool("create_program").run({
    title: "Strength", objective: "x",
    phases: [PHASE({ metrics: [{ kind: "lift_e1rm", target: 120, exercise: "Bench Press", hero: true },
      { kind: "lift_e1rm", target: 150, exercise: "Squat", exercise_id: "someone-elses" }] })],
  }, ctx);
  assertEquals(phases[0].metrics[0].ref, { exercise_name: "Bench Press", exercise_id: "bench-id" });
  assertEquals(phases[0].metrics[1].ref, { exercise_name: "Squat" });
});

Deno.test("create: a replay says nothing new was written; a database refusal reaches the assistant", async () => {
  const replay = await tool("create_program").run({ title: "A", objective: "x", phases: [PHASE()], request_id: "r" },
    ctxWith({}, { saveProgram: () => Promise.resolve({ id: "old", title: "A", replayed: true }) }));
  assertEquals(body(replay).replayed, true);
  const refused = await tool("create_program").run({ title: "A", objective: "x", phases: [PHASE()] },
    ctxWith({}, { saveProgram: () => Promise.reject(new WriteRefused("Overload refused a value: 10 programs today")) }));
  assert(refused.isError && refused.text.includes("10 programs"));
});

// ── update_program ──────────────────────────────────────────────────────────

Deno.test("update: a new calorie target on the running phase goes live; protein stays; the list keeps ids in order", async () => {
  const calls: any[] = [];
  const ctx = ctxWith({}, { updateProgram: (...a: any[]) => { calls.push(a); return Promise.resolve({ total_weeks: 6 }); } });
  const r = await tool("update_program").run({ program_id: P, phases: [{ phase_id: PH1, diet: { calories: 1900 } }], request_id: "u1" }, ctx);
  assert(!r.isError, r.text);
  const [, id, fields, phases, today, mirror, req] = calls[0];
  assertEquals([id, today, req], [P, TODAY, "u1"]);
  assertEquals(fields, {});
  assertEquals(phases.map((p: any) => p.id), [PH1, PH2]);
  assertEquals(phases[0].diet_calorie_target, 1900);
  assertEquals(phases[0].diet_protein_g, 170);
  assertEquals(phases[1].diet_calorie_target, 2400, "untouched phase kept");
  assertEquals(mirror.seq, 0);
  assertEquals(mirror.kcal, 1900);
});

Deno.test("update: a change to a later phase leaves today's targets alone", async () => {
  let mirror: unknown = "unset";
  const ctx = ctxWith({}, { updateProgram: (_u: any, _i: any, _f: any, _p: any, _t: any, m: any) => { mirror = m; return Promise.resolve({}); } });
  await tool("update_program").run({ program_id: P, phases: [{ phase_id: PH2, diet: { calories: 2300 } }] }, ctx);
  assertEquals(mirror, null);
});

Deno.test("update: shortening phase 1 so phase 2 covers today makes phase 2's targets live", async () => {
  let mirror: any = null;
  const ctx = ctxWith({}, { updateProgram: (_u: any, _i: any, _f: any, _p: any, _t: any, m: any) => { mirror = m; return Promise.resolve({}); } });
  await tool("update_program").run({ program_id: P, phases: [{ phase_id: PH1, duration_weeks: 2 }] }, ctx);
  assertEquals([mirror.seq, mirror.kcal], [1, 2400]);
});

Deno.test("update: add a phase at the end and remove one; the target weight re-checks the goal", async () => {
  const calls: any[] = [];
  const ctx = ctxWith({}, { updateProgram: (...a: any[]) => { calls.push(a); return Promise.resolve({}); } });
  const r = await tool("update_program").run({
    program_id: P, target_weight_kg: 84, remove_phase_ids: [PH2], add_phases: [PHASE({ name: "Lean gain", diet: { calories: 2700, protein_g: 170 } })],
  }, ctx);
  assert(!r.isError, r.text);
  const [, , fields, phases] = calls[0];
  assertEquals(fields, { target_weight_kg: 84, goal: "hypertrophy" });
  assertEquals(phases.map((p: any) => p.id ?? p.name), [PH1, "Lean gain"]);
});

Deno.test("update: only the active program; unknown phase ids and empty changes are refused", async () => {
  let wrote = 0;
  const ctx = ctxWith({}, { updateProgram: () => { wrote++; return Promise.resolve({}); } });
  for (const args of [
    { program_id: "00000000-0000-4000-8000-0000000000ff", title: "x" },
    { program_id: P, phases: [{ phase_id: "00000000-0000-4000-8000-0000000000ff", name: "x" }] },
    { program_id: P, remove_phase_ids: ["nope"] },
    { program_id: P, remove_phase_ids: [PH1, PH2] },
    { program_id: P },
    { program_id: P, title: "  " },
  ]) {
    const r = await tool("update_program").run(args, ctx);
    assert(r.isError, JSON.stringify(args));
  }
  assertEquals(wrote, 0);
});

// ── end / delete / list ─────────────────────────────────────────────────────

Deno.test("end: archives the active program; targets stay", async () => {
  const r = await tool("end_program").run({}, ctxWith());
  assertEquals(body(r).ended, true);
  const none = await tool("end_program").run({}, ctxWith({}, { endProgram: () => Promise.reject(new WriteRefused("There is no active program to end.")) }));
  assert(none.isError);
});

Deno.test("delete: two steps; nothing is deleted without the exact title", async () => {
  let deleted = 0;
  const ctx = ctxWith({}, { deleteProgram: () => { deleted++; return Promise.resolve({ id: P, title: "Cut to 76", was: "archived" }); } });
  const first = body(await tool("delete_program").run({ program_id: P }, ctx));
  assertEquals(first.deleted, false);
  assertEquals(first.needs_confirmation, true);
  assertEquals(first.will_delete.phases, ["Block 1", "Diet break"]);
  const wrong = body(await tool("delete_program").run({ program_id: P, confirm_title: "cut to 76" }, ctx));
  assertEquals(wrong.deleted, false);
  assertEquals(deleted, 0);
  const done = body(await tool("delete_program").run({ program_id: P, confirm_title: "Cut to 76" }, ctx));
  assertEquals(done.deleted, true);
  assertEquals(deleted, 1);
  const missing = await tool("delete_program").run({ program_id: P }, ctxWith({ programById: () => Promise.resolve(null) }));
  assert(missing.isError);
});

Deno.test("annotations: delete is destructive; create, update and end are not; list is read-only", () => {
  assertEquals(tool("delete_program").annotations?.destructiveHint, true);
  for (const n of ["create_program", "update_program", "end_program"]) assertEquals(tool(n).annotations?.destructiveHint, false, n);
  assertEquals(tool("list_programs").annotations?.readOnlyHint, true);
  for (const n of ["create_program", "update_program", "end_program", "delete_program"]) {
    assert(/yes/.test(tool(n).description), `${n} asks for the user's yes`);
  }
});

Deno.test("list: an assistant's program says so", async () => {
  const r = body(await tool("list_programs").run({}, ctxWith()));
  assertEquals(r.programs[0].made_by, "assistant");
});
