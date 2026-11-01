// Run with: deno test supabase/functions/ai-coach/userContextLean.test.ts
//
// Chat carries a short user summary; the big sections wait behind
// coach_get_user_details. Measured 2026-10-29: the owner's user_context was
// 59k characters, 44k of them the full contents of 52 saved routines, written
// into the prompt cache again on every cold chat message.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { leanUserContext, readHeldSections, ON_REQUEST_SECTIONS } from "./userContextLean.ts";

const routine = (i: number) => ({
  name: `Routine ${i}`,
  description: "a day",
  exercises: [
    { name: "Bench Press", muscle: "chest", sets: 3, reps: "6-8", rest_s: 150 },
    { name: "Row", muscle: "back", sets: 3, reps: "8-10", rest_s: 120 },
  ],
});

const full = () => ({
  profile: { goal: "hypertrophy", weight_kg: 80 },
  today: { date: "2026-10-29", weekday: "Thursday", time_zone: "Asia/Kolkata" },
  injury_notes: "bad lower back",
  memory: [{ category: "equipment", key: "home gym", value: "dumbbells only", noted: "2026-10-01" }],
  top_lifts: [{ exercise: "Bench Press", e1rm_kg: 100 }],
  nutrition: { targets: { kcal: 2400 } },
  active_routines: Array.from({ length: 30 }, (_, i) => routine(i)),
  weekly_volume: Array.from({ length: 12 }, (_, i) => ({ week: "2026-10-20", muscle: `m${i}`, sets: 10 })),
  recent_plan_changes: ["2026-10-28 (chat) targets: kcal 2500 -> 2400", "2026-10-20 (manual) routine 'Push' created", "2026-10-10 (card) goal set", "2026-10-01 (manual) program created"],
  // summarizeMeasurements' shape (memory.ts)
  body_measurements: {
    latest_on: "2026-10-26", days_logged: 4,
    sites: ["chest", "hips", "neck", "thigh_l", "waist", "calf_l"].map((site) => ({ site, cm: 80, on: "2026-10-26", prev_cm: 82, prev_on: "2026-08-03" })),
  },
});

Deno.test("the summary keeps who the user is and drops the big sections", () => {
  const { summary } = leanUserContext(full());
  const s = summary as Record<string, unknown>;
  for (const kept of ["profile", "today", "injury_notes", "memory", "top_lifts", "nutrition"]) {
    assertEquals(s[kept], (full() as Record<string, unknown>)[kept], kept);
  }
  assertEquals(s.weekly_volume, undefined);
  assertEquals(s.body_measurements, undefined);
});

Deno.test("routines stay as names with an exercise count, newest first, capped", () => {
  const { summary } = leanUserContext(full());
  const r = (summary as { active_routines: { name: string; exercises: number }[] }).active_routines;
  assertEquals(r.length, 15);
  assertEquals(r[0], { name: "Routine 0", exercises: 2 });
});

Deno.test("only the newest three plan changes stay in the summary", () => {
  const { summary } = leanUserContext(full());
  assertEquals((summary as { recent_plan_changes: string[] }).recent_plan_changes, full().recent_plan_changes.slice(0, 3));
});

Deno.test("on_request lists exactly what was held back", () => {
  const { summary, held } = leanUserContext(full());
  const on = (summary as { on_request: Record<string, string> }).on_request;
  assertEquals(Object.keys(on).sort(), ["body_measurements", "plan_changes", "routines", "weekly_volume"]);
  assertStringIncludes(on.routines, "30");
  assertEquals(Object.keys(held).sort(), Object.keys(on).sort());
});

Deno.test("a small context holds nothing back and has no on_request", () => {
  const small = { profile: { goal: "strength" }, active_routines: [routine(1)], recent_plan_changes: ["2026-10-28 (chat) goal set"] };
  const { summary, held } = leanUserContext(small);
  assertEquals((summary as Record<string, unknown>).on_request, undefined);
  assertEquals(held, {});
  // a routine list short enough to send whole is sent whole
  assertEquals((summary as { active_routines: unknown[] }).active_routines, small.active_routines);
});

Deno.test("a short volume table is sent whole: a fetch would cost more than it saves", () => {
  const short = { ...full(), weekly_volume: [{ week: "2026-10-20", muscle: "chest", sets: 12 }, { week: "2026-10-20", muscle: "back", sets: 14 }] };
  const { summary, held } = leanUserContext(short);
  assertEquals((summary as Record<string, unknown>).weekly_volume, short.weekly_volume);
  assertEquals(held.weekly_volume, undefined);
});

Deno.test("routines can be read by name, so one routine does not bring back all of them", () => {
  const { held } = leanUserContext(full());
  const out = readHeldSections(held, { sections: ["routines"], routine_names: ["routine 3", "Nope"] }) as Record<string, unknown>;
  assertEquals((out.routines as { name: string }[]).map((r) => r.name), ["Routine 3"]);
  // a name not found is not "routines unavailable": the section exists
  assert(String(out.unknown_routines).includes("Nope"));
  assertEquals(out.not_available, undefined);
});

Deno.test("routine_names reaches routines past the names listed in the summary", () => {
  const { summary, held } = leanUserContext(full());
  assertStringIncludes((summary as { on_request: Record<string, string> }).on_request.routines, "any saved routine");
  const out = readHeldSections(held, { sections: ["routines"], routine_names: ["Routine 29"] }) as Record<string, unknown>;
  assertEquals((out.routines as { name: string }[]).map((r) => r.name), ["Routine 29"]);
});

Deno.test("a few tape sites are sent whole", () => {
  const few = { ...full(), body_measurements: { latest_on: "2026-10-26", days_logged: 1, sites: [{ site: "waist", cm: 82, on: "2026-10-26" }] } };
  const { summary, held } = leanUserContext(few);
  assertEquals((summary as Record<string, unknown>).body_measurements, few.body_measurements);
  assertEquals(held.body_measurements, undefined);
});

Deno.test("a routine name that is part of a saved name still finds it", () => {
  const { held } = leanUserContext({ ...full(), active_routines: [{ name: "Push Day A", exercises: [] }, { name: "Pull Day", exercises: [] }, { name: "Legs", exercises: [] }, { name: "Arms", exercises: [] }] });
  const out = readHeldSections(held, { sections: ["routines"], routine_names: ["push"] }) as Record<string, unknown>;
  assertEquals((out.routines as { name: string }[]).map((r) => r.name), ["Push Day A"]);
  assertEquals(out.unknown_routines, undefined);
});

Deno.test("no context in, no context out", () => {
  assertEquals(leanUserContext(null), { summary: null, held: {} });
});

Deno.test("the tool returns the sections asked for, and says which do not exist", () => {
  const { held } = leanUserContext(full());
  const out = readHeldSections(held, { sections: ["routines", "body_measurements", "nonsense"] }) as Record<string, unknown>;
  assertEquals((out.routines as unknown[]).length, 30);
  assertEquals(out.body_measurements, full().body_measurements);
  assert(String(out.not_available).includes("nonsense"));
});

Deno.test("every section the tool can name is one the lean step can hold", () => {
  assertEquals([...ON_REQUEST_SECTIONS].sort(), ["body_measurements", "plan_changes", "routines", "weekly_volume"]);
});
