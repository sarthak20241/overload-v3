// Run with: deno test supabase/functions/ai-coach/itemMeals.test.ts
//
// Plan I8: one message can cover a whole day. Every line has to land in the
// section the user named for IT, and a message that names no per-item meal
// must come out exactly as it did before per-item meals existed.

import { assertEquals } from "jsr:@std/assert@1";
import { assignItemMeals, type ExtractedItem, type ParsedItem } from "./parseMeal.ts";

const line = (food_name: string, extra: Partial<ParsedItem> = {}): ParsedItem => ({
  food_id: null, food_name, quantity: 1, serving_label: "serving", grams: 100,
  kcal: 100, protein_g: 5, carb_g: 10, fat_g: 3, fiber_g: null,
  source: "estimate", assumption: null, confidence: "medium", ...extra,
});
const ext = (
  name: string,
  meal: ExtractedItem["meal"] = null,
  brand: string | null = null,
  correctsFoodName: string | null = null,
): ExtractedItem =>
  ({ name, brand, quantity: 1, unit: "serving", prep: null, meal, correctsFoodName });

Deno.test("no per-item meal: every line takes the default, nothing else changes", () => {
  const out = assignItemMeals(
    [line("roti"), line("dal")],
    [ext("roti"), ext("dal")],
    { explicit: null, fallback: "lunch" },
  );
  assertEquals(out.map((i) => i.meal_type), ["lunch", "lunch"]);
  // Shape is untouched apart from the stamp.
  assertEquals(out[0].food_name, "roti");
  assertEquals(out[0].kcal, 100);
});

Deno.test("the canonical case: eggs to breakfast, dal chawal to lunch", () => {
  const out = assignItemMeals(
    [line("Egg, whole, boiled"), line("Dal chawal")],
    [ext("eggs", "breakfast"), ext("dal chawal", "lunch")],
    { explicit: null, fallback: "dinner" },
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "lunch"]);
});

Deno.test("decide renamed the line to the row's display name: matched through the brand", () => {
  // The user typed "amul cheese slice"; decide displays the catalog row.
  const out = assignItemMeals(
    [line("Amul Cheese slices"), line("Oreo biscuits")],
    [ext("cheese slice", "snack", "Amul"), ext("oreo biscuits", "breakfast", "Oreo")],
    { explicit: null, fallback: "lunch" },
  );
  assertEquals(out.map((i) => i.meal_type), ["snack", "breakfast"]);
});

Deno.test("an item with no named meal takes the default even when its neighbours have one", () => {
  const out = assignItemMeals(
    [line("eggs"), line("milk tea")],
    [ext("eggs", "breakfast"), ext("milk tea")],
    { explicit: null, fallback: "snack" },
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "snack"]);
});

Deno.test("a corrected previous line keeps its own section", () => {
  // "make it 3 eggs" at 9pm: the line already says breakfast, the correction
  // names no meal, the clock says dinner. Breakfast must win.
  const out = assignItemMeals(
    [line("Egg, whole, boiled", { meal_type: "breakfast" })],
    [ext("eggs")],
    { explicit: null, fallback: "dinner" },
  );
  assertEquals(out[0].meal_type, "breakfast");
});

Deno.test("but a correction that names a meal moves the line", () => {
  const out = assignItemMeals(
    [line("Egg, whole, boiled", { meal_type: "breakfast" })],
    [ext("eggs", "lunch")],
    { explicit: null, fallback: "dinner" },
  );
  assertEquals(out[0].meal_type, "lunch");
});

Deno.test("positional fallback when names do not overlap but counts line up", () => {
  // Decide can translate a name entirely ("chai" -> "Tea, with milk").
  const out = assignItemMeals(
    [line("Tea, with milk"), line("Poha")],
    [ext("chai", "breakfast"), ext("poha", "lunch")],
    { explicit: null, fallback: "snack" },
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "lunch"]);
});

Deno.test("each extracted item is claimed once: two rotis do not share one tag", () => {
  const out = assignItemMeals(
    [line("roti"), line("roti")],
    [ext("roti", "breakfast"), ext("roti", "dinner")],
    { explicit: null, fallback: "snack" },
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "dinner"]);
});

Deno.test("a line that matches nothing and cannot be placed by position takes the default", () => {
  // Three lines, two extracted items: no positional fallback, and "paneer"
  // overlaps neither. It must not inherit a neighbour's breakfast.
  const out = assignItemMeals(
    [line("eggs"), line("paneer"), line("dal")],
    [ext("eggs", "breakfast"), ext("dal", "lunch")],
    { explicit: null, fallback: "snack" },
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "snack", "lunch"]);
});

// ── The three the PR bot found, each with the wrong answer written down ──────

