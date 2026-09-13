// Run with: deno test supabase/functions/_shared/dailySuggestion.test.ts
//
// The server makes each user's TODAY pick at THEIR local midnight, from a
// runtime whose clock is UTC. These pin that the server sees the user's days
// the way their phone does.

import { assertEquals } from "jsr:@std/assert@1";
import { buildSuggestion, type SuggestionProgram, type SuggestionRoutine } from "./dailySuggestion.ts";
import { wallClock, isTimeZone } from "./wallClock.ts";

const PH = "phase-1";
const program: SuggestionProgram = {
  id: "prog-1",
  start_date: "2026-09-13",
  phases: [{
    id: PH, duration_weeks: 4, start_offset_weeks: 0,
    training_block: { split_type: "Push/Pull/Legs", days_per_week: 5, week_pattern: ["Push", "Pull", "Legs", "Rest", "Push", "Pull", "Rest"] },
  }],
};
const r = (id: string, created_at: string, phase: string | null = PH): SuggestionRoutine =>
  ({ id, name: id, created_at, program_phase_id: phase });
const routines = [
  r("Legs B", "2026-09-13T12:32:29Z"), r("Pull B", "2026-09-13T12:32:27Z"), r("Push B", "2026-09-13T12:32:26Z"),
  r("Legs A", "2026-09-13T12:32:25Z"), r("Pull A", "2026-09-13T12:32:24Z"), r("Push A", "2026-09-13T12:32:23Z"),
  r("Upper Body", "2026-08-22T10:28:58Z", null),
];
const done = (id: string, finishedUtc: string) =>
  ({ name: id, routine_id: id, started_at: finishedUtc, finished_at: finishedUtc, created_at: finishedUtc });
const IST = "Asia/Kolkata";

Deno.test("wall clock: a UTC moment reads as the user's local time", () => {
  assertEquals(wallClock("2026-09-13T18:30:00Z", IST), "2026-09-14T00:00:00");
  assertEquals(wallClock("2026-09-13T18:30:00Z", "America/New_York"), "2026-09-13T14:30:00");
  assertEquals(wallClock("2026-09-13T18:30:00Z", "Not/AZone"), null);
  assertEquals(isTimeZone(IST), true);
  assertEquals(isTimeZone("Mars/Olympus"), false);
});

Deno.test("the day is the user's day: 18:30 UTC is already tomorrow in India", () => {
  const row = buildSuggestion({ routines, workouts: [], program, timeZone: IST, now: new Date("2026-09-13T18:30:00Z") })!;
  assertEquals(row.day, "2026-09-14");
  assertEquals(row.kind, "planned");
  assertEquals(row.routine_id, "Push A");
});

Deno.test("at local midnight, yesterday's session moves the split on", () => {
  // Push A finished 20:00 IST on the 13th (14:30 UTC); run at 00:00 IST on the 14th.
  const row = buildSuggestion({ routines, workouts: [done("Push A", "2026-09-13T14:30:00Z")], program, timeZone: IST, now: new Date("2026-09-13T18:30:00Z") })!;
  assertEquals(row.routine_id, "Pull A");
});

Deno.test("a session finished after local midnight does not change the day's pick", () => {
  // 06:00 IST on the 14th is after that day began: the 00:00 pick stands.
  const at0000 = buildSuggestion({ routines, workouts: [], program, timeZone: IST, now: new Date("2026-09-13T18:30:00Z") })!;
  const at0700 = buildSuggestion({ routines, workouts: [done("Push A", "2026-09-14T00:30:00Z")], program, timeZone: IST, now: new Date("2026-09-14T01:30:00Z") })!;
  assertEquals(at0700.routine_id, at0000.routine_id);
  assertEquals(at0700.basis, at0000.basis);
});

Deno.test("00:10 in India is already today, though UTC still calls it yesterday", () => {
  // 00:10 IST on the 14th = 18:40 UTC on the 13th. A UTC server would count that
  // session as yesterday's and move the split on; for the user it is today's.
  const row = buildSuggestion({ routines, workouts: [done("Push A", "2026-09-13T18:40:00Z")], program, timeZone: IST, now: new Date("2026-09-13T19:00:00Z") })!;
  assertEquals(row.day, "2026-09-14");
  assertEquals(row.routine_id, "Push A");
});

Deno.test("rest days follow the phase's pattern in the user's zone", () => {
  const workouts = [done("Push A", "2026-09-13T04:00:00Z"), done("Pull A", "2026-09-14T04:00:00Z"), done("Legs A", "2026-09-15T04:00:00Z")];
  const row = buildSuggestion({ routines, workouts, program, timeZone: IST, now: new Date("2026-09-15T18:30:00Z") })!;
  assertEquals(row.day, "2026-09-16");
  assertEquals(row.kind, "rest");
  assertEquals(row.routine_id, "Push B");
  assertEquals(row.resumes_on, "2026-09-17");
});

Deno.test("the basis moves when a late-synced session from before today appears", () => {
  const without = buildSuggestion({ routines, workouts: [], program, timeZone: IST, now: new Date("2026-09-14T03:00:00Z") })!;
  const withLate = buildSuggestion({ routines, workouts: [done("Push A", "2026-09-13T14:30:00Z")], program, timeZone: IST, now: new Date("2026-09-14T03:00:00Z") })!;
  assertEquals(without.basis === withLate.basis, false);
  assertEquals(withLate.routine_id, "Pull A");
});

Deno.test("no routines: build one", () => {
  const row = buildSuggestion({ routines: [], workouts: [], program: null, timeZone: IST, now: new Date("2026-09-14T03:00:00Z") })!;
  assertEquals(row.kind, "new");
  assertEquals(row.routine_id, null);
});

Deno.test("an unknown zone builds nothing", () => {
  assertEquals(buildSuggestion({ routines, workouts: [], program, timeZone: "Nope/Zone", now: new Date() }), null);
});

import { latestWorkoutBeforeDay, planKey, suggestionBasis } from "./todayPick.ts";

Deno.test("the server's basis equals the phone's for the same data, so the app does not re-ask forever", () => {
  // The phone runs in the user's zone: use this runtime's zone as the user's.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date("2026-09-15T09:00:00Z");
  const workouts = [done("Push A", "2026-09-13T04:00:00Z"), done("Pull A", "2026-09-14T04:00:00Z")];
  const row = buildSuggestion({ routines, workouts, program, timeZone: zone, now })!;
  const phoneProgram = {
    id: program.id, start_date: program.start_date,
    phases: program.phases.map((p) => ({ id: p.id, duration_weeks: p.duration_weeks, start_offset_weeks: p.start_offset_weeks })),
  };
  const phoneBasis = suggestionBasis(planKey(phoneProgram, routines, now), latestWorkoutBeforeDay(workouts, now));
  assertEquals(row.basis, phoneBasis);
});
