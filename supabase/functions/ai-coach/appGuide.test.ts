// Run with: deno test supabase/functions/ai-coach/appGuide.test.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  APP_FEATURES,
  APP_GUIDE,
  APP_GUIDE_TOPICS,
  lookupAppGuide,
} from "./appGuide.ts";
import { AI_LIMITS } from "../_shared/aiLimits.ts";
import {
  FUEL_DEFAULT,
  FUEL_LABEL_MAX,
  FUEL_MAX,
  FUEL_MIN,
  FUEL_STEP,
} from "../_shared/fuelDays.ts";

Deno.test("exact topic keys resolve", () => {
  for (const topic of APP_GUIDE_TOPICS) {
    const r = lookupAppGuide(topic);
    assert("instructions" in r, `${topic} did not resolve`);
    assertEquals(r.topic, topic);
  }
});

Deno.test("the words a user would say resolve to the right topic", () => {
  const cases: Array<[string, string]> = [
    ["measurements", "body_log"],
    ["body measurements", "body_log"],
    ["can I track my waist", "body_log"],
    ["body fat", "body_log"],
    ["sleep", "health_readiness"],
    ["apple health", "health_readiness"],
    ["barcode", "nutrition"],
    ["log food", "nutrition"],
    ["how do I set a fuel day", "fuel_days"],
    ["fuel days", "fuel_days"],
    ["Fuel by day", "fuel_days"],
    ["extra calories on Sunday", "fuel_days"],
    ["more calories on leg days", "fuel_days"],
    ["calorie cycling", "fuel_days"],
    ["hevy", "import"],
    ["pro", "pro_and_free"],
    ["how do supersets work", "workout_logging"],
    ["weekly card", "today_and_cards"],
    ["Goal and plan", "goal_plan_program"],
    ["delete account", "profile_settings"],
    ["notifications", "not_available"],
    ["push reminders", "not_available"],
    ["subscriptions", "pro_and_free"],
    ["programs", "goal_plan_program"],
    ["warmups", "workout_logging"],
    ["rest timers", "workout_logging"],
  ];
  for (const [q, want] of cases) {
    const r = lookupAppGuide(q);
    assert("instructions" in r, `"${q}" did not resolve`);
    assertEquals(r.topic, want, `"${q}" resolved to ${r.topic}`);
  }
});

Deno.test("an unknown topic returns the list instead of a guess", () => {
  const r = lookupAppGuide("quantum flux capacitor");
  assert("error" in r);
  assertEquals(r.topics, APP_GUIDE_TOPICS);
  assert("error" in lookupAppGuide(""));
  assert("error" in lookupAppGuide(undefined));
});

Deno.test("every feature block topic exists in the guide", () => {
  // <app_features> says "(topic xyz)" for each area; each must be a real key.
  const mentioned = [...APP_FEATURES.matchAll(/\(topic ([a-z_]+)\)/g)].map((
    m,
  ) => m[1]);
  assertEquals(mentioned, APP_GUIDE_TOPICS);
  for (const t of mentioned) {
    assert(Object.hasOwn(APP_GUIDE, t), `topic ${t} has no guide entry`);
  }
});

Deno.test("no em dashes anywhere the coach might quote", () => {
  assert(!APP_FEATURES.includes("—"));
  for (const [k, v] of Object.entries(APP_GUIDE)) {
    assert(!v.instructions.includes("—"), `em dash in ${k}`);
  }
});

Deno.test("the body log guide names every tape site", () => {
  const g = APP_GUIDE.body_log.instructions;
  for (
    const site of [
      "chest",
      "shoulders",
      "neck",
      "bicep",
      "forearm",
      "waist",
      "hips",
      "thigh",
      "calf",
    ]
  ) {
    assertStringIncludes(g, site);
  }
});

Deno.test("fuel days are discoverable and explain setup and target behavior", () => {
  assertStringIncludes(APP_FEATURES, "(topic fuel_days)");
  const r = lookupAppGuide("fuel_days");
  assert("instructions" in r);
  assertStringIncludes(r.instructions, '"Goal and plan"');
  assertStringIncludes(r.instructions, '"Daily goal"');
  assertStringIncludes(r.instructions, '"Save fuel days"');
  assertStringIncludes(r.instructions, "protein and fat stay the same");
  assertStringIncludes(r.instructions, "propose_targets changes only the base");
});

