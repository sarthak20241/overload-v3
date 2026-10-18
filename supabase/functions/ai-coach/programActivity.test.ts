import { assertEquals } from "jsr:@std/assert@1";
import { weekActivityForPrompt, withPhaseActivity } from "./programActivity.ts";

const PROGRAM = {
  title: "12-Week Cut",
  phases: [{ seq: 0, name: "Deficit" }, { seq: 1, name: "Diet break" }],
  current_phase: { seq: 0, name: "Deficit", week_in_phase: 2 },
};

Deno.test("each phase carries its own goals; a phase with none gets no key", () => {
  const out = withPhaseActivity(PROGRAM, [
    { seq: 0, activity_steps_target: 10000, cardio_sessions_per_week: 3 },
    { seq: 1, activity_steps_target: null, cardio_sessions_per_week: null },
  ]) as typeof PROGRAM & { phases: Record<string, unknown>[]; current_phase: Record<string, unknown> };
  assertEquals(out.phases[0].activity, { steps_per_day: 10000, cardio_sessions_per_week: 3 });
  assertEquals("activity" in out.phases[1], false);
  assertEquals(out.current_phase.activity, { steps_per_day: 10000, cardio_sessions_per_week: 3 });
});

Deno.test("a stored goal out of bounds reaches the model clamped", () => {
  const out = withPhaseActivity(PROGRAM, [
    { seq: 0, activity_steps_target: 90000, cardio_sessions_per_week: 12 },
  ]) as { phases: Record<string, unknown>[] };
  assertEquals(out.phases[0].activity, { steps_per_day: 30000, cardio_sessions_per_week: 7 });
});

Deno.test("this week's numbers ride on the current phase only", () => {
  const out = withPhaseActivity(
    PROGRAM,
    [{ seq: 0, activity_steps_target: 8000, cardio_sessions_per_week: null }],
    { a_as_of: "2026-10-18", a_steps_days: 5, a_steps_days_met: 3, a_cardio_sessions: 1, r_steps_avg: 7420 },
  ) as { phases: Record<string, unknown>[]; current_phase: Record<string, unknown> };
  assertEquals(out.current_phase.activity_this_week, {
    as_of: "2026-10-18",
    cardio_sessions_done: 1,
    step_days_logged: 5,
    step_days_at_goal: 3,
    steps_avg: 7420,
  });
  assertEquals("activity_this_week" in out.phases[0], false);
});

Deno.test("no goals anywhere leaves the program exactly as it was", () => {
  const rows = [{ seq: 0, activity_steps_target: null, cardio_sessions_per_week: 0 }];
  assertEquals(withPhaseActivity(PROGRAM, rows, { a_cardio_sessions: 2 }), PROGRAM);
  assertEquals(withPhaseActivity(null, rows), null);
});

Deno.test("an empty week row says nothing", () => {
  assertEquals(weekActivityForPrompt(null), null);
  assertEquals(weekActivityForPrompt({ a_cardio_sessions: null, a_steps_days_met: null }), null);
  assertEquals(weekActivityForPrompt({ a_cardio_sessions: 0 }), { cardio_sessions_done: 0 });
});
