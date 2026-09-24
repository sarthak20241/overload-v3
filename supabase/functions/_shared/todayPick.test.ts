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

// ── Training a program day your own way ──
// No tester had ever opened an active program's routine: they trained freestyle,
// or from their own routines. The pick counted only sessions of the phase's own
// routines, so it offered the same day forever (a tester was told "Legs" for 12
// days straight, the day after a session that trained every one of its muscles).
// Now a session counts as the program day it trained, and what comes next is the
// day whose muscles the last 7 days left untrained.

const ex = (...groups: string[]) => groups.map((g) => ({ exercises: { muscle_group: g } }));
const push: PickRoutine = { id: "push", name: "Push", created_at: "2026-09-13T10:00:01Z", program_phase_id: "ph-1", routine_exercises: ex("Chest", "Upper Chest", "Side Delts", "Triceps") };
const pull: PickRoutine = { id: "pull", name: "Pull", created_at: "2026-09-13T10:00:02Z", program_phase_id: "ph-1", routine_exercises: ex("Lats", "Upper Back", "Biceps", "Rear Delts") };
const legs: PickRoutine = { id: "legs", name: "Legs", created_at: "2026-09-13T10:00:03Z", program_phase_id: "ph-1", routine_exercises: ex("Quads", "Hamstrings", "Calves", "Abs") };
const legsAndAbs: PickRoutine = { id: "own-legs", name: "Legs and Abs 2 Office", created_at: "2026-08-01T10:00:00Z", program_phase_id: null, routine_exercises: ex("Quads", "Abs") };
const ppl = [legsAndAbs, legs, pull, push];

/** A session with no routine, training these muscle groups. */
const freestyle = (n: number, ...groups: string[]): PickWorkout => ({
  name: "Freestyle", routine_id: null, started_at: daysAgo(n), finished_at: daysAgo(n - 0.04),
  sets: groups.map((g) => ({ completed: true, set_type: "normal", exercises: { muscle_group: g } })),
});

Deno.test("own way: a freestyle session that trained a program day counts as that day", () => {
  const workouts = [did(push, 3), did(pull, 2), freestyle(1, "Quads", "Hamstrings", "Calves", "Abs")];
  const pick = pickToday({ routines: ppl, workouts, program, now: NOW });
  assertEquals(pick.routine?.id, "push");
});

Deno.test("own way: a session of the person's own routine counts as the program day it covers", () => {
  // "Legs and Abs" trains quads and core: half of the program's Legs day.
  const own = { name: legsAndAbs.name, routine_id: legsAndAbs.id, started_at: daysAgo(1),
    sets: [{ completed: true, set_type: "normal", exercises: { muscle_group: "Quads" } }, { completed: true, set_type: "normal", exercises: { muscle_group: "Abs" } }] };
  const pick = pickToday({ routines: ppl, workouts: [did(push, 3), did(pull, 2), own], program, now: NOW });
  assertEquals(pick.routine?.id, "push");
});

Deno.test("own way: the dashboard's workout_sets shape counts the same as sets", () => {
  const w = freestyle(1, "Quads", "Hamstrings");
  const serverRow = { ...w, sets: undefined, workout_sets: w.sets };
  const pick = pickToday({ routines: ppl, workouts: [did(push, 3), did(pull, 2), serverRow], program, now: NOW });
  assertEquals(pick.routine?.id, "push");
});

Deno.test("own way: under half of a day's muscle groups is not that day", () => {
  // Core and shoulders: a quarter of Legs, a third of Push and of Pull.
  const workouts = [did(push, 3), did(pull, 2), freestyle(1, "Abs", "Side Delts")];
  assertEquals(pickToday({ routines: ppl, workouts, program, now: NOW }).routine?.id, "legs");
});

Deno.test("own way: warm-up sets and unfinished sets train nothing", () => {
  const w: PickWorkout = { name: "Freestyle", routine_id: null, started_at: daysAgo(1), sets: [
    { completed: true, set_type: "warmup", exercises: { muscle_group: "Quads" } },
    { completed: false, set_type: "normal", exercises: { muscle_group: "Hamstrings" } },
    { completed: true, set_type: "normal", exercises: { muscle_group: "Abs" } },
  ] };
  assertEquals(pickToday({ routines: ppl, workouts: [did(push, 3), did(pull, 2), w], program, now: NOW }).routine?.id, "legs");
});

Deno.test("own way: a session counts once, as the day it covers best", () => {
  // All of Push, and two of Pull's three groups: it was a push day, not a pull
  // day. Pull's back and shoulders were trained, its biceps not; Legs was
  // trained 3 days ago. Legs goes after Pull because it was done more lately.
  const workouts = [{ ...did(legs, 3), ...freestyle(3, "Quads", "Hamstrings", "Calves", "Abs"), routine_id: "legs" }, freestyle(1, "Chest", "Side Delts", "Triceps", "Lats")];
  assertEquals(pickToday({ routines: ppl, workouts, program, now: NOW }).routine?.id, "pull");
});

