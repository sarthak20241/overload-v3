// Run with: deno test --allow-all --unstable-sloppy-imports lib/yourFoods.test.ts
//
// lib/yourFoods.ts imports only lib/units.ts, which has no imports, so Deno
// tests it directly (sloppy imports resolve the extensionless path).

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  buildYourFoods, entryTrust, matchYourFoods, mergeYourFoods, portionText, yourFoodKey,
  type YourFoodEntry,
} from "./yourFoods.ts";
import { MASS_UNITS, VOLUME_UNITS } from "./units.ts";

const line = (name: string, over: Partial<YourFoodEntry> = {}): YourFoodEntry => ({
  food_id: null, food_name: name, serving_unit: "g", quantity: 100, grams_logged: 100,
  kcal: 100, protein_g: 10, carb_g: 10, fat_g: 2,
  fiber_g: null, sugar_g: null, sat_fat_g: null, sodium_mg: null,
  logged_via: "ai", source: "catalog", tier: "precise", logged_at: "2026-10-20T08:00:00Z",
  ...over,
});
const names = (list: { name: string }[]) => list.map((f) => f.name);

Deno.test("an AI line with no catalog id is found by name", () => {
  const foods = buildYourFoods([line("Chia seeds", { food_id: null, logged_via: "ai" })]);
  assertEquals(names(matchYourFoods(foods, "chia")), ["Chia seeds"]);
});

Deno.test("logged once is enough", () => {
  const foods = buildYourFoods([line("Kesar pista oats")]);
  assertEquals(foods.length, 1);
  assertEquals(foods[0].yours.times, 1);
});

Deno.test("case, punctuation and plurals are one food; extra words are not", () => {
  assertEquals(yourFoodKey("Cucumbers"), yourFoodKey("cucumber"));
  assertEquals(yourFoodKey("CUCUMBER"), yourFoodKey("cucumber"));
  assertEquals(yourFoodKey("Berries"), "berry");
  const foods = buildYourFoods([
    line("Cucumbers", { logged_at: "2026-10-01T08:00:00Z" }),
    line("cucumber", { logged_at: "2026-10-02T08:00:00Z" }),
    line("Cucumber, raw"),
    line("Milk"),
    line("Chocolate milk"),
  ]);
  assertEquals(foods.length, 4);
  const cucumber = foods.find((f) => f.key === "cucumber")!;
  assertEquals(cucumber.yours.times, 2);
  assertEquals(cucumber.name, "cucumber"); // the newest spelling is shown
});

Deno.test("trust: typed beats search pick and Precise, which beat Thorough, which beats Quick", () => {
  assertEquals(entryTrust({ logged_via: "manual", source: null, tier: null }), 4);
  assertEquals(entryTrust({ logged_via: "ai", source: "manual", tier: "fast" }), 4);
  assertEquals(entryTrust({ logged_via: null, source: null, tier: null }), 3);
  assertEquals(entryTrust({ logged_via: "ai", source: "catalog", tier: "precise" }), 3);
  assertEquals(entryTrust({ logged_via: "ai", source: "catalog", tier: "thorough" }), 2);
  assertEquals(entryTrust({ logged_via: "ai", source: "estimate", tier: "fast" }), 1);
  assertEquals(entryTrust({ logged_via: "ai", source: "catalog", tier: null }), 1);
});

Deno.test("a newer Quick guess does not replace the user's own numbers", () => {
  // The cucumber case from Drona's memory (2026-10-04): own 12.5 kcal/100 g,
  // later a Quick guess of 6.3.
  const foods = buildYourFoods([
    line("cucumber", { source: "manual", grams_logged: 200, quantity: 200, kcal: 25, logged_at: "2026-10-01T08:00:00Z" }),
    line("cucumber", { source: "estimate", tier: "fast", grams_logged: 100, quantity: 100, kcal: 6.3, logged_at: "2026-10-04T08:00:00Z" }),
  ]);
  assertAlmostEquals(foods[0].kcal, 12.5, 1e-9);
  assertEquals(foods[0].yours.estimate, false);
  // The portion is still last time's.
  assertEquals(foods[0].yours.quantity, 100);
  assertEquals(foods[0].yours.servingLabel, "g");
});

Deno.test("same trust: the newest numbers win", () => {
  const foods = buildYourFoods([
    line("paneer", { kcal: 250, logged_at: "2026-10-01T08:00:00Z" }),
    line("paneer", { kcal: 280, logged_at: "2026-10-05T08:00:00Z" }),
  ]);
  assertAlmostEquals(foods[0].kcal, 280, 1e-9);
});

Deno.test("an estimate is marked as one", () => {
  const foods = buildYourFoods([line("veggies", { source: "estimate", tier: "fast" })]);
  assertEquals(foods[0].yours.estimate, true);
});

