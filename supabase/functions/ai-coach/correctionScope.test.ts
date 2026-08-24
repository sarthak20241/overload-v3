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
