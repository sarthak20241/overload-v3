// Run with: deno test --allow-all supabase/functions/_shared/
//
// TODAY with no split to follow (no program, or a phase whose split is not
// built). The pick used to rank every routine ever saved by "done longest ago",
// so a never-done routine always won: a real account got a one-exercise "Push"
// (dead hang, muscle Other) on 13 days while it trained Push / Pull / Legs
// from blank workouts. These pin the pick to what the person actually trains.

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { pickToday, type PickRoutine, type PickWorkout } from "./todayPick.ts";
import { buildSuggestion } from "./dailySuggestion.ts";
import { DEAD_HANG_PUSH, realRoutines, realWorkouts } from "./todayPick.fixture.ts";

const IST = "Asia/Kolkata";
/** The server's pick for an India day, made at that day's local 00:05. */
const serverPick = (day: string) => {
  const now = new Date(`${day}T00:05:00+05:30`);
  const row = buildSuggestion({ routines: realRoutines, workouts: realWorkouts, program: null, timeZone: IST, now })!;
  return realRoutines.find((r) => r.id === row.routine_id)!;
};
const groupsOf = (r: { routine_exercises: { exercises: { muscle_group: string } }[] }) =>
  new Set(r.routine_exercises.map((e) => e.exercises.muscle_group));

// The 13 days the dead-hang "Push" was TODAY.
const DEAD_HANG_DAYS = [
  "2026-10-19", "2026-10-20", "2026-10-21",
  "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05",
  "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10",
];

Deno.test("real account: the never-done one-exercise Push is not TODAY on any of its 13 days", () => {
  for (const day of DEAD_HANG_DAYS) {
    const pick = serverPick(day);
    assertNotEquals(pick.id, DEAD_HANG_PUSH, day);
    assert(pick.routine_exercises.length >= 3, `${day}: ${pick.name} has ${pick.routine_exercises.length} exercises`);
  }
});

Deno.test("real account: the pick follows the Push / Pull / Legs rotation of its blank workouts", () => {
  // Oct 28 legs, Oct 30 push, Oct 31 pull -> legs.
  assert(groupsOf(serverPick("2026-11-01")).has("Quads"), serverPick("2026-11-01").name);
  // Nov 2 legs, Nov 3 push, Nov 4 pull -> legs.
  assert(groupsOf(serverPick("2026-11-05")).has("Quads"), serverPick("2026-11-05").name);
  // Nov 4 pull, Nov 6 legs, Nov 7 push -> pull.
  assert(groupsOf(serverPick("2026-11-08")).has("Back"), serverPick("2026-11-08").name);
  // Nov 3 push, Nov 4 pull, Nov 6 legs -> push.
  assert(groupsOf(serverPick("2026-11-07")).has("Chest"), serverPick("2026-11-07").name);
});

Deno.test("real account: the app's pick on the same data is the server's", () => {
  for (const day of DEAD_HANG_DAYS) {
    // The app's clock in India just after midnight, as a runtime-local wall clock.
    const now = new Date(`${day}T00:05:00`);
    const before = new Date(`${day}T00:00:00+05:30`).getTime();
    const wall = (iso: string | null) => {
      if (!iso) return null;
      const t = new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 19);
      return t;
    };
    const workouts = realWorkouts
      .filter((w) => new Date(w.finished_at || w.started_at).getTime() < before)
      .map((w) => ({ ...w, started_at: wall(w.started_at), finished_at: wall(w.finished_at), created_at: wall(w.created_at) }));
    const routines = realRoutines.map((r) => ({ ...r, created_at: wall(r.created_at) }));
    const app = pickToday({ routines, workouts, program: null, now });
    assertEquals(app.kind, "planned");
    assertEquals(app.routine?.id, serverPick(day).id, day);
  }
});

