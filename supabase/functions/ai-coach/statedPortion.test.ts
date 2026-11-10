// Run with: deno test --allow-all supabase/functions/ai-coach/statedPortion.test.ts
//
// The user's numbers set the portion (owner, 2026-11-08). From a real user's
// "150 cals of atta bread": Precise kept a label's "1 medium piece (40 g)" and
// put 150 kcal in it (375 kcal per 100 g, no bread prints that); Quick read
// "150 cals" as 150 portions of "kcal"; the agent's label edit then priced the
// broken line at 100 g, 252 kcal, and said it was 150.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  energyAmountAsStated,
  energyUnitKcal,
  fitPortionToStated,
  type StatedTotal,
  totalNote,
  userNumbersOnLine,
} from "./statedNumbers.ts";
import { honourStatedTotals, type ParsedItem } from "./parseMeal.ts";
import { lineFromLabel } from "./foodAgent.ts";
import { cardLines } from "./foodContext.ts";

const kcalOnly = (kcal: number): StatedTotal => ({ kcal, protein_g: null, carb_g: null, fat_g: null, fiber_g: null });
// Atta bread at a label's 252 kcal, 12.5 P, 42.8 C, 3.5 F per 100 g.
const bread = (grams: number, quantity: number, serving_label: string) => {
  const f = grams / 100;
  return { quantity, serving_label, grams, kcal: 252 * f, protein_g: 12.5 * f, carb_g: 42.8 * f, fat_g: 3.5 * f, fiber_g: null };
};
const near = (a: number, b: number, tol: number, what: string) => assert(Math.abs(a - b) <= tol, `${what}: ${a}, want ${b}`);

Deno.test("kcal and no amount: the weight comes from the kcal at the food's density", () => {
  // A label's piece weight was on the line: it no longer decides the weight.
  const l = fitPortionToStated(bread(40, 1, "1 medium piece (40 g)"), kcalOnly(150), false);
  assertEquals(l.kcal, 150);
  near(l.grams, 59.5, 0.1, "grams");
  assertEquals([l.quantity, l.serving_label], [l.grams, "g"]);
  near(l.protein_g, 7.4, 0.1, "protein");
  near(4 * l.protein_g + 4 * l.carb_g + 9 * l.fat_g, 150, 3, "adds up");
});

Deno.test("an amount the user named stays; only the weight moves, and a stale weight leaves the label", () => {
  const l = fitPortionToStated(bread(50, 2, "slice (25 g)"), kcalOnly(150), true);
  assertEquals(l.kcal, 150);
  near(l.grams, 59.5, 0.1, "grams");
  assertEquals([l.quantity, l.serving_label], [2, "slice"]);
});

Deno.test("macros only: the portion follows the macros the user gave, the rest from the food", () => {
  // Chicken breast at 165 kcal, 31 P, 0 C, 3.6 F per 100 g; "30 g protein".
  const chicken = { quantity: 1, serving_label: "serving", grams: 150, kcal: 247.5, protein_g: 46.5, carb_g: 0, fat_g: 5.4, fiber_g: null };
  const l = fitPortionToStated(chicken, { kcal: null, protein_g: 30, carb_g: null, fat_g: null, fiber_g: null }, false);
  assertEquals(l.protein_g, 30);
  near(l.grams, 96.8, 0.2, "grams");
  near(l.fat_g, 3.5, 0.1, "fat");
});

Deno.test("a line with nothing to measure against takes the numbers and keeps its portion", () => {
  const l = fitPortionToStated({ quantity: 1, serving_label: "serving", grams: 100, kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: null }, kcalOnly(150), false);
  assertEquals([l.kcal, l.grams, l.quantity, l.serving_label], [150, 100, 1, "serving"]);
});

