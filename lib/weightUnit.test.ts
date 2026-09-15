// Run with: deno test lib/weightUnit.test.ts
//
// user_profiles.weight_kg and goal_weight_kg hold kilograms. The kg/lbs switch
// on Profile used to be a label only: a user on lbs who typed 165 saved
// weight_kg = 165, and the coach, protein targets and goal lines read that as
// 165 kg. These tests pin the conversion on the way in and out.

import { assertEquals } from "jsr:@std/assert@1";
import { formatWeight, fromKg, KG_PER_LB, parseWeightInput, toKg } from "./weightUnit.ts";

Deno.test("a pound is the exact international pound", () => {
  assertEquals(KG_PER_LB, 0.45359237);
});

Deno.test("165 typed in lbs is saved as kilograms, not as 165", () => {
  assertEquals(parseWeightInput("165", "lbs"), { kg: 74.84 });
});

Deno.test("165 lbs round-trips back to 165 on screen", () => {
  const saved = parseWeightInput("165", "lbs");
  assertEquals(formatWeight(saved!.kg, "lbs"), "165");
});

Deno.test("a kg user's number is saved as typed", () => {
  assertEquals(parseWeightInput("75", "kg"), { kg: 75 });
  assertEquals(parseWeightInput("72.5", "kg"), { kg: 72.5 });
});

Deno.test("the saved kilograms re-display when the unit toggles", () => {
  assertEquals(formatWeight(74.84, "kg"), "74.8");
  assertEquals(formatWeight(74.84, "lbs"), "165");
  assertEquals(formatWeight(80, "lbs"), "176.4");
});

Deno.test("PostgREST numeric strings and long health-sync decimals display cleanly", () => {
  assertEquals(formatWeight("97.7489969786705", "kg"), "97.7");
  assertEquals(formatWeight("97.7489969786705", "lbs"), "215.5");
});

Deno.test("nothing saved shows an empty field", () => {
  assertEquals(formatWeight(null, "kg"), "");
  assertEquals(formatWeight(undefined, "lbs"), "");
  assertEquals(formatWeight(0, "kg"), "");
});

Deno.test("clearing the field clears the saved value", () => {
  assertEquals(parseWeightInput("", "lbs"), { kg: null });
  assertEquals(parseWeightInput("  ", "kg"), { kg: null });
});

Deno.test("a half-typed or unreadable value is not saved", () => {
  // "7" on the way to "75": saving it would store a 7 kg person.
  assertEquals(parseWeightInput("7", "kg"), null);
  assertEquals(parseWeightInput("1", "lbs"), null);
  assertEquals(parseWeightInput("abc", "kg"), null);
  assertEquals(parseWeightInput("9000", "lbs"), null);
});

Deno.test("toKg and fromKg keep the bodyweight log's rounding", () => {
  assertEquals(toKg(165, "lbs"), 74.84);
  assertEquals(toKg(10, "kg"), null);
  assertEquals(fromKg(74.84, "lbs"), 165);
});
