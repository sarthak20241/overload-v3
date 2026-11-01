// Run with: deno test --allow-all supabase/functions/ai-coach/cardRouting.test.ts
//
// With a meal card on screen, a message used to skip the router: every one was
// a correction, so a question got a canned breakdown and "make it a meal" was
// never heard. The owner's thread, 2026-10-21 (card: rice, paneer sabji,
// Tomato and Onion, masoor dal):
//   "shall we make it a meal ... also there is some oil"  -> read as an edit; the save ignored
//   "how is it 240 cals? also why did u add tomato and onion separately"
//                                                         -> the canned breakdown
//   "u didn't even reply to me?"                          -> the SAME canned breakdown
// Now the router reads the card, and the food agent holds it: edit, remove,
// save, or answer. Nothing here calls a real model or Jev.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { CARD_MAX_LINES, type CardLine, cardLines, cardMayBeCut, foodIntentState, readFoodContext, readPreviousItems } from "./foodContext.ts";
import { CARD_NOTE, type FoodAgentDeps, openingText, runFoodAgent, toolsFor } from "./foodAgent.ts";
import {
  CARD_AGENT_FLOOR,
  cardQuestionFellToParse,
  decideFoodAction,
  isBareAck,
  type FoodIntentDecision,
  routeFoodIntent,
  shouldRouteFoodIntent,
  wantsFoodAgent,
} from "./foodIntent.ts";
import { MAX_ITEMS_PER_PARSE, type ParseMealDeps, type ParseMealResult } from "./parseMeal.ts";

const CARD: CardLine[] = [
  { food_name: "Rice, cooked, NFS", quantity: 150, serving_label: "g", grams: 150, kcal: 194, protein_g: 4, carb_g: 42, fat_g: 0.4, food_id: "r1", source: "catalog" },
  { food_name: "Milky Mist low fat paneer sabji", quantity: 1, serving_label: "serving", grams: 180, kcal: 240, protein_g: 18, carb_g: 8, fat_g: 14, source: "estimate" },
  { food_name: "Tomato and Onion", quantity: 1, serving_label: "serving", grams: 60, kcal: 22, protein_g: 1, carb_g: 5, fat_g: 0.2, source: "estimate" },
  { food_name: "Masoor dal (cooked)", quantity: 1, serving_label: "katori", grams: 150, kcal: 150, protein_g: 9, carb_g: 22, fat_g: 3, source: "catalog" },
];
const decision = (d: Partial<FoodIntentDecision>): FoodIntentDecision => ({
  intent: "other", source: "jev", confidence: 0.9, note: "test", savedMatch: null, ...d,
});

// ── The router runs with a card open, and sees it ───────────────────────────

Deno.test("the failure this prevents: a message beside a card skipped the router", () => {
  assertEquals(shouldRouteFoodIntent("on"), true);
  assertEquals(shouldRouteFoodIntent("off"), false);
});

Deno.test("the router's state carries the card, one numbered line per food", () => {
  const ctx = { ...readFoodContext([], null), card: CARD };
  const state = JSON.parse(foodIntentState("remove the dal", ctx));
  assertEquals(state.card.length, 4);
  assertEquals(state.card[2], "3. Tomato and Onion: 1 serving, 60 g, 22 kcal");
  // No card: the state is as it was.
  assertEquals(foodIntentState("2 eggs", readFoodContext([], null)), "2 eggs");
});

function jevSays(intent: string, conf: number): ParseMealDeps["fetchFn"] {
  return (async () => Response.json({
    model: "jev-test", usage: {},
    answers: { intent: { type: "choice", choice: intent, confidence: conf, probabilities: { [intent]: conf } }, has_food: { type: "noul", noul: 0.3 } },
  })) as typeof fetch;
}

