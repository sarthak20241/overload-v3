import { assertEquals } from "jsr:@std/assert@1";
import { decideSwap, swapCandidates, swapCard, type SwapFacts } from "./dronaSwap.ts";

const BACK = "Back";
const ROW = { exercise_id: "row", name: "Barbell Row", muscle_group: BACK };
const CSR = { exercise_id: "csr", name: "Chest-Supported Row", muscle_group: BACK };
const PULL = { exercise_id: "pull", name: "Lat Pulldown", muscle_group: BACK };
const SQUAT = { exercise_id: "squat", name: "Back Squat", muscle_group: "Legs" };

/** A routine whose plan is Row + Pulldown, with `n` newest-first sessions. */
function facts(sessions: { performed: { exercise_id: string; name?: string; muscle_group?: string }[]; on: string }[], autoAdjust = true): SwapFacts {
  return {
    as_of: "2026-09-18",
    auto_adjust: autoAdjust,
    routines: [
      {
        routine_id: "r1",
        name: "Pull A",
        plan: [
          { routine_exercise_id: "re1", ...ROW },
          { routine_exercise_id: "re2", ...PULL },
        ],
        sessions: sessions.map((s, i) => ({ workout_id: `w${i}`, ...s })),
      },
    ],
  };
}

/** n sessions where Chest-Supported Row stood in for Barbell Row. */
const swapped = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    on: `2026-09-${String(17 - (i + from) * 3).padStart(2, "0")}`,
    performed: [CSR, PULL],
  }));

const asPlanned = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    on: `2026-09-${String(17 - (i + from) * 3).padStart(2, "0")}`,
    performed: [ROW, PULL],
  }));

Deno.test("four sessions in a row with the same stand-in is a candidate", () => {
  const [c] = swapCandidates(facts(swapped(4)));
  assertEquals(c.routine_exercise_id, "re1");
  assertEquals(c.from_exercise_id, "row");
  assertEquals(c.to_exercise_id, "csr");
  assertEquals(c.to_name, "Chest-Supported Row");
  assertEquals(c.run, 4);
  assertEquals(c.sessions, 4);
});

Deno.test("two sessions is not enough to call it a habit", () => {
  assertEquals(swapCandidates(facts([...swapped(2), ...asPlanned(3, 2)])).length, 0);
});

Deno.test("an old run that stopped does not count", () => {
  // Newest first: the last two sessions went back to the planned exercise.
  assertEquals(swapCandidates(facts([...asPlanned(2), ...swapped(4, 2)])).length, 0);
});

Deno.test("a different stand-in each time is not one swap", () => {
  const mixed = [
    { on: "2026-09-17", performed: [CSR, PULL] },
    { on: "2026-09-14", performed: [{ exercise_id: "seated", name: "Seated Row", muscle_group: BACK }, PULL] },
    { on: "2026-09-11", performed: [CSR, PULL] },
    { on: "2026-09-08", performed: [CSR, PULL] },
  ];
  assertEquals(swapCandidates(facts(mixed)).length, 0);
});

Deno.test("a stand-in for another muscle is not a swap", () => {
  const off = Array.from({ length: 4 }, (_, i) => ({
    on: `2026-09-${17 - i * 3}`,
    performed: [SQUAT, PULL],
  }));
  assertEquals(swapCandidates(facts(off)).length, 0);
});

Deno.test("a session that simply skipped the exercise is not a swap", () => {
  const skipped = Array.from({ length: 4 }, (_, i) => ({
    on: `2026-09-${17 - i * 3}`,
    performed: [PULL],
  }));
  assertEquals(swapCandidates(facts(skipped)).length, 0);
});

Deno.test("two missing back exercises and two stand-ins is too murky to pair", () => {
  const murky = Array.from({ length: 4 }, (_, i) => ({
    on: `2026-09-${17 - i * 3}`,
    performed: [CSR, { exercise_id: "chin", name: "Chin-up", muscle_group: BACK }],
  }));
  assertEquals(swapCandidates(facts(murky)).length, 0);
});

Deno.test("four in a row applies on its own when the setting is on", () => {
  const d = decideSwap(facts(swapped(4)));
  assertEquals(d.move, "auto");
  assertEquals(d.candidate?.to_name, "Chest-Supported Row");
});

Deno.test("three in a row asks instead of applying", () => {
  const d = decideSwap(facts([...swapped(3), ...asPlanned(2, 3)]));
  assertEquals(d.move, "ask");
  assertEquals(d.candidate?.run, 3);
});

Deno.test("with the setting off even four in a row only asks", () => {
  assertEquals(decideSwap(facts(swapped(4), false)).move, "ask");
});

Deno.test("no routines, no move", () => {
  assertEquals(decideSwap({ routines: [] }).move, "none");
  assertEquals(decideSwap({}).move, "none");
});

Deno.test("an applied swap card tells the user what changed and offers Undo", () => {
  const c = swapCandidates(facts(swapped(4)))[0];
  const card = swapCard(c, "auto");
  assertEquals(card.kind, "notice");
  assertEquals(card.topic, "swap");
  assertEquals(card.payload.action, "undo_swap");
  assertEquals(card.payload.routine_exercise_id, "re1");
  assertEquals(card.payload.from_exercise_id, "row");
  assertEquals(card.payload.to_exercise_id, "csr");
  assertEquals(card.body.includes("Chest-Supported Row"), true);
  assertEquals(card.evidence[0].value, "4");
});

Deno.test("an asked swap card carries the same ids and an act kind", () => {
  const c = swapCandidates(facts([...swapped(3), ...asPlanned(2, 3)]))[0];
  const card = swapCard(c, "ask");
  assertEquals(card.kind, "act");
  assertEquals(card.payload.action, "apply_swap");
  assertEquals(card.payload.routine_exercise_id, "re1");
  assertEquals(card.title.includes("Barbell Row"), true);
});
