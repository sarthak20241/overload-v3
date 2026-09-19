import { assertEquals } from "jsr:@std/assert@1";
import {
  calorieGate, floorKcalFor, isProTier, validateTargets, caloriesCard, uglyChecks, type DietFacts,
} from "./dronaCalories.ts";
import type { DronaFacts } from "./dronaCards.ts";

const AS_OF = "2026-09-18";
const day = (back: number) => {
  const d = new Date(Date.UTC(2026, 8, 18) - back * 86_400_000);
  return d.toISOString().slice(0, 10);
};

/** A clean stall: 12 of 14 days logged near 2100, weight flat at 72.4, last change 21 days ago. */
function facts(over: Partial<DronaFacts> = {}): DronaFacts {
  return {
    as_of: AS_OF, week_start: "2026-09-14", tier: "annual",
    tenure: { days_since_first_session: 90, sessions_total: 40 },
    goal: { goal: "fat_loss", goal_weight_kg: 68, weight_kg: 72.4 },
    training: { sessions_14d: 6, planned_14d: 8, days_since_last_session: 1 },
    nutrition: { days_logged_14d: 12, target_kcal: 2100, on_target_days_14d: 10 },
    weight: { weigh_ins_14d: 9, weigh_ins_28d: 18 },
    cards: [],
    ...over,
  } as DronaFacts;
}
function diet(over: Partial<DietFacts> = {}): DietFacts {
  return {
    as_of: AS_OF, tier: "annual", tier_expires_at: null,
    body: { gender: "M", height_cm: 178, weight_kg: 72.4, age_years: 30 },
    targets: { kcal: 2100, protein_g: 150, carb_g: 210, fat_g: 60 },
    phase: { id: "ph1", kcal: 2100, protein_g: 150, carb_g: 210, fat_g: 60 },
    food: Array.from({ length: 12 }, (_, i) => ({ day: day(i), kcal: 2080 + (i % 3) * 40, protein_g: 145 })),
    weight: Array.from({ length: 9 }, (_, i) => ({ day: day(i), kg: 72.4 + ((i % 2) ? 0.1 : -0.1) })),
    target_changes: [{ at: "2026-08-28T08:00:00Z", from: 2250, to: 2100, source: "chat", card_id: null }],
    days_since_target_change: 21,
    ...over,
  };
}

Deno.test("a clean stall on a cut is eligible, with a 10% anchor above the floor", () => {
  const g = calorieGate(facts(), diet());
  assertEquals(g.eligible, true, g.reasons.join(","));
  assertEquals(g.anchor?.from, 2100);
  assertEquals(g.anchor?.to, 1950);       // 2100 - min(210, 150) = 1950, on a 25 grid
  assertEquals((g.anchor?.floor ?? 0) < 1950, true);
});

Deno.test("not a cut: no card", () => {
  assertEquals(calorieGate(facts({ goal: { goal: "hypertrophy" } }), diet()).eligible, false);
});

Deno.test("thin food logging cannot fire", () => {
  const g = calorieGate(facts({ nutrition: { days_logged_14d: 7, target_kcal: 2100, on_target_days_14d: 6 } }), diet());
  assertEquals(g.eligible, false);
  assertEquals(g.reasons.includes("food_thin"), true);
});

Deno.test("logging on the days but eating off target is not a stall to fix by lowering", () => {
  const g = calorieGate(facts({ nutrition: { days_logged_14d: 12, target_kcal: 2100, on_target_days_14d: 5 } }), diet());
  assertEquals(g.eligible, false);
  assertEquals(g.reasons.includes("off_target"), true);
});

Deno.test("weight actually falling is not flat", () => {
  const falling = Array.from({ length: 9 }, (_, i) => ({ day: day(i), kg: 71.0 + i * 0.12 })); // newest first, lower now
  const g = calorieGate(facts(), diet({ weight: falling }));
  assertEquals(g.eligible, false);
  assertEquals(g.reasons.includes("losing"), true);
});

Deno.test("too few weigh-ins cannot read a trend", () => {
  const g = calorieGate(facts({ weight: { weigh_ins_14d: 4, weigh_ins_28d: 6 } }), diet({ weight: (diet().weight ?? []).slice(0, 4) }));
  assertEquals(g.eligible, false);
  assertEquals(g.reasons.includes("weight_thin"), true);
});

Deno.test("a calorie change inside 14 days is left to settle", () => {
  const g = calorieGate(facts(), diet({ days_since_target_change: 9 }));
  assertEquals(g.eligible, false);
  assertEquals(g.reasons.includes("just_changed"), true);
});

Deno.test("no change ever is fine: nothing to wait for", () => {
  assertEquals(calorieGate(facts(), diet({ target_changes: [], days_since_target_change: null })).eligible, true);
});

Deno.test("at the floor there is no room to cut", () => {
  const g = calorieGate(facts({ nutrition: { days_logged_14d: 12, target_kcal: 1300, on_target_days_14d: 10 } }),
    diet({ targets: { kcal: 1300, protein_g: 120, carb_g: 100, fat_g: 40 }, body: { gender: "F", height_cm: 160, weight_kg: 58, age_years: 40 } }));
  assertEquals(g.eligible, false);
  assertEquals(g.reasons.includes("at_floor"), true);
});

Deno.test("the floor is Mifflin-St Jeor when the body is known, a fixed floor when it is not", () => {
  assertEquals(floorKcalFor({ gender: "M", height_cm: 178, weight_kg: 72.4, age_years: 30 }), 1692); // 724+1112.5-150+5
  assertEquals(floorKcalFor({ gender: "F", height_cm: 160, weight_kg: 58, age_years: 40 }), 1219);  // 580+1000-200-161
  assertEquals(floorKcalFor({ gender: "F" }), 1200);
  assertEquals(floorKcalFor({ gender: "M" }), 1500);
  assertEquals(floorKcalFor({}), 1350);
});