Deno.test("'edit' is an intent only while a card is open", async () => {
  const deps = { jev: { apiKey: "k", timeoutMs: 1000, fetchFn: jevSays("edit", 0.9) } };
  const withCard = await routeFoodIntent("they were small", deps, { ...readFoodContext([], null), card: CARD });
  assertEquals(withCard.intent, "edit");
  // No card: an 'edit' verdict is unusable and the ladder falls to the floor.
  const noCard = await routeFoodIntent("they were small", deps, readFoodContext([], null));
  assertEquals(noCard.intent, "log");
});

Deno.test("the failure this prevents: a bare 'ok' beside a card was read as a save request", async () => {
  // Live, 2026-10-22: Jev scored "ok" as create at 0.70-0.75 with a card open,
  // right against the create bar, so the agent offered a save card for "ok".
  const deps = { jev: { apiKey: "k", timeoutMs: 1000, fetchFn: jevSays("create", 0.75) } };
  const ctx = { ...readFoodContext([], null), card: CARD };
  const d = await routeFoodIntent("ok", deps, ctx);
  assertEquals([d.intent, d.confidence], ["other", 0]);
  assertEquals(decideFoodAction({ decision: d, mode: "on", parseFoundFood: true, clientSupportsCreate: true, cardOpen: true }), "log");
  assertEquals(wantsFoodAgent(d, true, true), false);
  // A real save request beside the same card is untouched.
  const save = await routeFoodIntent("shall we make it a meal, I have this daily", deps, ctx);
  assertEquals(save.intent, "create");
  // No card: the ack rule does not apply, and Jev's verdict stands.
  assertEquals((await routeFoodIntent("ok", deps, readFoodContext([], null))).intent, "create");
  // The rule covers EVERY verdict: Jev calling "ok" an edit at 0.9 would
  // otherwise start the agent on a message with nothing to change.
  const asEdit = { jev: { apiKey: "k", timeoutMs: 1000, fetchFn: jevSays("edit", 0.9) } };
  const e = await routeFoodIntent("ok", asEdit, ctx);
  assertEquals([e.intent, e.confidence], ["other", 0]);
  assertEquals(wantsFoodAgent(e, true, true), false);
});

Deno.test("isBareAck: stock words only, never a message with content", () => {
  for (const t of ["ok", "OK!", "yes", "cool", "thanks", "thanks that's it", "looks good", "all good, thanks"]) assertEquals(isBareAck(t), true, t);
  for (const t of ["", "ok make it 2", "thanks, remove the dal", "yes it was navratri chana", "ok but how is it 240"]) assertEquals(isBareAck(t), false, t);
  // A short question is a question for the agent, never an ack.
  for (const t of ["is it right", "is that all", "right?", "go ahead?"]) assertEquals(isBareAck(t), false, t);
  // Filler alone is not an ack: at least one word must mean yes or thanks.
  // ("it good" IS one: "good" means yes.)
  for (const t of ["that all", "you that", "looks it", "it that all"]) assertEquals(isBareAck(t), false, t);
  assertEquals(isBareAck("it good"), true);
});

Deno.test("the failure this prevents: the card-question trace flag was always false", () => {
  // The outcome's cardOpen was never stamped, so card_question_to_parse could
  // not fire and the canned-breakdown rate was unmeasurable. The flag is pure
  // now, and it fires exactly when a card question fell to the parse.
  const other = decision({ intent: "other" });
  assertEquals(cardQuestionFellToParse(other, { cardOpen: true, action: "log" }), true);
  // Not when the agent took it, not without a card, not for an edit or a log.
  assertEquals(cardQuestionFellToParse(other, { cardOpen: true, action: "agent" }), false);
  assertEquals(cardQuestionFellToParse(other, { cardOpen: false, action: "log" }), false);
  assertEquals(cardQuestionFellToParse(other, { action: "log" }), false);
  assertEquals(cardQuestionFellToParse(decision({ intent: "edit" }), { cardOpen: true, action: "log" }), false);
  assertEquals(cardQuestionFellToParse(null, { cardOpen: true, action: "log" }), false);
});

// ── Policy: who handles what beside a card ─────────────────────────────────

