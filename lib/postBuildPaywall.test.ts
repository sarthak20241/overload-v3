// Run with: deno test --allow-all lib/postBuildPaywall.test.ts
//
// The paywall after sign-up's phase 1 build: both sign-up orders get it, and
// the server flag picks when it shows (right after Save, or on the first tap).

import { assertEquals } from "jsr:@std/assert@1";
import {
  DEFAULT_POST_BUILD_PAYWALL,
  postBuildPaywallStep,
  signupGoalPlanParams,
  timingFromFlag,
} from "./postBuildPaywall.ts";

Deno.test("the flag picks the timing; an unknown or missing value falls back to the first tap", () => {
  assertEquals(timingFromFlag("after_save"), "after_save");
  assertEquals(timingFromFlag("first_tap"), "first_tap");
  assertEquals(DEFAULT_POST_BUILD_PAYWALL, "first_tap");
  assertEquals(timingFromFlag(null), "first_tap");
  assertEquals(timingFromFlag(undefined), "first_tap");
  assertEquals(timingFromFlag("control"), "first_tap");
});

Deno.test("sign-up's Goal screen visit carries the paywall on iPhone and Android, not on web", () => {
  assertEquals(signupGoalPlanParams("ios"), { build: "phase", auto: "1", tour: "1", then: "upgrade" });
  assertEquals(signupGoalPlanParams("android"), { build: "phase", auto: "1", tour: "1", then: "upgrade" });
  assertEquals(signupGoalPlanParams("web"), { build: "phase", auto: "1", tour: "1" });
});

Deno.test("after_save: the paywall opens when the build sheet closes", () => {
  assertEquals(postBuildPaywallStep({ timing: "after_save", event: "build_closed", armed: false, fired: false }), "open");
  // A tap before the sheet closed (none can happen, the sheet covers the screen) changes nothing.
  assertEquals(postBuildPaywallStep({ timing: "after_save", event: "tap", armed: false, fired: false }), "allow");
});

Deno.test("first_tap: closing the build arms it, and the next tap opens the paywall instead", () => {
  assertEquals(postBuildPaywallStep({ timing: "first_tap", event: "build_closed", armed: false, fired: false }), "arm");
  assertEquals(postBuildPaywallStep({ timing: "first_tap", event: "tap", armed: true, fired: false }), "open");
  // Before the build closed, taps do what they always did.
  assertEquals(postBuildPaywallStep({ timing: "first_tap", event: "tap", armed: false, fired: false }), "allow");
});

Deno.test("the paywall opens once, whatever the timing", () => {
  for (const timing of ["after_save", "first_tap"] as const) {
    assertEquals(postBuildPaywallStep({ timing, event: "build_closed", armed: false, fired: true }), "allow");
    assertEquals(postBuildPaywallStep({ timing, event: "tap", armed: true, fired: true }), "allow");
  }
});

// The bug this guards (2026-11-20): onboarding finished signed in (the user
// tapped "I already have an account" first) sent the Goal screen no
// then=upgrade, so no paywall came after the build. Both doors must build the
// params in one place.
Deno.test("both sign-up doors use signupGoalPlanParams, never their own Goal screen params", async () => {
  for (const file of ["app/onboarding.tsx", "app/(app)/_layout.tsx"]) {
    const src = await Deno.readTextFile(new URL(`../${file}`, import.meta.url));
    assertEquals(src.includes("signupGoalPlanParams("), true, `${file} must call signupGoalPlanParams`);
    assertEquals(/pathname: '\/goal-plan',\s*params: \{\s*build: 'phase'/.test(src), false, `${file} builds its own Goal screen params`);
  }
});