Deno.test("Pro is a paid tier that has not run out", () => {
  assertEquals(isProTier("annual", null, AS_OF), true);
  assertEquals(isProTier("monthly", "2026-10-01T00:00:00Z", AS_OF), true);
  assertEquals(isProTier("monthly", "2026-09-01T00:00:00Z", AS_OF), false);
  assertEquals(isProTier("founding_lifetime", null, AS_OF), true);
  assertEquals(isProTier("free", null, AS_OF), false);
  assertEquals(isProTier(null, null, AS_OF), false);
});

Deno.test("free users are gated out before the model", () => {
  assertEquals(calorieGate(facts({ tier: "free" }), diet({ tier: "free" })).reasons.includes("not_pro"), true);
});

Deno.test("the ugly checks read the series the mean hides", () => {
  const clean = uglyChecks(facts(), diet());
  assertEquals(clean.worst_day_kcal, 2160);
  assertEquals(clean.weight_range_kg, 0.2);
  assertEquals(clean.mean_protein_g, 145);
  assertEquals(clean.raised_back, false);
  assertEquals(clean.failed, []);

  const blowout = uglyChecks(facts(), diet({ food: (diet().food ?? []).map((r, i) => (i === 1 ? { ...r, kcal: 3400 } : r)) }));
  assertEquals(blowout.failed, ["blowout_day"]);

  const noisy = uglyChecks(facts(), diet({ weight: (diet().weight ?? []).map((r, i) => ({ ...r, kg: i % 2 ? 73.4 : 71.6 })) }));
  assertEquals(noisy.failed, ["noisy_scale"]);

  const lowProtein = uglyChecks(facts(), diet({ food: (diet().food ?? []).map((r) => ({ ...r, protein_g: 70 })) }));
  assertEquals(lowProtein.failed, ["protein_low"]);

  const raised = uglyChecks(facts(), diet({ target_changes: [
    { at: "2026-08-20T08:00:00Z", from: 1950, to: 2100, source: "manual", card_id: null },
    { at: "2026-08-10T08:00:00Z", from: 2100, to: 1950, source: "card", card_id: "x" },
  ] }));
  assertEquals(raised.failed, ["raised_back"]);
});

Deno.test("a proposal on an ugly week is refused whatever the model said", () => {
  const ctx = { from: 2100, floor: 1592, checks: uglyChecks(facts(), diet({ food: (diet().food ?? []).map((r, i) => (i === 1 ? { ...r, kcal: 3400 } : r)) })) };
  const v = validateTargets({ calories: 1950, rationale: "Weight has held two weeks at 2100. Try 1950.", worst_day_kcal: 3400, weight_range_kg: 0.2 }, ctx);
  assertEquals(v.ok, false);
  assertEquals((v as { reason: string }).reason, "blowout_day");
});

Deno.test("the model must have read the series: its worst day and range must match the data", () => {
  const ctx = { from: 2100, floor: 1592, checks: uglyChecks(facts(), diet()) };
  const good = { calories: 1950, rationale: "Weight has held two weeks at 2100. Try 1950." };
  assertEquals(validateTargets({ ...good, worst_day_kcal: 2160, weight_range_kg: 0.2 }, ctx).ok, true);
  assertEquals(validateTargets({ ...good, worst_day_kcal: 2140, weight_range_kg: 0.3 }, ctx).ok, true);   // within tolerance
  assertEquals(validateTargets({ ...good, worst_day_kcal: 2500, weight_range_kg: 0.2 }, ctx).ok, false);  // did not look
  assertEquals(validateTargets({ ...good, worst_day_kcal: 2160, weight_range_kg: 1.5 }, ctx).ok, false);
  assertEquals(validateTargets({ ...good }, ctx).ok, false);                                             // left them out
});

Deno.test("the validator holds the model to the bounds", () => {
  const ctx = { from: 2100, floor: 1592 };
  assertEquals(validateTargets({ calories: 1950, rationale: "Weight has held two weeks at 2100. Try 1950." }, ctx).ok, true);
  assertEquals(validateTargets({ calories: 2100, rationale: "Same again." }, ctx).ok, false);          // not a cut
  assertEquals(validateTargets({ calories: 1850, rationale: "Big cut." }, ctx).ok, false);            // over 10%
  assertEquals(validateTargets({ calories: 1500, rationale: "Under the floor." }, { from: 1600, floor: 1592 }).ok, false);
  assertEquals(validateTargets({ calories: 1950.5, rationale: "Fraction." }, ctx).ok, false);
  assertEquals(validateTargets({ calories: 1950, rationale: "" }, ctx).ok, false);
  assertEquals(validateTargets({ calories: 1950, rationale: "I will check back in a week." }, ctx).ok, false); // a promise the code does not keep
});

Deno.test("the card carries the numbers the user can check, and the move to undo", () => {
  const card = caloriesCard(facts(), diet(), 1950, "Twelve of fourteen days logged near 2100 and the scale has held. Try 1950.");
  assertEquals(card.kind, "act");
  assertEquals(card.topic, "calories");
  assertEquals(card.payload.action, "apply_targets");
  assertEquals(card.payload.from_kcal, 2100);
  assertEquals(card.payload.to_kcal, 1950);
  assertEquals(card.payload.from_protein_g, 150);
  assertEquals(card.payload.phase_id, "ph1");
  assertEquals(card.evidence.map((e) => e.value), ["12", "10", "2100", "0.0 kg"]);
  assertEquals(card.title, "Let us try 1950 kcal");
});
