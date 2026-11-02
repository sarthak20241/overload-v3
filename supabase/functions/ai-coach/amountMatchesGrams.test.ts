// Run with: deno test --allow-all supabase/functions/ai-coach/amountMatchesGrams.test.ts
//
// quantity x serving_label is what the food card prints. These are the live
// lines (parse_traces, 2026-09 to 2026-11) where it disagreed with the grams.

import { assertEquals } from "jsr:@std/assert@1";
import { amountMatchesGrams, type ParsedItem } from "./parseMeal.ts";

const line = (quantity: number, serving_label: string, grams: number): ParsedItem => ({
  food_id: null, food_name: "food", quantity, serving_label, grams,
  kcal: 100, protein_g: 1, carb_g: 1, fat_g: 1, fiber_g: null,
  source: "catalog", assumption: null, confidence: "high",
} as ParsedItem);
const amount = (it: ParsedItem) => [it.quantity, it.serving_label, it.grams];

Deno.test("grams written as the count of a '100 g' serving read as grams", () => {
  assertEquals(amount(amountMatchesGrams(line(30, "100 g", 30))), [30, "g", 30]);   // peanuts
  assertEquals(amount(amountMatchesGrams(line(100, "100 g", 130))), [130, "g", 130]); // rice, quantity capped at 100
  assertEquals(amount(amountMatchesGrams(line(0.75, "100 g", 184))), [184, "g", 184]); // kulcha
});

Deno.test("grams written as both the count and the label read as grams", () => {
  assertEquals(amount(amountMatchesGrams(line(4, "4 g", 4))), [4, "g", 4]);    // chia, read "16 g"
  assertEquals(amount(amountMatchesGrams(line(25, "25 g", 25))), [25, "g", 25]); // oats, read "625 g"
});

Deno.test("a bare gram line follows its grams", () => {
  assertEquals(amount(amountMatchesGrams(line(100, "g", 130))), [130, "g", 130]);
});

Deno.test("lines that already agree are left exactly as they are", () => {
  for (const [q, l, g] of [
    [1, "250 g", 250], [1.5, "100 g", 150], [13, "g", 13], [250, "ml", 250],
    [1, "250 ml", 258], [2, "1 large", 100], [1, "1 scoop (31 g)", 31], [3, "fork", 60],
  ] as const) {
    assertEquals(amount(amountMatchesGrams(line(q, l, g))), [q, l, g], `${q} x ${l}`);
  }
});

Deno.test("a liquid a little off its ml is density, not a wrong amount", () => {
  assertEquals(amount(amountMatchesGrams(line(15, "ml", 13.8))), [15, "ml", 13.8]);
});

Deno.test("no grams means nothing to check against", () => {
  assertEquals(amount(amountMatchesGrams(line(30, "100 g", 0))), [30, "100 g", 0]);
});
