// Run with: deno test lib/todayPick.test.ts
//
// The TODAY card used to rank EVERY saved routine by "done longest ago", so a
// routine from months before the program beat today's program day. These pin
// the pick to the current phase's split, in day order.

import { assertEquals } from "jsr:@std/assert@1";
import { currentPhaseId, pickToday, type PickProgram, type PickRoutine, type PickWorkout } from "./todayPick.ts";

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
