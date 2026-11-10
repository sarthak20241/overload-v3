// Run with: deno test --allow-all supabase/functions/ai-coach/servingCount.test.ts
//
// A label serving that names a count and a weight is a GROUP: "2 slices (50 g)"
// is two slices, 25 g each. Live, 2026-11-07: a protein bread label of two
// slices at 50 g was stored as one slice = 50 g, and the user's 2 slices became
// 100 g and 242 kcal (truth: 50 g, 121 kcal). Nothing here calls a model.

import { assertEquals } from "jsr:@std/assert@1";
import { type ParsedItem, perOneServing, servingCount, unitWeightMatchesGrams } from "./parseMeal.ts";

Deno.test("servingCount: the count and the weight, wherever the count sits", () => {
  assertEquals(servingCount("2 slices (50 g)"), { count: 2, noun: "slices", grams: 50, perUnit: 25 });
  assertEquals(servingCount("3 biscuits (30 g)"), { count: 3, noun: "biscuits", grams: 30, perUnit: 10 });
  assertEquals(servingCount("1 scoop (30 g)"), { count: 1, noun: "scoop", grams: 30, perUnit: 30 });
  assertEquals(servingCount("50 g (2 slices)")?.perUnit, 25);
  assertEquals(servingCount("1 serving (2 slices, 50 g)")?.perUnit, 25);
  assertEquals(servingCount("Serving size: 2 slices = 50g")?.perUnit, 25);
  assertEquals(servingCount("per 3 biscuits (30 g)")?.perUnit, 10);
  assertEquals(servingCount("2 large eggs (100 g)")?.noun, "eggs");
  // No printed weight: the serving's own grams.
  assertEquals(servingCount("2 slices", 60)?.perUnit, 30);
});

Deno.test("servingCount: amounts and words that are not pieces are not counts", () => {
  for (const label of ["100 g", "1/2 cup (120 g)", "2 cups (300 g)", "2 tbsp (30 g)", "1 serving (100 g)", "12 count box (400 g)", "120 kcal (30 g)", "10 inch (400 g)"]) {
    assertEquals(servingCount(label), null, label);
  }
  assertEquals(servingCount("2 slices"), null, "no weight at all");
});

Deno.test("perOneServing: a count inside the label is a group too", () => {
  assertEquals(perOneServing({ label: "1 serving (2 slices, 50 g)", grams: 50 }), { label: "1 slice", grams: 25 });
  assertEquals(perOneServing({ label: "50 g (2 slices)", grams: 50 }), { label: "1 slice", grams: 25 });
  assertEquals(perOneServing({ label: "Serving size: 2 slices = 50g", grams: 50 }), { label: "1 slice", grams: 25 });
  // The leading-count shape is unchanged.
  assertEquals(perOneServing({ label: "2 slices (50 g)", grams: 50 }), { label: "1 slice", grams: 25 });
  // A text whose weight is not the serving's is not this serving.
  assertEquals(perOneServing({ label: "1 serving (2 slices, 50 g)", grams: 80 }), { label: "1 serving (2 slices, 50 g)", grams: 80 });
  // One piece already, and measures, stay.
  assertEquals(perOneServing({ label: "1 scoop (30 g)", grams: 30 }), { label: "1 scoop (30 g)", grams: 30 });
  assertEquals(perOneServing({ label: "1 cup (2 slices)", grams: 60 }), { label: "1 cup (2 slices)", grams: 60 });
});

const line = (o: Partial<ParsedItem>): ParsedItem => ({
  food_id: null, food_name: "Health Factory protein bread", quantity: 2, serving_label: "slice (25 g)", grams: 100,
  kcal: 242, protein_g: 28, carb_g: 26, fat_g: 4.4, fiber_g: null, source: "web", assumption: null, confidence: "high",
  ...o,
});

