import { assertEquals } from "jsr:@std/assert@1";
import { activePhaseOn, phaseFor } from "./phasePick.ts";

// Seqs with a gap (0, 2, 3): a phase's seq is not its place in the list.
// Three 2-week phases from Monday 2026-10-05.
const phases = [
  { seq: 0, name: "Foundation", duration_weeks: 2, start_offset_weeks: 0 },
  { seq: 2, name: "Build", duration_weeks: 2, start_offset_weeks: 2 },
  { seq: 3, name: "Peak", duration_weeks: 2, start_offset_weeks: 4 },
];
const START = "2026-10-05";

Deno.test("the active phase is found by its place in time and reported by its own seq", () => {
  // Day 22: the second phase (days 14 to 27), its second week.
  const a = activePhaseOn(START, phases, "2026-10-27");
  assertEquals([a.phase?.name, a.seq, a.weekInPhase], ["Build", 2, 2]);
  assertEquals(activePhaseOn(START, phases, "2026-10-04"), { phase: null, seq: null, weekInPhase: null });
  assertEquals(activePhaseOn(START, phases, "2026-11-16"), { phase: null, seq: null, weekInPhase: null });
});

Deno.test("phaseFor looks a phase up by seq, never by list index", () => {
  const program = { phases, currentPhaseSeq: 2 };
  // phases[2] is Peak; seq 2 is Build.
  assertEquals(phaseFor(program, null)?.name, "Build");
  assertEquals(phaseFor(program, 3)?.name, "Peak");
  // A seq that does not exist falls back to the current phase, then the first.
  assertEquals(phaseFor(program, 1)?.name, "Build");
  assertEquals(phaseFor({ phases, currentPhaseSeq: null }, null)?.name, "Foundation");
  assertEquals(phaseFor(null, 0), null);
});