Deno.test("all existing guide topics remain available after the registry migration", () => {
  assertEquals(APP_GUIDE_TOPICS, [
    "workout_logging",
    "routines",
    "exercises",
    "history",
    "analytics",
    "body_log",
    "health_readiness",
    "nutrition",
    "fuel_days",
    "goal_plan_program",
    "today_and_cards",
    "coach_chat",
    "xp_and_insights",
    "import",
    "form_check",
    "share",
    "profile_settings",
    "pro_and_free",
    "guest_mode",
    "not_available",
  ]);
  for (const entry of Object.values(APP_GUIDE)) {
    assert(entry.instructions.length > 0);
    assert(entry.availability.length > 0);
    assert(entry.sources.length > 0);
  }
});

Deno.test("the feature index omits detailed steps and guide calls return only the requested topic", () => {
  assert(!APP_FEATURES.includes("Save Measurements"));
  assert(!APP_FEATURES.includes("Save fuel days"));
  assert(!APP_FEATURES.includes("MAX_LABEL"));
  const r = lookupAppGuide("fuel_days");
  assert("instructions" in r);
  assertStringIncludes(r.instructions, "Save fuel days");
  assert(!r.instructions.includes("Save Measurements"));
  assertEquals(Object.keys(r), [
    "topic",
    "title",
    "instructions",
    "availability",
  ]);
});

Deno.test("short aliases do not accidentally match inside unrelated words", () => {
  for (
    const q of [
      "programming",
      "importantly",
      "reformat",
      "constructor",
      "toString",
    ]
  ) {
    assert("error" in lookupAppGuide(q), q);
  }
  for (
    const [q, want] of [["PRs", "workout_logging"], [
      "supersets",
      "workout_logging",
    ], ["progress", "analytics"]]
  ) {
    const r = lookupAppGuide(q);
    assert("instructions" in r);
    assertEquals(r.topic, want);
  }
});

Deno.test("equally strong matches return candidates instead of the first arbitrary topic", () => {
  const r = lookupAppGuide("sleep and coach");
  assert("error" in r);
  assertStringIncludes(r.error, "ambiguous");
  assertEquals(r.topics, ["health_readiness", "coach_chat"]);
});

Deno.test("access requirements describe each capability without gating the whole topic", () => {
  assertEquals(
    APP_GUIDE.fuel_days.availability.map((a) => [a.signIn, a.subscription]),
    [
      ["required", "free"],
      ["required", "pro_or_trial"],
    ],
  );
  assertEquals(APP_GUIDE.body_log.availability[0].signIn, "optional");
  assertEquals(APP_GUIDE.health_readiness.availability[0].signIn, "required");
  assertEquals(
    APP_GUIDE.health_readiness.availability.slice(1).map((a) => a.platforms),
    [["ios"], ["android"]],
  );
  assertEquals(APP_GUIDE.import.availability[0].signIn, "required");
  assertEquals(APP_GUIDE.import.availability[0].subscription, "free");
  assertEquals(APP_GUIDE.coach_chat.availability.map((a) => a.subscription), [
    "free",
    "pro_or_trial",
  ]);
  assertEquals(APP_GUIDE.form_check.availability[0].status, "unreachable");
  assertEquals(APP_GUIDE.pro_and_free.availability[2].status, "unavailable");
  assertEquals(APP_GUIDE.pro_and_free.availability[2].platforms, ["android"]);
});

Deno.test("instructions use the same fuel bounds and AI allowances as enforcement", () => {
  const fuel = APP_GUIDE.fuel_days.instructions;
  assertStringIncludes(fuel, `+${FUEL_DEFAULT} kcal`);
  assertStringIncludes(
    fuel,
    `+${FUEL_MIN} to +${FUEL_MAX} kcal in ${FUEL_STEP} kcal steps`,
  );
  assertStringIncludes(fuel, `up to ${FUEL_LABEL_MAX} characters`);
  const access = APP_GUIDE.pro_and_free.instructions;
  assertStringIncludes(
    access,
    `${AI_LIMITS.freeChat} coach messages and ${AI_LIMITS.freeFood} AI food logs`,
  );
  assertStringIncludes(
    access,
    `${AI_LIMITS.proChat} coach messages and ${AI_LIMITS.proFood} AI food logs`,
  );
});
