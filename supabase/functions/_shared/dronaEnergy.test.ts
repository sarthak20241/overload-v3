import { assertEquals } from "jsr:@std/assert@1";
import { decideEnergyCard, type EnergyFacts, nextTarget } from "./dronaEnergy.ts";

const never = () => false;

function facts(behaviours: EnergyFacts["behaviours"], over: Partial<EnergyFacts> = {}): EnergyFacts {
  return {
    as_of: "2026-10-19", week_start: "2026-10-12", tier: "annual", tier_expires_at: null,
    targets: { kcal: 1800, protein_g: 150, carb_g: 170, fat_g: 55 }, phase_id: "ph1",
    behaviours, ...over,
  };
}
const caloriesOff = (detail: Record<string, unknown> = {}) => ({
  behaviour: "calories_off", card_kind: "act", priority: 16, mutes: [],
  detail: { estimate_kcal: 2294, suggested_kcal: 1700, floor_kcal: 1686, goal_kg: 59, pace_kg_per_week: -0.726,
            trend_rate_kg_per_week: -0.31, readings: 9, whole_days: 15, source: "learning", ...detail },
});
const finding = (missing: string[], detail: Record<string, unknown> = {}) => ({
  behaviour: "finding_maintenance", card_kind: "request", priority: 14, mutes: [],
  detail: { missing, readings: 2, whole_days: 3, source: "guess", ...detail },
});

Deno.test("nextTarget: a 100 kcal gap moves, 99 does not", () => {
  assertEquals(nextTarget(1800, 1700, null), 1700);
  assertEquals(nextTarget(1800, 1701, null), null);
  assertEquals(nextTarget(1800, 1900, null), 1900);
});

Deno.test("nextTarget: at most 200 kcal a step, either way", () => {
  assertEquals(nextTarget(2250, 1700, null), 2050);
  assertEquals(nextTarget(1800, 2400, null), 2000);
});

Deno.test("nextTarget: never under the floor, rounded up to 25", () => {
  // 1800 - 200 = 1600, under a 1686 floor -> 1700
  assertEquals(nextTarget(1800, 1500, 1686), 1700);
  // the floor IS the live target: nothing to do
  assertEquals(nextTarget(1700, 1500, 1686), null);
});

Deno.test("calories_off becomes the app's Set X kcal card, with Undo's four numbers", () => {
  const card = decideEnergyCard(facts([caloriesOff()]), never)!;
  assertEquals(card.kind, "act");
  assertEquals(card.topic, "calories");
  assertEquals(card.title, "Let us try 1700 kcal");
  assertEquals(card.payload, { action: "apply_targets", from_kcal: 1800, to_kcal: 1700, from_protein_g: 150,
    from_carb_g: 170, from_fat_g: 55, phase_id: "ph1" });
  assertEquals(card.evidence.map((e) => e.value), ["2294", "1800", "-0.31 kg/wk"]);
});

Deno.test("a stepped change says it is a first step", () => {
  const card = decideEnergyCard(facts([caloriesOff({ suggested_kcal: 1500, floor_kcal: 1400 })]), never)!;
  assertEquals(card.payload.to_kcal, 1600);
  assertEquals(card.body.includes("1600 is a careful first step."), true);
});

Deno.test("free tier: no calorie card, the data ask still comes", () => {
  const card = decideEnergyCard(facts([finding(["weigh_ins"]), caloriesOff()], { tier: "free" }), never)!;
  assertEquals(card.topic, "weigh_in");
});

Deno.test("calories on cooldown: the data ask comes instead", () => {
  const card = decideEnergyCard(facts([finding(["whole_days"]), caloriesOff()]), (t) => t === "calories")!;
  assertEquals(card.topic, "log_food");
});

Deno.test("weigh-ins missing on a formula guess: ask, and say why", () => {
  const card = decideEnergyCard(facts([finding(["weigh_ins", "whole_days"])]), never)!;
  assertEquals(card.kind, "request");
  assertEquals(card.topic, "weigh_in");
  assertEquals(card.payload.action, "log_weight");
  assertEquals(card.body.includes("formula"), true);
});

Deno.test("a stale trend while learning: the learning words", () => {
  const card = decideEnergyCard(facts([finding(["stale"], { source: "learning" })]), never)!;
  assertEquals(card.title, "Step on the scale this week");
  assertEquals(card.body.includes("keeps that number honest"), true);
});

Deno.test("an untrusted scale: the same-scale words", () => {
  const card = decideEnergyCard(facts([finding(["scale"])]), never)!;
  assertEquals(card.body.startsWith("A few recent weigh-ins jumped"), true);
});

Deno.test("weigh-ins muted after cards that did not land: ask for food, or nothing", () => {
  const mute = { behaviour: "topic_not_landing", card_kind: "steer", priority: 13, mutes: ["topic:weigh_in"], detail: {} };
  assertEquals(decideEnergyCard(facts([mute, finding(["weigh_ins", "whole_days"])]), never)?.topic, "log_food");
  assertEquals(decideEnergyCard(facts([mute, finding(["weigh_ins"])]), never), null);
});

Deno.test("the food card only says the weigh-ins are in when they are", () => {
  const done = decideEnergyCard(facts([finding(["whole_days"])]), never)!;
  assertEquals(done.body.startsWith("Your weigh-ins are the first half"), true);
  const mute = { behaviour: "topic_not_landing", card_kind: "steer", priority: 13, mutes: ["topic:weigh_in"], detail: {} };
  const muted = decideEnergyCard(facts([mute, finding(["weigh_ins", "stale", "whole_days"])]), never)!;
  assertEquals(muted.topic, "log_food");
  assertEquals(muted.body.includes("weigh-ins"), false);
});

Deno.test("nothing to say: null, so the other rules get their turn", () => {
  assertEquals(decideEnergyCard(facts([]), never), null);
  assertEquals(decideEnergyCard(facts([caloriesOff({ suggested_kcal: 1750 })]), never), null);
});

Deno.test("no card promises what the code does not do, and none uses an em dash", () => {
  const cards = [
    decideEnergyCard(facts([caloriesOff({ suggested_kcal: 1500, floor_kcal: 1400 })]), never)!,
    decideEnergyCard(facts([finding(["weigh_ins"])]), never)!,
    decideEnergyCard(facts([finding(["stale"], { source: "measured" })]), never)!,
    decideEnergyCard(facts([finding(["scale"])]), never)!,
    decideEnergyCard(facts([finding(["whole_days"])]), never)!,
  ];
  for (const c of cards) {
    const text = `${c.title} ${c.body}`;
    assertEquals(/—/.test(text), false, text);
    assertEquals(/\bi will\b|\bcheck back\b|\bnext week i\b/i.test(text), false, text);
  }
});
