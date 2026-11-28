// Run with: deno test --allow-all lib/phasePrebuild.test.ts
//
// Phase 1's workouts built before sign-up (PostHog flag phase1-build-timing),
// handed to the new account after it: used once, waited for while in flight,
// never built twice.

import { assertEquals } from "jsr:@std/assert@1";
import {
  beginPrebuildGeneration,
  clearPhasePrebuild,
  DEFAULT_PHASE1_BUILD_TIMING,
  hasPhasePrebuild,
  phase1TimingFromFlag,
  phaseBlockForPrebuild,
  resetPhasePrebuildForTest,
  startPhasePrebuild,
  takePhasePrebuild,
} from "./phasePrebuild.ts";

const plan = { name: "Phase 1", rationale: "x", workouts: [] } as any;
const later = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));

Deno.test("the flag picks the timing; missing or unknown is at sign-up, as today", () => {
  assertEquals(DEFAULT_PHASE1_BUILD_TIMING, "at_signup");
  assertEquals(phase1TimingFromFlag("before_signup"), "before_signup");
  assertEquals(phase1TimingFromFlag("at_signup"), "at_signup");
  assertEquals(phase1TimingFromFlag(null), "at_signup");
  assertEquals(phase1TimingFromFlag("control"), "at_signup");
});

Deno.test("phase 1's block goes out as the route reads it", () => {
  assertEquals(
    phaseBlockForPrebuild({
      name: "Build the base",
      training_directive: "Compounds first.",
      training_block: { split_type: "Upper / Lower", days_per_week: 4, emphasis: "strength", week_pattern: ["Upper", "Rest"] },
    }),
    { name: "Build the base", split_type: "Upper / Lower", days_per_week: 4, emphasis: "strength", week_pattern: ["Upper", "Rest"], training_directive: "Compounds first." },
  );
  assertEquals(phaseBlockForPrebuild({ name: "", training_block: null }), null);
});

Deno.test("a finished build is handed over once", async () => {
  resetPhasePrebuildForTest();
  assertEquals(hasPhasePrebuild(), false);
  startPhasePrebuild(() => Promise.resolve(plan), "P1");
  assertEquals(hasPhasePrebuild(), true);
  assertEquals(await takePhasePrebuild(1000, "P1"), plan);
  // Taken: the next visit builds as usual.
  assertEquals(hasPhasePrebuild(), false);
  assertEquals(await takePhasePrebuild(1000, "P1"), null);
});

Deno.test("a build still running is waited for, not started again", async () => {
  resetPhasePrebuildForTest();
  let runs = 0;
  startPhasePrebuild(() => { runs++; return later(plan, 30); }, "P1");
  assertEquals(await takePhasePrebuild(1000, "P1"), plan);
  assertEquals(runs, 1);
});

Deno.test("a build that fails, or runs past the wait, hands over nothing", async () => {
  resetPhasePrebuildForTest();
  startPhasePrebuild(() => Promise.reject(new Error("429")), "P1");
  assertEquals(await takePhasePrebuild(1000, "P1"), null);
  resetPhasePrebuildForTest();
  startPhasePrebuild(() => later(plan, 200), "P1");
  assertEquals(await takePhasePrebuild(20, "P1"), null);
  // Given up on: it never lands later on top of the build that replaced it.
  await later(null, 250);
  assertEquals(hasPhasePrebuild(), false);
});

Deno.test("a second onboarding replaces the first build", async () => {
  resetPhasePrebuildForTest();
  const first = { ...plan, name: "first" };
  const second = { ...plan, name: "second" };
  startPhasePrebuild(() => later(first, 50), "P1");
  startPhasePrebuild(() => Promise.resolve(second), "P1");
  assertEquals(await takePhasePrebuild(1000, "P1"), second);
  await later(null, 80);
  assertEquals(hasPhasePrebuild(), false);
});

Deno.test("two callers waiting at once: one gets the plan, the other nothing", async () => {
  resetPhasePrebuildForTest();
  startPhasePrebuild(() => later(plan, 30), "P1");
  const [a, b] = await Promise.all([takePhasePrebuild(1000, "P1"), takePhasePrebuild(1000, "P1")]);
  assertEquals([a, b].filter((x) => x !== null).length, 1);
});

// PR #419 review: the plan is tied to the phase it was built for, so another
// account or a redone onboarding never gets it.
Deno.test("the plan goes only to the phase it was built for", async () => {
  resetPhasePrebuildForTest();
  startPhasePrebuild(() => Promise.resolve(plan), "Build the base");
  assertEquals(await takePhasePrebuild(1000, "Another phase"), null);
  // A wrong phase used it up: it never lands later on a different account.
  assertEquals(hasPhasePrebuild(), false);
  resetPhasePrebuildForTest();
  startPhasePrebuild(() => Promise.resolve(plan), "Build the base");
  assertEquals(await takePhasePrebuild(1000, "  build the BASE "), plan);
});

Deno.test("a new onboarding clears the old build even before it has its own", async () => {
  resetPhasePrebuildForTest();
  startPhasePrebuild(() => later(plan, 30), "Old");
  clearPhasePrebuild();
  assertEquals(hasPhasePrebuild(), false);
  assertEquals(await takePhasePrebuild(1000, "Old"), null);
  await later(null, 50);
  assertEquals(hasPhasePrebuild(), false);
});

// PR #419 review: onboarding A's program request lands late, after B began,
// with the same phase name. A must not start a build over B's.
Deno.test("a late start from an earlier onboarding is ignored, even with the same phase name", async () => {
  resetPhasePrebuildForTest();
  const a = beginPrebuildGeneration();
  const b = beginPrebuildGeneration();
  startPhasePrebuild(() => Promise.resolve({ ...plan, name: "A" }), "Build the base", a);
  assertEquals(hasPhasePrebuild(), false);
  startPhasePrebuild(() => Promise.resolve({ ...plan, name: "B" }), "Build the base", b);
  assertEquals(((await takePhasePrebuild(1000, "Build the base")) as { name: string }).name, "B");
});