Deno.test("an energy unit is never an amount", () => {
  assertEquals(energyUnitKcal(150, "kcal"), 150);
  assertEquals(energyUnitKcal(150, "Cals"), 150);
  assertEquals(energyUnitKcal(418.4, "kJ"), 100);
  assertEquals(energyUnitKcal(2, "slice"), null);
  assertEquals(energyAmountAsStated(150, "kcal", null), {
    quantity: 1, unit: "serving",
    stated: { basis: "total", serving_g: null, kcal: 150, protein_g: null, carb_g: null, fat_g: null, fiber_g: null },
  });
  assertEquals(energyAmountAsStated(2, "slice", null), { quantity: 2, unit: "slice", stated: null });
  // A card line already broken that way is shown by weight once it is fitted.
  const l = fitPortionToStated(bread(100, 150, "kcal"), kcalOnly(150), true);
  assertEquals([l.kcal, l.serving_label], [150, "g"]);
  near(l.grams, 59.5, 0.1, "grams");
});

Deno.test("the user's numbers are read back off a card line", () => {
  const t = { kcal: 150, protein_g: 12, carb_g: null, fat_g: null, fiber_g: null };
  assertEquals(userNumbersOnLine({ quantity: 1, serving_label: "serving", assumption: totalNote(t, "line") }), t);
  assertEquals(userNumbersOnLine({ quantity: 150, serving_label: "kcal" }), kcalOnly(150));
  assertEquals(userNumbersOnLine({ quantity: 1, serving_label: "serving", assumption: "From the label online" }), null);
  assertEquals(userNumbersOnLine({ quantity: 1, serving_label: "serving", assumption: "Scaled to fit your meal total: 500 kcal" }), null);
});

// ── Where the numbers land: the parse's totals and the agent's label edit ───


const item = (over: Partial<ParsedItem>): ParsedItem => ({
  food_id: null, food_name: "atta bread", quantity: 1, serving_label: "1 medium piece (40 g)", grams: 40,
  kcal: 100.8, protein_g: 5, carb_g: 17.1, fat_g: 1.4, fiber_g: null, source: "web", assumption: null, confidence: "medium",
  ...over,
});

Deno.test("a line total with no amount sets the weight, not just the kcal (atta bread, 2026-11-08)", () => {
  const steps: { tool: string }[] = [];
  const out = honourStatedTotals(
    [item({})],
    { meal: null, lines: [{ name: "atta bread", correctsFoodName: null, totals: kcalOnly(150), amountTyped: false }] },
    steps as never,
  )!;
  assertEquals(out[0].kcal, 150);
  near(out[0].grams, 59.5, 0.1, "grams");
  assertEquals(out[0].serving_label, "g");
});

Deno.test("a label put on a line keeps the user's kcal and finds the weight (agent use_label)", () => {
  const label = {
    name: "atta bread", brand: null, base_unit: "g" as const,
    per_100: { kcal: 252, protein_g: 12.5, carb_g: 42.8, fat_g: 3.5, fiber_g: null },
    serving: null, piece: null, verified: false, site: "clearcals.com",
  };
  // The broken line Quick left: 150 portions of "kcal".
  const broken = lineFromLabel({ food_name: "atta bread", quantity: 150, serving_label: "kcal", grams: 100, kcal: 0, source: "estimate" }, label, "lunch");
  assertEquals(broken.kcal, 150);
  near(broken.grams, 59.5, 0.1, "grams");
  assertEquals(broken.serving_label, "g");
  // A line carrying the user's numbers from an earlier message keeps them.
  const typed = lineFromLabel({
    food_name: "atta bread", quantity: 1, serving_label: "1 serving (50 g)", grams: 50, kcal: 150, source: "manual",
    assumption: "Your numbers: 150 kcal for this line, the rest estimated",
  }, label, "lunch");
  assertEquals(typed.kcal, 150);
  near(typed.grams, 59.5, 0.1, "grams");
  assert(/^Your numbers: 150 kcal/.test(typed.assumption ?? ""), typed.assumption ?? "");
  // A line with no numbers of the user's is priced from the label as before.
  const plain = lineFromLabel({ food_name: "atta bread", quantity: 60, serving_label: "g", grams: 60, kcal: 140, source: "estimate" }, label, "lunch");
  assertEquals([plain.grams, plain.kcal], [60, 151.2]);
});


