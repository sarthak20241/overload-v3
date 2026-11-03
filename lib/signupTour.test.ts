// Run with: deno test --allow-all lib/signupTour.test.ts
//
// The sign-up tour's words and its tap rules.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { nextScene, phaseLineFor, tapStep, TOUR_SUB_MAX, TOUR_TITLE_MAX, tourScenes } from "./signupTour.ts";

Deno.test("five scenes, greeting by first name only", () => {
  const s = tourScenes("Sarthak Kumar", null);
  assertEquals(s.length, 5);
  assertEquals(s[0].title, "You’re in, Sarthak.");
  assertEquals(tourScenes(null, null)[0].title, "You’re in.");
  assertEquals(tourScenes("  ", null)[0].title, "You’re in.");
});

Deno.test("the last scene names the phase when it is known", () => {
  assertEquals(tourScenes("A", "Build the base. 4 weeks.")[4].sub, "Build the base. 4 weeks.");
  assertEquals(tourScenes("A", null)[4].sub, "Built from your answers.");
  assertEquals(phaseLineFor("Build the base", 4), "Build the base. 4\u00a0weeks.");
  assertEquals(phaseLineFor("Deload", 1), "Deload. 1\u00a0week.");
  assertEquals(phaseLineFor("Get stronger.", null), "Get stronger.");
  assertEquals(phaseLineFor("", 4), null);
});

Deno.test("copy fits the screen, has no em dashes, and never says the plan is ready", () => {
  for (const s of tourScenes("Maximilianus", "Build the base. 12 weeks.")) {
    assert(s.title.length <= TOUR_TITLE_MAX, `title too long: ${s.title}`);
    assert(s.sub.length <= TOUR_SUB_MAX, `sub too long: ${s.sub}`);
    for (const t of [s.title, s.sub]) {
      assert(!t.includes("—"), `em dash in "${t}"`);
      assert(!t.includes("'"), `straight apostrophe in "${t}"`);
      assert(!/\bready\b/i.test(t), `promises a finished plan: "${t}"`);
    }
  }
});

Deno.test("left third goes back, the rest goes on; back stops at the first scene", () => {
  assertEquals(tapStep(50, 400), -1);
  assertEquals(tapStep(200, 400), 1);
  // Just past the left third already goes on.
  assertEquals(tapStep(150, 400), 1);
  assertEquals(nextScene(0, -1, 5), 0);
  assertEquals(nextScene(2, 1, 5), 3);
  assertEquals(nextScene(4, 1, 5), "done");
});