Deno.test("portion: last time's count and unit, with that unit's weight", () => {
  const foods = buildYourFoods([
    line("Roti / chapati", { serving_unit: "roti", quantity: 2, grams_logged: 80, kcal: 240, logged_via: null, source: null, tier: null }),
  ]);
  const f = foods[0];
  assertEquals(f.yours.quantity, 2);
  assertEquals(f.yours.servingLabel, "roti");
  assertEquals(f.servings, [{ label: "roti", grams: 40, is_default: true }]);
  assertAlmostEquals(f.kcal, 300, 1e-9); // 240 kcal / 80 g
  // 2 roti x 40 g x 3 kcal/g = the 240 logged last time
  assertAlmostEquals(f.kcal * (f.servings[0].grams * f.yours.quantity) / 100, 240, 1e-9);
});

Deno.test("trusted numbers are put into the newest portion when both were weighed", () => {
  const foods = buildYourFoods([
    // Trusted: typed, 100 g = 120 kcal.
    line("dal", { source: "manual", serving_unit: "g", quantity: 100, grams_logged: 100, kcal: 120, logged_at: "2026-10-01T08:00:00Z" }),
    // Newest: 1 bowl of 200 g at a Quick 300 kcal.
    line("dal", { source: "estimate", tier: "fast", serving_unit: "bowl", quantity: 1, grams_logged: 200, kcal: 300, logged_at: "2026-10-03T08:00:00Z" }),
  ]);
  const f = foods[0];
  assertEquals(f.yours.servingLabel, "bowl");
  assertAlmostEquals(f.kcal, 120, 1e-9);
  assertEquals(f.servings[0].grams, 200);
});

Deno.test("a line with no weight keeps its numbers per unit", () => {
  // Drona knew a scoop of whey was 130 kcal without knowing what it weighed.
  const foods = buildYourFoods([
    line("whey", { serving_unit: "scoop", quantity: 1, grams_logged: null, kcal: 130 }),
  ]);
  const f = foods[0];
  assertEquals(f.servings, [{ label: "scoop", grams: 100, is_default: true }]);
  assertAlmostEquals(f.kcal, 130, 1e-9);
});

Deno.test("weightless trusted line with another unit: that line gives the portion too", () => {
  const foods = buildYourFoods([
    line("whey", { source: "manual", serving_unit: "scoop", quantity: 1, grams_logged: null, kcal: 120, logged_at: "2026-10-01T08:00:00Z" }),
    line("whey", { source: "estimate", tier: "fast", serving_unit: "g", quantity: 30, grams_logged: 30, kcal: 110, logged_at: "2026-10-03T08:00:00Z" }),
  ]);
  const f = foods[0];
  assertEquals(f.yours.servingLabel, "scoop");
  assertEquals(f.yours.quantity, 1);
  assertAlmostEquals(f.kcal, 120, 1e-9);
});

Deno.test("a measurement unit is not turned into a serving", () => {
  const foods = buildYourFoods([line("rice", { serving_unit: "g", quantity: 150, grams_logged: 150, kcal: 195 })]);
  assertEquals(foods[0].servings, []);
  assertEquals(foods[0].yours.servingLabel, "g");
  assertEquals(foods[0].yours.quantity, 150);
  assertAlmostEquals(foods[0].kcal, 130, 1e-9);
});

// What logFood would write for this food at its own portion: grams through
// the same unit tables (lib/foods resolveBaseAmount), times kcal per gram.
const relogKcal = (f: ReturnType<typeof buildYourFoods>[number]) => {
  const u = f.yours.servingLabel, q = f.yours.quantity;
  const sv = f.servings.find((s) => s.label.toLowerCase() === u.toLowerCase());
  const grams = sv ? sv.grams * q
    : u in MASS_UNITS ? q * MASS_UNITS[u]
    : q * VOLUME_UNITS[u] * (f.density_g_per_ml ?? 1);
  return f.kcal * grams / 100;
};

Deno.test("a cup re-logs the calories it was logged with", () => {
  // 1 cup of rice weighed 195 g: the table's 236.6 ml as water would log 21% more.
  const foods = buildYourFoods([line("rice", { serving_unit: "cup", quantity: 1, grams_logged: 195, kcal: 254 })]);
  assertEquals(foods[0].servings, []);
  assertEquals(foods[0].yours.servingLabel, "cup");
  assertAlmostEquals(relogKcal(foods[0]), 254, 1e-9);
});

