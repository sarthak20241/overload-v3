// Run with: deno test lib/todayReason.test.ts
//
// The TODAY card used to say only "Push · 5 ex", which is a label, not a reason.
// This is the line under it: why THIS session, today, in the coach's voice, and
// computed from the user's own logged sets rather than written by a model.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { todayReason, type ReasonRoutine, type ReasonWorkout } from "./todayReason.ts";

const NOW = new Date("2026-09-12T18:00:00");

const push: ReasonRoutine = {
  id: "r-push",
  name: "Push",
  routine_exercises: [
    { exercises: { name: "Bench Press", muscle_group: "Chest" } },
    { exercises: { name: "Overhead Press", muscle_group: "Shoulders" } },
    { exercises: { name: "Lateral Raise", muscle_group: "Shoulders" } },
  ],
};

/** A session `daysAgo` back, with one working weight on the lead lift. */
function session(
  name: string,
  routineId: string,
  daysAgo: number,
  lead: { name: string; muscle: string; weight: number },
): ReasonWorkout {
  return {
    id: `w-${name}-${daysAgo}`,
    name,
    routine_id: routineId,
    started_at: new Date(NOW.getTime() - daysAgo * 86400000).toISOString(),
    sets: [
      { weight_kg: lead.weight, reps: 7, completed: true, exercises: { name: lead.name, muscle_group: lead.muscle } },
      { weight_kg: lead.weight, reps: 6, completed: true, exercises: { name: lead.name, muscle_group: lead.muscle } },
    ],
  };
}

Deno.test("names the gap since this routine last ran", () => {
  const line = todayReason({
    routine: push,
    workouts: [session("Push", "r-push", 6, { name: "Bench Press", muscle: "Chest", weight: 70 })],
    now: NOW,
  });
  assert(line != null);
  assert(line.includes("6 days since Push"), line);
});

Deno.test("names the rested muscle and the opening weight", () => {
  const line = todayReason({
    routine: push,
    workouts: [
      session("Push", "r-push", 6, { name: "Bench Press", muscle: "Chest", weight: 70 }),
      session("Pull", "r-pull", 1, { name: "Barbell Row", muscle: "Back", weight: 75 }),
    ],
    now: NOW,
  })!;
  assert(line.includes("Chest"), line);
  assert(line.includes("Bench Press"), line);
  assert(line.includes("70 kg"), line);
});

Deno.test("a routine never trained reads as a baseline, not a gap", () => {
  const line = todayReason({
    routine: push,
    workouts: [session("Pull", "r-pull", 2, { name: "Barbell Row", muscle: "Back", weight: 75 })],
    now: NOW,
  })!;
  assert(!line.includes("days since"), line);
  assert(/first|baseline/i.test(line), line);
});

Deno.test("yesterday reads as 1 day, not 1 days", () => {
  const line = todayReason({
    routine: push,
    workouts: [session("Push", "r-push", 1, { name: "Bench Press", muscle: "Chest", weight: 70 })],
    now: NOW,
  })!;
  assert(line.includes("1 day since"), line);
  assert(!line.includes("1 days"), line);
});

Deno.test("no history at all says nothing rather than inventing a reason", () => {
  assertEquals(todayReason({ routine: push, workouts: [], now: NOW }), null);
});

Deno.test("no routine says nothing", () => {
  assertEquals(todayReason({ routine: null, workouts: [], now: NOW }), null);
});

Deno.test("matches a session by name when it carries no routine_id", () => {
  const byName = session("Push", null as unknown as string, 4, {
    name: "Bench Press",
    muscle: "Chest",
    weight: 67.5,
  });
  byName.routine_id = null;
  const line = todayReason({ routine: push, workouts: [byName], now: NOW })!;
  assert(line.includes("4 days since Push"), line);
  assert(line.includes("67.5 kg"), line);
});

Deno.test("picks the lead lift by its order, not by array position", () => {
  // Supabase returns routine_exercises unordered (no order-by on the join), so
  // the first array element is NOT necessarily the first exercise of the day.
  const shuffled: ReasonRoutine = {
    id: "r-push",
    name: "Push",
    routine_exercises: [
      { order: 2, exercises: { name: "Lateral Raise", muscle_group: "Shoulders" } },
      { order: 1, exercises: { name: "Dumbbell Shoulder Press", muscle_group: "Shoulders" } },
      { order: 0, exercises: { name: "Bench Press", muscle_group: "Chest" } },
    ],
  };
  const w = session("Push", "r-push", 6, { name: "Bench Press", muscle: "Chest", weight: 77.5 });
  w.sets!.push({
    weight_kg: 22, reps: 10, completed: true,
    exercises: { name: "Dumbbell Shoulder Press", muscle_group: "Shoulders" },
  });
  const line = todayReason({ routine: shuffled, workouts: [w], now: NOW })!;
  assert(line.includes("Bench Press opens at 77.5 kg"), line);
  assert(!line.includes("Dumbbell Shoulder Press"), line);
});

Deno.test("'Other' is a catch-all bucket, never named as a rested muscle", () => {
  const withOther: ReasonRoutine = {
    id: "r-push",
    name: "Push",
    routine_exercises: [
      { order: 0, exercises: { name: "Bench Press", muscle_group: "Chest" } },
      { order: 1, exercises: { name: "Dumbbell Shoulder Press", muscle_group: "Other" } },
    ],
  };
  // "Other" was worked longest ago, so a naive ranking would name it.
  const old = session("Push", "r-push", 30, {
    name: "Dumbbell Shoulder Press", muscle: "Other", weight: 22,
  });
  const recent = session("Push", "r-push", 6, { name: "Bench Press", muscle: "Chest", weight: 77.5 });
  const line = todayReason({ routine: withOther, workouts: [old, recent], now: NOW })!;
  assert(!line.includes("Other is your most rested"), line);
  assert(line.includes("Chest is your most rested"), line);
});

Deno.test("never uses an em dash", () => {
  const line = todayReason({
    routine: push,
    workouts: [session("Push", "r-push", 6, { name: "Bench Press", muscle: "Chest", weight: 70 })],
    now: NOW,
  })!;
  assert(!line.includes("—"), line);
});
