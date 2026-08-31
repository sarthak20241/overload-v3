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
  applyLabelChain,
  type CandidateFood,
  fallbackFromResolved,
  gramsPerUnit,
  isBasisServing,
  namesAPiece,
  type Per100,
  type ServingOption,
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

Deno.test("basis servings are recognised, real portions are not", () => {
  const sv = (label: string, grams: number): ServingOption => ({ label, grams });
  // Shape 1: the label IS the amount. Caught whatever the number is.
  for (const l of ["100 g", "100g", " 100 G ", "per 100 g", "100 ml", "30 g", "250ml", "100 gm"]) {
    assertEquals(isBasisServing(sv(l, 100)), true, l);
  }
  // Shape 2: the per-100 basis dressed up as a generic serving. Review note on
  // PR #127 - OFF passes contributor free text straight through as the label,
  // so this shape is reachable today.
  for (const l of ["1 serving (100 g)", "serving (100g)", "per serving - 100 g", "1 portion (100 ml)"]) {
    assertEquals(isBasisServing(sv(l, 100)), true, l);
  }
  // A real portion is never a basis, however it is spelled.
  for (const l of ["1 cookie (11 g)", "1 slice", "1 katori", "2 pieces", "1 scoop (30 g)", "packet (55 g)"]) {
    assertEquals(isBasisServing(sv(l, 11)), false, l);
  }
  // A NAMED amount that is not the per-100 basis is a real pack portion, so
  // the generic-wrapper rule must not swallow it.
  assertEquals(isBasisServing(sv("1 serving (30 g)", 30)), false);
  assertEquals(isBasisServing(sv("2 biscuits (22 g)", 22)), false);
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

Deno.test("fallback: a MEASURED portion beats the model's free-text estimate", () => {
  // Review note on PR #127: est.total_g must not outrank a real catalog
  // serving. 2 x 11 g of measured cookie, not the model's 40 g guess.
  const it = fallbackFromResolved(
    resolved({
      candidates: [row([
        { label: "100 g", grams: 100, is_default: true },
        { label: "1 cookie (11 g)", grams: 11 },
      ])],
      est: { kcal: 483, protein_g: 4.8, carb_g: 71, fat_g: 20, total_g: 40 },
    }),
    per100Map(),
  );
  assertEquals(it.grams, 22);
});

Deno.test("fallback: a genuine mass input is untouched", () => {
  const it = fallbackFromResolved(resolved({ unit: "g", quantity: 200 }), per100Map());
  assertEquals(it.grams, 200);
});

Deno.test("fallback: every MASS_UNITS spelling counts as a mass, not a count", () => {
  // Review note on PR #127: the old inline check listed only g/ml/gram/grams,
  // so "2 gm" was read as two PIECES and multiplied by the 100 g basis.
  for (const u of ["g", "gm", "gms", "gram", "grams", "ml", "millilitre", "milliliter"]) {
    assertEquals(fallbackFromResolved(resolved({ unit: u, quantity: 200 }), per100Map()).grams, 200, u);
  }
});

Deno.test("fallback: an absurd model estimate is capped, not trusted", () => {
  const it = fallbackFromResolved(
    resolved({ est: { kcal: 483, protein_g: 4.8, carb_g: 71, fat_g: 20, total_g: 999999 } }),
    per100Map(),
  );
  assertEquals(it.grams, 5000);
});

Deno.test("fallback: the displayed label is the one that drove the grams", () => {
  // Review note on PR #127: the card printed "2 x serving" against grams
  // derived from "1 cookie (11 g)", so quantity x serving_label did not read
  // back as grams.
  const it = fallbackFromResolved(
    resolved({ candidates: [row([{ label: "1 cookie (11 g)", grams: 11, is_default: true }])] }),
    per100Map(),
  );
  assertEquals(it.serving_label, "1 cookie (11 g)");
  assertEquals(it.quantity, 2);
  assertEquals(it.grams, 22);
  // A mass input keeps the user's own unit, not a serving label.
  assertEquals(fallbackFromResolved(resolved({ unit: "g", quantity: 200 }), per100Map()).serving_label, "g");
});

Deno.test("a dressed-up 100 g basis does not resolve a piece count either", () => {
  // The regression the review flagged: "1 serving (100 g)" used to look like a
  // real portion, so "2 oreo biscuits" was back to 200 g on that row.
  const dressed = row([{ label: "1 serving (100 g)", grams: 100, is_default: true }]);
  assertEquals(gramsPerUnit("serving", dressed), null);
  assertEquals(gramsPerUnit("", dressed), null);
  assertEquals(
    fallbackFromResolved(resolved({ candidates: [dressed] }), per100Map()).grams,
    100,
  );
});

Deno.test("an unnamed portion is not a piece, so a count must not multiply it", () => {
  // Parle Monaco Classic Biscuits ships "1 serving (14.4 g)" - roughly three
  // crackers, not one. "3 monaco biscuits" logged 43.2 g against a true ~13 g.
  // The label never claims to describe one biscuit, so the count has nothing
  // safe to multiply and the caller drops to the model's est_total_g.
  assertEquals(namesAPiece({ label: "1 serving (14.4 g)", grams: 14.4, is_default: true }), false);
  assertEquals(gramsPerUnit("serving", row([
    { label: "1 serving (14.4 g)", grams: 14.4, is_default: true },
    { label: "100 g", grams: 100 },
  ])), null);
});

Deno.test("a label that NAMES the piece is still multiplied", () => {
  // The whole point of keeping a per-piece path: these say what one weighs.
  assertEquals(namesAPiece({ label: "1 cookie (11 g)", grams: 11 }), true);
  assertEquals(namesAPiece({ label: "1 large", grams: 50 }), true);
  assertEquals(namesAPiece({ label: "1 slice (20 g)", grams: 20 }), true);
  assertEquals(
    gramsPerUnit("serving", row([
      { label: "1 cookie (11 g)", grams: 11, is_default: true },
      { label: "100 g", grams: 100 },
    ]))?.grams,
    11,
  );
});

// ── applyLabelChain ─────────────────────────────────────────────────────────
// The model recalls the pack's label; the CODE multiplies. These pin the
// arithmetic and every guard rail.

const EST = { kcal: 150, protein_g: 2, carb_g: 20, fat_g: 7, total_g: 60 };

Deno.test("label chain: derives total and rescales macros together", () => {
  // 3 pieces of a pack stating: serving 30 g = 4 pieces, 160 kcal.
  const { est, applied } = applyLabelChain(3, "piece", EST, { serving_g: 30, serving_kcal: 160, pieces: 4 });
  assertEquals(applied, true);
  assertEquals(est.total_g, 22.5);            // 3 x 30/4
  assertEquals(est.kcal, 120);                // 3 x 160/4, ratio 0.8 from 150
  assertEquals(est.protein_g, 2 * 0.8);       // macros move by the SAME ratio,
  assertEquals(est.fat_g, 7 * 0.8);           // so Atwater still holds
});

Deno.test("label chain: grams-only label fixes the weight, leaves kcal alone", () => {
  const { est, applied } = applyLabelChain(3, "piece", EST, { serving_g: 30, serving_kcal: null, pieces: 4 });
  assertEquals(applied, true);
  assertEquals(est.total_g, 22.5);
  assertEquals(est.kcal, 150);
});

Deno.test("label chain: a stated mass bypasses the chain entirely", () => {
  const { applied } = applyLabelChain(100, "g", EST, { serving_g: 30, serving_kcal: 160, pieces: 4 });
  assertEquals(applied, false);
});

Deno.test("label chain: household and pack units never enter the chain", () => {
  // The eval caught the first version answering "1 cup cooked rice" with the
  // pack's DRY 30 g serving. Cups, spoons and packets are not pieces.
  for (const u of ["cup", "katori", "packet", "spoons", "tbsp", "scoop", "bowl", "glass", "plate"]) {
    assertEquals(applyLabelChain(1, u, EST, { serving_g: 30, serving_kcal: 160, pieces: 4 }).applied, false, u);
  }
});

Deno.test("label chain: null or absurd label facts change nothing", () => {
  assertEquals(applyLabelChain(3, "piece", EST, { serving_g: null, serving_kcal: 160, pieces: 4 }).applied, false);
  assertEquals(applyLabelChain(3, "piece", EST, { serving_g: 30, serving_kcal: 160, pieces: null }).applied, false);
  assertEquals(applyLabelChain(3, "piece", EST, { serving_g: 5000, serving_kcal: 160, pieces: 4 }).applied, false);
  assertEquals(applyLabelChain(3, "piece", EST, { serving_g: 30, serving_kcal: 160, pieces: 200 }).applied, false);
  // Schema says number|null, but the wire can carry anything.
  assertEquals(applyLabelChain(3, "piece", EST, { serving_g: "30", serving_kcal: 160, pieces: 4 }).applied, false);
});

Deno.test("label chain: the correction ratio is clamped at 5x either way", () => {
  const tiny = { ...EST, kcal: 10 };
  // Derived would be 375 kcal (37.5x); the clamp holds it to 5x.
  const { est } = applyLabelChain(3, "piece", tiny, { serving_g: 30, serving_kcal: 500, pieces: 4 });
  assertEquals(est.kcal, 50);
});