// ── Small cases ─────────────────────────────────────────────────────────────
const NOW = new Date("2026-11-18T18:00:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString();
const routine = (id: string, groups: string[], created_at = "2026-08-01T10:00:00Z"): PickRoutine => ({
  id, name: id, created_at, program_phase_id: null,
  routine_exercises: groups.map((muscle_group) => ({ exercises: { muscle_group } })),
});
const blank = (n: number, groups: string[]): PickWorkout => ({
  name: "Workout", routine_id: null, started_at: daysAgo(n),
  workout_sets: groups.map((muscle_group) => ({ completed: true, exercises: { muscle_group } })),
});
const did = (r: PickRoutine, n: number): PickWorkout => ({ ...blank(n, []), name: r.name, routine_id: r.id });

const push = routine("push", ["Chest", "Shoulders", "Triceps"]);
const pull = routine("pull", ["Back", "Biceps", "Shoulders"]);
const legs = routine("legs", ["Quads", "Hamstrings", "Calves"]);
const arms = routine("arms-never-done", ["Biceps", "Triceps", "Forearms", "Shoulders"], "2026-11-17T10:00:00Z");
const deadHang = routine("dead-hang", ["Other"], "2026-11-17T11:00:00Z");
const tiny = routine("tiny", ["Chest", "Back"], "2026-11-17T12:00:00Z");

Deno.test("active: a routine never done in the last 4 weeks does not win, however due it is", () => {
  // 3 sessions in the last 14 days: push 3 days ago, pull 2, legs 1.
  const pick = pickToday({
    routines: [arms, legs, pull, push],
    workouts: [did(push, 3), did(pull, 2), did(legs, 1)],
    program: null, now: NOW,
  });
  assertEquals(pick.routine?.id, "push");
});

Deno.test("active: a blank workout counts as the routine it covers best, so that routine can win", () => {
  const pick = pickToday({
    routines: [arms, legs, pull, push],
    workouts: [blank(3, ["Chest", "Triceps", "Shoulders"]), did(pull, 2), did(legs, 1)],
    program: null, now: NOW,
  });
  assertEquals(pick.routine?.id, "push");
});

Deno.test("active: muscles left alone this week still go first among the routines in use", () => {
  // Legs done 10 days ago, push + pull + push this week: legs is due.
  const pick = pickToday({
    routines: [arms, legs, pull, push],
    workouts: [did(legs, 10), did(push, 5), did(pull, 3), did(push, 1)],
    program: null, now: NOW,
  });
  assertEquals(pick.routine?.id, "legs");
});

Deno.test("active: copies of one day share its due date, so the rotation holds", () => {
  // Three Push copies, each claimed by one blank push. Legs was trained before
  // the last push, so legs is due, not the push copy claimed longest ago.
  const pushB = routine("push-b", ["Chest", "Shoulders", "Triceps"], "2026-09-01T10:00:00Z");
  const pushC = routine("push-c", ["Chest", "Shoulders", "Triceps"], "2026-10-01T10:00:00Z");
  const pushes = ["Chest", "Shoulders", "Triceps"];
  const pick = pickToday({
    routines: [pushC, pushB, legs, pull, push],
    workouts: [
      blank(20, pushes), blank(13, pushes), did(legs, 12), did(pull, 11), blank(10, pushes),
      did(legs, 3), blank(2, pushes), did(pull, 1),
    ],
    program: null, now: NOW,
  });
  assertEquals(pick.routine?.id, "legs");
});

Deno.test("not active: every routine can win, but not one with under 3 exercises or no known muscle", () => {
  // One session in the last 14 days: not active.
  const pick = pickToday({
    routines: [tiny, deadHang, arms, legs, pull, push],
    workouts: [did(push, 2)],
    program: null, now: NOW,
  });
  assertEquals(pick.routine?.id, "arms-never-done");
});

Deno.test("not active, and every routine is too small: the pick still offers one", () => {
  const pick = pickToday({ routines: [tiny, deadHang], workouts: [], program: null, now: NOW });
  assertEquals(pick.kind, "planned");
  assertEquals(pick.routine?.id, "tiny");
});

Deno.test("active, but no session matches a routine: falls back to the usable routines", () => {
  const pick = pickToday({
    routines: [deadHang, tiny, legs],
    workouts: [blank(5, ["Cardio"]), blank(3, ["Cardio"]), blank(1, ["Cardio"])],
    program: null, now: NOW,
  });
  assertEquals(pick.routine?.id, "legs");
});
