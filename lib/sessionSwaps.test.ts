import { assertEquals } from "jsr:@std/assert@1";
import { applySessionSwaps, canSwapLive, clearSessionSwaps, peekSessionSwaps, setSessionSwaps, slotKey, swapLiveSlot, type LiveSlot, type SwapSlot } from "./sessionSwaps.ts";

const row = (id: string, name: string) => ({ id, name, muscle_group: "Chest", category: "Dumbbell", metric_type: "weight_reps" });
const slot = (order: number, id: string, name: string, more: Record<string, unknown> = {}) =>
  ({ order, exercise_id: id, note: "Pause at the chest", sets: 3, reps_min: 8, reps_max: 12, rest_seconds: 90, exercises: row(id, name), ...more }) as SwapSlot & Record<string, unknown>;

const SLOTS = [slot(0, "a", "Incline Dumbbell Press"), slot(1, "b", "Cable Fly"), slot(2, "a", "Incline Dumbbell Press")];

Deno.test("a swap changes only its own slot and keeps the slot's sets, reps and rest", () => {
  const got = applySessionSwaps(SLOTS, { [slotKey(SLOTS[0])]: row("x", "Incline Barbell Press") });
  assertEquals(got.map((s) => [s.order, s.exercise_id, s.exercises.name]), [
    [0, "x", "Incline Barbell Press"],
    [1, "b", "Cable Fly"],
    // The same exercise later in the routine is another slot, and stays.
    [2, "a", "Incline Dumbbell Press"],
  ]);
  assertEquals([got[0].sets, got[0].reps_min, got[0].reps_max, got[0].rest_seconds], [3, 8, 12, 90]);
});

Deno.test("the coach's note leaves with the exercise it was written for", () => {
  const got = applySessionSwaps(SLOTS, { [slotKey(SLOTS[1])]: row("y", "Pec Deck") });
  assertEquals(got.map((s) => s.note), ["Pause at the chest", null, "Pause at the chest"]);
});

Deno.test("no swaps, an unknown slot, or a swap to the same exercise change nothing", () => {
  assertEquals(applySessionSwaps(SLOTS, null), SLOTS);
  assertEquals(applySessionSwaps(SLOTS, {}), SLOTS);
  assertEquals(applySessionSwaps(SLOTS, { "9:z": row("x", "X") }), SLOTS);
  assertEquals(applySessionSwaps(SLOTS, { [slotKey(SLOTS[1])]: row("b", "Cable Fly") })[1].note, "Pause at the chest");
});

Deno.test("the hand-over survives a second read, and ends when the workout starts", () => {
  const swaps = { "0:a": row("x", "Incline Barbell Press") };
  setSessionSwaps("r1", swaps);
  // The load can run twice before the workout exists: both reads see the swaps.
  assertEquals(peekSessionSwaps("r1"), swaps);
  assertEquals(peekSessionSwaps("r1"), swaps);
  clearSessionSwaps();
  assertEquals(peekSessionSwaps("r1"), null);
});

Deno.test("swaps waiting for one routine never reach another, nor a later start of their own", () => {
  const swaps = { "0:a": row("x", "Incline Barbell Press") };
  setSessionSwaps("r1", swaps);
  assertEquals(peekSessionSwaps("r2"), null);
  // Another routine started first: the waiting swaps are gone, not kept for later.
  assertEquals(peekSessionSwaps("r1"), null);

  // An empty set of swaps clears what was waiting.
  setSessionSwaps("r1", swaps);
  setSessionSwaps("r1", {});
  assertEquals(peekSessionSwaps("r1"), null);
});

Deno.test("a swapped slot remembers the plan's exercise and its note", () => {
  const got = applySessionSwaps(SLOTS, { [slotKey(SLOTS[0])]: row("x", "Incline Barbell Press") });
  assertEquals(got[0].swapped_from, { exercise: row("a", "Incline Dumbbell Press"), coachNote: "Pause at the chest" });
  assertEquals(got[1].swapped_from, undefined);
});

const live = (more: Partial<LiveSlot> = {}): LiveSlot & { restSeconds: number; supersetGroup: number | null } => ({
  exercise: row("a", "Incline Dumbbell Press"),
  sets: [0, 1, 2].map(() => ({ weight_kg: 20, reps: 10, completed: false })),
  targetSets: 3,
  repsMin: 8,
  restSeconds: 120,
  supersetGroup: 1,
  coachNote: "Pause at the chest",
  sessionNote: "Left shoulder felt off",
  previousSets: [{ weight_kg: 20, reps: 10 }],
  allTimeBestWeight: 24,
  ...more,
});

Deno.test("in a workout, a slot can be swapped only before its first logged set", () => {
  assertEquals(canSwapLive(live(), false), true);
  assertEquals(canSwapLive(live(), true), false);
  const logged = live({ sets: [{ weight_kg: 20, reps: 10, completed: true }, { weight_kg: 20, reps: 10, completed: false }] });
  assertEquals(canSwapLive(logged, false), false);
});

Deno.test("a live swap keeps the prescription and starts the sets from the new exercise's history", () => {
  const got = swapLiveSlot(live(), row("x", "Incline Barbell Press"), {
    previousSets: [{ weight_kg: 50, reps: 8 }, { weight_kg: 50, reps: 7 }],
    allTimeBestWeight: 60,
  });
  assertEquals(got.exercise.name, "Incline Barbell Press");
  assertEquals([got.targetSets, got.restSeconds, got.supersetGroup], [3, 120, 1]);
  assertEquals(got.sets, [
    { weight_kg: 50, reps: 8, completed: false },
    { weight_kg: 50, reps: 7, completed: false },
    { weight_kg: 0, reps: 8, completed: false },
  ]);
  assertEquals([got.previousSets?.length, got.allTimeBestWeight], [2, 60]);
  // The old exercise's history, today's note and the cue do not follow.
  assertEquals([got.coachNote, got.sessionNote], [undefined, undefined]);
  assertEquals(got.swappedFrom, { exercise: row("a", "Incline Dumbbell Press"), coachNote: "Pause at the chest" });
});

Deno.test("with no history the new sets start empty, not with the old exercise's weights", () => {
  const got = swapLiveSlot(live(), row("x", "Incline Barbell Press"));
  assertEquals(got.sets.map((s) => [s.weight_kg, s.reps]), [[0, 8], [0, 8], [0, 8]]);
  assertEquals([got.previousSets, got.allTimeBestWeight], [undefined, undefined]);
});

Deno.test("a second swap still points back to the plan, and going back brings its cue back", () => {
  const once = swapLiveSlot(live(), row("x", "Incline Barbell Press"));
  const twice = swapLiveSlot(once, row("y", "Incline Machine Press"));
  assertEquals(twice.swappedFrom?.exercise.id, "a");
  const back = swapLiveSlot(twice, row("a", "Incline Dumbbell Press"));
  assertEquals([back.exercise.id, back.coachNote, back.swappedFrom], ["a", "Pause at the chest", null]);
});
