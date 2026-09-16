// Run with: deno test lib/weightUnit.test.ts
//
// user_profiles.weight_kg and goal_weight_kg hold kilograms. The kg/lbs switch
// on Profile used to be a label only: a user on lbs who typed 165 saved
// weight_kg = 165, and the coach, protein targets and goal lines read that as
// 165 kg. These tests pin the conversion on the way in and out.

import { assertEquals } from "jsr:@std/assert@1";
import { formatWeight, fromKg, KG_PER_LB, parseWeightInput, stampLegacyUnits, toKg, type WeightUnit, weightLogInUnit } from "./weightUnit.ts";

type Entry = { date: string; weight: number; unit?: WeightUnit };

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

Deno.test("a comma decimal reads as a decimal, not as a whole number", () => {
  // An Android numeric keypad shows a comma in many locales. parseFloat("75,5")
  // gives 75, so the weight log and the saved weight would disagree.
  assertEquals(parseWeightInput("75,5", "kg"), { kg: 75.5 });
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

// ─── Weight history on the device ────────────────────────────────────────────
// The device log saved the typed number with no unit. A guest on lbs who typed
// 180 and then switched to kg saw "92% to goal": the start weight read as
// 180 kg against a current 81.7 kg and a 72.6 kg goal. 81.7 matches the
// Profile field, which stores 180 lbs as 81.65 kg.

Deno.test("a history entry typed in lbs shows in kg after the switch", () => {
  const log = [{ date: "2026-09-15T08:00:00.000Z", weight: 180, unit: "lbs" as const }];
  assertEquals(weightLogInUnit(log, "kg"), [{ date: "2026-09-15T08:00:00.000Z", weight: 81.7, unit: "kg" }]);
});

Deno.test("an entry already in the shown unit keeps its number", () => {
  const log = [{ date: "2026-09-15T08:00:00.000Z", weight: 180, unit: "lbs" as const }];
  assertEquals(weightLogInUnit(log, "lbs")[0].weight, 180);
});

Deno.test("mixed entries all land in one unit", () => {
  const log = [
    { date: "2026-09-01T08:00:00.000Z", weight: 80, unit: "kg" as const },
    { date: "2026-09-15T08:00:00.000Z", weight: 170, unit: "lbs" as const },
  ];
  assertEquals(weightLogInUnit(log, "lbs").map((e) => e.weight), [176.4, 170]);
  assertEquals(weightLogInUnit(log, "kg").map((e) => e.weight), [80, 77.1]);
});

Deno.test("old entries without a unit get the current unit once, and say so", () => {
  const log = [
    { date: "2026-09-01T08:00:00.000Z", weight: 180 },
    { date: "2026-09-15T08:00:00.000Z", weight: 80, unit: "kg" },
  ] as Entry[];
  const { log: stamped, changed } = stampLegacyUnits(log, "lbs");
  assertEquals(changed, true);
  assertEquals(stamped.map((e) => e.unit), ["lbs", "kg"]);
  assertEquals(stampLegacyUnits(stamped, "kg").changed, false);
});

Deno.test("an unreadable history is empty, not a crash", () => {
  assertEquals(stampLegacyUnits(null, "kg"), { log: [], changed: false });
  assertEquals(weightLogInUnit(undefined, "kg"), []);
});
