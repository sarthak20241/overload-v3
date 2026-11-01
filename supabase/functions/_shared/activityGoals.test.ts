import { assertEquals } from "jsr:@std/assert@1";
import {
  activityText,
  cardioRowsFromWorkouts,
  stepsProgressFromReading,
  cardioLine,
  clampCardioSessions,
  clampStepsTarget,
  countCardioSessions,
  goalProgress,
  hasActivityGoals,
  normalizeActivityGoals,
  shortSteps,
  stepsLine,
} from "./activityGoals.ts";

Deno.test("a step goal is held to 2,000-30,000 on the 500 grid", () => {
  assertEquals(clampStepsTarget(10000), 10000);
  assertEquals(clampStepsTarget(7342), 7500);
  assertEquals(clampStepsTarget(7249), 7000);
  assertEquals(clampStepsTarget(500), 2000);
  assertEquals(clampStepsTarget(1_000_000), 30000);
});

Deno.test("no step goal: zero, negative, missing or not a number", () => {
  assertEquals(clampStepsTarget(0), null);
  assertEquals(clampStepsTarget(-8000), null);
  assertEquals(clampStepsTarget(undefined), null);
  assertEquals(clampStepsTarget(null), null);
  assertEquals(clampStepsTarget("10000"), null);
  assertEquals(clampStepsTarget(NaN), null);
  assertEquals(clampStepsTarget(Infinity), null);
});

Deno.test("cardio sessions are held to 1-7 a week, whole sessions", () => {
  assertEquals(clampCardioSessions(3), 3);
  assertEquals(clampCardioSessions(2.6), 3);
  assertEquals(clampCardioSessions(0.4), 1);
  assertEquals(clampCardioSessions(14), 7);
  assertEquals(clampCardioSessions(0), null);
  assertEquals(clampCardioSessions(-2), null);
  assertEquals(clampCardioSessions("3"), null);
});

Deno.test("the coach's activity block is normalized field by field", () => {
  assertEquals(normalizeActivityGoals({ steps_per_day: 45000, cardio_sessions_per_week: 20 }), {
    steps_per_day: 30000,
    cardio_sessions_per_week: 7,
  });
  assertEquals(normalizeActivityGoals({ steps_per_day: 9000 }), { steps_per_day: 9000, cardio_sessions_per_week: null });
  assertEquals(normalizeActivityGoals(undefined), { steps_per_day: null, cardio_sessions_per_week: null });
  assertEquals(normalizeActivityGoals("10k steps"), { steps_per_day: null, cardio_sessions_per_week: null });
  assertEquals(hasActivityGoals({ steps_per_day: null, cardio_sessions_per_week: null }), false);
  assertEquals(hasActivityGoals({ steps_per_day: null, cardio_sessions_per_week: 2 }), true);
});

Deno.test("a cardio session is a workout with a done, timed, non-warmup Cardio set", () => {
  const run = { muscle_group: "Cardio", metric_type: "distance_duration", completed: true, set_type: "normal" };
  const sessions = countCardioSessions([
    // Two runs in one workout: one session.
    { workout_id: "w1", ...run },
    { workout_id: "w1", ...run },
    // A bike session.
    { workout_id: "w2", muscle_group: "Cardio", metric_type: "resistance_duration", completed: true },
    // A treadmill warmup before squats: not a cardio day.
    { workout_id: "w3", ...run, set_type: "warmup" },
    // A cardio set left undone.
    { workout_id: "w4", ...run, completed: false },
    // A plank is timed but not Cardio.
    { workout_id: "w5", muscle_group: "Core", metric_type: "duration", completed: true },
    // Burpees counted in reps: not a timed cardio set.
    { workout_id: "w6", muscle_group: "Cardio", metric_type: "bodyweight_reps", completed: true },
  ]);
  assertEquals(sessions, 2);
  assertEquals(countCardioSessions([]), 0);
});

Deno.test("progress: what is done, what is left, and the bar", () => {
  assertEquals(goalProgress(6240, 10000), { done: 6240, target: 10000, left: 3760, met: false, fraction: 0.624 });
  assertEquals(goalProgress(12000, 10000), { done: 12000, target: 10000, left: 0, met: true, fraction: 1 });
  assertEquals(goalProgress(3, 3)?.met, true);
  // No reading yet counts as nothing done, not as no goal.
  assertEquals(goalProgress(null, 3), { done: 0, target: 3, left: 3, met: false, fraction: 0 });
  assertEquals(goalProgress(-5, 3)?.done, 0);
  // No goal: nothing to show.
  assertEquals(goalProgress(5000, null), null);
  assertEquals(goalProgress(5000, 0), null);
});

Deno.test("the lines read like a coach, short numbers for steps", () => {
  assertEquals(shortSteps(10000), "10k");
  assertEquals(shortSteps(7500), "7.5k");
  assertEquals(shortSteps(3760), "3.8k");
  assertEquals(shortSteps(640), "640");
  assertEquals(stepsLine(goalProgress(6240, 10000)!), "3.8k steps to go");
  assertEquals(stepsLine(goalProgress(10400, 10000)!), "Steps done for today");
  assertEquals(cardioLine(goalProgress(1, 3)!), "2 cardio sessions left this week");
  assertEquals(cardioLine(goalProgress(2, 3)!), "1 cardio session left this week");
  assertEquals(cardioLine(goalProgress(3, 3)!), "Cardio done this week");
});

