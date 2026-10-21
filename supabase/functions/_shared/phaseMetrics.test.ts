import { assertEquals } from "jsr:@std/assert@1";
import {
  chartKindOf,
  cleanLine,
  defaultJobText,
  formatMetricValue,
  heroOf,
  jobFraction,
  metricLabel,
  metricRowName,
  normalizeMetric,
  normalizeMetrics,
  phaseProgress,
  statusFor,
  statusTone,
  type StatusInput,
} from "./phaseMetrics.ts";

// ── Status rules: progress kinds ─────────────────────────────────────────────

const cut = (current: number | null, progress: number, start: number | null = 71.0): StatusInput =>
  ({ kind: "bodyweight", direction: "down", start_value: start, target_value: 69.6, current_value: current, progress });

Deno.test("a cut at pace is on track, reaching the target is done", () => {
  // 1.4 kg to lose; 0.7 gone at half the phase = exactly on pace.
  assertEquals(statusFor(cut(70.3, 0.5)), "on_track");
  // Ahead of pace is still on track.
  assertEquals(statusFor(cut(69.9, 0.5)), "on_track");
  assertEquals(statusFor(cut(69.6, 0.9)), "done");
  assertEquals(statusFor(cut(69.4, 0.2)), "done");
});

Deno.test("a cut behind pace reads close, then slipping, then behind", () => {
  // Half the phase gone (p = 0.5). a = share of the 1.4 kg done.
  assertEquals(statusFor(cut(70.5, 0.5)), "close");    // a = 0.36, 14 points behind
  assertEquals(statusFor(cut(70.75, 0.5)), "slipping"); // a = 0.18, 32 points behind
  assertEquals(statusFor(cut(70.8, 0.5)), "slipping");  // a = 0.14, 36 points behind
  assertEquals(statusFor(cut(71.0, 0.7)), "behind");   // a = 0, 70 points behind
});

Deno.test("moving the wrong way after the first quarter is behind, before it is not yet judged", () => {
  assertEquals(statusFor(cut(71.3, 0.3)), "behind");
  // The first days of a phase: scale noise is not a verdict.
  assertEquals(statusFor(cut(71.2, 0.1)), "close");
});

Deno.test("no reading yet is set; no start value makes the first reading the start", () => {
  assertEquals(statusFor(cut(null, 0.5)), "set");
  assertEquals(statusFor(cut(70.9, 0.8, null)), "on_track");
});

Deno.test("a lift pushed up is judged the same way, upward", () => {
  const bench = (current: number, progress: number): StatusInput =>
    ({ kind: "lift_e1rm", direction: "up", start_value: 100, target_value: 110, current_value: current, progress });
  assertEquals(statusFor(bench(105, 0.5)), "on_track");
  assertEquals(statusFor(bench(103, 0.5)), "close");
  assertEquals(statusFor(bench(101, 0.5)), "slipping");
  assertEquals(statusFor(bench(100, 0.8)), "behind");
  assertEquals(statusFor(bench(112, 0.4)), "done");
});

Deno.test("a hold target is judged by a band around it", () => {
  const hold = (current: number): StatusInput =>
    ({ kind: "bodyweight", direction: "hold", start_value: 70, target_value: 70, current_value: current, progress: 0.5 });
  assertEquals(statusFor(hold(70.5)), "on_track");  // inside 1.5% (1.05 kg)
  assertEquals(statusFor(hold(71.5)), "close");     // inside 3%
  assertEquals(statusFor(hold(73.0)), "slipping");  // inside 6%
  assertEquals(statusFor(hold(75.0)), "behind");
});

// ── Status rules: weekly kinds ───────────────────────────────────────────────

const steps = (current: number | null, progress = 0.5): StatusInput =>
  ({ kind: "steps", direction: "up", start_value: null, target_value: 8000, current_value: current, progress });

Deno.test("a weekly target reads last week against the number", () => {
  assertEquals(statusFor(steps(8200)), "on_track");
  assertEquals(statusFor(steps(8000)), "on_track");
  assertEquals(statusFor(steps(7400)), "close");    // 92%
  assertEquals(statusFor(steps(5600)), "slipping"); // 70%
  assertEquals(statusFor(steps(4000)), "behind");   // 50%
});

Deno.test("a weekly target with nothing logged is set before the first week and due after", () => {
  assertEquals(statusFor(steps(null, 0)), "set");
  assertEquals(statusFor(steps(null, 0.2)), "due");
});

