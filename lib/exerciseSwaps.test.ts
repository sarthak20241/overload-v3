import { assertEquals } from "jsr:@std/assert@1";
import { rankSwaps, swapTier, type SwapExercise } from "./exerciseSwaps.ts";

const ex = (
  id: string,
  name: string,
  target_muscle: string | null,
  swap_pattern: string | null,
  more: Partial<SwapExercise> = {},
): SwapExercise => ({ id, name, muscle_group: "Chest", category: "Dumbbell", metric_type: "weight_reps", created_by: null, target_muscle, swap_pattern, ...more });

const FROM = ex("from", "Incline Dumbbell Press", "Upper Chest", "horizontal_press");
const CATALOG = [
  FROM,
  ex("crossover", "Cable Crossover", "Mid Chest", "fly", { category: "Cable" }),
  ex("bench", "Bench Press", "Mid Chest", "horizontal_press", { category: "Barbell" }),
  ex("inc-fly", "Incline Cable Fly", "Upper Chest", "fly", { category: "Cable" }),
  ex("inc-bb", "Incline Barbell Press", "Upper Chest", "horizontal_press", { category: "Barbell" }),
  ex("row", "Barbell Row", "Upper Back", "horizontal_pull", { muscle_group: "Back" }),
  ex("ohp", "Overhead Press", "Front Delts", "vertical_press", { muscle_group: "Shoulders" }),
];
const names = (input: Parameters<typeof rankSwaps>[0]) => rankSwaps(input).map((o) => `${o.tier}: ${o.exercise.name}`);

Deno.test("the exact muscle leads: same movement, then other movement, then the rest of the group", () => {
  assertEquals(names({ from: FROM, exercises: CATALOG }), [
    "exact: Incline Barbell Press",
    "muscle: Incline Cable Fly",
    "movement: Bench Press",
    "group: Cable Crossover",
  ]);
});

Deno.test("another muscle group is never a swap, whatever the movement", () => {
  // A close-grip bench is a horizontal press too, but it is triceps work.
  const closeGrip = ex("cgbp", "Close-Grip Bench Press", "Triceps", "horizontal_press", { muscle_group: "Triceps" });
  assertEquals(swapTier(FROM, closeGrip), null);
  assertEquals(swapTier(FROM, CATALOG[5]), null);
});

Deno.test("inside a tier: done before, then measured the same way, then same equipment, then name", () => {
  const exercises = [
    ex("a", "Incline Machine Press", "Upper Chest", "horizontal_press", { category: "Machine" }),
    ex("b", "Incline Dumbbell Squeeze Press", "Upper Chest", "horizontal_press"),
    ex("c", "Decline Push-Up", "Upper Chest", "horizontal_press", { category: "Bodyweight", metric_type: "bodyweight_reps" }),
    ex("d", "Incline Smith Press", "Upper Chest", "horizontal_press", { category: "Machine" }),
    ex("e", "Incline Cable Fly", "Upper Chest", "fly", { category: "Cable" }),
  ];
  const got = rankSwaps({ from: FROM, exercises, doneIds: new Set(["d", "e"]) });
  assertEquals(got.map((o) => [o.exercise.id, o.tier, o.done]), [
    ["d", "exact", true], // done before beats same equipment
    ["b", "exact", false], // same equipment (dumbbell)
    ["a", "exact", false],
    ["c", "exact", false], // measured another way: last of its tier
    ["e", "muscle", true], // done before never jumps a tier
  ]);
});

Deno.test("a well-known exercise comes before an obscure one, but after one done before", () => {
  const from = ex("from", "Lateral Raise", "Side Delts", "raise");
  const exercises = [
    ex("a", "Iron Cross", "Side Delts", "raise"),
    ex("b", "Cable Lateral Raise", "Side Delts", "raise", { category: "Cable" }),
    ex("c", "Dumbbell Scaption", "Side Delts", "raise"),
  ];
  const commonNames = new Set(["cable lateral raise"]);
  assertEquals(rankSwaps({ from, exercises, commonNames }).map((o) => o.exercise.id), ["b", "c", "a"]);
  assertEquals(rankSwaps({ from, exercises, commonNames, doneIds: new Set(["a"]) }).map((o) => o.exercise.id), ["a", "b", "c"]);
});

