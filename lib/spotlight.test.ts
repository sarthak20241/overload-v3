// Run with: deno test --allow-all lib/spotlight.test.ts
//
// The spotlight intro + first-visit hints: who sees them, the lit hole, the copy.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  accountAgeDays,
  canStart,
  countsAsSeen,
  dataLoaded,
  holeFor,
  nextStep,
  onScreen,
  parseSeen,
  SPOTLIGHT_BODY_MAX,
  SPOTLIGHT_TITLE_MAX,
  tipSide,
  toOverlay,
  TOURS,
} from "./spotlight.ts";

const DAY = 86_400_000;

Deno.test("a new account sees each tour once, one at a time", () => {
  const seen = new Set<string>();
  assert(canStart("intro", { seen, active: null, accountAgeDays: 0 }));
  assert(!canStart("food_box", { seen, active: "intro", accountAgeDays: 0 }), "never two at once");
  assert(!canStart("intro", { seen: new Set(["intro"]), active: null, accountAgeDays: 0 }), "only once");
});

Deno.test("an older account never sees a tour; an unknown age waits", () => {
  const seen = new Set<string>(["intro"]);
  assert(canStart("goal_plan", { seen, active: null, accountAgeDays: 14 }));
  assert(!canStart("goal_plan", { seen, active: null, accountAgeDays: 14.5 }));
  assert(!canStart("goal_plan", { seen, active: null, accountAgeDays: null }));
  assertEquals(accountAgeDays(null, 0), null);
  assertEquals(accountAgeDays(0, 5), null);
  assertEquals(accountAgeDays(1_000, 1_000 + 3 * DAY), 3);
  assertEquals(accountAgeDays(5_000, 1_000), 0, "a clock behind the server reads as brand new");
});

Deno.test("the intro is three dashboard stops; every hint is one", () => {
  assertEquals(TOURS.intro.kind, "intro");
  assertEquals(TOURS.intro.steps.map((s) => s.target), ["today_card", "log_food", "goal_button"]);
  for (const id of ["workout_set", "food_box", "goal_plan"] as const) {
    assertEquals(TOURS[id].kind, "hint");
    assertEquals(TOURS[id].steps.length, 1);
  }
});

Deno.test("copy: short, curly apostrophes, no em dashes", () => {
  for (const t of Object.values(TOURS)) {
    for (const s of t.steps) {
      assert(s.title.length <= SPOTLIGHT_TITLE_MAX, `title too long: ${s.title}`);
      assert(s.body.length <= SPOTLIGHT_BODY_MAX, `body too long: ${s.body}`);
      for (const text of [s.title, s.body]) {
        assert(!text.includes("'"), `straight apostrophe: ${text}`);
        assert(!text.includes("—"), `em dash: ${text}`);
      }
    }
  }
});

Deno.test("the hole hugs the control by its shape", () => {
  const card = holeFor({ x: 20, y: 100, width: 300, height: 120 }, "card");
  assertEquals(card, { x: 12, y: 92, width: 316, height: 136, r: 22 });
  const pill = holeFor({ x: 0, y: 0, width: 80, height: 36 }, "pill");
  assertEquals(pill.r, pill.height / 2);
  const circle = holeFor({ x: 100, y: 100, width: 58, height: 58 }, "circle");
  assertEquals(circle.width, circle.height);
  assertEquals(circle.r, circle.width / 2);
  assertEquals(circle.x + circle.width / 2, 129, "centred on the control");
});

Deno.test("a control off the screen or not laid out gets no spotlight", () => {
  assert(onScreen({ x: 0, y: 0, width: 10, height: 10 }, 400, 800));
  assert(!onScreen(null, 400, 800));
  assert(!onScreen({ x: 0, y: 0, width: 0, height: 10 }, 400, 800));
  assert(!onScreen({ x: 0, y: 790, width: 10, height: 40 }, 400, 800), "below the fold");
});

Deno.test("the tip goes where there is more room", () => {
  assertEquals(tipSide({ x: 0, y: 100, width: 10, height: 100 }, 800), "below");
  assertEquals(tipSide({ x: 0, y: 650, width: 10, height: 60 }, 800), "above");
});

Deno.test("steps run in order and end", () => {
  assertEquals(nextStep(0, 3), 1);
  assertEquals(nextStep(2, 3), "done");
  assertEquals(nextStep(0, 1), "done");
});

Deno.test("the stored list reads defensively", () => {
  assertEquals([...parseSeen('["intro","food_box"]')], ["intro", "food_box"]);
  assertEquals(parseSeen("nope").size, 0);
  assertEquals(parseSeen('{"intro":1}').size, 0);
  assertEquals([...parseSeen('["intro","made_up",3]')], ["intro"]);
  assertEquals(parseSeen(null).size, 0);
});

Deno.test("a tour cut short by something else comes back; a real end does not", () => {
  assert(!countsAsSeen("intro", "interrupted"), "a popup took the screen");
  assert(!countsAsSeen("hint", "interrupted"));
  assert(!countsAsSeen("intro", "left"), "pulled away mid-intro: show it again");
  assert(!countsAsSeen("hint", "left"), "left without Got it or using it: show it again next visit");
  for (const how of ["finished", "skipped", "used", "outside"] as const) {
    assert(countsAsSeen("intro", how));
    assert(countsAsSeen("hint", how));
  }
});

Deno.test("a tour waits for the seen list and the account date, then tries again", () => {
  assert(!dataLoaded({ seenLoaded: false, createdAtMs: 1_000, demo: false }), "seen list still loading");
  assert(!dataLoaded({ seenLoaded: true, createdAtMs: null, demo: false }), "account not loaded yet");
  assert(dataLoaded({ seenLoaded: true, createdAtMs: 1_000, demo: false }));
  assert(dataLoaded({ seenLoaded: true, createdAtMs: null, demo: true }), "the dev demo needs no date");
});

Deno.test("hints wait for the intro to end first", () => {
  const age = 0;
  assert(!canStart("food_box", { seen: new Set(), active: null, accountAgeDays: age }), "intro not done yet");
  assert(canStart("food_box", { seen: new Set(["intro"]), active: null, accountAgeDays: age }), "intro finished or skipped");
  assert(canStart("intro", { seen: new Set(), active: null, accountAgeDays: age }));
});

Deno.test("a control's window position is moved into the overlay's own space", () => {
  assertEquals(toOverlay({ x: 10, y: 100, width: 50, height: 20 }, { x: 0, y: 0 }), { x: 10, y: 100, width: 50, height: 20 });
  assertEquals(toOverlay({ x: 10, y: 100, width: 50, height: 20 }, { x: 0, y: 24 }), { x: 10, y: 76, width: 50, height: 20 }, "overlay starts under a status bar");
});
