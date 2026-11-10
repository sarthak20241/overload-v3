// Step 4 (Precise plan): clear origins on the server's lines, memory trust by
// origin, and a remembered recipe that follows the user's words for one part.
import { assertEquals } from "jsr:@std/assert@1";
import { finishOrigins, type ParsedItem, preserveManual } from "./parseMeal.ts";
import { savedMealLines } from "./savedMeals.ts";
import { buildMemory, entryOriginTrust, type MemoryEntry, memoryKey } from "./userFoodMemory.ts";

const line = (o: Partial<ParsedItem>): ParsedItem => ({
  food_id: null, food_name: "x", quantity: 1, serving_label: "serving", grams: 100,
  kcal: 100, protein_g: 5, carb_g: 10, fat_g: 4, fiber_g: null, source: "estimate",
  assumption: null, confidence: "medium", ...o,
});

const SABJI = [
  { name: "Milky Mist low fat paneer", grams: 65, per100: { kcal: 180, protein_g: 25, carb_g: 5, fat_g: 6.5 } },
  { name: "onion", grams: 40, per100: { kcal: 40, protein_g: 1.1, carb_g: 9.3, fat_g: 0.1 } },
  { name: "oil", grams: 5, per100: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 } },
];

Deno.test("finishOrigins: every line leaves with an origin; old manual reads unknown", () => {
  const [a, b, c] = finishOrigins([
    line({ source: "catalog" }),
    line({ source: "manual" }),
    line({ source: "manual", assumption: "Your numbers: 150 kcal" }),
  ], "lunch");
  assertEquals([a.origin, b.origin, c.origin], ["catalog", "unknown", "user_typed"]);
});

Deno.test("finishOrigins: '60 g paneer' scales the paneer part of a remembered recipe, not the whole dish", () => {
  const sabji = line({
    food_name: "Milky Mist low fat paneer sabji", grams: 110, kcal: 177, protein_g: 16.7, carb_g: 7, fat_g: 9.3,
    source: "manual", origin: "recipe", copied_from: "memory", recipe: SABJI,
  });
  const [out] = finishOrigins([sabji], "lunch was milky mist paneer sabji made of 60g paneer, onion and oil");
  assertEquals(out.grams, 105);
  assertEquals(out.recipe?.[0].grams, 60);
  assertEquals(out.recipe?.[2].grams, 5);
  // 60 g paneer + 40 g onion + 5 g oil, added up in code.
  assertEquals(Math.round(out.kcal), Math.round(108 + 16 + 44.2));
  // Whole-dish scaling would have read "60 g" as 60 g of sabji: 97 kcal.
  assertEquals(out.origin, "recipe");
});

Deno.test("finishOrigins: a weight that belongs to another card line leaves the recipe alone", () => {
  const sabji = line({ food_name: "Milky Mist low fat paneer sabji", grams: 110, kcal: 177, origin: "recipe", recipe: SABJI });
  const paneer = line({ food_name: "Paneer", grams: 60, kcal: 108, source: "catalog" });
  const [out] = finishOrigins([sabji, paneer], "sabji, and 60 g paneer");
  assertEquals(out.grams, 110);
});

Deno.test("preserveManual keeps a copied guess a guess through a correction", () => {
  const items = [line({ food_name: "Soyabean sabji", source: "catalog", grams: 30, kcal: 40 })];
  const prev = [{ food_id: null, food_name: "Soyabean sabji", quantity: 1, serving_label: "serving", grams: 15, kcal: 60,
    protein_g: 4, carb_g: 3, fat_g: 3, source: "manual" as const, origin: "guess" as const }];
  const [out] = preserveManual(items, prev);
  assertEquals([out.source, out.origin, out.copied_from], ["manual", "guess", "correction"]);
  // An old app sends no origin: the copy is unknown, never the user's own.
  const [old] = preserveManual(items, [{ ...prev[0], origin: undefined }]);
  assertEquals(old.origin, "unknown");
});

Deno.test("a saved meal's lines keep their own origin; saving is not typing", () => {
  const meal = {
    id: "m", name: "Lunch bowl", kind: "meal" as const, servings: 1, serving_label: null,
    kcal: 300, protein_g: 20, carb_g: 30, fat_g: 10,
    items: [
      { food_id: "f", food_name: "Rice", quantity: 1, serving_unit: "katori", grams: 150, kcal: 200, protein_g: 4, carb_g: 44, fat_g: 0.5, fiber_g: null, origin: "catalog" },
      { food_id: null, food_name: "Dal", quantity: 1, serving_unit: "katori", grams: 150, kcal: 100, protein_g: 6, carb_g: 15, fat_g: 1, fiber_g: null },
    ],
  };
  const [rice, dal] = savedMealLines({ meal, count: 1, mealType: null });
  assertEquals([rice.origin, rice.copied_from], ["catalog", "saved_meal"]);
  assertEquals(dal.origin, "unknown");
});

const entry = (o: Partial<MemoryEntry>): MemoryEntry => ({
  food_name: "Cocoa", food_id: null, kcal: 228, protein_g: 20, carb_g: 58, fat_g: 14, fiber_g: null,
  grams: 100, quantity: 100, serving_unit: "g", source: "catalog", logged_via: "ai", tier: "precise",
  logged_at: "2026-11-05T10:00:00Z", ...o,
});

Deno.test("memory trust by origin: a 'manual' copy no longer beats the catalog; the user's own numbers still win", () => {
  const now = new Date("2026-11-07T10:00:00Z");
  const entries = [
    entry({ kcal: 228, source: "catalog", logged_at: "2026-11-04T10:00:00Z" }),
    entry({ kcal: 400, source: "manual", logged_at: "2026-11-06T10:00:00Z" }),
  ];
  // Today's rule: "manual" ranks top, so the copied 400 wins.
  assertEquals(buildMemory(entries, "precise", now)[0].per100.kcal, 400);
  // By origin: the old 'manual' copy is unknown, below the catalog.
  assertEquals(buildMemory(entries, "precise", now, undefined, true)[0].per100.kcal, 228);
  const typed = [...entries, entry({ kcal: 250, source: "manual", origin: "user_typed", logged_at: "2026-11-03T10:00:00Z" })];
  assertEquals(buildMemory(typed, "precise", now, undefined, true)[0].per100.kcal, 250);
  assertEquals(entryOriginTrust({ origin: "label", tier: "precise" }) > entryOriginTrust({ origin: "catalog", tier: "precise" }), true);
  assertEquals(entryOriginTrust({ source: "manual", tier: "precise" }) < entryOriginTrust({ source: "catalog", tier: "fast" }), true);
});

Deno.test("memory: a recipe written into the name is one food", () => {
  assertEquals(
    memoryKey("Milky Mist low fat paneer sabji (20 g paneer, onion, oil)"),
    memoryKey("Milky Mist low fat paneer sabji (65 g paneer, onion, tomato, little oil)"),
  );
  const foods = buildMemory([
    entry({ food_name: "Milky Mist low fat paneer sabji (20 g paneer, onion, oil)", kcal: 125, source: "estimate" }),
    entry({ food_name: "Milky Mist low fat paneer sabji (65 g paneer, onion, tomato, little oil)", kcal: 133, source: "estimate", logged_at: "2026-11-06T10:00:00Z" }),
  ], "precise", new Date("2026-11-07T10:00:00Z"));
  assertEquals(foods.length, 1);
  assertEquals(foods[0].name, "Milky Mist low fat paneer sabji");
});
