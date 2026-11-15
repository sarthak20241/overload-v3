// Run with: deno test --allow-all supabase/functions/ai-coach/typedWeight.test.ts
//
// A weight the user types next to a count ("2 slices (~50 g)") is the line's
// weight. From a real log (2026-11-15): "The Health Factory Multi-Protein
// Bread - 2 slices (~50 g)" with "Per 100 g: 265 kcal". The extract form had
// no place for the 50 g, so Quick put it in label_serving_g with 1 piece per
// serving, the label chain did 2 x 50, and the card said 100 g, 265 kcal.
// Precise got 50 g only because its model picked the line total.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { readStated, readTypedWeight } from "./statedNumbers.ts";
import {
  type ExtractedItem,
  EXTRACT_TOOL_FOR_TEST,
  FAST_EXTRACT_TOOL_FOR_TEST,
  honourStatedTotals,
  lineEstimate,
  type ParsedItem,
  statedFor,
  statedQuickItem,
} from "./parseMeal.ts";

const near = (a: number, b: number, tol: number, what: string) => assert(Math.abs(a - b) <= tol, `${what}: ${a}, want ${b}`);

// ── reading the field ───────────────────────────────────────────────────────

Deno.test("typed weight: a total for the line is the line's grams", () => {
  assertEquals(readTypedWeight({ grams: 50, per: "total" }, 2, "slice"), 50);
});

Deno.test("typed weight: a weight for each piece is multiplied in code", () => {
  assertEquals(readTypedWeight({ grams: 25, per: "each" }, 2, "slice"), 50);
});

Deno.test("typed weight: a g or ml unit already is the weight, so the field is ignored", () => {
  assertEquals(readTypedWeight({ grams: 50, per: "total" }, 100, "g"), null);
  assertEquals(readTypedWeight({ grams: 50, per: "total" }, 200, "ml"), null);
});

Deno.test("typed weight: nothing, junk or a weight past any portion reads as none", () => {
  assertEquals(readTypedWeight(null, 2, "slice"), null);
  assertEquals(readTypedWeight({ grams: 0, per: "total" }, 2, "slice"), null);
  assertEquals(readTypedWeight({ grams: "50", per: "total" }, 2, "slice"), null);
  assertEquals(readTypedWeight({ grams: 9000, per: "total" }, 2, "slice"), null);
  assertEquals(readTypedWeight({ grams: 3000, per: "each" }, 2, "slice"), null);
});

// ── the schema carries the field in both modes ──────────────────────────────

Deno.test("typed weight: Precise and Quick extract forms both have the field", () => {
  for (const tool of [EXTRACT_TOOL_FOR_TEST, FAST_EXTRACT_TOOL_FOR_TEST]) {
    const props = (tool as any).input_schema.properties.items.items.properties;
    assert(props.typed_weight, `${(tool as any).name} has typed_weight`);
    assertEquals(props.typed_weight.properties.per.enum, ["total", "each"]);
  }
});

// ── the real log, Quick ─────────────────────────────────────────────────────

const breadPer100 = readStated({ basis: "per_100g", kcal: 265, protein_g: 20.8, carb_g: 41.6, fat_g: 1.8 })!;

// What the Quick model sent in production: the line weight in the label slot.
const prodLabel = { applies: true, serving_g: 50, serving_kcal: 133, pieces: 1 };
const prodEst = { kcal: 133, protein_g: 10.4, carb_g: 20.8, fat_g: 0.9, total_g: 50 };

Deno.test("Quick, real log: a typed weight keeps the label chain off, the line is 50 g", () => {
  const { est, chained } = lineEstimate(2, "slice", prodEst, prodLabel, 50, breadPer100);
  assertEquals(chained, false);
  assertEquals(est!.total_g, 50);
  near(est!.kcal, 133, 0.5, "kcal");
});

Deno.test("Quick: user numbers alone keep the label chain off too", () => {
  const { chained } = lineEstimate(2, "slice", prodEst, prodLabel, null, breadPer100);
  assertEquals(chained, false);
});