Deno.test("own way: a counted session takes its slot in the week, so the rest after it holds", () => {
  // Pattern Push, Pull, Legs, Rest. Three sessions done the person's way on the
  // first three days of the phase: the fourth day is rest, then Push.
  const ppr: PickProgram = { ...program, phases: [{ ...program.phases[0], week_pattern: ["Push", "Pull", "Legs", "Rest", "Push", "Pull", "Rest"] }, program.phases[1]] };
  const at = (isoDay: string, ...groups: string[]): PickWorkout => ({
    name: "Freestyle", routine_id: null, started_at: `${isoDay}T08:00:00`, finished_at: `${isoDay}T09:00:00`,
    sets: groups.map((g) => ({ completed: true, set_type: "normal", exercises: { muscle_group: g } })),
  });
  const workouts = [at("2026-09-10", "Chest", "Triceps"), at("2026-09-11", "Lats", "Biceps"), at("2026-09-12", "Quads", "Hamstrings")];
  const pick = pickToday({ routines: ppl, workouts, program: ppr, now: NOW });
  assertEquals(pick.kind, "rest");
  if (pick.kind === "rest") {
    assertEquals(pick.next.id, "push");
    assertEquals(localDay(pick.resumesOn), "2026-09-14");
  }
});

Deno.test("own way: a day whose muscles the week left untrained goes before one trained piecemeal", () => {
  // Legs is the longest undone, but two small sessions this week trained half of
  // it (abs, then calves). Pull's back and biceps are untouched: Pull goes first.
  const workouts = [did(legs, 9), did(pull, 8), did(push, 2), freestyle(4, "Abs", "Rear Delts"), freestyle(1, "Calves", "Forearms")];
  assertEquals(pickToday({ routines: ppl, workouts, program, now: NOW }).routine?.id, "pull");
});

Deno.test("own way: muscles trained over a week ago do not hold a day back", () => {
  // The same two small sessions as above, but 8 and 9 days ago.
  const workouts = [did(legs, 9), did(pull, 8), did(push, 2), freestyle(9, "Abs", "Rear Delts"), freestyle(8, "Calves", "Forearms")];
  assertEquals(pickToday({ routines: ppl, workouts, program, now: NOW }).routine?.id, "legs");
});

Deno.test("own way: a fresh split still opens on Day 1 when other days share a muscle", () => {
  // Push (shoulders) yesterday: Pull shares the shoulders, Legs shares nothing.
  // One shared group of four is not "trained": the split's own order holds.
  assertEquals(pickToday({ routines: ppl, workouts: [did(push, 1)], program, now: NOW }).routine?.id, "pull");
});

Deno.test("own way: the tester's fortnight, replayed, moves on from Legs", () => {
  // 2026-09-13..24, Asia/Kolkata, from the live database. Program started 09-13,
  // Push/Pull/Legs/Rest/Push/Pull/Rest. Before: "Legs" every day.
  const p: PickProgram = { id: "prog", start_date: "2026-09-13", phases: [{ id: "ph-1", duration_weeks: 5, start_offset_weeks: 0, week_pattern: ["Push", "Pull", "Legs", "Rest", "Push", "Pull", "Rest"] }] };
  const R = (id: string, n: number, ...g: string[]): PickRoutine => ({ id, name: id, created_at: `2026-09-13T15:50:5${n}Z`, program_phase_id: "ph-1", routine_exercises: ex(...g) });
  const tester = [R("Push", 1, "Chest", "Shoulders", "Triceps"), R("Pull", 2, "Back", "Biceps", "Shoulders"), R("Legs", 3, "Calves", "Core", "Hamstrings", "Quads")];
  const s = (isoDay: string, ...g: string[]): PickWorkout => ({ name: "x", routine_id: null, started_at: `${isoDay}T09:00:00`, finished_at: `${isoDay}T10:00:00`,
    sets: g.map((m) => ({ completed: true, set_type: "normal", exercises: { muscle_group: m } })) });
  const history = [
    { name: "Legs", routine_id: "old-legs", started_at: "2026-08-09T18:48:00", finished_at: "2026-08-09T19:48:00" },
    { name: "Pull", routine_id: "old-pull", started_at: "2026-08-30T21:26:00", finished_at: "2026-08-30T22:26:00" },
    { name: "Push", routine_id: "old-push", started_at: "2026-09-09T08:57:00", finished_at: "2026-09-09T10:12:00" },
    s("2026-09-14", "Chest", "Shoulders", "Triceps"),
    s("2026-09-15", "Back", "Biceps", "Other"),
    s("2026-09-16", "Core", "Quads"),
    s("2026-09-18", "Core", "Shoulders"),
    s("2026-09-20", "Back", "Biceps", "Shoulders"),
    s("2026-09-21", "Calves", "Core", "Hamstrings", "Quads"),
    s("2026-09-22", "Chest", "Shoulders", "Triceps"),
  ];
  const on = (isoDay: string) => {
    const now = new Date(`${isoDay}T00:05:00`);
    const before = history.filter((w) => new Date(w.finished_at!).getTime() < new Date(`${isoDay}T00:00:00`).getTime());
    const pk = pickToday({ routines: tester, workouts: before, program: p, now });
    return pk.kind === "rest" ? `rest>${pk.next.id}` : pk.routine?.id;
  };
  // The day after the full-body session trained all of Legs, Legs is not offered.
  assertEquals(on("2026-09-22"), "rest>Push");
  assertEquals(on("2026-09-23"), "Pull");
});
