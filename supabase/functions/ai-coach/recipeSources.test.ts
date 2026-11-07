// Run with: deno test --allow-all supabase/functions/ai-coach/recipeSources.test.ts
//
// A dish built from its parts (source "recipe", recipe.ts) keeps that source
// when it comes back from the diary (copy_lines) or from food memory, with its
// parts, instead of reading as an estimate or a catalog row.

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { diarySourceLine } from "./foodAgent.ts";
import { type MealRowIn, resolveDay, shapeLoggedMeals } from "./loggedMeals.ts";
import { memoryStamp } from "./parseMeal.ts";
import type { MemoryFood } from "./userFoodMemory.ts";

const PARTS = [
  { name: "low fat paneer", grams: 60, per100: { kcal: 254, protein_g: 25, carb_g: 4, fat_g: 15 }, source: "catalog" as const },
  { name: "oil", grams: 5, per100: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 }, source: "catalog" as const, assumed: true },
];

Deno.test("diary: a recipe line is copied as a recipe, with its parts, not as an estimate to check", () => {
  const line = diarySourceLine({ name: "Paneer sabji", kcal: 197, source: "recipe", origin: "recipe", recipe: PARTS, quantity: 1, serving_unit: "serving", grams: 65 });
  assert(line);
  const item = line!.item("lunch");
  assertEquals(item.source, "recipe");
  assertEquals(item.recipe, PARTS);
  assertEquals(item.confidence, "high");
  assertFalse((item.assumption ?? "").includes("Check this one"));
});

const DAY = (() => {
  const d = resolveDay({ days_ago: 1 }, { timeZone: "Asia/Kolkata", nowMs: Date.UTC(2026, 8, 22, 6, 30) });
  if ("error" in d) throw new Error(d.error);
  return d;
})();

Deno.test("diary: the full read keeps a recipe line's parts, and only on a recipe line", () => {
  const rows: MealRowIn[] = [{
    meal_type: "lunch",
    logged_at: "2026-09-21T07:45:00Z",
    meal_entries: [
      { food_name: "Paneer sabji", food_id: null, source: "recipe", recipe: PARTS, quantity: 1, serving_unit: "serving", kcal: 197, protein_g: 15, carb_g: 2.4, fat_g: 14, position: 0 },
      { food_name: "Rice", food_id: "f-1", source: "catalog", recipe: PARTS, quantity: 1, serving_unit: "bowl", kcal: 195, protein_g: 4, carb_g: 42, fat_g: 0.4, position: 1 },
    ],
  } as MealRowIn];
  const items = shapeLoggedMeals(rows, DAY, "lunch", true).meals[0].items;
  assertEquals(items.map((i) => i.recipe ?? null), [PARTS, null]);
  // The model's lean read stays as it was.
  assertEquals(shapeLoggedMeals(rows, DAY, "lunch").meals[0].items.map((i) => i.recipe ?? null), [null, null]);
});

Deno.test("memory: a remembered dish is served as a recipe, not as a catalog row", () => {
  const food = {
    key: "paneer sabji", name: "Paneer sabji", food_id: null, serving: null, source: "recipe", level: "precise",
    times: 3, last_logged_at: "2026-11-04T12:00:00Z", origin: "recipe", recipe: PARTS,
  } as unknown as MemoryFood;
  const stamp = memoryStamp(food, "Asia/Kolkata");
  assertEquals(stamp.source, "recipe");
  assertEquals(stamp.recipe, PARTS);
});
