// Run with: deno test --allow-all --unstable-sloppy-imports lib/planSwap.test.ts
//
// Swapping an exercise on a built plan (the Phase 1 workouts screen), before
// it is saved. The swap is the plan's from then on: it saves with it.

import { assertEquals } from "jsr:@std/assert@1";
import { restorePlanExercise, swapFromFor, swapPlanExercise, swapExcludeIds } from "./planSwap.ts";

const plan = {
  name: "Phase 1",
  rationale: "x",
  workouts: [
    {
      name: "Full Body A",
      exercises: [
        { name: "Back Squat", sets: 3, reps: "6-8", rest: "120s", note: "Brace hard" },
        { name: "Couch Stretch", sets: 2, reps: "45s", rest: "30s", new_exercise: { muscle_group: "Quads", category: "Stretch", metric_type: "time" } },
      ],
    },
    { name: "Full Body B", exercises: [{ name: "Pull-ups", sets: 3, reps: "6-10", rest: "90s" }] },
  ],
} as any;

const catalog = [
  { id: "sq", name: "Back Squat", muscle_group: "Legs", category: "Barbell", target_muscle: "Quads", swap_pattern: "squat" },
  { id: "fsq", name: "Front Squat", muscle_group: "Legs", category: "Barbell", target_muscle: "Quads", swap_pattern: "squat" },
  { id: "pu", name: "Pull-ups", muscle_group: "Back", category: "Bodyweight" },
];

Deno.test("a swap takes the new name, keeps the sets, reps and rest, and drops the old cue", () => {
  const next = swapPlanExercise(plan, 0, 0, catalog[1]);
  const ex = next.workouts[0].exercises[0];
  assertEquals(ex.name, "Front Squat");
  assertEquals([ex.sets, ex.reps, ex.rest], [3, "6-8", "120s"]);
  assertEquals(ex.note, undefined);
  // The plan's own pick is kept, to go back to it.
  assertEquals(ex.planned?.name, "Back Squat");
  assertEquals(ex.planned?.note, "Brace hard");
  // Nothing else moved, and the plan given in is untouched.
  assertEquals(next.workouts[1], plan.workouts[1]);
  assertEquals(plan.workouts[0].exercises[0].name, "Back Squat");
});

Deno.test("a swapped Drona-invented exercise no longer saves as a new custom one", () => {
  const next = swapPlanExercise(plan, 0, 1, catalog[1]);
  assertEquals(next.workouts[0].exercises[1].new_exercise, undefined);
  assertEquals(next.workouts[0].exercises[1].planned?.new_exercise?.metric_type, "time");
});

Deno.test("a second swap still goes back to the plan's own pick", () => {
  const once = swapPlanExercise(plan, 0, 0, catalog[1]);
  const twice = swapPlanExercise(once, 0, 0, { id: "x", name: "Leg Press" });
  assertEquals(twice.workouts[0].exercises[0].planned?.name, "Back Squat");
  const back = restorePlanExercise(twice, 0, 0);
  assertEquals(back.workouts[0].exercises[0], plan.workouts[0].exercises[0]);
});

Deno.test("swapping back to the plan's own pick is the same as Back to", () => {
  const once = swapPlanExercise(plan, 0, 0, catalog[1]);
  const back = swapPlanExercise(once, 0, 0, catalog[0]);
  assertEquals(back.workouts[0].exercises[0], plan.workouts[0].exercises[0]);
});

Deno.test("the swap list ranks from the catalog row when the name is known, any case", () => {
  assertEquals(swapFromFor({ name: "back squat", sets: 3, reps: "5", rest: "90s" }, catalog).id, "sq");
  // An invented one: its own muscle group, so the list still has a place to start.
  const invented = swapFromFor(plan.workouts[0].exercises[1], catalog);
  assertEquals(invented.name, "Couch Stretch");
  assertEquals(invented.muscle_group, "Quads");
});

Deno.test("the day's other exercises are never offered", () => {
  const ids = swapExcludeIds(plan.workouts[0], 1, catalog);
  assertEquals([...ids], ["sq"]);
});
