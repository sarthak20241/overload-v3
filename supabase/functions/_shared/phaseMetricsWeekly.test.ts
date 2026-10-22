import { assertEquals } from "jsr:@std/assert@1";
import {
  activePhaseIndex,
  addDays,
  bestOfSets,
  mondayOf,
  stampWeekFor,
  checkDue,
  checkMetric,
  checkMetrics,
  currentValueFor,
  EMPTY_READINGS,
  meanPositive,
  proteinDaysOf,
  setsForMuscle,
  weekInPhaseOn,
  type MetricToCheck,
  type WeeklyReadings,
} from "./phaseMetricsWeekly.ts";

const readings = (over: Partial<WeeklyReadings>): WeeklyReadings => ({ ...EMPTY_READINGS, ...over });

const metric = (over: Partial<MetricToCheck> & { kind: MetricToCheck["kind"] }): MetricToCheck => ({
  id: "m1", direction: "up", start_value: null, target_value: 1, current_value: null, ...over,
});

Deno.test("each kind reads its own source", () => {
  const r = readings({
    bodyweight: 70.4,
    e1rm_by_exercise: { "ex-bench": 104.5 },
    sets_by_muscle: { Chest: 10, "Upper Chest": 4, Back: 12 },
    sessions: 3, cardio_sessions: 1, steps_avg: 7400, sleep_avg_h: 6.9, protein_days: 5,
    distance_best_km: 5.2, duration_best_min: 32,
    custom_latest: { m9: 12 },
  });
  assertEquals(currentValueFor(metric({ kind: "bodyweight" }), r), 70.4);
  assertEquals(currentValueFor(metric({ kind: "lift_e1rm", ref: { exercise_id: "ex-bench", exercise_name: "Bench" } }), r), 104.5);
  // The group plus its finer heads.
  assertEquals(currentValueFor(metric({ kind: "sets_per_muscle", ref: { muscle: "Chest" } }), r), 14);
  assertEquals(currentValueFor(metric({ kind: "steps" }), r), 7400);
  assertEquals(currentValueFor(metric({ kind: "sessions_per_week" }), r), 3);
  assertEquals(currentValueFor(metric({ kind: "cardio_sessions" }), r), 1);
  assertEquals(currentValueFor(metric({ kind: "sleep_hours" }), r), 6.9);
  assertEquals(currentValueFor(metric({ kind: "protein_days" }), r), 5);
  assertEquals(currentValueFor(metric({ kind: "distance" }), r), 5.2);
  assertEquals(currentValueFor(metric({ kind: "duration" }), r), 32);
  // Named: that exercise's own best, never the any-exercise one.
  const named = readings({ duration_best_min: 32, best_by_metric: { "m-plank": 2.5 } });
  assertEquals(currentValueFor(metric({ id: "m-plank", kind: "duration", ref: { exercise_name: "Plank", exercise_id: "ex-plank" } }), named), 2.5);
  assertEquals(currentValueFor(metric({ id: "m-other", kind: "duration", ref: { exercise_name: "Row", exercise_id: "ex-row" } }), named), null);
  // Named but not yet resolved to an id: still never another exercise's set.
  assertEquals(currentValueFor(metric({ id: "m-new", kind: "duration", ref: { exercise_name: "Plank" } }), named), null);
  assertEquals(currentValueFor(metric({ id: "m9", kind: "custom", ref: { name: "Hold" } }), r), 12);
});

Deno.test("a lift with no resolved exercise id, and a custom metric never logged, read nothing", () => {
  const r = readings({ e1rm_by_exercise: { "ex-bench": 104.5 }, custom_latest: {} });
  assertEquals(currentValueFor(metric({ kind: "lift_e1rm", ref: { exercise_name: "Bench" } }), r), null);
  assertEquals(currentValueFor(metric({ id: "m2", kind: "custom", ref: { name: "Hold" } }), r), null);
  assertEquals(setsForMuscle({ Back: 12 }, "Chest"), null);
});

Deno.test("a weekly kind with nothing this week drops its stale number and reads due", () => {
  const steps = metric({ kind: "steps", target_value: 8000, current_value: 7900 });
  assertEquals(checkMetric(steps, readings({ steps_avg: null }), 0.5), { id: "m1", current_value: null, status: "due" });
  assertEquals(checkMetric(steps, readings({ steps_avg: 8100 }), 0.5), { id: "m1", current_value: 8100, status: "on_track" });
});

Deno.test("in the phase's first week a weekly kind is not judged on the week before", () => {
  const steps = metric({ kind: "steps", target_value: 8000 });
  // Last week belonged to the previous phase (or no program): no verdict yet.
  assertEquals(checkMetric(steps, readings({ steps_avg: 4000 }), 0, true), { id: "m1", current_value: null, status: "set" });
  // A progress kind still takes its reading: the scale is the scale.
  const bw = metric({ kind: "bodyweight", direction: "down", start_value: 71, target_value: 69.6 });
  assertEquals(checkMetric(bw, readings({ bodyweight: 70.9 }), 0, true).current_value, 70.9);
  // After the first week the same reading is judged.
  assertEquals(checkMetric(steps, readings({ steps_avg: 4000 }), 0.3, false).status, "behind");
});