Deno.test("beside a card: edit, create and a question go to the agent; new food stays on the parse", () => {
  const go = (intent: FoodIntentDecision["intent"], conf = 0.9) =>
    decideFoodAction({ decision: decision({ intent, confidence: conf }), mode: "on", parseFoundFood: true, clientSupportsCreate: true, cardOpen: true });
  assertEquals(go("edit"), "agent");
  assertEquals(go("create"), "agent");
  assertEquals(go("other"), "agent");
  // The failure this prevents: "u didn't even reply to me?" read as create at
  // 0.50 and the agent offered a save card. A save keeps the create bar.
  assertEquals(go("create", 0.5), "log");
  assertEquals(go("create", 0.69), "log");
  assertEquals(go("log"), "log");
  // Unsure: the correction path edits the card from the user's words.
  assertEquals(go("edit", CARD_AGENT_FLOOR - 0.01), "log");
  // A client that cannot draw a save card gets the parse, as before.
  assertEquals(decideFoodAction({ decision: decision({ intent: "edit" }), mode: "on", parseFoundFood: true, clientSupportsCreate: false, cardOpen: true }), "log");
  // No card: a sure 'other' is still a plain reply, not the agent.
  assertEquals(wantsFoodAgent(decision({ intent: "other" }), true, false), false);
  assertEquals(decideFoodAction({ decision: decision({ intent: "other" }), mode: "on", parseFoundFood: false, clientSupportsCreate: true }), "reply");
});

// ── The agent holds the card ────────────────────────────────────────────────

type Use = { name: string; input: Record<string, unknown> };
function scripted(script: Use[][], bodies: Record<string, unknown>[] = []): FoodAgentDeps["callModel"] {
  let n = 0;
  return async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const uses = script[Math.min(n, script.length - 1)];
    n++;
    return { ok: true, data: { usage: { input_tokens: 1, output_tokens: 1 }, content: uses.map((u, i) => ({ type: "tool_use", id: `t${n}_${i}`, name: u.name, input: u.input })) } };
  };
}
const EMPTY_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
function deps(callModel: FoodAgentDeps["callModel"], corrections: string[] = []): FoodAgentDeps {
  return {
    model: "sonnet", callModel,
    readDiary: async () => [], savedMeals: async () => [],
    parseFood: async () => ({ parsed: null, declined: { message: "no" }, usage: EMPTY_USAGE, tool_calls: [], steps: [], iterations: 0 }),
    correctCard: async (change) => {
      corrections.push(change);
      const r: ParseMealResult = {
        parsed: {
          meal_type: "lunch", drona_line: "Updated.", corrects_previous: true,
          items: [{ food_id: null, food_name: "Milky Mist low fat paneer sabji", quantity: 1, serving_label: "serving", grams: 120, kcal: 160, protein_g: 14, carb_g: 6, fat_g: 9, fiber_g: null, source: "estimate", assumption: null, confidence: "medium" }],
        },
        declined: null, usage: EMPTY_USAGE, tool_calls: ["extract_meal", "log_meal"], steps: [], iterations: 2,
      };
      return r;
    },
  };
}
const INPUT = { text: "x", defaultMeal: "lunch" as const, card: CARD };

Deno.test("the agent is shown the card and gets the card tools only when one is open", async () => {
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent({ ...INPUT, text: "how is it 240 cals?" }, deps(scripted([[{ name: "reply", input: { text: "ok" } }]], bodies)));
  const names = (bodies[0].tools as { name: string }[]).map((t) => t.name);
  assert(names.includes("edit_card") && names.includes("remove_card_lines") && names.includes("save_card_as_meal"), names.join(","));
  assert(String(bodies[0].system).includes(CARD_NOTE.slice(0, 40)));
  const msgs = bodies[0].messages as { content: string }[];
  assert(msgs[0].content.includes(cardLines(CARD)[1]), msgs[0].content);
  assertEquals(toolsFor(null).some((t) => t.name === "edit_card"), false);
  assertEquals(openingText({ text: "2 eggs" }, null), "2 eggs");
});

