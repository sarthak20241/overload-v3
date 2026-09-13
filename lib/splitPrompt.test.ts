// Run with: deno test lib/splitPrompt.test.ts
//
// The prompt sends people to a screen that costs a model call, so the
// conditions matter more than the copy. These pin the three ways it could
// misfire: before anything has loaded, after the split already exists, and
// during the snooze a "Later" bought.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { splitPromptFor, splitPromptSnoozeKey, SNOOZE_MS, type SplitPromptState } from "./splitPrompt.ts";

const NOW = 1_760_000_000_000;

const base: SplitPromptState = {
  ready: true,
  onboardingDone: true,
  isGuest: false,
  hasProgram: true,
  phaseRoutineCount: 0,
  dismissedAt: null,
  nowMs: NOW,
};

Deno.test("a signed-in account with an unbuilt phase 1 is asked to build", () => {
  assertEquals(splitPromptFor(base), "build");
});

Deno.test("nothing is asked until auth and the program have settled", () => {
  assertEquals(splitPromptFor({ ...base, ready: false }), null);
  // Not loaded is not the same as zero, or the prompt flashes on cold start.
  assertEquals(splitPromptFor({ ...base, phaseRoutineCount: null }), null);
});

Deno.test("a phase that already has routines is left alone", () => {
  assertEquals(splitPromptFor({ ...base, phaseRoutineCount: 4 }), null);
});

Deno.test("no program means nothing to build a split for", () => {
  assertEquals(splitPromptFor({ ...base, hasProgram: false }), null);
});

Deno.test("a guest is asked to sign in, not to build", () => {
  // A guest has no program row at all, so the routine count says nothing.
  assertEquals(splitPromptFor({ ...base, isGuest: true, hasProgram: false, phaseRoutineCount: null }), "signin");
});

Deno.test("someone who never finished onboarding is never asked", () => {
  assertEquals(splitPromptFor({ ...base, onboardingDone: false }), null);
  assertEquals(splitPromptFor({ ...base, onboardingDone: false, isGuest: true }), null);
});

Deno.test("Later holds for three days and then the ask returns", () => {
  assertEquals(splitPromptFor({ ...base, dismissedAt: NOW - 1000 }), null);
  assertEquals(splitPromptFor({ ...base, dismissedAt: NOW - SNOOZE_MS + 1 }), null);
  assertEquals(splitPromptFor({ ...base, dismissedAt: NOW - SNOOZE_MS }), "build");
});

Deno.test("a snooze stamped in the future does not hold forever", () => {
  // A clock moved backwards would otherwise park the prompt permanently.
  assertEquals(splitPromptFor({ ...base, dismissedAt: NOW + 10 * SNOOZE_MS }), "build");
});

Deno.test("a new program gets a fresh ask, not the old one's answer", () => {
  // The bug: the popup remembered its answer in ONE device-wide key. Tapping
  // Build once (even if the builder was abandoned) silenced it forever, so a
  // brand-new program whose phase 1 had zero routines never got asked.
  const oldPhase = splitPromptSnoozeKey("phase-aaa");
  const newPhase = splitPromptSnoozeKey("phase-bbb");
  assert(oldPhase !== newPhase, `both phases share ${oldPhase}`);
});

Deno.test("a guest's snooze has a stable key of its own", () => {
  assertEquals(splitPromptSnoozeKey(null), splitPromptSnoozeKey(undefined));
  assert(splitPromptSnoozeKey(null) !== splitPromptSnoozeKey("phase-aaa"));
});
