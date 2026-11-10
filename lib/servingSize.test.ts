// Run with: deno test lib/servingSize.test.ts
//
// lib/servingSize.ts has no imports, so Deno can test it directly. The unit
// check is a copy of the two tables' keys in lib/units.ts.

import { assertEquals } from "jsr:@std/assert@1";
import { fromPortion, toPortion, sizeForUnitChange, scaleServingNutrition, servingText, formatCount, fixWeightLabel } from "./servingSize.ts";

const UNITS = new Set(["g", "kg", "oz", "lb", "ml", "l", "cup", "tbsp", "tsp"]);
const isM = (u: string) => UNITS.has(u.trim().toLowerCase());

Deno.test("a gram line shows its grams: 15 g, not 15 x g", () => {
  // The reported sheet: "15 g" of cheese sauce showed Quantity 15, Amount 15.
  assertEquals(toPortion(15, "g", isM), { amount: 15, unit: "g" });
});

Deno.test("a number in the label folds into the amount when it is a plain size", () => {
  assertEquals(toPortion(2, "1 roti", isM), { amount: 2, unit: "roti" });
  assertEquals(toPortion(1.5, "100 g", isM), { amount: 150, unit: "g" });
  assertEquals(toPortion(3, "1/2 katori", isM), { amount: 1.5, unit: "katori" });
  assertEquals(toPortion(1, "0.50 cup", isM), { amount: 0.5, unit: "cup" });
  assertEquals(toPortion(3, "slice", isM), { amount: 3, unit: "slice" });
  assertEquals(toPortion(2, "1 medium (65 g)", isM), { amount: 2, unit: "medium (65 g)" });
});

Deno.test("a number that names the thing stays in the unit: 2 x 250 ml bottle", () => {
  // Folding it would read "500 ml bottle", one big bottle instead of two.
  assertEquals(toPortion(2, "250 ml bottle", isM), { amount: 2, unit: "250 ml bottle" });
  assertEquals(toPortion(1, "2 pc pack", isM), { amount: 1, unit: "2 pc pack" });
});

Deno.test("an untouched line saves back exactly as it came in", () => {
  for (const [q, l] of [[15, "g"], [2, "1 roti"], [3, "slice"], [1, "0.50 cup"], [2, "cup"],
    [1, "medium (65 g)"], [1.5, "100 g"], [3, "1/2 katori"], [2, "250 ml bottle"], [0.333, "100 g"]] as const) {
    const orig = { quantity: q, serving_label: l };
    const shown = toPortion(q, l, isM);
    // The editor shows the amount through a 3-decimal box and reads it back.
    const typed = { amount: Number(String(Math.round(shown.amount * 1000) / 1000)), unit: shown.unit };
    assertEquals(fromPortion(typed, orig, isM), orig, `${q} x ${l}`);
  }
});

Deno.test("a measurement is stored as its total: 150 g, not 1.5 x 100 g", () => {
  const orig = { quantity: 1.5, serving_label: "100 g" };
  assertEquals(fromPortion({ amount: 200, unit: "g" }, orig, isM), { quantity: 200, serving_label: "g" });
  assertEquals(fromPortion({ amount: 0.065, unit: "kg" }, { quantity: 1, serving_label: "1 roti" }, isM),
    { quantity: 0.065, serving_label: "kg" });
});

Deno.test("a new count of the same named serving keeps its exact label", () => {
  assertEquals(fromPortion({ amount: 3, unit: "roti" }, { quantity: 2, serving_label: "1 roti" }, isM),
    { quantity: 3, serving_label: "1 roti" });
  assertEquals(fromPortion({ amount: 3, unit: "250 ml bottle" }, { quantity: 2, serving_label: "250 ml bottle" }, isM),
    { quantity: 3, serving_label: "250 ml bottle" });
});

Deno.test("a folded named serving with a new amount is stored as amount + unit", () => {
  // 3 x "1/2 katori" (1.5 katori) changed to 2 katori: 2 "katori", not 4 x "1/2 katori".
  assertEquals(fromPortion({ amount: 2, unit: "katori" }, { quantity: 3, serving_label: "1/2 katori" }, isM),
    { quantity: 2, serving_label: "katori" });
  assertEquals(fromPortion({ amount: 2, unit: "tub" }, { quantity: 3, serving_label: "slice" }, isM),
    { quantity: 2, serving_label: "tub" });
});

