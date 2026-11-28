// Run with: deno test --allow-all lib/signupBuild.test.ts
//
// Sign-up's phase 1 build has one way forward: Back never reaches the coach menu.

import { assertEquals } from "jsr:@std/assert@1";
import { isSignupBuildVisit, onSignupBuild, reportSignupBuild, signupBuildStateOf, signupPlanBack } from "./signupBuild.ts";

Deno.test("Back on the built plan opens Drona to change it, and Back from that chat returns to the plan", () => {
  assertEquals(signupPlanBack({ hasPlan: true, refineOpen: false, building: false }), "open_refine");
  assertEquals(signupPlanBack({ hasPlan: true, refineOpen: true, building: false }), "close_refine");
});

Deno.test("Back from an exercise's swap list returns to the plan", () => {
  assertEquals(signupPlanBack({ hasPlan: true, refineOpen: false, building: false, swapOpen: true }), "close_swap");
});

Deno.test("while Drona builds, Back does nothing", () => {
  assertEquals(signupPlanBack({ hasPlan: false, refineOpen: false, building: true }), "stay");
  assertEquals(signupPlanBack({ hasPlan: true, refineOpen: true, building: true }), "stay");
});

Deno.test("with no plan (the build failed), Back closes the sheet and sign-up goes on", () => {
  assertEquals(signupPlanBack({ hasPlan: false, refineOpen: false, building: false }), "close_sheet");
});

Deno.test("no answer is the coach menu", () => {
  for (const hasPlan of [true, false]) for (const refineOpen of [true, false]) for (const building of [true, false]) {
    const a = signupPlanBack({ hasPlan, refineOpen, building });
    assertEquals(["open_refine", "close_refine", "close_swap", "close_sheet", "stay"].includes(a), true);
  }
});

Deno.test("the sign-up visit is known by its params, also on web (no paywall) and after the tour param is cleared", () => {
  assertEquals(isSignupBuildVisit({ then: "upgrade", tour: "1" }), true);
  assertEquals(isSignupBuildVisit({ tour: "1" }), true);
  assertEquals(isSignupBuildVisit({ then: "upgrade" }), true);
  // The dashboard's "Build phase 1" (build=phase&auto=1) keeps the normal sheet.
  assertEquals(isSignupBuildVisit({}), false);
});

// The Goal screen and the coach sheet must use these, not their own rules.
Deno.test("the Goal screen and the coach sheet read the sign-up rules from here", async () => {
  const goal = await Deno.readTextFile(new URL("../app/goal-plan.tsx", import.meta.url));
  const coach = await Deno.readTextFile(new URL("../components/ai/AICoachModal.tsx", import.meta.url));
  assertEquals(goal.includes("isSignupBuildVisit("), true);
  assertEquals(goal.includes("signupBuild={"), true);
  assertEquals(coach.includes("signupPlanBack("), true);
});

Deno.test("the build under the tour reports building, ready or failed, and the latest state reaches a late listener", () => {
  const seen: (string | null)[] = [];
  reportSignupBuild("building");
  const off = onSignupBuild((s) => seen.push(s));
  // A listener that joins late hears where the build is now.
  assertEquals(seen, ["building"]);
  reportSignupBuild("building"); // no change, no call
  reportSignupBuild("ready");
  assertEquals(seen, ["building", "ready"]);
  off();
  reportSignupBuild("failed");
  assertEquals(seen, ["building", "ready"]);
  assertEquals(signupBuildStateOf({ building: true, hasPlan: false, failed: false }), "building");
  assertEquals(signupBuildStateOf({ building: false, hasPlan: true, failed: true }), "ready");
  assertEquals(signupBuildStateOf({ building: false, hasPlan: false, failed: true }), "failed");
  assertEquals(signupBuildStateOf({ building: false, hasPlan: false, failed: false }), null);
});
