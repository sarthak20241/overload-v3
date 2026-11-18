// Run with: deno test --allow-all lib/spotlight.test.ts
//
// The spotlight intro + first-visit hints: who sees them, the lit hole, the copy.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  accountAgeDays,
  canStart,
  countsAsSeen,
  dataLoaded,
  mergeSeen,
  holeFor,
  nextStep,
  onScreen,
  parseSeen,
  SPOTLIGHT_BODY_MAX,
  SPOTLIGHT_FROM_MS,
  SPOTLIGHT_TITLE_MAX,
  type SpotlightTour,
  tipControls,
  tipSide,
  toOverlay,
  TOURS,
} from "./spotlight.ts";

const DAY = 86_400_000;

const FROM = SPOTLIGHT_FROM_MS;
const fresh = { createdAtMs: FROM + DAY, nowMs: FROM + 2 * DAY };

Deno.test("a new account sees each tour once, one at a time", () => {
  const seen = new Set<string>();
  assert(canStart(TOURS.intro, { seen, active: null, ...fresh }));
  // intro seen, so the active tour is the only reason to say no.
  assert(!canStart(TOURS.food_box, { seen: new Set(["intro"]), active: "goal_plan", ...fresh }), "never two at once");
  assert(!canStart(TOURS.intro, { seen: new Set(["intro"]), active: null, ...fresh }), "only once");
});

Deno.test("only accounts made after the tours shipped get them, for 14 days", () => {
  const seen = new Set<string>(["intro"]);
  assert(!canStart(TOURS.intro, { seen: new Set(), active: null, createdAtMs: FROM - 1, nowMs: FROM + DAY }), "an account from before, even 1 day old");
  assert(canStart(TOURS.goal_plan, { seen, active: null, createdAtMs: FROM, nowMs: FROM + 14 * DAY }));
  assert(!canStart(TOURS.goal_plan, { seen, active: null, createdAtMs: FROM, nowMs: FROM + 14.5 * DAY }), "older than 14 days");
  assert(!canStart(TOURS.goal_plan, { seen, active: null, createdAtMs: null, nowMs: FROM }), "unknown date: wait");
});

Deno.test("the dev demo skips the date rules, never the order", () => {
  const demo = { createdAtMs: null, nowMs: 0, demo: true };
  assert(canStart(TOURS.intro, { seen: new Set(), active: null, ...demo }));
  assert(!canStart(TOURS.food_box, { seen: new Set(), active: null, ...demo }), "hints still wait for the intro");
});

Deno.test("a release tour goes to accounts from before the release, for its window", () => {
  const rel: SpotlightTour = {
    id: "intro", // any id: the rules read the tour, not the id
    kind: "hint",
    release: { on: "2026-12-01", days: 30 },
    steps: [{ target: "food_box", shape: "pill", title: "New", body: "New." }],
  };
  const on = Date.parse("2026-12-01T00:00:00Z");
  const none = new Set<string>();
  assert(canStart({ ...rel, id: "workout_set" }, { seen: none, active: null, createdAtMs: on - 400 * DAY, nowMs: on + DAY }), "an old account, no intro needed");
  assert(!canStart({ ...rel, id: "workout_set" }, { seen: none, active: null, createdAtMs: on + DAY, nowMs: on + 2 * DAY }), "signed up after: it is not new to them");
  assert(!canStart({ ...rel, id: "workout_set" }, { seen: none, active: null, createdAtMs: on - DAY, nowMs: on + 31 * DAY }), "the window has closed");
  assert(!canStart({ ...rel, id: "workout_set" }, { seen: none, active: null, createdAtMs: on - 400 * DAY, nowMs: on - 1 }), "not before the release date");
  assert(canStart({ ...rel, id: "workout_set" }, { seen: none, active: null, createdAtMs: on - 400 * DAY, nowMs: on }), "from the release instant");
  assert(!canStart({ ...rel, id: "workout_set" }, { seen: new Set(["workout_set"]), active: null, createdAtMs: on - DAY, nowMs: on + DAY }), "once");
  assert(!canStart({ ...rel, id: "workout_set" }, { seen: none, active: "food_box", createdAtMs: on - DAY, nowMs: on + DAY }), "one at a time");
});

Deno.test("account age in days", () => {
  assertEquals(accountAgeDays(null, 0), null);
  assertEquals(accountAgeDays(0, 5), null);
  assertEquals(accountAgeDays(1_000, 1_000 + 3 * DAY), 3);
  assertEquals(accountAgeDays(5_000, 1_000), 0, "a clock behind the server reads as brand new");
});