Deno.test("a completed named-unit edit ignores temporary mass-unit text", () => {
  const gramsPerUnit = (u: string) => u === 'g' ? 1 : u === 'kg' ? 1000 : null;
  assertEquals(sizeForUnitChange(2, 1, 480, 'glass', 'QA glass', gramsPerUnit), 2);
  assertEquals(sizeForUnitChange(150, 1, 150, 'g', 'slice', gramsPerUnit), 1);
  assertEquals(sizeForUnitChange(1, 2, 140, 'roti', 'g', gramsPerUnit), 70);
  assertEquals(sizeForUnitChange(70, 2, 140, 'g', 'kg', gramsPerUnit), 0.07);
  assertEquals(sizeForUnitChange(100, 1.5, 150, 'g', 'g', gramsPerUnit), 100);
});

Deno.test("serving chip round trips retain the full precision snapshot", () => {
  const original = { kcal: 300, protein: 6.7, carb: 28.1, fat: 8.3 };
  const small = scaleServingNutrition(original, 100 / 250);
  const restored = scaleServingNutrition(small, 250 / 100);
  const doubled = scaleServingNutrition(restored, 2);
  assertEquals(Math.round(small.protein * 10) / 10, 2.7);
  assertEquals(Math.round(doubled.protein * 10) / 10, 13.4);
  assertEquals(Math.round(doubled.carb * 10) / 10, 56.2);
  assertEquals(doubled.kcal, 600);
});

Deno.test("a small part of a 100 g serving reads as grams, not 0 x 100 g", () => {
  // The reported day list: 0.04 of a "100 g" whey serving showed "0 x 100 g".
  assertEquals(servingText(0.04, "100 g", isM), "4 g");
  assertEquals(servingText(0.16, "100 g", isM), "16 g");
  assertEquals(servingText(1.5, "100 g", isM), "150 g");
  assertEquals(servingText(1, "100 g", isM), "100 g");
  assertEquals(servingText(0.5, "250 ml", isM), "125 ml");
});

Deno.test("a small part of a named serving keeps two places instead of reading 0", () => {
  assertEquals(servingText(0.04, "1 scoop", isM), "0.04 × 1 scoop");
  assertEquals(servingText(0.25, "bowl", isM), "0.25 × bowl");
  assertEquals(servingText(0.001, "bowl", isM), "<0.01 × bowl");
});

Deno.test("ordinary portions read as before", () => {
  assertEquals(servingText(150, "g", isM), "150 g");
  assertEquals(servingText(2, "bowl", isM), "2 × bowl");
  assertEquals(servingText(1, "1 large egg", isM), "1 large egg");
  assertEquals(servingText(1.25, "roti", isM), "1.3 × roti");
  assertEquals(formatCount(0), "0");
});

Deno.test("a weight label whose quantity is already the grams reads as the grams", () => {
  // The reported card: "18g casein" came back as 18 x "100 g" with 18 g behind it.
  assertEquals(fixWeightLabel(18, "100 g", 18), { quantity: 18, serving_label: "g" });
  assertEquals(fixWeightLabel(0.75, "100 g", 184), { quantity: 184, serving_label: "g" });
  assertEquals(fixWeightLabel(250, "250 ml", 250), { quantity: 250, serving_label: "ml" });
});

Deno.test("a bare gram line follows its grams, as the server's check does", () => {
  // 130 g of rice came back 100 "g" (decide's quantity is capped at 100).
  assertEquals(fixWeightLabel(100, "g", 130), { quantity: 130, serving_label: "g" });
  assertEquals(fixWeightLabel(100, "ml", 250), { quantity: 250, serving_label: "ml" });
  // A liquid a little off its ml is density.
  assertEquals(fixWeightLabel(15, "ml", 13.8), { quantity: 15, serving_label: "ml" });
});

Deno.test("a weight label that agrees with its grams is left alone", () => {
  assertEquals(fixWeightLabel(1.5, "100 g", 150), { quantity: 1.5, serving_label: "100 g" });
  assertEquals(fixWeightLabel(1, "250 ml", 258), { quantity: 1, serving_label: "250 ml" });
  assertEquals(fixWeightLabel(2, "1 roti", 80), { quantity: 2, serving_label: "1 roti" });
  assertEquals(fixWeightLabel(15, "g", 15), { quantity: 15, serving_label: "g" });
  // No grams to check against: nothing to go on.
  assertEquals(fixWeightLabel(18, "100 g", 0), { quantity: 18, serving_label: "100 g" });
});