Deno.test("the failure this prevents: 'why did u add tomato and onion separately' removes that line", async () => {
  const out = await runFoodAgent(
    { ...INPUT, text: "why did u add tomato and onion as seperate food item as well" },
    deps(scripted([[{ name: "remove_card_lines", input: { lines: [3], summary: "Took the separate tomato and onion off, they are in the sabji." } }]])),
  );
  assert(out.kind === "log", out.kind);
  const items = out.result.parsed!.items;
  assertEquals(items.map((i) => i.food_name), ["Rice, cooked, NFS", "Milky Mist low fat paneer sabji", "Masoor dal (cooked)"]);
  // The kept lines come back exactly as they were, and the card is REPLACED.
  assertEquals([items[0].kcal, items[0].food_id, items[1].kcal], [194, "r1", 240]);
  assertEquals(out.result.parsed!.corrects_previous, true);
});

Deno.test("a kept line comes back exactly as it was: section, confidence, note and fiber carried", async () => {
  // The failure this prevents: remove_card_lines rebuilt every kept line as
  // "high" confidence, no note, no fiber, stamped into the default meal.
  const card: CardLine[] = [
    { ...CARD[0], meal_type: "dinner", confidence: "low", assumption: "Took the plain cooked row.", fiber_g: 1.2, said_name: "chawal" },
    { ...CARD[2], meal_type: "dinner" },
  ];
  const out = await runFoodAgent(
    { text: "remove the tomato line", defaultMeal: "lunch", card },
    deps(scripted([[{ name: "remove_card_lines", input: { lines: [2], summary: "Off it goes." } }]])),
  );
  assert(out.kind === "log", out.kind);
  const [rice] = out.result.parsed!.items;
  assertEquals([rice.meal_type, rice.confidence, rice.assumption, rice.fiber_g, rice.said_name], ["dinner", "low", "Took the plain cooked row.", 1.2, "chawal"]);
  assertEquals(out.result.parsed!.meal_type, "dinner");
});

Deno.test("an edit goes through the correction path and replaces the card", async () => {
  const corrections: string[] = [];
  const out = await runFoodAgent(
    { ...INPUT, text: "i said 65g paneer grilled with onion and tomato, how is it 240" },
    deps(scripted([[{ name: "edit_card", input: { change: "the paneer sabji is 65 g paneer grilled with onion, tomato and a little oil", summary: "Reworked the sabji from 65 g paneer." } }]]), corrections),
  );
  assert(out.kind === "log", out.kind);
  assertEquals(corrections, ["the paneer sabji is 65 g paneer grilled with onion, tomato and a little oil"]);
  assertEquals(out.result.parsed!.corrects_previous, true);
  assertEquals(out.result.parsed!.drona_line, "Reworked the sabji from 65 g paneer.");
});

Deno.test("'make it a meal' with a card open becomes a save card with every line copied", async () => {
  const out = await runFoodAgent(
    { ...INPUT, text: "shall we make it a meal as I will be having this daily" },
    deps(scripted([[{ name: "save_card_as_meal", input: { name: "Paneer sabji lunch", log_now: true, summary: "Paneer sabji lunch, 4 items. Want it in My Meals?" } }]])),
  );
  assert(out.kind === "create", out.kind);
  assertEquals(out.create.tool, "create_custom_meal");
  const input = out.create.input as { name: string; log_now: boolean; items: Record<string, unknown>[] };
  assertEquals([input.name, input.log_now, input.items.length], ["Paneer sabji lunch", true, 4]);
  assertEquals(input.items[1], { name: "Milky Mist low fat paneer sabji", quantity: 1, serving_label: "serving", grams: 180, kcal: 240, protein_g: 18, carb_g: 8, fat_g: 14, estimated: true });
});

