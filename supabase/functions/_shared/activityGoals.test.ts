import { assertEquals } from "jsr:@std/assert@1";
import {
  activityText,
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
