// Run with: deno test lib/todayPick.test.ts
//
// The TODAY card used to rank EVERY saved routine by "done longest ago", so a
// routine from months before the program beat today's program day. These pin
// the pick to the current phase's split, in day order.

import { assertEquals } from "jsr:@std/assert@1";
import { currentPhaseId, pickToday, pickUpNext, type PickProgram, type PickRoutine, type PickWorkout } from "./todayPick.ts";

const NOW = new Date("2026-09-13T18:00:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString();

// Started 10 days ago: phase 1 is weeks 0-1 (today is day 10, inside it).
const program: PickProgram = {
  start_date: "2026-09-03",
  phases: [
    { id: "ph-1", duration_weeks: 2, start_offset_weeks: 0 },
    { id: "ph-2", duration_weeks: 4, start_offset_weeks: 2 },
  ],
};

// Saved Day 1 first. The dashboard hands routines over newest first.
const day1: PickRoutine = { id: "d1", name: "Full Body A", created_at: "2026-09-13T10:11:55Z", program_phase_id: "ph-1" };
const day2: PickRoutine = { id: "d2", name: "Full Body B", created_at: "2026-09-13T10:11:57Z", program_phase_id: "ph-1" };
const day3: PickRoutine = { id: "d3", name: "Full Body C", created_at: "2026-09-13T10:11:58Z", program_phase_id: "ph-1" };
const old: PickRoutine = { id: "old", name: "Arms", created_at: "2026-05-01T09:00:00Z", program_phase_id: null };
const nextPhase: PickRoutine = { id: "p2", name: "Upper", created_at: "2026-09-13T11:00:00Z", program_phase_id: "ph-2" };
const newestFirst = [nextPhase, day3, day2, day1, old];

const did = (r: PickRoutine, n: number): PickWorkout => ({ name: r.name, routine_id: r.id, started_at: daysAgo(n) });

Deno.test("a fresh program split opens on Day 1, not on an old routine", () => {
  const pick = pickToday({ routines: newestFirst, workouts: [], program, now: NOW });
  assertEquals(pick.kind, "planned");
  assertEquals(pick.routine?.id, "d1");
  assertEquals(pick.fromProgram, true);
});

Deno.test("after Day 1 comes Day 2", () => {
  const pick = pickToday({ routines: newestFirst, workouts: [did(day1, 2)], program, now: NOW });
  assertEquals(pick.routine?.id, "d2");
});

Deno.test("once every day has run, the one done longest ago is next", () => {
  const workouts = [did(day1, 5), did(day2, 3), did(day3, 1)];
  const pick = pickToday({ routines: newestFirst, workouts, program, now: NOW });
  assertEquals(pick.routine?.id, "d1");
});

Deno.test("a skipped day stays due instead of being jumped", () => {
  const workouts = [did(day1, 4), did(day3, 2)];
  const pick = pickToday({ routines: newestFirst, workouts, program, now: NOW });
  assertEquals(pick.routine?.id, "d2");
});

Deno.test("another phase's split is not today's", () => {
  const pick = pickToday({ routines: [nextPhase, old], workouts: [], program, now: NOW });
  // Phase 1 has no split built: fall back to every routine.
  assertEquals(pick.fromProgram, false);
  assertEquals(pick.routine?.id, "p2");
});

Deno.test("no program keeps the old rule: least recently done across all routines", () => {
  const workouts = [did(day1, 1), did(day2, 2), did(day3, 3), did(nextPhase, 4)];
  const pick = pickToday({ routines: newestFirst, workouts, program: null, now: NOW });
  assertEquals(pick.routine?.id, "old");
  assertEquals(pick.fromProgram, false);
});

Deno.test("no program, nothing done: the list's own order wins the tie", () => {
  const pick = pickToday({ routines: newestFirst, workouts: [], program: null, now: NOW });
  assertEquals(pick.routine?.id, "p2");
});

Deno.test("a completed workout shows the most recent session done today", () => {
  const workouts = [
    { name: "Lower", started_at: new Date("2026-09-13T07:00:00").toISOString() },
    { name: "Arms", started_at: new Date("2026-09-13T12:00:00").toISOString() },
  ];
  const pick = pickToday({ routines: newestFirst, workouts, program, now: NOW });
  assertEquals(pick.kind, "complete");
  if (pick.kind !== "complete") throw new Error("Expected today's workout to be complete");
  assertEquals(pick.completedWorkout?.name, "Arms");
});

Deno.test("a session that ran past midnight counts as done today", () => {
  const late = {
    name: "Late Push",
    started_at: new Date("2026-09-12T23:40:00").toISOString(),
    finished_at: new Date("2026-09-13T00:35:00").toISOString(),
  };
  const pick = pickToday({ routines: newestFirst, workouts: [late], program, now: NOW });
  assertEquals(pick.kind, "complete");
});

Deno.test("yesterday's session is not today's, even without finished_at", () => {
  const legacy = { name: "Arms", started_at: new Date("2026-09-12T20:00:00").toISOString(), finished_at: null };
  assertEquals(pickToday({ routines: newestFirst, workouts: [legacy], program, now: NOW }).kind, "planned");
});

Deno.test("no routines means build one", () => {
  assertEquals(pickToday({ routines: [], workouts: [], program, now: NOW }).kind, "new");
});

Deno.test("matches a session by name when it carries no routine_id", () => {
  const byName = { name: "full body a", routine_id: null, started_at: daysAgo(2) };
  assertEquals(pickToday({ routines: newestFirst, workouts: [byName], program, now: NOW }).routine?.id, "d2");
});

Deno.test("current phase follows the calendar, and is null outside the program", () => {
  assertEquals(currentPhaseId(program, NOW), "ph-1");
  assertEquals(currentPhaseId(program, new Date("2026-09-17T08:00:00")), "ph-2");
  assertEquals(currentPhaseId(program, new Date("2026-09-02T23:00:00")), null);
  assertEquals(currentPhaseId(program, new Date("2026-10-15T08:00:00")), null);
  assertEquals(currentPhaseId(null, NOW), null);
});

Deno.test("up next: after Day 1 today, the next session is Day 2", () => {
  const today = { name: "Full Body A", routine_id: "d1", started_at: daysAgo(0.2), finished_at: daysAgo(0.1) };
  const { pick, tomorrow } = pickUpNext({ routines: newestFirst, workouts: [today], program, now: NOW });
  assertEquals(pick.kind, "planned");
  assertEquals(pick.routine?.id, "d2");
  assertEquals(tomorrow.getDate(), 14);
});

Deno.test("up next crosses into the next phase on its first day", () => {
  // Phase 2 starts 2026-09-17; the evening before, up next comes from its split.
  const eve = new Date("2026-09-16T20:00:00");
  const today = { name: "Full Body A", routine_id: "d1", started_at: "2026-09-16T17:00:00", finished_at: "2026-09-16T18:00:00" };
  const { pick } = pickUpNext({ routines: newestFirst, workouts: [today], program, now: eve });
  assertEquals(pick.routine?.id, "p2");
  assertEquals(pick.kind === "planned" && pick.fromProgram, true);
});

// ── Rest days from the phase's week pattern (follows the user, not the calendar) ──
// Pattern: Day 1 train, Day 2 rest, Day 3 train, Day 4-5 rest, Day 6 train, Day 7 rest.
const FB = "Full Body";
const weekly: PickProgram = {
  ...program,
  phases: [{ ...program.phases[0], week_pattern: [FB, "Rest", FB, "Rest", "Rest", FB, "Rest"] }, program.phases[1]],
};
const on = (r: PickRoutine, isoDay: string) => ({
  name: r.name, routine_id: r.id, started_at: `${isoDay}T08:00:00`, finished_at: `${isoDay}T09:00:00`,
});
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

Deno.test("rest: the day after Day 1 is a rest day, and Day 2's session is due after it", () => {
  const pick = pickToday({ routines: newestFirst, workouts: [on(day1, "2026-09-12")], program: weekly, now: NOW });
  assertEquals(pick.kind, "rest");
  if (pick.kind !== "rest") return;
  assertEquals(pick.next.id, "d2");
  assertEquals(localDay(pick.resumesOn), "2026-09-14");
});

Deno.test("rest: once the rest day has passed, the next session is due", () => {
  const pick = pickToday({ routines: newestFirst, workouts: [on(day1, "2026-09-11")], program: weekly, now: NOW });
  assertEquals(pick.kind, "planned");
  assertEquals(pick.routine?.id, "d2");
  assertEquals(pick.kind === "planned" && pick.scheduled, true);
});

Deno.test("rest: the gap comes from the slot the last session sat on (two rest days after Day 3)", () => {
  const due = pickToday({ routines: newestFirst, workouts: [on(day1, "2026-09-08"), on(day2, "2026-09-10")], program: weekly, now: NOW });
  assertEquals(due.kind, "planned");
  assertEquals(due.routine?.id, "d3");
  const resting = pickToday({ routines: newestFirst, workouts: [on(day1, "2026-09-09"), on(day2, "2026-09-11")], program: weekly, now: NOW });
  assertEquals(resting.kind, "rest");
});

Deno.test("rest: a missed day never piles up, the session just stays due", () => {
  const pick = pickToday({ routines: newestFirst, workouts: [on(day1, "2026-09-05")], program: weekly, now: NOW });
  assertEquals(pick.kind, "planned");
  assertEquals(pick.routine?.id, "d2");
});

Deno.test("rest: the week wraps, Day 6 is followed by Day 7 rest, then Day 1 again", () => {
  const workouts = [on(day1, "2026-09-08"), on(day2, "2026-09-10"), on(day3, "2026-09-12")];
  const pick = pickToday({ routines: newestFirst, workouts, program: weekly, now: NOW });
  assertEquals(pick.kind, "rest");
  if (pick.kind === "rest") assertEquals(pick.next.id, "d1");
});

Deno.test("rest: sessions from before the phase started do not count", () => {
  // Phase 2 opens 2026-09-17. An "Upper" logged the evening before belongs to
  // phase 1's calendar, so phase 2 opens with its first session due, not a rest.
  const both: PickProgram = {
    ...weekly,
    phases: [weekly.phases[0], { ...program.phases[1], week_pattern: weekly.phases[0].week_pattern }],
  };
  const pick = pickToday({ routines: newestFirst, workouts: [on(nextPhase, "2026-09-16")], program: both, now: new Date("2026-09-17T18:00:00") });
  assertEquals(pick.kind, "planned");
  assertEquals(pick.routine?.id, "p2");
});

Deno.test("rest: no week pattern means no rest days are invented", () => {
  const pick = pickToday({ routines: newestFirst, workouts: [on(day1, "2026-09-12")], program, now: NOW });
  assertEquals(pick.kind, "planned");
  assertEquals(pick.kind === "planned" && pick.scheduled, false);
});

Deno.test("up next: after today's Day 1, tomorrow is a rest day", () => {
  const { pick } = pickUpNext({ routines: newestFirst, workouts: [on(day1, "2026-09-13")], program: weekly, now: NOW });
  assertEquals(pick.kind, "rest");
  if (pick.kind === "rest") assertEquals(localDay(pick.resumesOn), "2026-09-15");
});

// ── The day's saved pick (made by the server at local 00:00) ──
import { resolveToday, planKey, latestWorkoutBeforeDay, suggestionBasis, type SavedPick } from "./todayPick.ts";

const withId: PickProgram = { ...weekly, id: "prog-1" };
const basisNow = (routines: PickRoutine[], workouts: PickWorkout[], prog: PickProgram | null = withId, now = NOW) =>
  suggestionBasis(planKey(prog, routines, now), latestWorkoutBeforeDay(workouts, now));
const saved = (over: Partial<SavedPick> = {}): SavedPick => ({
  day: "2026-09-13", kind: "planned", routine_id: "d2", resumes_on: null, scheduled: true,
  basis: basisNow(newestFirst, []), ...over,
});
const view = (over: Partial<Parameters<typeof resolveToday>[0]> = {}) =>
  resolveToday({ routines: newestFirst, workouts: [], program: withId, now: NOW, saved: saved(), dataReady: true, requesting: false, ...over });

Deno.test("saved: a current saved pick is shown as is, even where the phone would pick otherwise", () => {
  // The phone's own rule says Day 1 here; the server's saved pick says Day 2.
  const r = view();
  assertEquals(r.view.routine?.id, "d2");
  assertEquals(r.needsRequest, false);
});

Deno.test("saved: no pick for today yet asks for one and, while asking, says it is preparing", () => {
  const asking = view({ saved: null, requesting: true });
  assertEquals(asking.view.kind, "preparing");
  assertEquals(asking.needsRequest, true);
});

Deno.test("saved: yesterday's saved pick is not today's", () => {
  const r = view({ saved: saved({ day: "2026-09-12" }) });
  assertEquals(r.needsRequest, true);
  assertEquals(r.view.routine?.id, "d1"); // the phone's own pick, until the server answers
});

Deno.test("saved: a split built after the pick was made asks again", () => {
  const before = saved({ kind: "planned", routine_id: "old", basis: basisNow([old], []) });
  const r = view({ saved: before });
  assertEquals(r.needsRequest, true);
});

Deno.test("saved: a workout from before today that synced late asks again", () => {
  const late = [on(day1, "2026-09-12")];
  const r = view({ workouts: late });
  assertEquals(r.basis === saved().basis, false);
  assertEquals(r.needsRequest, true);
});

Deno.test("saved: a session finished today shows done and asks for nothing", () => {
  const r = view({ workouts: [on(day1, "2026-09-13")], saved: null });
  assertEquals(r.view.kind, "complete");
  assertEquals(r.needsRequest, false);
});

Deno.test("saved: before the server reads settle, a saved pick is trusted and nothing is asked", () => {
  const r = view({ dataReady: false, saved: saved({ basis: "from-a-stale-cache" }) });
  assertEquals(r.view.routine?.id, "d2");
  assertEquals(r.needsRequest, false);
  const none = view({ dataReady: false, saved: null });
  assertEquals(none.needsRequest, false);
});

Deno.test("saved: a rest day comes back with its next session and date", () => {
  const r = view({ saved: saved({ kind: "rest", routine_id: "d3", resumes_on: "2026-09-15" }) });
  assertEquals(r.view.kind, "rest");
  if (r.view.kind === "rest") {
    assertEquals(r.view.next.id, "d3");
    assertEquals(localDay(r.view.resumesOn), "2026-09-15");
  }
});

Deno.test("saved: a saved routine that was deleted asks again and shows the phone's pick meanwhile", () => {
  const r = view({ saved: saved({ routine_id: "gone" }) });
  assertEquals(r.needsRequest, true);
  assertEquals(r.view.kind, "planned");
});

Deno.test("saved: 'build one' is not shown once routines exist", () => {
  const r = view({ saved: saved({ kind: "new", routine_id: null }) });
  assertEquals(r.view.kind, "planned");
  assertEquals(r.needsRequest, true);
});

Deno.test("saved: when the server cannot be reached the card still shows the phone's pick", () => {
  const r = view({ saved: null, requesting: false });
  assertEquals(r.view.kind, "planned");
  assertEquals(r.view.routine?.id, "d1");
});
