// Run with: deno test --allow-all --unstable-sloppy-imports lib/cardioLog.test.ts
//
// Every case pins "now" to Wednesday 4 Nov 2026, 19:30 local. The week starts
// Monday 2 Nov.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildCardioLogEntry, cardioChoices, cardioDays, cardioStartedAt, queuedCardioRows,
  takeCardioStart, setCardioStart, CARDIO_START_TTL_MS, type CardioExercise,
} from "./cardioLog.ts";
import { countCardioSessions, isCardioSet } from "./activityGoals.ts";

const NOW = new Date(2026, 10, 4, 19, 30); // Wed 4 Nov 2026
const WEEK_START = new Date(2026, 10, 2); // Mon 2 Nov
const RUN: CardioExercise = { id: "run-id", name: "Outdoor Run", category: "Bodyweight", metric_type: "distance_duration" };
const ROPE: CardioExercise = { id: null, name: "Jump Rope", category: "Other", metric_type: "duration" };

const log = (over: Partial<Parameters<typeof buildCardioLogEntry>[0]> = {}) =>
  buildCardioLogEntry({
    clientId: "c1", ownerId: "u1", exercise: RUN, minutes: 30, distanceKm: 5, dayIso: "2026-11-04", now: NOW, ...over,
  });

Deno.test("a logged session counts as one cardio session this week", () => {
  const rows = queuedCardioRows([log()], WEEK_START, new Set());
  assert(rows.every(isCardioSet));
  assertEquals(countCardioSessions(rows), 1);
});

Deno.test("two logged sessions count as two; one already on the server counts once", () => {
  const a = log({ clientId: "a" });
  const b = log({ clientId: "b", dayIso: "2026-11-03" });
  assertEquals(countCardioSessions(queuedCardioRows([a, b], WEEK_START, new Set())), 2);
  assertEquals(countCardioSessions(queuedCardioRows([a, b], WEEK_START, new Set(["a"]))), 1);
});

Deno.test("a session logged for last week does not count this week", () => {
  const lastSunday = log({ dayIso: "2026-11-01" });
  assertEquals(countCardioSessions(queuedCardioRows([lastSunday], WEEK_START, new Set())), 0);
});

Deno.test("the logged set carries the time, and distance only when the exercise has it", () => {
  const run = log();
  assertEquals(run.durationSeconds, 1800);
  assertEquals(run.exercises[0].sets[0].duration_seconds, 1800);
  assertEquals(run.exercises[0].sets[0].distance_m, 5000);
  assertEquals(run.exercises[0].sets[0].set_type, "normal");
  assertEquals(run.exercises[0].resolvedExerciseId, "run-id");

  const rope = log({ exercise: ROPE, distanceKm: 3 });
  assertEquals(rope.exercises[0].sets[0].distance_m, null);
  // Offline fallback row: no id, so the flusher resolves it by name.
  assertEquals(rope.exercises[0].resolvedExerciseId, null);
  assertEquals(rope.exercises[0].def.metric_type, "duration");

  assertEquals(log({ distanceKm: 0 }).exercises[0].sets[0].distance_m, null);
});

Deno.test("a warmup set in a queued lifting day is not a cardio session", () => {
  const lifting = {
    clientId: "w",
    startedAtIso: new Date(2026, 10, 3, 18).toISOString(),
    exercises: [
      { def: { muscle_group: "Cardio", metric_type: "distance_duration" }, sets: [{ set_type: "warmup" }] },
      { def: { muscle_group: "Quads", metric_type: "weight_reps" }, sets: [{ set_type: "normal" }] },
    ],
  };
  assertEquals(countCardioSessions(queuedCardioRows([lifting], WEEK_START, new Set())), 0);
});

Deno.test("today ends now; an earlier day ends at 6 pm; never before that day's midnight", () => {
  assertEquals(cardioStartedAt("2026-11-04", 30, NOW).getTime(), new Date(2026, 10, 4, 19, 0).getTime());
  assertEquals(cardioStartedAt("2026-11-02", 45, NOW).getTime(), new Date(2026, 10, 2, 17, 15).getTime());
  const early = new Date(2026, 10, 4, 0, 20);
  assertEquals(cardioStartedAt("2026-11-04", 60, early).getTime(), new Date(2026, 10, 4, 0, 0).getTime());
  assert(cardioStartedAt("2026-11-04", 30, NOW).getTime() <= NOW.getTime());
});

Deno.test("minutes are held to 5..240", () => {
  assertEquals(log({ minutes: 1 }).durationSeconds, 300);
  assertEquals(log({ minutes: 999 }).durationSeconds, 240 * 60);
});

Deno.test("the day choices are today and the six before it, never a future day", () => {
  const days = cardioDays(NOW);
  assertEquals(days.length, 7);
  assertEquals(days[0], { iso: "2026-11-04", label: "Today" });
  assertEquals(days[1], { iso: "2026-11-03", label: "Yesterday" });
  assertEquals(days[6].iso, "2026-10-29");
  assertEquals(days[2].label, "Mon");
});

Deno.test("choices: timed Cardio only, Burpee and lifts left out, popular first, no repeats", () => {
  const choices = cardioChoices([
    { id: "1", name: "Swimming", category: "Other", muscle_group: "Cardio", metric_type: "distance_duration" },
    { id: "2", name: "Burpee", category: "Bodyweight", muscle_group: "Cardio", metric_type: "bodyweight_reps" },
    { id: "3", name: "Bench Press", category: "Barbell", muscle_group: "Chest", metric_type: "weight_reps" },
    { id: "4", name: "Outdoor Run", category: "Bodyweight", muscle_group: "Cardio", metric_type: "distance_duration" },
    { id: "5", name: "outdoor run", category: "Bodyweight", muscle_group: "Cardio", metric_type: "distance_duration" },
    { id: "6", name: "Assault Bike", category: "Machine", muscle_group: "Cardio", metric_type: "resistance_duration" },
  ]);
  assertEquals(choices.map((c) => c.name), ["Outdoor Run", "Assault Bike", "Swimming"]);
});

Deno.test("the start hand-off is taken once", () => {
  setCardioStart(RUN);
  assertEquals(takeCardioStart()?.name, "Outdoor Run");
  assertEquals(takeCardioStart(), null);
});

Deno.test("a start hand-off nobody took goes stale: a later new workout starts empty", () => {
  setCardioStart(RUN, 1_000);
  assertEquals(takeCardioStart(1_000 + CARDIO_START_TTL_MS + 1), null);
  // Still taken in time when the workout screen opens right away.
  setCardioStart(RUN, 1_000);
  assertEquals(takeCardioStart(1_000 + 2_000)?.name, "Outdoor Run");
});