Deno.test("the exercise itself, its other rows by name, and excluded ids are not offered", () => {
  const exercises = [
    ...CATALOG,
    ex("own-copy", "incline dumbbell press", "Upper Chest", "horizontal_press", { created_by: "user_1" }),
  ];
  assertEquals(names({ from: FROM, exercises, excludeIds: new Set(["inc-bb", "bench"]) }), [
    "muscle: Incline Cable Fly",
    "group: Cable Crossover",
  ]);
});

Deno.test("a name that is in the list twice is offered once, the user's own row first", () => {
  const exercises = [
    ex("cat", "Incline Barbell Press", "Upper Chest", "horizontal_press"),
    ex("own", "incline barbell press", "Upper Chest", "horizontal_press", { created_by: "user_1" }),
  ];
  assertEquals(rankSwaps({ from: FROM, exercises }).map((o) => o.exercise.id), ["own"]);
  // Unless the catalog row is the one they have logged.
  assertEquals(rankSwaps({ from: FROM, exercises, doneIds: new Set(["cat"]) }).map((o) => o.exercise.id), ["cat"]);
});

Deno.test("a row with no tags is read by the group the user sees", () => {
  const untagged = ex("new", "My Chest Thing", null, null, { created_by: "user_1" });
  // As a candidate: it is chest work, and no more is known.
  assertEquals(swapTier(FROM, untagged), "group");
  // As the exercise to replace: every chest exercise is a swap, none exact.
  // (Same equipment first, then by name.)
  assertEquals(names({ from: untagged, exercises: CATALOG }), [
    "group: Incline Dumbbell Press",
    "group: Bench Press",
    "group: Cable Crossover",
    "group: Incline Barbell Press",
    "group: Incline Cable Fly",
  ]);
});

Deno.test("a row that names no muscle has no swaps and is nobody's swap", () => {
  const other = ex("x", "Warm Up", "Other", "mobility", { muscle_group: "Other" });
  const blank = ex("y", "Bjh", null, null, { muscle_group: "Other" });
  assertEquals(rankSwaps({ from: other, exercises: [...CATALOG, blank] }), []);
  assertEquals(rankSwaps({ from: blank, exercises: [...CATALOG, other] }), []);
  assertEquals(swapTier(FROM, other), null);
});

Deno.test("the movement 'other' matches nothing, so two odd lifts are not an exact pair", () => {
  const a = ex("a", "Atlas Stones", "Lower Back", "other", { muscle_group: "Back" });
  const b = ex("b", "Keg Load", "Lower Back", "other", { muscle_group: "Back" });
  assertEquals(swapTier(a, b), "muscle");
});

Deno.test("a head and its parent are the same group, not the same muscle", () => {
  const curl = ex("a", "Barbell Curl", "Biceps", "curl", { muscle_group: "Biceps" });
  const incline = ex("b", "Incline Dumbbell Curl", "Biceps Long Head", "curl", { muscle_group: "Biceps" });
  assertEquals(swapTier(curl, incline), "movement");
  // Spelling and case in the stored tag do not matter.
  assertEquals(swapTier({ ...curl, target_muscle: " biceps LONG head " }, incline), "exact");
});

Deno.test("limit keeps the best options", () => {
  assertEquals(rankSwaps({ from: FROM, exercises: CATALOG, limit: 2 }).map((o) => o.exercise.id), ["inc-bb", "inc-fly"]);
  assertEquals(rankSwaps({ from: FROM, exercises: CATALOG, limit: 0 }), []);
});