Deno.test("the intro is three dashboard stops; the food guide is two; other hints one", () => {
  assertEquals(TOURS.intro.kind, "intro");
  assertEquals(TOURS.intro.steps.map((s) => s.target), ["today_card", "log_food", "goal_button"]);
  // Owner, 2026-11-18: the food page shows both log modes on the first visit.
  assertEquals(TOURS.food_box.kind, "hint");
  assertEquals(TOURS.food_box.steps.map((s) => s.target), ["food_box", "log_mode"]);
  for (const id of ["workout_set", "goal_plan", "set_types"] as const) {
    assertEquals(TOURS[id].kind, "hint");
    assertEquals(TOURS[id].steps.length, 1);
  }
  assert(!("food_modes" in TOURS), "Quick/Precise is no longer a separate later hint");
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
  assert(!countsAsSeen("interrupted"), "a popup took the screen");
  assert(!countsAsSeen("left"), "left without answering it: show it again next visit");
  for (const how of ["finished", "skipped", "used", "outside"] as const) {
    assert(countsAsSeen(how), how);
  }
});

Deno.test("a tour waits for the seen list and the account date, then tries again", () => {
  assert(!dataLoaded({ seenLoaded: false, createdAtMs: 1_000, demo: false }), "seen list still loading");
  assert(!dataLoaded({ seenLoaded: true, createdAtMs: null, demo: false }), "account not loaded yet");
  assert(dataLoaded({ seenLoaded: true, createdAtMs: 1_000, demo: false }));
  assert(dataLoaded({ seenLoaded: true, createdAtMs: null, demo: true }), "the dev demo needs no date");
});

Deno.test("hints wait for the intro to end first", () => {
  assert(!canStart(TOURS.food_box, { seen: new Set(), active: null, ...fresh }), "intro not done yet");
  assert(canStart(TOURS.food_box, { seen: new Set(["intro"]), active: null, ...fresh }), "intro finished or skipped");
});

Deno.test("a control's window position is moved into the overlay's own space", () => {
  assertEquals(toOverlay({ x: 10, y: 100, width: 50, height: 20 }, { x: 0, y: 0 }), { x: 10, y: 100, width: 50, height: 20 });
  assertEquals(toOverlay({ x: 10, y: 100, width: 50, height: 20 }, { x: 0, y: 24 }), { x: 10, y: 76, width: 50, height: 20 }, "overlay starts under a status bar");
});

Deno.test("only real tour names load from storage, not inherited object keys", () => {
  assertEquals([...parseSeen('["constructor","toString","intro"]')], ["intro"]);
});

Deno.test("a save merges with what is stored, so a failed read never wipes it", () => {
  assertEquals(mergeSeen('["intro","food_box"]', new Set(["goal_plan"])).sort(), ["food_box", "goal_plan", "intro"]);
  assertEquals(mergeSeen(null, new Set(["intro"])), ["intro"]);
  assertEquals(mergeSeen("broken", new Set(["intro"])), ["intro"]);
});

Deno.test("set types does not wait for the first-set hint (a user may log before it shows)", () => {
  assertEquals(TOURS.set_types.after, undefined);
  const intro = new Set<string>(["intro"]);
  assert(canStart(TOURS.set_types, { seen: intro, active: null, ...fresh }), "first-set hint never shown: still teach set types");
  assert(!canStart(TOURS.set_types, { seen: new Set(["workout_set"]), active: null, ...fresh }), "the intro still comes first");
});

Deno.test("every tip shows its step count; Skip on every step but the intro's last", () => {
  assertEquals(tipControls(TOURS.intro, 0), { progress: "1/3", showSkip: true, cta: "Next" });
  assertEquals(tipControls(TOURS.intro, 1), { progress: "2/3", showSkip: true, cta: "Next" });
  assertEquals(tipControls(TOURS.intro, 2), { progress: "3/3", showSkip: false, cta: "Got it" });
  // A one-step page guide: the user can still skip it.
  assertEquals(tipControls(TOURS.goal_plan, 0), { progress: "1/1", showSkip: true, cta: "Got it" });
  // The food guide: 1/2 then 2/2.
  assertEquals(tipControls(TOURS.food_box, 0), { progress: "1/2", showSkip: true, cta: "Next" });
  assertEquals(tipControls(TOURS.food_box, 1), { progress: "2/2", showSkip: false, cta: "Got it" });
});

Deno.test("using step 1 of a two-step guide pauses it for step 2; it is not done yet", () => {
  assert(!countsAsSeen("used_step"), "the food guide still owes its Quick/Precise step");
  assert(countsAsSeen("used"), "using the last step finishes it");
});

Deno.test("a tour with `after` waits for that tour (kept for future follow-ups)", () => {
  const follow: SpotlightTour = { ...TOURS.goal_plan, after: "workout_set" };
  assert(!canStart(follow, { seen: new Set(["intro"]), active: null, ...fresh }));
  assert(canStart(follow, { seen: new Set(["intro", "workout_set"]), active: null, ...fresh }));
});
