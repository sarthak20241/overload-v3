// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Tool } from "./protocol.ts";
import type { Ctx } from "./tools.ts";
import { cleanSet, WORKOUT_WRITE_TOOLS } from "./workoutWrites.ts";
import { WriteRefused } from "./writes.ts";

const U = "user_1";
const W = "00000000-0000-4000-8000-0000000000a1";
const BENCH = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-11-10T12:00:00Z"); // 17:30 in Kolkata
const tool = (n: string) => WORKOUT_WRITE_TOOLS.find((t) => t.name === n) as Tool;

function ctxWith(writes: Record<string, unknown> = {}, data: Record<string, unknown> = {}): Ctx {
  return {
    userId: U, email: null, tz: "Asia/Kolkata", now: NOW, profile: {},
    data: {
      workout: () => Promise.resolve({ id: W, name: "Push", started_at: "2026-11-09T12:30:00Z", workout_sets: [] }),
      searchExercises: () => Promise.resolve([]),
      ...data,
    } as any,
    writes: {
      logWorkout: () => Promise.resolve({ id: W }),
      updateWorkout: () => Promise.resolve({ before: {}, after: {}, xp_change: 0 }),
      deleteWorkout: () => Promise.resolve({ deleted: {} }),
      ...writes,
    } as any,
  };
}

const bench = { exercise_id: BENCH, sets: [{ weight_kg: 80, reps: 6, rpe: 8 }] };

Deno.test("cleanSet: needs reps, a duration or a distance; set types and ranges checked", () => {
  assertEquals(cleanSet({ weight_kg: 80, reps: 6 }, "s"), { weight_kg: 80, reps: 6, set_type: "normal" });
  assertEquals(cleanSet({ duration_seconds: 90.4 }, "s"), { duration_seconds: 90, set_type: "normal" });
  assert(typeof cleanSet({ weight_kg: 80 }, "s") === "string");
  assert(typeof cleanSet({ reps: 5, set_type: "left" }, "s") === "string", "legacy left/right types are not written");
  assert(typeof cleanSet({ reps: 5, rpe: 11 }, "s") === "string");
  assert(typeof cleanSet({ reps: 5, weight_kg: 1200 }, "s") === "string");
  assertEquals(cleanSet({ reps: 8, reps_right: 7 }, "s"), { reps: 8, set_type: "normal" }, "right side only for one-side sets");
  assertEquals(cleanSet({ reps: 8, reps_right: 7, one_side_at_a_time: true }, "s"),
    { reps: 8, reps_right: 7, set_type: "normal", one_side_at_a_time: true });
});

Deno.test("log_workout: today ends now; another day starts 18:00 local; a given time is local", async () => {
  const calls: any[] = [];
  const ctx = ctxWith({ logWorkout: (...a: any[]) => { calls.push(a); return Promise.resolve({ id: W }); } });
  await tool("log_workout").run({ name: "Push", duration_minutes: 45, exercises: [bench] }, ctx);
  await tool("log_workout").run({ name: "Push", date: "2026-11-08", exercises: [bench] }, ctx);
  await tool("log_workout").run({ name: "Push", date: "2026-11-10", start_time: "07:15", exercises: [bench] }, ctx);
  assertEquals(calls[0][1], { name: "Push", startedAt: "2026-11-10T11:15:00.000Z", durationSeconds: 2700, notes: null });
  assertEquals(calls[1][1].startedAt, "2026-11-08T12:30:00.000Z"); // 18:00 IST
  assertEquals(calls[2][1].startedAt, "2026-11-10T01:45:00.000Z"); // 07:15 IST
  assertEquals(calls[0][2], [{ exercise_id: BENCH, sets: [{ weight_kg: 80, reps: 6, rpe: 8, set_type: "normal" }] }]);
});

Deno.test("log_workout: future, a set with nothing done, a repeated exercise: refused, nothing written", async () => {
  let wrote = 0;
  const ctx = ctxWith({ logWorkout: () => { wrote++; return Promise.resolve({ id: W }); } });
  const cases = [
    { name: "Push", start_time: "23:00", exercises: [bench] },
    { name: "Push", exercises: [{ exercise_id: BENCH, sets: [{ weight_kg: 80 }] }] },
    { name: "Push", exercises: [bench, bench] },
    { name: "Push", exercises: [] },
    { name: "", exercises: [bench] },
    { name: "Push", duration_minutes: 900, exercises: [bench] },
  ];
  for (const c of cases) assert((await tool("log_workout").run(c, ctx)).isError, JSON.stringify(c));
  assertEquals(wrote, 0);
});

Deno.test("log_workout: a name with one exact match is used; otherwise candidates come back", async () => {
  const calls: any[] = [];
  const ctx = ctxWith(
    { logWorkout: (...a: any[]) => { calls.push(a); return Promise.resolve({ id: W }); } },
    { searchExercises: () => Promise.resolve([{ id: BENCH, name: "Bench Press" }, { id: "x", name: "Incline Bench Press" }]) },
  );
  await tool("log_workout").run({ name: "Push", exercises: [{ exercise_name: "bench press", sets: [{ reps: 5, weight_kg: 80 }] }] }, ctx);
  assertEquals(calls[0][2][0].exercise_id, BENCH);
  const miss = await tool("log_workout").run({ name: "Push", exercises: [{ exercise_name: "bench", sets: [{ reps: 5 }] }] }, ctx);
  assert(miss.isError);
  assertEquals(JSON.parse(miss.text).candidates.length, 2);
});

Deno.test("update_workout: a new start time keeps the day unless given; an empty set list removes", async () => {
  const calls: any[] = [];
  const ctx = ctxWith({ updateWorkout: (...a: any[]) => { calls.push(a); return Promise.resolve({ before: {}, xp_change: 7 }); } });
  // Current start: 2026-11-09 18:00 IST.
  const r = await tool("update_workout").run({ workout_id: W, start_time: "06:30", replace_exercises: [{ exercise_id: BENCH, sets: [] }] }, ctx);
  assertEquals(calls[0][2], { started_at: "2026-11-09T01:00:00.000Z" });
  assertEquals(calls[0][3], [{ exercise_id: BENCH, sets: [] }]);
  assertEquals(JSON.parse(r.text).xp_change, 7);
  assert((await tool("update_workout").run({ workout_id: W }, ctx)).isError, "nothing to change");
});

Deno.test("update_workout: another user's workout (not found) is refused before any write", async () => {
  let wrote = 0;
  const ctx = ctxWith({ updateWorkout: () => { wrote++; return Promise.resolve({}); } }, { workout: () => Promise.resolve(null) });
  assert((await tool("update_workout").run({ workout_id: W, name: "x" }, ctx)).isError);
  assertEquals(wrote, 0);
});

Deno.test("delete_workout: an app workout's refusal reaches the assistant", async () => {
  const ctx = ctxWith({ deleteWorkout: () => Promise.reject(new WriteRefused("Not allowed: only workouts logged from ChatGPT or Claude can be removed here.")) });
  const r = await tool("delete_workout").run({ workout_id: W }, ctx);
  assert(r.isError && r.text.includes("Not allowed"));
  assert((await tool("delete_workout").run({ workout_id: "nope" }, ctx)).isError);
});

Deno.test("workout write tools say they write and are Pro-only", () => {
  for (const t of WORKOUT_WRITE_TOOLS) {
    assertEquals(t.annotations?.readOnlyHint, false, t.name);
    assert(!t.free, t.name);
  }
});
