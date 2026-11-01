// Run with: deno test --allow-all lib/healthCardio.test.ts
//
// Which watch / phone workouts become Overload cardio sessions: cardio types
// only, long enough, and never twice for the same stretch of time.

import { assertEquals } from "jsr:@std/assert@1";
import {
  cardioKind,
  earnedXp,
  importedFromLabel,
  planCardioImports,
  queuedCardioWindows,
  type HubWorkout,
} from "./healthCardio.ts";

const T0 = Date.parse("2026-10-30T07:00:00Z");
const MIN = 60_000;
const NOW = T0 + 24 * 60 * MIN;

const hk = (over: Partial<HubWorkout> = {}): HubWorkout => ({
  hub: "healthkit",
  externalId: "hk-1",
  activityType: 37, // running
  startMs: T0,
  endMs: T0 + 30 * MIN,
  ...over,
});

Deno.test("a 30 minute watch run becomes an Outdoor Run named Run", () => {
  const [run, ...rest] = planCardioImports([hk({ distanceM: 5012.4 })], [], NOW);
  assertEquals(rest.length, 0);
  assertEquals(run, {
    source: "healthkit",
    externalId: "hk-1",
    exercise: "Outdoor Run",
    name: "Run",
    startedAtIso: "2026-10-30T07:00:00.000Z",
    durationSeconds: 1800,
    distanceM: 5012,
  });
});

Deno.test("an indoor run is a treadmill run; a type with no indoor row keeps the outdoor one", () => {
  assertEquals(cardioKind({ hub: "healthkit", activityType: 37, indoor: true })?.exercise, "Treadmill Run");
  assertEquals(cardioKind({ hub: "healthkit", activityType: 13, indoor: true })?.exercise, "Stationary Bike");
  assertEquals(cardioKind({ hub: "healthkit", activityType: 46, indoor: true })?.exercise, "Swimming");
});

Deno.test("strength, yoga and sports from a watch are not cardio sessions", () => {
  for (const t of [50, 20, 57, 41, 48, 3000]) {
    assertEquals(cardioKind({ hub: "healthkit", activityType: t }), null, `healthkit ${t}`);
  }
  for (const t of [70, 81, 83, 0]) {
    assertEquals(cardioKind({ hub: "health_connect", activityType: t }), null, `health connect ${t}`);
  }
  assertEquals(planCardioImports([hk({ activityType: 50 })], [], NOW), []);
});

Deno.test("Health Connect types map to the same catalog rows", () => {
  assertEquals(cardioKind({ hub: "health_connect", activityType: 56 })?.exercise, "Outdoor Run");
  assertEquals(cardioKind({ hub: "health_connect", activityType: 57 })?.exercise, "Treadmill Run");
  assertEquals(cardioKind({ hub: "health_connect", activityType: 74 })?.exercise, "Swimming");
  assertEquals(cardioKind({ hub: "health_connect", activityType: 54 })?.exercise, "Rowing Machine");
  assertEquals(cardioKind({ hub: "health_connect", activityType: 36 })?.exercise, "HIIT");
});

Deno.test("too short to count: under 5 minutes, or a walk under 20", () => {
  assertEquals(planCardioImports([hk({ endMs: T0 + 4 * MIN })], [], NOW), []);
  assertEquals(planCardioImports([hk({ activityType: 52, endMs: T0 + 15 * MIN })], [], NOW), []);
  assertEquals(planCardioImports([hk({ activityType: 52, endMs: T0 + 25 * MIN })], [], NOW).length, 1);
});

Deno.test("the hub's active time wins over end minus start (a paused run)", () => {
  const [run] = planCardioImports([hk({ endMs: T0 + 40 * MIN, durationSeconds: 1500.6 })], [], NOW);
  assertEquals(run.durationSeconds, 1501);
  // Active time under the floor drops it, however long the clock ran.
  assertEquals(planCardioImports([hk({ endMs: T0 + 40 * MIN, durationSeconds: 120 })], [], NOW), []);
});

Deno.test("a run also logged in the app counts once", () => {
  const busy = [{ startMs: T0 + 5 * MIN, endMs: T0 + 35 * MIN }];
  assertEquals(planCardioImports([hk()], busy, NOW), []);
  // Back to back is not overlap.
  const after = [{ startMs: T0 + 30 * MIN, endMs: T0 + 60 * MIN }];
  assertEquals(planCardioImports([hk()], after, NOW).length, 1);
});

Deno.test("the same run written by two apps imports once, the longer copy", () => {
  const watch = hk({ externalId: "watch", endMs: T0 + 31 * MIN });
  const strava = hk({ externalId: "strava", startMs: T0 + 1 * MIN, endMs: T0 + 30 * MIN });
  const out = planCardioImports([strava, watch], [], NOW);
  assertEquals(out.map((o) => o.externalId), ["watch"]);
});

Deno.test("one id read twice imports once; a workout still going is skipped", () => {
  assertEquals(planCardioImports([hk(), hk()], [], NOW).length, 1);
  assertEquals(planCardioImports([hk({ endMs: NOW + MIN })], [], NOW), []);
});

Deno.test("two separate runs in a day both import, oldest first", () => {
  const evening = hk({ externalId: "pm", startMs: T0 + 600 * MIN, endMs: T0 + 630 * MIN });
  const out = planCardioImports([evening, hk()], [], NOW);
  assertEquals(out.map((o) => o.externalId), ["hk-1", "pm"]);
});

Deno.test("no distance, zero distance and junk distance all save as null", () => {
  assertEquals(planCardioImports([hk()], [], NOW)[0].distanceM, null);
  assertEquals(planCardioImports([hk({ distanceM: 0 })], [], NOW)[0].distanceM, null);
  assertEquals(planCardioImports([hk({ distanceM: Number.NaN })], [], NOW)[0].distanceM, null);
});

Deno.test("queued workouts with a timed cardio set block their time; lifting and warmups do not", () => {
  const start = "2026-10-30T07:00:00.000Z";
  const windows = queuedCardioWindows([
    { startedAtIso: start, durationSeconds: 1800, exercises: [{ def: { muscle_group: "Cardio", metric_type: "distance_duration" }, sets: [{ set_type: "normal" }] }] },
    { startedAtIso: start, durationSeconds: 1800, exercises: [{ def: { muscle_group: "Chest", metric_type: "weight_reps" }, sets: [{}] }] },
    { startedAtIso: start, durationSeconds: 1800, exercises: [{ def: { muscle_group: "Cardio", metric_type: "duration" }, sets: [{ set_type: "warmup" }] }] },
    { startedAtIso: start, durationSeconds: 600, exercises: [{ def: { muscle_group: "Cardio", metric_type: "bodyweight_reps" }, sets: [{}] }] },
  ]);
  assertEquals(windows, [{ startMs: T0, endMs: T0 + 30 * MIN }]);
});

Deno.test("only a workout logged in the app carries XP, so only it refunds XP on delete", () => {
  assertEquals(earnedXp(null), true);
  assertEquals(earnedXp(undefined), true);
  assertEquals(earnedXp("healthkit"), false);
  assertEquals(earnedXp("health_connect"), false);
});

Deno.test("History tag names the hub; an in-app workout has none", () => {
  assertEquals(importedFromLabel("healthkit"), "From Apple Health");
  assertEquals(importedFromLabel("health_connect"), "From Health Connect");
  assertEquals(importedFromLabel(null), null);
  assertEquals(importedFromLabel(undefined), null);
});