Deno.test("the agent sees which numbers on a line are the user's", () => {
  const [typed, broken] = cardLines([
    { food_name: "atta bread", quantity: 60, serving_label: "g", grams: 60, kcal: 150, source: "manual", assumption: "Your numbers: 150 kcal for this line, the rest estimated" },
    { food_name: "atta bread", quantity: 150, serving_label: "kcal", grams: 100, kcal: 0, source: "estimate" },
  ], { sources: true });
  assert(typed.endsWith("| the user's numbers: 150 kcal"), typed);
  assert(broken.endsWith("; the user said 150 kcal"), broken);
});

// ── Typed weights, refits, the note as the record ───────────────────────────

Deno.test("a weight the user typed stays with their kcal; nothing moves it", () => {
  const l = fitPortionToStated(bread(100, 100, "g"), kcalOnly(150), true);
  assertEquals([l.quantity, l.serving_label, l.grams, l.kcal], [100, "g", 100, 150]);
});

Deno.test("a label on a line an earlier fit weighed moves the weight with the new density", () => {
  const label = {
    name: "atta bread", brand: null, base_unit: "g" as const,
    per_100: { kcal: 227, protein_g: 8.9, carb_g: 42.5, fat_g: 2.5, fiber_g: null },
    serving: null, piece: null, verified: false,
  };
  const l = lineFromLabel({
    food_name: "atta bread", quantity: 59.5, serving_label: "g", grams: 59.5, kcal: 150, source: "manual",
    assumption: "Your numbers: 150 kcal for this line, the rest estimated (the rest from the label online)",
  }, label, "lunch");
  assertEquals(l.kcal, 150);
  near(l.grams, 66.1, 0.1, "grams");
  assertEquals(l.quantity, l.grams);
});

Deno.test("every macro mix totalNote writes reads back the same (the note is the record)", () => {
  const mixes: StatedTotal[] = [
    kcalOnly(80),
    { kcal: 500, protein_g: 12, carb_g: null, fat_g: null, fiber_g: null },
    { kcal: null, protein_g: 30, carb_g: null, fat_g: null, fiber_g: null },
    { kcal: 220.5, protein_g: 10, carb_g: 25.5, fat_g: 8, fiber_g: null },
    { kcal: null, protein_g: null, carb_g: 40, fat_g: 3, fiber_g: null },
  ];
  for (const t of mixes) {
    for (const scope of ["line", "meal"] as const) {
      assertEquals(userNumbersOnLine({ quantity: 1, serving_label: "serving", assumption: totalNote(t, scope) }), t);
    }
  }
});

Deno.test("an energy amount fills the kcal the model's copy of the user's numbers left out", () => {
  const out = energyAmountAsStated(150, "kcal", { basis: "total", serving_g: null, kcal: null, protein_g: 5, carb_g: null, fat_g: null, fiber_g: null });
  assertEquals(out.stated, { basis: "total", serving_g: null, kcal: 150, protein_g: 5, carb_g: null, fat_g: null, fiber_g: null });
});

Deno.test("an energy amount filling a per-100 copy makes it a line total, never a density", () => {
  const out = energyAmountAsStated(150, "kcal", { basis: "per_100g", serving_g: null, kcal: null, protein_g: 8, carb_g: null, fat_g: null, fiber_g: null });
  assertEquals(out.stated?.basis, "total");
  assertEquals(out.stated?.kcal, 150);
});

Deno.test("a portion that would move past 10x keeps the line's portion and takes the numbers", () => {
  const trace = { quantity: 1, serving_label: "serving", grams: 100, kcal: 1, protein_g: 0, carb_g: 0.2, fat_g: 0, fiber_g: null };
  const l = fitPortionToStated(trace, kcalOnly(150), false);
  assertEquals([l.kcal, l.grams, l.serving_label], [150, 100, "serving"]);
});
