// Run with: deno test --allow-all supabase/functions/_shared/dronaCards.test.ts
//
// The rules behind Drona's weekly card. What matters here is what does NOT
// happen: a card that fires on thin data, or repeats a week later, costs more
// trust than a missed one earns. So most of these pin silence.

import { assertEquals } from "jsr:@std/assert@1";
import { ACTION_ROUTES, decideCard, type DronaFacts, onCooldown, pickCurrentCard, signalsFrom, weekStartOf } from "./dronaCards.ts";

/** A settled user: months in, training to plan, logging food and weight. */
function steady(over: Partial<DronaFacts> = {}): DronaFacts {
  return {
    as_of: "2026-09-16",
    week_start: "2026-09-14",
    tenure: { days_since_first_session: 200, sessions_total: 60 },
    goal: { goal: "fat_loss", goal_weight_kg: 70 },
    training: { sessions_14d: 8, planned_14d: 8, days_since_last_session: 1, off_plan_14d: 0 },
    nutrition: { days_logged_14d: 12, target_kcal: 2250, on_target_days_14d: 9 },
    weight: { weigh_ins_14d: 10, weigh_ins_28d: 20 },
    recovery: { readiness_days_14d: 10 },
    cards: [],
    ...over,
  };
}

Deno.test("a steady week says nothing", () => {
  assertEquals(decideCard(steady()).kind, "hold");
});

Deno.test("a new user gets the watching notice, never a request", () => {
  const facts = steady({
    tenure: { days_since_first_session: 3, sessions_total: 2 },
    training: { sessions_14d: 2, planned_14d: 8, days_since_last_session: 9 },
    nutrition: { days_logged_14d: 0, target_kcal: 2250 },
    weight: { weigh_ins_14d: 0, weigh_ins_28d: 0 },
  });
  const card = decideCard(facts);
  assertEquals([card.kind, card.topic], ["notice", "watching"]);
});

Deno.test("someone who has not trained in a week is asked for one session", () => {
  const card = decideCard(steady({ training: { sessions_14d: 1, planned_14d: 8, days_since_last_session: 11 } }));
  assertEquals([card.kind, card.topic], ["request", "due_session"]);
  assertEquals(card.evidence[0].value, "11");
});

Deno.test("a scale goal with no weigh-ins at all asks for the scale", () => {
  const card = decideCard(steady({ weight: { weigh_ins_14d: 0, weigh_ins_28d: 0 } }));
  assertEquals([card.kind, card.topic], ["request", "weigh_in"]);
});

Deno.test("a goal that is not about weight never asks for the scale", () => {
  const facts = steady({
    goal: { goal: "strength" },
    weight: { weigh_ins_14d: 0, weigh_ins_28d: 0 },
  });
  assertEquals(decideCard(facts).kind, "hold");
});

Deno.test("no food days asks for food, but only once targets exist", () => {
  const withTargets = steady({ nutrition: { days_logged_14d: 0, target_kcal: 2250 } });
  assertEquals(decideCard(withTargets).topic, "log_food");
  const noTargets = steady({ nutrition: { days_logged_14d: 0 } });
  assertEquals(decideCard(noTargets).kind, "hold");
});

Deno.test("thin logging asks for a little more", () => {
  const card = decideCard(steady({ nutrition: { days_logged_14d: 4, target_kcal: 2250 } }));
  assertEquals([card.kind, card.topic], ["request", "log_food"]);
  assertEquals(card.evidence[0].value, "4");
});

Deno.test("half the planned sessions asks for the due one, with both numbers", () => {
  const card = decideCard(steady({ training: { sessions_14d: 3, planned_14d: 8, days_since_last_session: 2 } }));
  assertEquals([card.kind, card.topic], ["request", "due_session"]);
  assertEquals(card.evidence.map((e) => e.value), ["3", "8"]);
});

Deno.test("with no plan there is nothing to be behind on", () => {
  const facts = steady({ training: { sessions_14d: 1, planned_14d: 0, days_since_last_session: 2 } });
  assertEquals(signalsFrom(facts).sessions_missed, "unknown");
  assertEquals(decideCard(facts).kind, "hold");
});

Deno.test("missing counts read as unknown, and unknown never fires a card", () => {
  const facts: DronaFacts = {
    week_start: "2026-09-14",
    tenure: { days_since_first_session: 200, sessions_total: 60 },
    goal: { goal: "fat_loss" },
    training: {},
    nutrition: {},
    weight: {},
    cards: [],
  };
  const s = signalsFrom(facts);
  assertEquals([s.weight_none, s.food_none, s.no_training, s.sessions_missed], ["unknown", "unknown", "unknown", "unknown"]);
  assertEquals(decideCard(facts).kind, "hold");
});