Deno.test("an explicit meal in the text beats the section a line is already in", () => {
  // "that was lunch" on a logged breakfast line. Carried-beats-default was
  // written before an explicit meal was told apart from a clock guess, so the
  // line kept breakfast and the user's own words lost. Explicit sits above
  // carried now; the clock still sits below it (the test above).
  const out = assignItemMeals(
    [line("Egg, whole, boiled", { meal_type: "breakfast" })],
    [ext("eggs")],
    { explicit: "lunch", fallback: "dinner" },
  );
  assertEquals(out[0].meal_type, "lunch");
});

Deno.test("a correction does not collapse a full-day log into one section", () => {
  // The shape of the bug: three sections logged, then "make it 3 eggs". The
  // correction names no meal, so every line must stay where it was rather than
  // taking the correction's default.
  const out = assignItemMeals(
    [
      line("Egg, whole, boiled", { meal_type: "breakfast" }),
      line("Dal chawal", { meal_type: "lunch" }),
      line("Khakhra", { meal_type: "snack" }),
    ],
    [ext("eggs"), ext("dal chawal"), ext("khakhra")],
    { explicit: null, fallback: "dinner" },
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "lunch", "snack"]);
});

Deno.test("decide rebuilt the lines, so the section comes back by correctsFoodName", () => {
  // The decide path does not carry meal_type on the line at all: sanitizeItems
  // rebuilds every line from the tool's output, which has no such field. The
  // extracted item's correctsFoodName is the only handle back to the previous
  // line, and carriedFor is how the section is recovered from it.
  const prevMeal: Record<string, "breakfast" | "lunch" | "snack"> = {
    "egg, whole, boiled": "breakfast",
    "dal chawal": "lunch",
  };
  const out = assignItemMeals(
    [line("Egg, whole, boiled"), line("Dal chawal")],   // no meal_type: rebuilt
    [ext("eggs", null, null, "Egg, whole, boiled"), ext("dal chawal", null, null, "Dal chawal")],
    {
      explicit: null,
      fallback: "dinner",
      carriedFor: (n) => prevMeal[n.trim().toLowerCase()],
    },
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "lunch"]);
});

Deno.test("carriedFor never overrides a meal the text named for that item", () => {
  const out = assignItemMeals(
    [line("Egg, whole, boiled")],
    [ext("eggs", "dinner", null, "Egg, whole, boiled")],
    { explicit: null, fallback: "snack", carriedFor: () => "breakfast" },
  );
  assertEquals(out[0].meal_type, "dinner");
});

Deno.test("a generic line does not steal the specific line's tag", () => {
  // Greedy first-match let "Dal" claim the "dal makhani" entry, leaving
  // "Dal makhani" the leftover "dal" - both sections wrong, and SWAPPED rather
  // than merely missing, which is the worst shape for a bug like this because
  // both lines look plausibly placed. Pairs are scored and the exact match is
  // assigned before the loose one can take it.
  const out = assignItemMeals(
    [line("Dal"), line("Dal makhani")],
    [ext("dal makhani", "lunch"), ext("dal", "dinner")],
    { explicit: null, fallback: "snack" },
  );
  assertEquals(out.map((i) => i.meal_type), ["dinner", "lunch"]);
});

Deno.test("ordering is stable when two lines score the same", () => {
  // Two identical names, two entries: ties keep source order, so the result is
  // deterministic rather than depending on how the scorer happened to sort.
  const out = assignItemMeals(
    [line("roti"), line("roti")],
    [ext("roti", "breakfast"), ext("roti", "dinner")],
    { explicit: null, fallback: "snack" },
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "dinner"]);
});

Deno.test("the same food in two sections: position decides which one is corrected", () => {
  // "roti" logged at breakfast AND lunch. Correcting the second must not file
  // into the first just because the name matches it earlier in the list.
  const prev = [
    { food_name: "roti", meal: "breakfast" as const },
    { food_name: "roti", meal: "lunch" as const },
  ];
  const carriedFor = (name: string, idx?: number) => {
    const want = name.trim().toLowerCase();
    const hits = prev.filter((p) => p.food_name === want);
    if (hits.length === 1) return hits[0].meal;
    if (idx !== undefined && prev[idx]?.food_name === want) return prev[idx].meal;
    const distinct = new Set(hits.map((h) => h.meal));
    return distinct.size === 1 ? hits[0].meal : undefined;
  };
  const out = assignItemMeals(
    [line("roti"), line("roti")],
    [ext("roti", null, null, "roti"), ext("roti", null, null, "roti")],
    { explicit: null, fallback: "dinner", carriedFor },
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "lunch"]);
});

Deno.test("a name in two sections with no positional handle is left to the fallback", () => {
  // Genuinely ambiguous: one line, a name that exists in two sections, and no
  // index that agrees. Guessing the first would file it confidently wrong, so
  // it falls back instead - wrong is recoverable, confidently wrong is not.
  const carriedFor = (_n: string, _i?: number) => undefined;
  const out = assignItemMeals(
    [line("roti")],
    [ext("roti", null, null, "roti")],
    { explicit: null, fallback: "dinner", carriedFor },
  );
  assertEquals(out[0].meal_type, "dinner");
});