Deno.test("a weekly target never reads done: every week starts again", () => {
  assertEquals(statusFor({ kind: "sessions_per_week", direction: "up", start_value: null, target_value: 4, current_value: 5, progress: 0.9 }), "on_track");
});

Deno.test("a weekly target to keep under reads the other way", () => {
  const under = (current: number): StatusInput =>
    ({ kind: "sessions_per_week", direction: "down", start_value: null, target_value: 4, current_value: current, progress: 0.5 });
  assertEquals(statusFor(under(4)), "on_track");
  assertEquals(statusFor(under(5)), "slipping");  // 125%
  assertEquals(statusFor(under(6)), "behind");    // 150%
});

Deno.test("the chart follows the family: bars for a habit, a line for a number", () => {
  assertEquals(chartKindOf("sessions_per_week"), "bars");
  assertEquals(chartKindOf("steps"), "bars");
  assertEquals(chartKindOf("bodyweight"), "line");
  assertEquals(chartKindOf("custom"), "line");
  assertEquals(chartKindOf("lift_e1rm"), "line");
});

// ── Job bar and phase progress ───────────────────────────────────────────────

Deno.test("the job bar holds to 0..1 and reads a weekly kind against its target", () => {
  const f = jobFraction({ kind: "bodyweight", direction: "down", start_value: 71.0, target_value: 69.6, current_value: 70.4 });
  assertEquals(Math.round(f * 100), 43);
  assertEquals(jobFraction({ kind: "bodyweight", direction: "down", start_value: 71.0, target_value: 69.6, current_value: 69.0 }), 1);
  assertEquals(jobFraction({ kind: "bodyweight", direction: "down", start_value: 71.0, target_value: 69.6, current_value: 72.0 }), 0);
  assertEquals(jobFraction({ kind: "sessions_per_week", direction: "up", target_value: 4, current_value: 3 }), 0.75);
  assertEquals(jobFraction({ kind: "steps", direction: "up", target_value: 8000, current_value: null }), 0);
});

Deno.test("phase progress is the whole weeks gone over the phase length", () => {
  assertEquals(phaseProgress(1, 4), 0);
  assertEquals(phaseProgress(3, 4), 0.5);
  assertEquals(phaseProgress(5, 4), 1);
  assertEquals(phaseProgress(null, 4), 0);
});

// ── Normalizer ───────────────────────────────────────────────────────────────

Deno.test("a coach metric is kept with its kind's unit and direction", () => {
  assertEquals(normalizeMetric({ kind: "steps", target: 8000, hero: false }), {
    kind: "steps", is_hero: false, direction: "up", unit: "steps", target_value: 8000,
  });
  assertEquals(normalizeMetric({ kind: "lift_e1rm", exercise: "Bench Press", target: 110, start: 100 }), {
    kind: "lift_e1rm", is_hero: false, direction: "up", unit: "kg", target_value: 110, start_value: 100, ref: { exercise_name: "Bench Press" },
  });
});

Deno.test("bodyweight takes its direction from the start and target; custom carries its own unit", () => {
  assertEquals(normalizeMetric({ kind: "bodyweight", start: 72.5, target: 69.6 })?.direction, "down");
  assertEquals(normalizeMetric({ kind: "bodyweight", start: 66, target: 70 })?.direction, "up");
  assertEquals(normalizeMetric({ kind: "bodyweight", target: 70 })?.direction, "hold");
  assertEquals(normalizeMetric({ kind: "custom", name: "Handstand hold", unit: "s", target: 15, direction: "up" }), {
    kind: "custom", is_hero: false, direction: "up", unit: "s", target_value: 15, ref: { name: "Handstand hold" },
  });
});

Deno.test("a metric with no way to read it is dropped", () => {
  assertEquals(normalizeMetric({ kind: "lift_e1rm", target: 110 }), null);          // which lift?
  assertEquals(normalizeMetric({ kind: "sets_per_muscle", target: 12 }), null);     // which muscle?
  assertEquals(normalizeMetric({ kind: "custom", unit: "s", target: 15 }), null);   // called what?
  assertEquals(normalizeMetric({ kind: "vibes", target: 10 }), null);
  assertEquals(normalizeMetric({ kind: "steps" }), null);                           // no target
});

