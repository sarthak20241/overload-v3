// Run with: deno test --allow-all supabase/functions/ai-coach/pieceCount.test.ts
//
// Reproduced on production 2026-08-28, Fast mode, logged in parse_traces:
//
//   "2 oreo biscuits and 1 amul cheese slice"
//     -> Oreo Sandwich Biscuit: quantity 2, serving_label "100 g", 200 g, 966 kcal
//     -> Amul Cheese Slice A:   quantity 1, serving_label "100 g", 100 g, 316 kcal
//
// True answers are ~22 g / ~105 kcal and ~20 g / ~63 kcal, so the card was ~9x
// and ~5x high. The count was multiplied against the row's per-100 BASIS
// serving, which states a mass and not a portion. Smart mode never shows this
// because buildDecideSystemPrompt carries the household piece weights; Fast
// skips the decide call, so the refusal has to live in the conversion itself.

import { assertEquals } from "jsr:@std/assert@1";
import {
  type CandidateFood,
  fallbackFromResolved,
  gramsPerUnit,
  isBareMassLabel,
  type Per100,
  type ResolvedItem,
} from "./parseMeal.ts";

function row(servings: { label: string; grams: number; is_default?: boolean }[]): CandidateFood {
  return {
    food_id: "f1",
    name: "Oreo Sandwich Biscuit",
    brand: "Oreo",
    base_unit: "g",
    kcal: 483,
    protein_g: 4.8,
    carb_g: 71,
    fat_g: 20,
    fiber_g: 2.5,
    servings,
    source: "catalog",
  };
}

Deno.test("bare mass labels are recognised, portion labels are not", () => {
  for (const l of ["100 g", "100g", " 100 G ", "per 100 g", "100 ml", "30 g", "250ml"]) {
    assertEquals(isBareMassLabel(l), true, l);
  }
  for (const l of ["1 cookie (11 g)", "1 slice", "1 katori", "2 pieces", "1 scoop (30 g)", "packet (55 g)"]) {
    assertEquals(isBareMassLabel(l), false, l);
  }
});

Deno.test("a piece count against a 100 g-only row refuses instead of multiplying", () => {
  // THE BUG. Every one of these used to return { grams: 100 }, so quantity 2
  // became 200 g of biscuit.
  const only100 = row([{ label: "100 g", grams: 100, is_default: true }]);
  assertEquals(gramsPerUnit("", only100), null);
  assertEquals(gramsPerUnit("serving", only100), null);
  assertEquals(gramsPerUnit("servings", only100), null);
  assertEquals(gramsPerUnit("piece", only100), null);
  assertEquals(gramsPerUnit("pieces", only100), null);
  // The word the user actually typed has no anchor on this row either.
  assertEquals(gramsPerUnit("biscuit", only100), null);
  assertEquals(gramsPerUnit("slice", only100), null);
});

Deno.test("a genuine mass input is unaffected by the refusal", () => {
  // "200 g oreo" must still convert: 1 g per unit, quantity carries the amount.
  const only100 = row([{ label: "100 g", grams: 100, is_default: true }]);
  assertEquals(gramsPerUnit("g", only100), { grams: 1, label: "g" });
  assertEquals(gramsPerUnit("grams", only100), { grams: 1, label: "g" });
  assertEquals(gramsPerUnit("gm", only100), { grams: 1, label: "g" });
  const liquid = { ...only100, base_unit: "ml" as const };
  assertEquals(gramsPerUnit("ml", liquid), { grams: 1, label: "ml" });
});

Deno.test("a real per-piece serving still converts", () => {
  const withPiece = row([{ label: "1 cookie (11 g)", grams: 11, is_default: true }]);
  assertEquals(gramsPerUnit("", withPiece), { grams: 11, label: "1 cookie (11 g)" });
  assertEquals(gramsPerUnit("serving", withPiece), { grams: 11, label: "1 cookie (11 g)" });
});

Deno.test("a portion serving wins over a default 100 g basis on the same row", () => {
  // FatSecret v4 adds "100 g" (serving_id 0) to branded foods and can mark it
  // default, which used to bury the real cookie serving sitting next to it.
  const both = row([
    { label: "100 g", grams: 100, is_default: true },
    { label: "1 cookie (11 g)", grams: 11 },
  ]);
  assertEquals(gramsPerUnit("serving", both), { grams: 11, label: "1 cookie (11 g)" });
  // The named anchor path was always fine and must stay fine.
  assertEquals(gramsPerUnit("cookie", both), { grams: 11, label: "1 cookie (11 g)" });
});

Deno.test("a row with no servings at all still refuses", () => {
  assertEquals(gramsPerUnit("serving", row([])), null);
  assertEquals(gramsPerUnit("", row([{ label: "100 g", grams: 0 }])), null);
});

// ── fallbackFromResolved ────────────────────────────────────────────────────
// The second path to the same wrong number. It runs when there is no
// acceptable row AND no usable estimate (Fast), or when decide dropped a food
// it had already resolved (Smart). It multiplied the same 100 g basis serving
// by the same count, so a dropped "2 oreo biscuits" landed at 200 g too.

const OREO_PER100: Per100 = {
  kcal: 483,
  protein_g: 4.8,
  carb_g: 71,
  fat_g: 20,
  fiber_g: 2.5,
};

function resolved(over: Partial<ResolvedItem>): ResolvedItem {
  return {
    name: "oreo biscuits",
    brand: null,
    quantity: 2,
    unit: "serving",
    prep: null,
    est: null,
    candidates: [row([{ label: "100 g", grams: 100, is_default: true }])],
    ...over,
  };
}

const per100Map = () => new Map<string, Per100>([["f1", OREO_PER100]]);

Deno.test("fallback: a piece count does not multiply a 100 g basis serving", () => {
  const it = fallbackFromResolved(resolved({}), per100Map());
  // Used to be 200 g / 966 kcal.
  assertEquals(it.grams, 100);
  assertEquals(it.quantity, 2);
});

Deno.test("fallback: the model's gram estimate wins and is not re-multiplied", () => {
  const it = fallbackFromResolved(
    resolved({ est: { kcal: 483, protein_g: 4.8, carb_g: 71, fat_g: 20, total_g: 22 } }),
    per100Map(),
  );
  // est.total_g already covers BOTH biscuits, so 22 g, not 44 g.
  assertEquals(it.grams, 22);
  assertEquals(it.kcal, 106.3);
});

Deno.test("fallback: a real per-piece serving still multiplies by the count", () => {
  const it = fallbackFromResolved(
    resolved({ candidates: [row([{ label: "1 cookie (11 g)", grams: 11, is_default: true }])] }),
    per100Map(),
  );
  assertEquals(it.grams, 22);
});

Deno.test("fallback: a genuine mass input is untouched", () => {
  const it = fallbackFromResolved(resolved({ unit: "g", quantity: 200 }), per100Map());
  assertEquals(it.grams, 200);
});

Deno.test("fallback: an absurd model estimate is capped, not trusted", () => {
  const it = fallbackFromResolved(
    resolved({ est: { kcal: 483, protein_g: 4.8, carb_g: 71, fat_g: 20, total_g: 999999 } }),
    per100Map(),
  );
  assertEquals(it.grams, 5000);
});