Deno.test("the same topic waits two weeks, and four after a dismissal", () => {
  const thin = { weigh_ins_14d: 0, weigh_ins_28d: 0 };
  const lastWeek = steady({ weight: thin, cards: [{ week_start: "2026-09-07", topic: "weigh_in", status: "pending" }] });
  assertEquals(onCooldown("weigh_in", lastWeek), true);
  assertEquals(decideCard(lastWeek).kind, "hold");

  const threeWeeksAgo = steady({ weight: thin, cards: [{ week_start: "2026-08-24", topic: "weigh_in", status: "pending" }] });
  assertEquals(decideCard(threeWeeksAgo).topic, "weigh_in");

  const dismissed = steady({ weight: thin, cards: [{ week_start: "2026-08-24", topic: "weigh_in", status: "dismissed" }] });
  assertEquals(decideCard(dismissed).kind, "hold");
});

Deno.test("a topic on cooldown steps aside for the next case", () => {
  const facts = steady({
    weight: { weigh_ins_14d: 0, weigh_ins_28d: 0 },
    nutrition: { days_logged_14d: 0, target_kcal: 2250 },
    cards: [{ week_start: "2026-09-07", topic: "weigh_in", status: "pending" }],
  });
  assertEquals(decideCard(facts).topic, "log_food");
});

Deno.test("the worst case wins when several fire", () => {
  const facts = steady({
    training: { sessions_14d: 0, planned_14d: 8, days_since_last_session: 20 },
    nutrition: { days_logged_14d: 0, target_kcal: 2250 },
    weight: { weigh_ins_14d: 0, weigh_ins_28d: 0 },
  });
  assertEquals(decideCard(facts).topic, "due_session");
});

Deno.test("a card always carries a signal name and its evidence", () => {
  const card = decideCard(steady({ weight: { weigh_ins_14d: 0, weigh_ins_28d: 0 } }));
  assertEquals(card.signals, ["weight_goal", "weight_none"]);
  assertEquals(card.evidence.length > 0 && card.body.length > 0 && card.title.length > 0, true);
  assertEquals(card.body.includes("—"), false); // no em dashes in user-facing copy
});

Deno.test("weekStartOf gives the Monday of that local week", () => {
  assertEquals(weekStartOf("2026-09-16"), "2026-09-14"); // Wednesday
  assertEquals(weekStartOf("2026-09-14"), "2026-09-14"); // Monday itself
  assertEquals(weekStartOf("2026-09-13"), "2026-09-07"); // Sunday belongs to the week before
  assertEquals(weekStartOf("2026-01-01"), "2025-12-29"); // across a year end
  assertEquals(weekStartOf("2026-03-29"), "2026-03-23"); // a DST changeover Sunday
  assertEquals(weekStartOf("nope"), null);
});

Deno.test("traveller: the phone shows the server's card when the two clocks straddle Monday", () => {
  // Profile zone India: the server already wrote Monday 21 Sep's card. The phone,
  // now in New York, still reads Sunday 20 Sep, which is the week of the 14th.
  const rows = [
    { week_start: "2026-09-21", topic: "weigh_in" },
    { week_start: "2026-09-14", topic: "log_food" },
  ];
  assertEquals(pickCurrentCard(rows, "2026-09-20")?.week_start, "2026-09-21");
  // And the other way: the server still on last week, the phone already on Monday.
  assertEquals(pickCurrentCard([{ week_start: "2026-09-14" }], "2026-09-21")?.week_start, "2026-09-14");
});

Deno.test("an old card is not current, so the phone may ask for this week's", () => {
  assertEquals(pickCurrentCard([{ week_start: "2026-08-31" }], "2026-09-16"), null);
  assertEquals(pickCurrentCard([], "2026-09-16"), null);
  assertEquals(pickCurrentCard([{ week_start: "nope" }], "2026-09-16"), null);
});

Deno.test("every request card's action has somewhere to go, and food goes to nutrition", () => {
  const acts = new Set<string>();
  const cases: Partial<DronaFacts>[] = [
    { weight: { weigh_ins_14d: 0, weigh_ins_28d: 0 } },
    { nutrition: { days_logged_14d: 0, target_kcal: 2250 } },
    { training: { sessions_14d: 0, planned_14d: 8, days_since_last_session: 20 } },
  ];
  for (const c of cases) {
    const card = decideCard(steady(c));
    if (card.payload.action) acts.add(card.payload.action);
  }
  assertEquals([...acts].sort(), ["log_food", "log_weight", "start_session"]);
  assertEquals(ACTION_ROUTES.log_food, "/(app)/nutrition");
  assertEquals(ACTION_ROUTES.log_weight, "/(app)/analytics");
  assertEquals("start_session" in ACTION_ROUTES, false); // handled on the dashboard itself
});