Deno.test("the failure this prevents: removing every line sent a zero-item meal, which the app reads as an error", async () => {
  const out = await runFoodAgent(
    { text: "scrap all of it", defaultMeal: "lunch", card: [CARD[0]] },
    deps(scripted([[{ name: "remove_card_lines", input: { lines: [1], summary: "All gone." } }]])),
  );
  assert(out.kind === "log", out.kind);
  // Cleared, the way the X button clears the last line: no parsed meal at all.
  assertEquals(out.result.parsed, null);
  assertEquals(out.result.declined, { message: "All gone.", cleared: true });
});

Deno.test("a save marks estimated lines as estimated, and runs through the create validator", async () => {
  const out = await runFoodAgent(
    { ...INPUT, text: "make it a meal" },
    deps(scripted([[{ name: "save_card_as_meal", input: { name: "Lunch", log_now: false, summary: "Lunch, 4 items. Want it in My Meals?" } }]])),
  );
  assert(out.kind === "create", out.kind);
  const items = out.create.input.items as Record<string, unknown>[];
  // CARD[0] is catalog, CARD[1] and CARD[2] are estimates, CARD[3] is catalog.
  assertEquals(items.map((i) => i.estimated), [false, true, true, false]);
});

Deno.test("an app with no count: a card at its old cap of 12 gets no card tools, it may be 12 of more", async () => {
  // Builds before previous_items_total cut previous_items at 12 without a
  // count, so a 30-line card arrives as 12. Editing it would drop lines 13+.
  // With no count the agent cannot tell, so it keeps only the plain tools and
  // the parse path still runs. One under that cap is a whole card.
  const twelve = Array.from({ length: 12 }, (_, i) => ({ ...CARD[0], food_name: `line ${i + 1}` }));
  assertEquals(toolsFor(twelve).some((t) => t.name === "remove_card_lines"), false);
  assertEquals(toolsFor(twelve.slice(0, 11)).some((t) => t.name === "remove_card_lines"), true);
  // And a finish that names a card tool on such a card is refused, not acted on.
  const out = await runFoodAgent(
    { text: "remove line 3", defaultMeal: "lunch", card: twelve },
    deps(scripted([[{ name: "remove_card_lines", input: { lines: [3], summary: "x" } }]])),
  );
  assertEquals(out.kind, "failed");
});

Deno.test("the failure this prevents: a card at the old cap reached the agent with its card tools withheld", async () => {
  // index.ts treats a card that may be cut as NOT open, so the policy keeps it
  // on the parse. Pinned here through the same switch that index.ts computes:
  // cardOpen = card.length > 0 && !cardMayBeCut(card, total), total null here.
  const twelve = Array.from({ length: 12 }, (_, i) => ({ ...CARD[0], food_name: `line ${i + 1}` }));
  const cardOpen = twelve.length > 0 && !cardMayBeCut(twelve);
  assertEquals(cardOpen, false);
  const d = decision({ intent: "edit", confidence: 0.99 });
  assertEquals(wantsFoodAgent(d, true, cardOpen), false);
  assertEquals(decideFoodAction({ decision: d, mode: "on", parseFoundFood: true, clientSupportsCreate: true, cardOpen }), "log");
  // One line under the cap is whole, and the same edit goes to the agent.
  const eleven = twelve.slice(0, 11);
  assertEquals(wantsFoodAgent(d, true, eleven.length > 0 && !cardMayBeCut(eleven)), true);
});

Deno.test("the failure this prevents: a 15-line card arrived as 12, so the agent could not touch it", async () => {
  // The app sends every line and the count; the server reads them all. The
  // card is whole, its tools are offered, and line 14 means line 14.
  const sent = Array.from({ length: 15 }, (_, i) => ({ ...CARD[0], food_name: `line ${i + 1}` }));
  const { items, total } = readPreviousItems(sent, 15);
  assertEquals(items.length, 15);
  const card: CardLine[] = items.map((p) => ({ ...p, kcal: p.kcal ?? 0 }));
  assertEquals(cardMayBeCut(card, total), false);
  assertEquals(toolsFor(card, total).some((t) => t.name === "remove_card_lines"), true);
  assertEquals(cardLines(card).length, 15, "the agent must see every line it can name");
  const out = await runFoodAgent(
    { text: "take line 14 off", defaultMeal: "lunch", card, cardTotal: total },
    deps(scripted([[{ name: "remove_card_lines", input: { lines: [14], summary: "Took it off." } }]])),
  );
  assert(out.kind === "log", out.kind);
  const names = out.result.parsed!.items.map((i) => i.food_name);
  assertEquals(names.length, 14);
  assertEquals(names.includes("line 14"), false);
  assertEquals(names.includes("line 15"), true);
});