Deno.test("Quick: no weight and no numbers, the label chain still runs (no change)", () => {
  const est = { kcal: 120, protein_g: 1.1, carb_g: 14.3, fat_g: 6.4, total_g: 22.5 };
  const out = lineEstimate(3, "piece", est, { applies: true, serving_g: 30, serving_kcal: 160, pieces: 4 }, null, null);
  assertEquals(out.chained, true);
  near(out.est!.total_g, 22.5, 0.01, "grams");
});

Deno.test("Quick: the model's estimate is moved to the typed weight, density kept", () => {
  // The model guessed 80 g for 2 slices at 212 kcal; the user said 50 g.
  const { est } = lineEstimate(2, "slice", { kcal: 212, protein_g: 16, carb_g: 33, fat_g: 1.5, total_g: 80 }, { applies: false, serving_g: null, serving_kcal: null, pieces: null }, 50, null);
  assertEquals(est!.total_g, 50);
  near(est!.kcal, 132.5, 0.1, "kcal");
  near(est!.protein_g, 10, 0.01, "protein");
});

const bread = (extra: Partial<ExtractedItem>): ExtractedItem => ({
  name: "multi-protein bread",
  brand: "The Health Factory",
  quantity: 2,
  unit: "slice",
  prep: null,
  ...extra,
});

Deno.test("Quick, real log: per-100 numbers scale by the typed 50 g, not the model's grams", () => {
  // The est here is what the label chain left in production: 100 g.
  const it = bread({ stated: breadPer100, typedGrams: 50, est: { kcal: 266, protein_g: 20.8, carb_g: 41.6, fat_g: 1.8, total_g: 100 } });
  const line = statedQuickItem(statedFor(it)!, it)!;
  assertEquals(line.grams, 50);
  near(line.kcal, 132.5, 0.1, "kcal");
  assertEquals(line.quantity, 2);
  assertEquals(line.serving_label, "slice");
});

Deno.test("a line total with a typed weight becomes per-100 numbers", () => {
  const total = readStated({ basis: "total", kcal: 133, protein_g: 10.4, carb_g: 20.8, fat_g: 0.9 })!;
  const s = statedFor(bread({ stated: total, typedGrams: 50 }))!;
  assert(s, "statedFor reads it");
  near(s.kcal, 266, 0.1, "kcal per 100 g");
});

// ── every tier: the final pass ──────────────────────────────────────────────

const line = (over: Partial<ParsedItem>): ParsedItem => ({
  food_id: "x",
  food_name: "Multi-Protein Bread",
  quantity: 2,
  serving_label: "slice",
  grams: 80,
  kcal: 212,
  protein_g: 16.6,
  carb_g: 33.3,
  fat_g: 1.4,
  fiber_g: null,
  source: "catalog",
  confidence: "medium",
  ...over,
} as ParsedItem);

Deno.test("Precise: a line whose grams came from a lookup is moved to the typed weight", () => {
  const steps: any[] = [];
  const out = honourStatedTotals(
    [line({})],
    { meal: null, lines: [], weights: [{ name: "multi-protein bread", correctsFoodName: null, grams: 50 }] },
    steps,
  )!;
  assert(out, "changed");
  assertEquals(out[0].grams, 50);
  near(out[0].kcal, 132.5, 0.1, "kcal");
  assertEquals(out[0].quantity, 2);
  assertEquals(out[0].serving_label, "slice");
});

Deno.test("Precise: a weight in the label that no longer holds is dropped", () => {
  const out = honourStatedTotals(
    [line({ serving_label: "slice (40 g)" })],
    { meal: null, lines: [], weights: [{ name: "multi-protein bread", correctsFoodName: null, grams: 50 }] },
    [],
  )!;
  assertEquals(out[0].serving_label, "slice");
});

Deno.test("a line already at the typed weight is left alone", () => {
  const out = honourStatedTotals(
    [line({ grams: 50, kcal: 133 })],
    { meal: null, lines: [], weights: [{ name: "multi-protein bread", correctsFoodName: null, grams: 50 }] },
    [],
  );
  assertEquals(out, null);
});