Deno.test("a progress kind with no weigh-in this week keeps its last reading", () => {
  const bw = metric({ kind: "bodyweight", direction: "down", start_value: 71, target_value: 69.6, current_value: 70.4 });
  assertEquals(checkMetric(bw, readings({ bodyweight: null }), 0.5), { id: "m1", current_value: 70.4, status: "on_track" });
});

Deno.test("the first reading of a progress metric with no start becomes its start", () => {
  const bench = metric({ kind: "lift_e1rm", ref: { exercise_id: "ex", exercise_name: "Bench" }, target_value: 110 });
  assertEquals(checkMetric(bench, readings({ e1rm_by_exercise: { ex: 100 } }), 0.3), {
    id: "m1", current_value: 100, status: "on_track", start_value: 100,
  });
  // A hold metric needs no start.
  const hold = metric({ kind: "bodyweight", direction: "hold", target_value: 70 });
  assertEquals(checkMetric(hold, readings({ bodyweight: 70.2 }), 0.3), { id: "m1", current_value: 70.2, status: "on_track" });
});

Deno.test("a phase is checked metric by metric", () => {
  const out = checkMetrics([
    metric({ id: "a", kind: "bodyweight", direction: "down", start_value: 71, target_value: 69.6 }),
    metric({ id: "b", kind: "protein_days", target_value: 5 }),
  ], readings({ bodyweight: 70.5, protein_days: 3 }), 0.5);
  assertEquals(out.map((o) => `${o.id}:${o.status}`), ["a:close", "b:slipping"]);
});

Deno.test("readings from rows: means, protein days, the longest set", () => {
  assertEquals(meanPositive([8000, 0, null, 6000]), 7000);
  assertEquals(meanPositive([0, null]), null);
  assertEquals(proteinDaysOf([{ protein_g: 150 }, { protein_g: 120 }, { protein_g: 151 }], 150), 2);
  assertEquals(proteinDaysOf([], 150), null);
  assertEquals(proteinDaysOf([{ protein_g: 150 }], null), null);
  assertEquals(bestOfSets([
    { distance_m: 3000, completed: true }, { distance_m: 5200, duration_seconds: 1920, completed: true },
    { distance_m: 9000, completed: false },
  ]), { distance_best_km: 5.2, duration_best_min: 32 });
  assertEquals(bestOfSets([]), { distance_best_km: null, duration_best_min: null });
});

Deno.test("the running phase and its week, from the start date", () => {
  const phases = [{ duration_weeks: 2, start_offset_weeks: 0 }, { duration_weeks: 3, start_offset_weeks: 2 }];
  assertEquals(activePhaseIndex("2026-10-05", phases, "2026-10-04"), null);
  assertEquals(activePhaseIndex("2026-10-05", phases, "2026-10-18"), 0);
  assertEquals(activePhaseIndex("2026-10-05", phases, "2026-10-19"), 1);
  assertEquals(activePhaseIndex("2026-10-05", phases, "2026-11-09"), null);
  assertEquals(weekInPhaseOn("2026-10-05", phases[1], "2026-10-26"), 2);
});

Deno.test("the Monday of a day, and the week another phase's rows are stamped with", () => {
  assertEquals(mondayOf("2026-10-22"), "2026-10-19"); // a Thursday
  assertEquals(mondayOf("2026-10-19"), "2026-10-19"); // a Monday
  assertEquals(mondayOf("2026-10-25"), "2026-10-19"); // a Sunday
  assertEquals(addDays("2026-10-31", 1), "2026-11-01");
  // Program starts Monday 2026-10-05. Phase 0: weeks 1-4 (to Nov 1).
  // Phase 1 starts Monday Nov 2; phase 2 starts Monday Nov 23.
  const start = "2026-10-05";
  // This week is Oct 19. The running phase and any past phase: this week.
  assertEquals(stampWeekFor(start, { start_offset_weeks: 0 }, "2026-10-19"), "2026-10-19");
  // A phase that starts Nov 2: the Monday before its start week, Oct 26, so
  // it reads as due from the week of Nov 2 on, not before.
  assertEquals(stampWeekFor(start, { start_offset_weeks: 4 }, "2026-10-19"), "2026-10-26");
  // A program that starts mid-week (Thursday Oct 29): its first phase is
  // stamped Oct 19, so the week of Oct 26 (which holds the start) lists it.
  assertEquals(stampWeekFor("2026-10-29", { start_offset_weeks: 0 }, "2026-10-19"), "2026-10-19");
});

Deno.test("a check is due once a local week, whatever the UTC clock says", () => {
  assertEquals(checkDue([{ checked_week: null }], "2026-10-19"), true);
  assertEquals(checkDue([{ checked_week: "2026-10-12" }], "2026-10-19"), true);
  assertEquals(checkDue([{ checked_week: "2026-10-19" }], "2026-10-19"), false);
  // A check made at 00:30 Monday in Kolkata is stamped Sunday 19:00 UTC; it
  // belongs to the local week all the same and is not due again.
  assertEquals(checkDue([{ checked_week: "2026-10-19" }], "2026-10-19"), false);
  assertEquals(checkDue([], "2026-10-19"), false);
});
