// Run with: deno test lib/startGuide.test.ts
//
// The checklist sits on the dashboard, so the rules that matter are when it
// shows at all and what ticks a step off.

import { assertEquals } from "jsr:@std/assert@1";
import { parseOpened, START_GUIDE_DAYS, START_STEPS, startGuideView, type StartGuideFacts } from "./startGuide.ts";

const DAY = 24 * 60 * 60 * 1000;

const fresh: StartGuideFacts = {
  ready: true,
  accountAgeMs: DAY,
  dismissed: false,
  workoutsLogged: 0,
  aiMealLogged: false,
  modePicked: false,
  weightLogged: false,
  opened: new Set(),
};

Deno.test("a new account sees every step, pointing at the first", () => {
  const v = startGuideView(fresh);
  assertEquals(v?.steps.length, START_STEPS.length);
  assertEquals(v?.doneCount, 0);
  assertEquals(v?.nextId, "workout");
});

Deno.test("steps tick off from real data", () => {
  const v = startGuideView({ ...fresh, workoutsLogged: 1, aiMealLogged: true, weightLogged: true, modePicked: true });
  assertEquals(v?.doneCount, 4);
  assertEquals(v?.nextId, "phases");
});

Deno.test("opening phases or modes from the card counts", () => {
  const v = startGuideView({ ...fresh, opened: new Set(["phases", "modes"]) });
  assertEquals(v?.doneCount, 2);
});

Deno.test("opening a step with its own data does not tick it", () => {
  // Opening the food box is not logging a meal.
  const v = startGuideView({ ...fresh, opened: new Set(["ai_food", "weight", "workout"]) });
  assertEquals(v?.doneCount, 0);
});

Deno.test("all done, hidden, too old, unknown age or not loaded: no card", () => {
  const all = { ...fresh, workoutsLogged: 2, aiMealLogged: true, modePicked: true, weightLogged: true, opened: new Set(["phases"] as const) };
  assertEquals(startGuideView(all), null);
  assertEquals(startGuideView({ ...fresh, dismissed: true }), null);
  assertEquals(startGuideView({ ...fresh, accountAgeMs: (START_GUIDE_DAYS + 1) * DAY }), null);
  assertEquals(startGuideView({ ...fresh, accountAgeMs: null }), null);
  assertEquals(startGuideView({ ...fresh, ready: false }), null);
});

Deno.test("the opened list survives junk", () => {
  assertEquals([...parseOpened('["phases","nope",3]')], ["phases"]);
  assertEquals(parseOpened("{oops").size, 0);
  assertEquals(parseOpened(null).size, 0);
});
