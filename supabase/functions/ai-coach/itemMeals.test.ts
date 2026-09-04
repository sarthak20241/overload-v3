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
const ext = (name: string, meal: ExtractedItem["meal"] = null, brand: string | null = null): ExtractedItem =>
  ({ name, brand, quantity: 1, unit: "serving", prep: null, meal });

Deno.test("no per-item meal: every line takes the default, nothing else changes", () => {
  const out = assignItemMeals(
    [line("roti"), line("dal")],
    [ext("roti"), ext("dal")],
    "lunch",
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
    "dinner",
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "lunch"]);
});

Deno.test("decide renamed the line to the row's display name: matched through the brand", () => {
  // The user typed "amul cheese slice"; decide displays the catalog row.
  const out = assignItemMeals(
    [line("Amul Cheese slices"), line("Oreo biscuits")],
    [ext("cheese slice", "snack", "Amul"), ext("oreo biscuits", "breakfast", "Oreo")],
    "lunch",
  );
  assertEquals(out.map((i) => i.meal_type), ["snack", "breakfast"]);
});

Deno.test("an item with no named meal takes the default even when its neighbours have one", () => {
  const out = assignItemMeals(
    [line("eggs"), line("milk tea")],
    [ext("eggs", "breakfast"), ext("milk tea")],
    "snack",
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "snack"]);
});

Deno.test("a corrected previous line keeps its own section", () => {
  // "make it 3 eggs" at 9pm: the line already says breakfast, the correction
  // names no meal, the clock says dinner. Breakfast must win.
  const out = assignItemMeals(
    [line("Egg, whole, boiled", { meal_type: "breakfast" })],
    [ext("eggs")],
    "dinner",
  );
  assertEquals(out[0].meal_type, "breakfast");
});

Deno.test("but a correction that names a meal moves the line", () => {
  const out = assignItemMeals(
    [line("Egg, whole, boiled", { meal_type: "breakfast" })],
    [ext("eggs", "lunch")],
    "dinner",
  );
  assertEquals(out[0].meal_type, "lunch");
});

Deno.test("positional fallback when names do not overlap but counts line up", () => {
  // Decide can translate a name entirely ("chai" -> "Tea, with milk").
  const out = assignItemMeals(
    [line("Tea, with milk"), line("Poha")],
    [ext("chai", "breakfast"), ext("poha", "lunch")],
    "snack",
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "lunch"]);
});

Deno.test("each extracted item is claimed once: two rotis do not share one tag", () => {
  const out = assignItemMeals(
    [line("roti"), line("roti")],
    [ext("roti", "breakfast"), ext("roti", "dinner")],
    "snack",
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "dinner"]);
});

Deno.test("a line that matches nothing and cannot be placed by position takes the default", () => {
  // Three lines, two extracted items: no positional fallback, and "paneer"
  // overlaps neither. It must not inherit a neighbour's breakfast.
  const out = assignItemMeals(
    [line("eggs"), line("paneer"), line("dal")],
    [ext("eggs", "breakfast"), ext("dal", "lunch")],
    "snack",
  );
  assertEquals(out.map((i) => i.meal_type), ["breakfast", "snack", "lunch"]);
});