Deno.test("a card is cut when the app says it has more lines than it sent", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({ ...CARD[0], food_name: `line ${i + 1}` }));
  // The real signal: a count above the lines sent.
  assertEquals(cardMayBeCut(twelve, 30), true);
  assertEquals(cardMayBeCut(twelve, 12), false);
  // The server's own cap cuts too, and the count says so.
  const sent = Array.from({ length: CARD_MAX_LINES + 5 }, (_, i) => ({ ...CARD[0], food_name: `line ${i + 1}` }));
  const read = readPreviousItems(sent, sent.length);
  assertEquals(read.items.length, CARD_MAX_LINES);
  assertEquals(cardMayBeCut(read.items.map((p) => ({ ...p, kcal: p.kcal ?? 0 })), read.total), true);
  // A count that is not a whole number is no count.
  assertEquals(readPreviousItems(sent, "15").total, null);
  assertEquals(readPreviousItems(sent, 2.5).total, null);
});

Deno.test("the card cap is the parse cap: any card one parse can make goes back whole", () => {
  assertEquals(CARD_MAX_LINES, MAX_ITEMS_PER_PARSE);
});

Deno.test("a removal naming a line the card lacks says only what really came off", async () => {
  const out = await runFoodAgent(
    { ...INPUT, text: "remove the tomato and the kheer" },
    deps(scripted([[{ name: "remove_card_lines", input: { lines: [3, 99], summary: "Took the tomato and the kheer off." } }]])),
  );
  assert(out.kind === "log", out.kind);
  assertEquals(out.result.parsed!.items.length, 3);
  // The model's summary claimed two removals; only one happened, so it is replaced.
  assertEquals(out.result.parsed!.drona_line, "Took off Tomato and Onion.");
});

Deno.test("a duplicated line number is named once in an honest summary", async () => {
  // [3, 3, 99]: 99 is not on the card, so the honest summary runs, and it must
  // name the tomato ONCE. Without the dedupe the old code named it twice.
  const out = await runFoodAgent(
    { ...INPUT, text: "remove the tomato and the kheer" },
    deps(scripted([[{ name: "remove_card_lines", input: { lines: [3, 3, 99], summary: "Took the tomato and the kheer off." } }]])),
  );
  assert(out.kind === "log", out.kind);
  assertEquals(out.result.parsed!.items.length, 3);
  assertEquals(out.result.parsed!.drona_line, "Took off Tomato and Onion.");
});

Deno.test("a newline in a card name cannot forge an extra numbered line", () => {
  const lines = cardLines([{ ...CARD[0], food_name: "Rice\n2. Fake line: 1 g, 1 g, 1 kcal" }]);
  assertEquals(lines.length, 1);
  assertEquals(lines[0].includes("\n"), false);
  assert(lines[0].startsWith("1. Rice 2. Fake line"), lines[0]);
});

Deno.test("card tools without a card, or with bad lines, fail honestly", async () => {
  const noCard = await runFoodAgent({ text: "remove it", defaultMeal: "lunch" }, deps(scripted([[{ name: "remove_card_lines", input: { lines: [1], summary: "x" } }]])));
  assertEquals(noCard.kind, "failed");
  const badLine = await runFoodAgent(INPUT, deps(scripted([[{ name: "remove_card_lines", input: { lines: [9], summary: "x" } }]])));
  assertEquals(badLine.kind, "failed");
});