Deno.test("targets are held to their kind's bounds", () => {
  assertEquals(normalizeMetric({ kind: "steps", target: 90000 })?.target_value, 40000);
  assertEquals(normalizeMetric({ kind: "sleep_hours", target: 2 })?.target_value, 4);
  assertEquals(normalizeMetric({ kind: "protein_days", target: 9 })?.target_value, 7);
});

Deno.test("a phase's list keeps at most five and exactly one hero", () => {
  const list = normalizeMetrics([
    { kind: "steps", target: 8000 },
    { kind: "sleep_hours", target: 7, hero: true },
    { kind: "protein_days", target: 5, hero: true },
    { kind: "bad" },
    { kind: "sessions_per_week", target: 4 },
    { kind: "cardio_sessions", target: 2 },
    { kind: "bodyweight", target: 70 },
    { kind: "lift_e1rm", exercise: "Squat", target: 140 },
  ]);
  assertEquals(list.length, 5);
  assertEquals(list.map((m) => m.is_hero), [false, true, false, false, false]);
  assertEquals(heroOf(list)?.kind, "sleep_hours");
});

Deno.test("with no hero marked the first metric is the hero; no list is no metrics", () => {
  const list = normalizeMetrics([{ kind: "steps", target: 8000 }, { kind: "sleep_hours", target: 7 }]);
  assertEquals(list.map((m) => m.is_hero), [true, false]);
  assertEquals(normalizeMetrics(undefined), []);
  assertEquals(normalizeMetrics("steps"), []);
});

// ── Labels ───────────────────────────────────────────────────────────────────

Deno.test("labels and row names read like the card", () => {
  assertEquals(metricLabel({ kind: "lift_e1rm", ref: { exercise_name: "Bench Press" } }), "Bench Press e1RM");
  assertEquals(metricLabel({ kind: "sets_per_muscle", ref: { muscle: "Chest" } }), "Chest sets");
  assertEquals(metricLabel({ kind: "custom", ref: { name: "Handstand hold" } }), "Handstand hold");
  assertEquals(metricRowName({ kind: "steps", target_value: 8000, unit: "steps", direction: "up" }), "Steps 8,000");
  assertEquals(metricRowName({ kind: "sleep_hours", target_value: 7, unit: "h", direction: "up" }), "Sleep 7h+");
  assertEquals(metricRowName({ kind: "cardio_sessions", target_value: 2, unit: "sessions", direction: "up" }), "Cardio 2 a week");
});

Deno.test("values print in the kind's precision", () => {
  assertEquals(formatMetricValue("bodyweight", 70.44), "70.4");
  assertEquals(formatMetricValue("steps", 7400), "7,400");
  assertEquals(formatMetricValue("lift_e1rm", 109.6), "110");
  assertEquals(formatMetricValue("custom", 12), "12");
  assertEquals(formatMetricValue("custom", 12.25), "12.3");
});

Deno.test("the default job line names the move", () => {
  assertEquals(defaultJobText({ kind: "bodyweight", direction: "down", unit: "kg", start_value: 71.0, target_value: 69.6 }), "Bring weight 71.0 to 69.6 kg");
  assertEquals(defaultJobText({ kind: "lift_e1rm", ref: { exercise_name: "Bench Press" }, direction: "up", unit: "kg", target_value: 110 }), "Push Bench Press e1RM to 110 kg");
  assertEquals(defaultJobText({ kind: "sessions_per_week", direction: "up", unit: "sessions", target_value: 4 }), "Train 4 times a week");
  assertEquals(defaultJobText({ kind: "custom", ref: { name: "Handstand hold" }, direction: "up", unit: "s", start_value: 10, target_value: 15 }), "Push Handstand hold 10 to 15 s");
});

Deno.test("status words take the card's colours", () => {
  assertEquals(statusTone("on_track"), "ok");
  assertEquals(statusTone("close"), "ok");
  assertEquals(statusTone("slipping"), "warn");
  assertEquals(statusTone("behind"), "warn");
  assertEquals(statusTone("due"), "dim");
  assertEquals(statusTone("set"), "dim");
});

Deno.test("a coach line is kept only when it reads as one", () => {
  assertEquals(cleanLine("On pace. Protein is the one slipping."), "On pace. Protein is the one slipping.");
  assertEquals(cleanLine("On pace — keep going"), null);
  assertEquals(cleanLine("ok"), null);
  assertEquals(cleanLine("x".repeat(200)), null);
  assertEquals(cleanLine(42), null);
});
