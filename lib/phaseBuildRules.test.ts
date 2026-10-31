// Run with: deno test lib/phaseBuildRules.test.ts
//
// A background build is a paid model call and a draft decides what the user
// sees, so these pin when each fires: drafts that must not come back, the
// next phase's lead window, the running phase that began unbuilt, and the
// retry budget.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  AUTO_BUILD_MAX_TRIES,
  AUTO_BUILD_RETRY_MS,
  DRAFT_MAX_AGE_MS,
  mayAutoBuild,
  nextPhaseActionFor,
  NEXT_PHASE_LEAD_DAYS,
  parseAutoBuildRecord,
  parseStoredDraft,
  startsInText,
  type NextPhaseState,
  type PhaseLite,
} from "./phaseBuildRules.ts";

const NOW = 1_760_000_000_000;
const plan = { name: "Upper / Lower", workouts: [{ name: "Upper A" }] };

Deno.test("a fresh draft reads back with its source", () => {
  const d = parseStoredDraft(JSON.stringify({ plan, builtAt: NOW - 1000, source: "auto" }), NOW);
  assertEquals(d?.plan.name, "Upper / Lower");
  assertEquals(d?.source, "auto");
});

Deno.test("broken, empty or stale drafts are dropped", () => {
  assertEquals(parseStoredDraft(null, NOW), null);
  assertEquals(parseStoredDraft("{not json", NOW), null);
  assertEquals(parseStoredDraft(JSON.stringify({ plan: { name: "x", workouts: [] }, builtAt: NOW }), NOW), null);
  assertEquals(parseStoredDraft(JSON.stringify({ plan, builtAt: "yesterday" }), NOW), null);
  assertEquals(parseStoredDraft(JSON.stringify({ plan, builtAt: NOW - DRAFT_MAX_AGE_MS - 1 }), NOW), null);
});

Deno.test("an unknown source reads as the user's own build", () => {
  assertEquals(parseStoredDraft(JSON.stringify({ plan, builtAt: NOW, source: "?" }), NOW)?.source, "build");
});

const ph = (seq: number, routineCount: number, weeks = 4, offset = seq * 4): PhaseLite => ({
  id: `p${seq}`,
  seq,
  name: `Phase ${seq + 1}`,
  start_offset_weeks: offset,
  duration_weeks: weeks,
  routineCount,
});

const base: NextPhaseState = {
  ready: true,
  isPro: true,
  phases: [ph(0, 3), ph(1, 0), ph(2, 0)],
  currentPhaseSeq: 0,
  daysIntoProgram: 10,
  draftPhaseIds: new Set(),
};

Deno.test("nothing happens while the running phase has more than the lead left", () => {
  // Phase 1 ends on day 28; day 10 leaves 18.
  assertEquals(nextPhaseActionFor(base), null);
  assertEquals(nextPhaseActionFor({ ...base, daysIntoProgram: 28 - NEXT_PHASE_LEAD_DAYS - 1 }), null);
});

Deno.test("inside the lead window Pro builds the next phase and free is told", () => {
  const s = { ...base, daysIntoProgram: 28 - NEXT_PHASE_LEAD_DAYS };
  const pro = nextPhaseActionFor(s);
  assertEquals(pro?.kind, "auto_build");
  assertEquals(pro?.phase.id, "p1");
  assertEquals(pro?.startsInDays, NEXT_PHASE_LEAD_DAYS);
  assertEquals(pro?.running, false);
  assertEquals(nextPhaseActionFor({ ...s, isPro: false })?.kind, "upsell");
});

Deno.test("a draft waiting for the next phase is offered for review", () => {
  const s = { ...base, daysIntoProgram: 26, draftPhaseIds: new Set(["p1"]) };
  assertEquals(nextPhaseActionFor(s)?.kind, "review");
  // Free users keep a draft they got while on Pro.
  assertEquals(nextPhaseActionFor({ ...s, isPro: false })?.kind, "review");
});

Deno.test("a next phase that already has workouts is left alone", () => {
  const s = { ...base, phases: [ph(0, 3), ph(1, 4)], daysIntoProgram: 27 };
  assertEquals(nextPhaseActionFor(s), null);
});

Deno.test("a running phase after the first that began unbuilt is the target, now", () => {
  const s = { ...base, phases: [ph(0, 3), ph(1, 0)], currentPhaseSeq: 1, daysIntoProgram: 30 };
  const a = nextPhaseActionFor(s);
  assertEquals(a?.kind, "auto_build");
  assertEquals(a?.phase.id, "p1");
  assertEquals(a?.startsInDays, 0);
  assertEquals(a?.running, true);
});

Deno.test("phase 1 itself is never this card's job", () => {
  // An unbuilt phase 1 belongs to the split prompt, so only the NEXT phase counts.
  const s = { ...base, phases: [ph(0, 0), ph(1, 3)], daysIntoProgram: 2 };
  assertEquals(nextPhaseActionFor(s), null);
});

Deno.test("the last phase has no next phase", () => {
  const s = { ...base, phases: [ph(0, 3)], daysIntoProgram: 27 };
  assertEquals(nextPhaseActionFor(s), null);
});

Deno.test("not ready, not started, or ended: nothing", () => {
  assertEquals(nextPhaseActionFor({ ...base, ready: false, daysIntoProgram: 27 }), null);
  assertEquals(nextPhaseActionFor({ ...base, currentPhaseSeq: null, daysIntoProgram: 27 }), null);
});

Deno.test("phases out of order are read by seq, not list position", () => {
  const s = { ...base, phases: [ph(2, 0), ph(1, 0), ph(0, 3)], daysIntoProgram: 27 };
  assertEquals(nextPhaseActionFor(s)?.phase.id, "p1");
});

Deno.test("background builds: first try now, retry after the wait, then stop", () => {
  assert(mayAutoBuild(parseAutoBuildRecord(null), NOW));
  const once = { tries: 1, lastAt: NOW - 1000 };
  assertEquals(mayAutoBuild(once, NOW), false);
  assert(mayAutoBuild({ ...once, lastAt: NOW - AUTO_BUILD_RETRY_MS }, NOW));
  assertEquals(mayAutoBuild({ tries: AUTO_BUILD_MAX_TRIES, lastAt: 0 }, NOW), false);
  // A clock moved backwards does not lock the build out.
  assert(mayAutoBuild({ tries: 1, lastAt: NOW + 10_000 }, NOW));
  assertEquals(parseAutoBuildRecord("garbage"), { tries: 0, lastAt: 0 });
});

Deno.test("start wording", () => {
  assertEquals(startsInText(0), "starts today");
  assertEquals(startsInText(1), "starts tomorrow");
  assertEquals(startsInText(4), "starts in 4 days");
  assertEquals(startsInText(0, true), "is under way");
});
