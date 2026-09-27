// Run with: deno test supabase/functions/ai-coach/appGuide.test.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { APP_FEATURES, APP_GUIDE, APP_GUIDE_TOPICS, lookupAppGuide } from "./appGuide.ts";

Deno.test("exact topic keys resolve", () => {
  for (const topic of APP_GUIDE_TOPICS) {
    const r = lookupAppGuide(topic);
    assert("guide" in r, `${topic} did not resolve`);
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
    ["hevy", "import"],
    ["pro", "pro_and_free"],
    ["how do supersets work", "workout_logging"],
    ["weekly card", "today_and_cards"],
    ["Goal and plan", "goal_plan_program"],
    ["delete account", "profile_settings"],
    ["notifications", "not_available"],
  ];
  for (const [q, want] of cases) {
    const r = lookupAppGuide(q);
    assert("guide" in r, `"${q}" did not resolve`);
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
  const mentioned = [...APP_FEATURES.matchAll(/\(topic ([a-z_]+)\)/g)].map((m) => m[1]);
  assert(mentioned.length >= 15, `only ${mentioned.length} topics mentioned`);
  for (const t of mentioned) assert(t in APP_GUIDE, `topic ${t} has no guide entry`);
});

Deno.test("no em dashes anywhere the coach might quote", () => {
  assert(!APP_FEATURES.includes("—"));
  for (const [k, v] of Object.entries(APP_GUIDE)) assert(!v.includes("—"), `em dash in ${k}`);
});

Deno.test("the body log guide names every tape site", () => {
  const g = APP_GUIDE.body_log;
  for (const site of ["chest", "shoulders", "neck", "bicep", "forearm", "waist", "hips", "thigh", "calf"]) {
    assertStringIncludes(g, site);
  }
});
