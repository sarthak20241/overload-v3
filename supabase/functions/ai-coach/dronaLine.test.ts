// Run with: deno test supabase/functions/ai-coach/dronaLine.test.ts
//
// Seen live 2026-08-23: a card reading "Boiled Egg 231 kcal, 19g P" shipped
// with the line "Three eggs, 37.5 grams protein." The model had assumed 12.5 g
// per egg. The macros were right and the sentence beside them was wrong.

import { assertEquals } from "jsr:@std/assert@1";
import { groundDronaLine, type ParsedItem } from "./parseMeal.ts";

const item = (kcal: number, protein: number): ParsedItem => ({
  food_id: null,
  food_name: "Boiled Egg",
  quantity: 3,
  serving_label: "large",
  grams: 150,
  kcal,
  protein_g: protein,
  carb_g: 2,
  fat_g: 16,
  fiber_g: null,
  source: "fatsecret",
  assumption: null,
  confidence: "medium",
});

const EGGS = [item(231, 18.8)];
const TODAY = { kcal: 0, protein_g: 0 };
const TARGETS = { protein_target_g: 150, daily_calorie_target: 2000 };

Deno.test("the real regression: a fabricated protein figure is replaced", () => {
  const out = groundDronaLine("Three eggs, 37.5 grams protein.", EGGS, TODAY, TARGETS);
  assertEquals(out.includes("37.5"), false);
  assertEquals(out, "19g protein logged. Solid, keep stacking.");
});

Deno.test("a line quoting the MEAL total survives", () => {
  const line = "19g protein from those eggs. Good start.";
  assertEquals(groundDronaLine(line, EGGS, TODAY, TARGETS), line);
});

Deno.test("a line quoting the DAY AFTER this meal survives", () => {
  // The prompt invites the line to react to the day, so day-so-far + meal is
  // a legitimate figure and must not be treated as invented.
  const today = { kcal: 500, protein_g: 40 };
  const line = "You're at 59g protein now. Keep stacking.";
  assertEquals(groundDronaLine(line, EGGS, today, TARGETS), line);
});

Deno.test("a line quoting the target or what's left survives", () => {
  const target = "Target is 150 g protein. Keep going.";
  assertEquals(groundDronaLine(target, EGGS, TODAY, TARGETS), target);
  const left = "131 g protein still to go today.";
  assertEquals(groundDronaLine(left, EGGS, TODAY, TARGETS), left);
});

Deno.test("numbers not attached to a macro word are ignored", () => {
  // "Three eggs" / "3 x 1 large" must never trigger the guard.
  const line = "Three eggs down, 3 more meals to go.";
  assertEquals(groundDronaLine(line, EGGS, TODAY, TARGETS), line);
});

Deno.test("a fabricated calorie figure is replaced", () => {
  const out = groundDronaLine("That's 900 calories in one go.", EGGS, TODAY, TARGETS);
  assertEquals(out.includes("900"), false);
});

Deno.test("rounding does not trip the guard", () => {
  // 19 vs 18.8, and 231 vs 230: within the floor, must pass.
  assertEquals(groundDronaLine("19g protein, 230 kcal.", EGGS, TODAY, TARGETS), "19g protein, 230 kcal.");
});

Deno.test("missing day context still validates against the meal", () => {
  const out = groundDronaLine("Three eggs, 37.5 grams protein.", EGGS, null, null);
  assertEquals(out.includes("37.5"), false);
  assertEquals(groundDronaLine("19g protein logged.", EGGS, null, null), "19g protein logged.");
});
