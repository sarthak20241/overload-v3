// Run with: deno test lib/workoutSummary.test.ts
//
// The done-today sheet reads one workout back: exercises in the order they were
// done, and the sets each muscle got for the body map.

import { assertEquals } from "jsr:@std/assert@1";
import { groupSetsByExercise, muscleSetCounts, type SummarySet } from "./workoutSummary.ts";

const set = (name: string, muscle: string | null, order: number | null, extra: Partial<SummarySet> = {}): SummarySet => ({
  weight_kg: 60, reps: 8, completed: true, order, exercises: { name, muscle_group: muscle, metric_type: null }, ...extra,
});

Deno.test("groups by exercise in the order the session ran, not array order", () => {
  // Supabase returns the workout_sets join unordered.
  const sets = [set("Row", "Back", 2), set("Bench Press", "Chest", 0), set("Row", "Back", 3), set("Bench Press", "Chest", 1)];
  const groups = groupSetsByExercise(sets);
  assertEquals(groups.map((g) => g.name), ["Bench Press", "Row"]);
  assertEquals(groups.map((g) => g.sets.length), [2, 2]);
  assertEquals(groups[1].sets.map((s) => s.order), [2, 3]);
});

Deno.test("rows without an order keep their position", () => {
  const groups = groupSetsByExercise([set("Squat", "Legs", null), set("Plank", "Core", null)]);
  assertEquals(groups.map((g) => g.name), ["Squat", "Plank"]);
});

Deno.test("no sets means no groups", () => {
  assertEquals(groupSetsByExercise(undefined), []);
});

Deno.test("muscle counts are completed sets per muscle group", () => {
  const sets = [
    set("Bench Press", "Chest", 0),
    set("Bench Press", "Chest", 1),
    set("Bench Press", "Chest", 2, { completed: false }),
    set("Row", "Back", 3),
    set("Mystery", null, 4),
  ];
  assertEquals(muscleSetCounts(sets), { Chest: 2, Back: 1 });
});