Deno.test("one line per phase for the recap and the card", () => {
  assertEquals(activityText({ steps_per_day: 10000, cardio_sessions_per_week: 3 }), "10,000 steps a day, 3 cardio sessions a week");
  assertEquals(activityText({ steps_per_day: null, cardio_sessions_per_week: 1 }), "1 cardio session a week");
  assertEquals(activityText({ steps_per_day: 8500, cardio_sessions_per_week: null }), "8,500 steps a day");
  assertEquals(activityText({ steps_per_day: null, cardio_sessions_per_week: null }), "none");
});

Deno.test("no step reading today hides the bar, and 0 is no reading", () => {
  assertEquals(stepsProgressFromReading(undefined, 10000), null);
  assertEquals(stepsProgressFromReading(null, 10000), null);
  // Health Connect writes 0 for a day with no data (0142 steps_zero), so 0 is
  // not "0 steps walked".
  assertEquals(stepsProgressFromReading(0, 10000), null);
  assertEquals(stepsProgressFromReading("0", 10000), null);
  assertEquals(stepsProgressFromReading(1, 10000)?.done, 1);
  // PostgREST sends numeric columns as strings.
  assertEquals(stepsProgressFromReading("6240", 10000)?.left, 3760);
  assertEquals(stepsProgressFromReading("n/a", 10000), null);
  assertEquals(stepsProgressFromReading(6240, null), null);
});

Deno.test("nested workouts flatten into cardio rows", () => {
  const rows = cardioRowsFromWorkouts([
    { id: "w1", workout_sets: [
      { completed: true, set_type: "normal", exercises: { muscle_group: "Cardio", metric_type: "distance_duration" } },
      { completed: true, set_type: "normal", exercises: { muscle_group: "Quads", metric_type: "weight_reps" } },
    ] },
    { id: "w2", workout_sets: null },
    { id: "w3", workout_sets: [{ completed: true, exercises: null }] },
  ]);
  assertEquals(rows.length, 3);
  assertEquals(rows[0], { workout_id: "w1", completed: true, set_type: "normal", muscle_group: "Cardio", metric_type: "distance_duration", source: null, day: null });
  assertEquals(rows[2].muscle_group, null);
  assertEquals(countCardioSessions(rows), 1);
});

Deno.test("an imported run and an in-app cardio session on the same day count once", () => {
  const run = { muscle_group: "Cardio", metric_type: "distance_duration", completed: true, set_type: "normal" };
  // The watch run came in first (7 am); "Log one you did" that evening guessed 6 pm.
  const sameDay = [
    { workout_id: "watch", ...run, source: "healthkit", day: "2026-11-03" },
    { workout_id: "logged", ...run, source: null, day: "2026-11-03" },
  ];
  assertEquals(countCardioSessions(sameDay), 1);
  // Health Connect the same way.
  assertEquals(countCardioSessions([{ ...sameDay[0], source: "health_connect" }, sameDay[1]]), 1);
});

Deno.test("an imported run still counts beside a lifting day, or an in-app session on another day", () => {
  const run = { muscle_group: "Cardio", metric_type: "distance_duration", completed: true, set_type: "normal" };
  assertEquals(countCardioSessions([
    { workout_id: "watch", ...run, source: "healthkit", day: "2026-11-03" },
    // Squats that day, with a treadmill warmup: not a cardio session, so it hides nothing.
    { workout_id: "legs", ...run, set_type: "warmup", source: null, day: "2026-11-03" },
    { workout_id: "legs", muscle_group: "Quads", metric_type: "weight_reps", completed: true, source: null, day: "2026-11-03" },
  ]), 1);
  assertEquals(countCardioSessions([
    { workout_id: "watch", ...run, source: "healthkit", day: "2026-11-03" },
    { workout_id: "logged", ...run, source: null, day: "2026-11-04" },
  ]), 2);
  // Two in-app sessions on one day are two: only an import gives way.
  assertEquals(countCardioSessions([
    { workout_id: "am", ...run, source: null, day: "2026-11-03" },
    { workout_id: "pm", ...run, source: null, day: "2026-11-03" },
  ]), 2);
});

Deno.test("nested workouts carry their source and local day into the rows", () => {
  const set = { completed: true, set_type: "normal", exercises: { muscle_group: "Cardio", metric_type: "distance_duration" } };
  const rows = cardioRowsFromWorkouts([
    { id: "watch", source: "healthkit", started_at: new Date(2026, 10, 3, 7).toISOString(), workout_sets: [set] },
    { id: "logged", source: null, started_at: new Date(2026, 10, 3, 17, 30).toISOString(), workout_sets: [set] },
  ]);
  assertEquals(rows.map((r) => [r.source, r.day]), [["healthkit", "2026-11-03"], [null, "2026-11-03"]]);
  assertEquals(countCardioSessions(rows), 1);
});
