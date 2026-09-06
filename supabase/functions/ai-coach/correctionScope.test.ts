// Run with: deno test supabase/functions/ai-coach/correctionScope.test.ts
//
// I1. The asymmetry is the whole design: calling a CHANGED line unchanged
// silently discards the user's edit, while calling an unchanged line changed
// merely costs a re-resolve. Every ambiguous case below must therefore come
// back null (= re-resolve), not a match.

import { assertEquals } from "jsr:@std/assert@1";
import { unchangedInCorrection, type ExtractedItem, type PreviousItem } from "./parseMeal.ts";

const prev = (name: string, quantity: number, serving_label: string): PreviousItem => ({
  food_id: "id-" + name,
  food_name: name,
  quantity,
  serving_label,
  grams: 100,
  kcal: 200,
  protein_g: 10,
  carb_g: 5,
  fat_g: 8,
  fiber_g: null,
  source: "catalog",
  assumption: null,
  confidence: "high",
});

const ext = (o: Partial<ExtractedItem> & { name: string }): ExtractedItem => ({
  brand: null,
  quantity: 1,
  unit: "serving",
  prep: null,
  correctsFoodName: null,
  ...o,
});

const DAL = prev("Dal", 1, "katori");
const ROTI = prev("Roti / Chapati", 2, "roti");

Deno.test("an untouched line is recognised and passed through", () => {
  const same = unchangedInCorrection(ext({ name: "Dal", quantity: 1, unit: "katori" }), [DAL, ROTI]);
  assertEquals(same?.food_name, "Dal");
});

Deno.test("plural units still count as the same unit", () => {
  assertEquals(
    unchangedInCorrection(ext({ name: "Roti / Chapati", quantity: 2, unit: "rotis" }), [ROTI])?.food_name,
    "Roti / Chapati",
  );
});

Deno.test("a changed AMOUNT must re-resolve", () => {
  // "make the roti 3" - the whole point of the turn.
  assertEquals(unchangedInCorrection(ext({ name: "Roti / Chapati", quantity: 3, unit: "roti" }), [ROTI]), null);
});

Deno.test("a changed UNIT must re-resolve", () => {
  assertEquals(unchangedInCorrection(ext({ name: "Dal", quantity: 1, unit: "bowl" }), [DAL]), null);
});

Deno.test("a newly stated prep is a change", () => {
  // "make the egg boiled" must not be waved through as identical.
  const egg = prev("Egg", 2, "piece");
  assertEquals(unchangedInCorrection(ext({ name: "Egg", quantity: 2, unit: "piece", prep: "boiled" }), [egg]), null);
});

Deno.test("a food not in the previous meal is new, never a passthrough", () => {
  assertEquals(unchangedInCorrection(ext({ name: "Dosa", quantity: 1, unit: "serving" }), [DAL, ROTI]), null);
});

Deno.test("a re-target uses corrects_food_name and is NOT unchanged", () => {
  // "actually paneer not tofu": same amount, different food.
  const tofu = prev("Tofu", 50, "g");
  const item = ext({ name: "Paneer", quantity: 50, unit: "g", correctsFoodName: "Tofu" });
  assertEquals(unchangedInCorrection(item, [tofu]), null);
});

Deno.test("a duplicate name does not hide the matching line", () => {
  // Two chai entries differing only in size. The 150 g one is SECOND, so a scan
  // that stops at the first same-named line would call an unchanged line
  // changed. Flagged in review of PR #121.
  const chaiSmall = prev("Chai / Milk Tea", 75, "ml");
  const chaiBig = prev("Chai / Milk Tea", 150, "ml");
  assertEquals(
    unchangedInCorrection(
      ext({ name: "Chai / Milk Tea", quantity: 150, unit: "ml" }),
      [chaiSmall, chaiBig],
    )?.quantity,
    150,
  );
  // And the first one is still found when IT is the match.
  assertEquals(
    unchangedInCorrection(
      ext({ name: "Chai / Milk Tea", quantity: 75, unit: "ml" }),
      [chaiSmall, chaiBig],
    )?.quantity,
    75,
  );
  // A size matching neither is still a change.
  assertEquals(
    unchangedInCorrection(
      ext({ name: "Chai / Milk Tea", quantity: 200, unit: "ml" }),
      [chaiSmall, chaiBig],
    ),
    null,
  );
});

// ── Un-replacing is a contract, not part of the optimisation ────────────────
//
// The bug these pin, found on device against v154. A correction names every
// line it restates as the thing it "corrects", so an UNTOUCHED line ends up in
// replacedNames naming itself. A replaced name is treated as deliberately gone,
// so keepUncoveredPrevious will not restore it if decide omits the line.
//
// Un-marking used to live inside the resolve-narrowing branch, which is skipped
// when every line looks unchanged. So in exactly that case the line stayed
// marked, decide dropped it, and the restore guard refused to bring it back.
// Logging a three-meal day and then saying "make it 2 plates of rajma chawal"
// came back with two items: the poha silently gone, with its whole Breakfast
// section, though the user never mentioned poha.

import { scopeCorrection } from "./parseMeal.ts";

const POHA = prev("Poha", 1, "plate");
const RAJMA = prev("Rajma Chawal", 1, "plate");

Deno.test("THE BUG: untouched lines are un-replaced even when NOTHING narrows", () => {
  // Every line restated unchanged -> the narrowing branch is deliberately
  // skipped, and the un-marking must still happen.
  const replaced = new Set(["poha", "rajma chawal"]);
  const out = scopeCorrection(
    [
      ext({ name: "Poha", quantity: 1, unit: "plate", correctsFoodName: "Poha" }),
      ext({ name: "Rajma Chawal", quantity: 1, unit: "plate", correctsFoodName: "Rajma Chawal" }),
    ],
    [POHA, RAJMA],
    replaced,
  );
  assertEquals(replaced.has("poha"), false, "poha must not read as deliberately replaced");
  assertEquals(replaced.has("rajma chawal"), false);
  // All unchanged means we probably misread the turn, so resolve everything.
  assertEquals(out.untouched, 0);
  assertEquals(out.toResolve.length, 2);
});

Deno.test("a genuinely re-targeted line STAYS replaced", () => {
  // The other half of the contract. "actually paneer not tofu" must not
  // resurrect the tofu line, so a CHANGED line keeps its mark.
  const replaced = new Set(["poha", "rajma chawal"]);
  const out = scopeCorrection(
    [
      ext({ name: "Poha", quantity: 1, unit: "plate", correctsFoodName: "Poha" }),
      ext({ name: "Rajma Chawal", quantity: 2, unit: "plate", correctsFoodName: "Rajma Chawal" }),
    ],
    [POHA, RAJMA],
    replaced,
  );
  assertEquals(replaced.has("poha"), false, "untouched line un-marked");
  assertEquals(replaced.has("rajma chawal"), true, "the line the user changed stays replaced");
  // And the narrowing still applies: only the changed line is re-resolved.
  assertEquals(out.untouched, 1);
  assertEquals(out.toResolve.map((i) => i.name), ["Rajma Chawal"]);
});

Deno.test("no previous match means nothing is un-marked", () => {
  const replaced = new Set(["poha"]);
  const out = scopeCorrection([ext({ name: "Idli", quantity: 2, unit: "piece" })], [POHA], replaced);
  assertEquals(replaced.has("poha"), true);
  assertEquals(out.untouched, 0);
});