Deno.test("unitWeightMatchesGrams: 2 x slice (25 g) weighs 50 g, macros scaled with it", () => {
  const out = unitWeightMatchesGrams(line({}));
  assertEquals([out.quantity, out.serving_label, out.grams, out.kcal, out.protein_g, out.carb_g, out.fat_g], [2, "slice (25 g)", 50, 121, 14, 13, 2.2]);
});

Deno.test("unitWeightMatchesGrams: a group label is never guessed at", () => {
  // 2 x "2 slices (50 g)" at 100 g: 2 servings, or 2 slices counted twice?
  // The line cannot say, so it stays.
  const two = line({ serving_label: "2 slices (50 g)", grams: 100 });
  assertEquals(unitWeightMatchesGrams(two), two);
  // 1 x the group at 50 g is right already, and stays as written.
  const one = line({ quantity: 1, serving_label: "2 slices (50 g)", grams: 50, kcal: 121 });
  assertEquals(unitWeightMatchesGrams(one), one);
  // 2 slices at 50 g against the group label: restated per slice, numbers unchanged.
  const per = unitWeightMatchesGrams(line({ serving_label: "2 slices (50 g)", grams: 50, kcal: 121 }));
  assertEquals([per.quantity, per.serving_label, per.grams, per.kcal], [2, "slice (25 g)", 50, 121]);
});

Deno.test("unitWeightMatchesGrams: a serving or a measure proves no piece weight", () => {
  const sv = line({ quantity: 2, serving_label: "serving (15 g)", grams: 60, kcal: 66 });
  assertEquals(unitWeightMatchesGrams(sv), sv);
  const tbsp = line({ quantity: 2, serving_label: "tbsp (17 g)", grams: 68, kcal: 75 });
  assertEquals(unitWeightMatchesGrams(tbsp), tbsp);
});

Deno.test("unitWeightMatchesGrams: lines that already agree, and labels it does not read, stay", () => {
  for (const it of [
    line({ grams: 50, kcal: 121 }),
    line({ quantity: 3, serving_label: "biscuits (10 g each)", grams: 30 }),
    line({ quantity: 1, serving_label: "scoop (31 g)", grams: 31 }),
    line({ quantity: 2, serving_label: "slices (25 g total)", grams: 25 }),
    line({ quantity: 30, serving_label: "g", grams: 30 }),
    line({ quantity: 1, serving_label: "serving", grams: 80 }),
    // A weight the user gave against a unit's weight: not a whole multiple.
    line({ quantity: 1, serving_label: "bowl (250 g)", grams: 150 }),
    // Numbers the user stated.
    line({ source: "manual" }),
  ]) {
    assertEquals(unitWeightMatchesGrams(it), it, it.serving_label);
  }
});

// ── The reader's count (2026-11-07 follow-up) ───────────────────────────────
// The page reader copies the printed count and piece word beside the serving's
// grams; code divides. The text reading above is the fallback.

import { servingsFromFinding } from "./parseMeal.ts";

Deno.test("servingsFromFinding: the reader's count makes one piece, the code divides", () => {
  assertEquals(
    servingsFromFinding({ serving_label: "1 serving (50 g)", serving_grams: 50, serving_count: 2, serving_unit: "slices" }),
    [{ label: "1 slice", grams: 25 }],
  );
  assertEquals(
    servingsFromFinding({ serving_label: "30 g", serving_grams: 30, serving_count: 3, serving_unit: "biscuit" }),
    [{ label: "1 biscuit", grams: 10 }],
  );
});

Deno.test("servingsFromFinding: no count, a measure, or no grams keeps the printed serving", () => {
  assertEquals(servingsFromFinding({ serving_label: "2 slices (50 g)", serving_grams: 50 }), [{ label: "2 slices (50 g)", grams: 50 }]);
  assertEquals(servingsFromFinding({ serving_label: "2 cups (300 g)", serving_grams: 300, serving_count: 2, serving_unit: "cups" }), [{ label: "2 cups (300 g)", grams: 300 }]);
  assertEquals(servingsFromFinding({ serving_label: "1 bar", serving_grams: null, serving_count: 1, serving_unit: "bar" }), []);
});