Deno.test("a measurement unit with no weight is weighed by the unit tables", () => {
  // Was: 100 g per unit, so 150 "g" came out 100x too light per gram.
  const g = buildYourFoods([line("rice", { serving_unit: "g", quantity: 150, grams_logged: null, kcal: 195 })]);
  assertAlmostEquals(g[0].kcal, 130, 1e-9);
  assertAlmostEquals(relogKcal(g[0]), 195, 1e-9);
  const cup = buildYourFoods([line("dal", { serving_unit: "Cup", quantity: 1, grams_logged: null, kcal: 200 })]);
  assertEquals(cup[0].yours.servingLabel, "cup"); // the unit tables are lower case
  assertAlmostEquals(relogKcal(cup[0]), 200, 1e-9);
});

Deno.test("zero-calorie lines are left out", () => {
  assertEquals(buildYourFoods([line("whey", { kcal: 0 })]), []);
});

Deno.test("match: every typed word starts a word of the name", () => {
  const foods = buildYourFoods([line("Toned milk"), line("Chia seeds"), line("Milky Mist paneer"), line("Almonds")]);
  assertEquals(names(matchYourFoods(foods, "milk")), ["Toned milk", "Milky Mist paneer"]);
  assertEquals(names(matchYourFoods(foods, "chi se")), ["Chia seeds"]);
  assertEquals(names(matchYourFoods(foods, "seeds chia")), ["Chia seeds"]);
  assertEquals(matchYourFoods(foods, "lmond"), []); // middle of a word is not a match
  assertEquals(matchYourFoods(foods, "  "), []);
});

Deno.test("match order: whole name first, then by tier, then most logged", () => {
  const foods = buildYourFoods([
    line("Toned milk"), line("Toned milk"), line("Toned milk"),
    line("Milk"),
    line("Milk powder"),
  ]);
  // "Toned milk" and "Milk powder" both hold the whole word: the one logged more wins.
  assertEquals(names(matchYourFoods(foods, "milk")), ["Milk", "Toned milk", "Milk powder"]);
  const more = buildYourFoods([line("Oats"), line("Oat milk"), line("Oat milk")]);
  assertEquals(names(matchYourFoods(more, "oat")), ["Oats", "Oat milk"]); // "Oats" folds to "oat": whole name
});

Deno.test("match: a whole word beats the start of a longer word", () => {
  // Prod, 2026-10-31: "milk" listed four "Milky Mist" rows above Toned Milk.
  const foods = buildYourFoods([
    line("Milky Mist low fat paneer"), line("Milky Mist low fat paneer"), line("Milky Mist low fat paneer"),
    line("Toned Milk"), line("Toned Milk"),
    line("Country delight low fat milk"), line("Country delight low fat milk"), line("Country delight low fat milk"),
  ]);
  assertEquals(names(matchYourFoods(foods, "milk")), ["Country delight low fat milk", "Toned Milk", "Milky Mist low fat paneer"]);
  // Still typing: no whole word yet, so the most logged comes first.
  assertEquals(names(matchYourFoods(foods, "mil")), ["Milky Mist low fat paneer", "Country delight low fat milk", "Toned Milk"]);
});

Deno.test("portion text does not repeat the count in the label", () => {
  assertEquals(portionText({ quantity: 2, servingLabel: "roti" }), "2 roti");
  assertEquals(portionText({ quantity: 150, servingLabel: "g" }), "150 g");
  assertEquals(portionText({ quantity: 1, servingLabel: "100 g" }), "100 g");
  assertEquals(portionText({ quantity: 1, servingLabel: "1 serving (171 g)" }), "1 serving (171 g)");
  assertEquals(portionText({ quantity: 2, servingLabel: "1 roti" }), "2 roti");
  assertEquals(portionText({ quantity: 2, servingLabel: "100 g" }), "2 x 100 g");
  assertEquals(portionText({ quantity: 1.5, servingLabel: "scoop" }), "1.5 scoop");
  assertEquals(portionText({ quantity: 0.333333, servingLabel: "cup" }), "0.33 cup");
});

Deno.test("match keeps the limit", () => {
  const foods = buildYourFoods(Array.from({ length: 20 }, (_, i) => line(`Bar ${i}`)));
  assertEquals(matchYourFoods(foods, "bar", 8).length, 8);
});

Deno.test("merge: yours first, the catalog copy is not shown twice", () => {
  const mine = matchYourFoods(buildYourFoods([
    line("Banana", { food_id: "f-banana" }),
    line("Toned Milk"),
  ]), "ban");
  // only Banana matches "ban"
  assertEquals(names(mine), ["Banana"]);
  const merged = mergeYourFoods(mine, [
    { id: "f-banana", name: "Bananas, raw" },
    { id: null, name: "Bananas" },
    { id: "f-chips", name: "Banana chips" },
  ]);
  assertEquals(names(merged), ["Banana", "Banana chips"]);
  assert("yours" in merged[0]);
  assert(!("yours" in merged[1]));
});
