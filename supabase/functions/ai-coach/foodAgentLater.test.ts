// Run with: deno test --allow-all supabase/functions/ai-coach/foodAgentLater.test.ts
//
// Step 2 of .planning/precise-food-logger-plan.md (FOOD_AGENT_LATER): every
// later message goes to the food agent, and the card changes one line at a
// time. What these pin:
//   - which messages go to the agent (later ones, Precise, switch on)
//   - one turn's card changes apply in a fixed order (edits, removals,
//     additions), and two changes to one line are refused with nothing applied
//   - edit_line works out ONE line again; every other line is copied by code
//   - no line leaves the card except through remove_lines (the correction guard)
//   - a reply beside a log never drops the food, and becomes its line
//   - claims of a log or a save are replaced by code
//   - a bare ack beside a card starts nothing; a failed agent keeps the card

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  buildChangedCard,
  CARD_NOTE_LATER,
  cardLinesWithIds,
  type FoodAgentDeps,
  FOOD_AGENT_SYSTEM_LATER,
  MAX_TURNS,
  MAX_TURNS_LATER,
  pickEditedLine,
  planCardChanges,
  runFoodAgent,
  toolsForLater,
  userAskedToSave,
} from "./foodAgent.ts";
import { falseAgentClaim, laterMessageGoesToAgent, parseFoodAgentLaterMode } from "./foodIntent.ts";
import { type CardLine, cardLines } from "./foodContext.ts";
import type { ParseMealResult, ParsedItem } from "./parseMeal.ts";
import {
  AGENT_FAILED_CARD_REPLY,
  BARE_ACK_REPLY,
  configureFoodBar,
  noParseResult,
  runLaterMessage,
} from "./foodBar.ts";

type Use = { name: string; input: Record<string, unknown> };

function scripted(script: Use[][], bodies: Record<string, unknown>[] = []): FoodAgentDeps["callModel"] {
  let n = 0;
  return async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const uses = script[Math.min(n, script.length - 1)];
    n++;
    return {
      ok: true,
      data: {
        usage: { input_tokens: 100, output_tokens: 20 },
        content: uses.map((u, i) => ({ type: "tool_use", id: `t${n}_${i}`, name: u.name, input: u.input })),
      },
    };
  };
}

const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };

function item(food_name: string, kcal: number, more: Partial<ParsedItem> = {}): ParsedItem {
  return {
    food_id: null, food_name, quantity: 1, serving_label: "serving", grams: 100, kcal,
    protein_g: 5, carb_g: 10, fat_g: 2, fiber_g: null, source: "catalog", assumption: null, confidence: "medium",
    ...more,
  };
}

function result(items: ParsedItem[]): ParseMealResult {
  return {
    parsed: { meal_type: "dinner", items, drona_line: "", corrects_previous: true },
    declined: null, usage: { ...USAGE, input_tokens: 50 }, tool_calls: ["extract_meal"], steps: [], iterations: 1, tier: "precise",
  };
}

const CARD: CardLine[] = [
  { food_name: "Roti", quantity: 2, serving_label: "piece", grams: 80, kcal: 240, protein_g: 7, carb_g: 36, fat_g: 7.4, source: "catalog", meal_type: "dinner" },
  { food_name: "Dal", quantity: 1, serving_label: "katori", grams: 150, kcal: 150, protein_g: 7, carb_g: 20, fat_g: 4, source: "catalog", meal_type: "dinner" },
  { food_name: "Onion salad", quantity: 1, serving_label: "bowl", grams: 80, kcal: 35, protein_g: 1, carb_g: 7, fat_g: 0.1, source: "estimate", meal_type: "dinner" },
];

function deps(callModel: FoodAgentDeps["callModel"], log: string[] = []): FoodAgentDeps {
  return {
    model: "sonnet",
    callModel,
    readDiary: async () => ({ meals: [] }),
    savedMeals: async () => [],
    parseFood: async (t) => {
      log.push(`parse:${t}`);
      return result([item(t, 155, { source: "estimate" })]);
    },
    editLine: async (i, change) => {
      log.push(`edit:${i}:${change}`);
      return result([item(`${CARD[i].food_name} (edited)`, 360)]);
    },
  };
}

const LATER = { text: "x", defaultMeal: "dinner" as const, card: CARD, later: true };

// ── Which messages go to the agent ─────────────────────────────────────────

Deno.test("laterMessageGoesToAgent: later messages only, Precise only, switch on only", () => {
  const base = { mode: "on" as const, precise: true, supportsCreate: true, hasModelKey: true, turns: 0, cardLines: 0, cardOpen: false, pending: false };
  // A first message with no card keeps today's path.
  assertFalse(laterMessageGoesToAgent(base));
  assert(laterMessageGoesToAgent({ ...base, turns: 2 }));
  assert(laterMessageGoesToAgent({ ...base, cardLines: 3, cardOpen: true }));
  assert(laterMessageGoesToAgent({ ...base, pending: true }));
  // Off, Quick or Thorough, an old client, or no key: today's path.
  assertFalse(laterMessageGoesToAgent({ ...base, turns: 2, mode: "off" }));
  assertFalse(laterMessageGoesToAgent({ ...base, turns: 2, precise: false }));
  assertFalse(laterMessageGoesToAgent({ ...base, turns: 2, supportsCreate: false }));
  assertFalse(laterMessageGoesToAgent({ ...base, turns: 2, hasModelKey: false }));
  // A card cut at the cap: the agent could not see all of it.
  assertFalse(laterMessageGoesToAgent({ ...base, turns: 2, cardLines: 12, cardOpen: false }));
});

Deno.test("parseFoodAgentLaterMode: only 'on' is on", () => {
  assertEquals(parseFoodAgentLaterMode("on"), "on");
  assertEquals(parseFoodAgentLaterMode(" ON "), "on");
  assertEquals(parseFoodAgentLaterMode("shadow"), "off");
  assertEquals(parseFoodAgentLaterMode(undefined), "off");
});

// ── Claims ──────────────────────────────────────────────────────────────────

Deno.test("falseAgentClaim: a log or a save never happened; a card change only when the card changed", () => {
  assert(falseAgentClaim("I've logged your dinner.", { cardChanged: true }));
  assert(falseAgentClaim("Saved it to your meals.", { cardChanged: true }) || falseAgentClaim("I have saved it.", { cardChanged: true }));
  assert(falseAgentClaim("Logging 2 eggs for you now.", { cardChanged: true }));
  assertFalse(falseAgentClaim("I've added 2 eggs to the card.", { cardChanged: true }));
  assert(falseAgentClaim("I've added 2 eggs to the card.", { cardChanged: false }));
  assertFalse(falseAgentClaim("Want me to add the eggs?", { cardChanged: false }));
  assertFalse(falseAgentClaim("650 is fine for a cut dinner if the day stays under target.", { cardChanged: false }));
});

// ── The plan: checked before anything runs ─────────────────────────────────

Deno.test("planCardChanges: two changes to one line are refused, nothing planned", () => {
  const editAndRemove = planCardChanges(CARD, [
    { name: "edit_line", input: { line_id: "L1", change: "3 roti" } },
    { name: "remove_lines", input: { line_ids: ["L1"] } },
  ]);
  assertFalse(editAndRemove.ok);
  if (!editAndRemove.ok) assert(editAndRemove.error.includes("L1 has two changes"));
  const twoEdits = planCardChanges(CARD, [
    { name: "edit_line", input: { line_id: "L2", change: "half" } },
    { name: "edit_line", input: { line_id: "l2", change: "double" } },
  ]);
  assertFalse(twoEdits.ok);
});

Deno.test("planCardChanges: unknown ids, empty edits, and a restore in the same turn are refused", () => {
  assertFalse(planCardChanges(CARD, [{ name: "edit_line", input: { line_id: "L9", change: "x" } }]).ok);
  assertFalse(planCardChanges(CARD, [{ name: "edit_line", input: { line_id: "L1", change: " " } }]).ok);
  assertFalse(planCardChanges(CARD, [{ name: "remove_lines", input: { line_ids: ["L4"] } }]).ok);
  assertFalse(planCardChanges(CARD, [{ name: "add_lines", input: {} }]).ok);
  assertFalse(planCardChanges(CARD, [{ name: "remove_lines", input: { line_ids: ["L3"] } }], true).ok);
});

Deno.test("planCardChanges: ids as the card shows them, removals once each, log_food is an addition", () => {
  const p = planCardChanges(CARD, [
    { name: "remove_lines", input: { line_ids: ["[L3]", "L3"] } },
    { name: "edit_line", input: { line_id: "L1", change: "3 pieces" } },
    { name: "log_food", input: { text: "2 boiled eggs" } },
  ]);
  assert(p.ok);
  if (!p.ok) return;
  assertEquals(p.edits, [{ index: 0, change: "3 pieces" }]);
  assertEquals(p.removes, [2]);
  assertEquals(p.adds.map((a) => a.text), ["2 boiled eggs"]);
});

// ── The card after: code copies every line it was not told to change ──────

Deno.test("buildChangedCard: untouched lines verbatim, the edit in its own place, additions last", () => {
  const out = buildChangedCard(CARD, new Set([2]), new Map([[0, item("Roti", 360, { meal_type: "lunch" })]]), [item("Boiled egg", 155)], "snack");
  assertEquals(out.map((i) => i.food_name), ["Roti", "Dal", "Boiled egg"]);
  assertEquals(out[0].kcal, 360);
  // The edited line keeps the card line's section, not the parse's.
  assertEquals(out[0].meal_type, "dinner");
  // The untouched line is the card's own: same numbers and source.
  assertEquals([out[1].kcal, out[1].protein_g, out[1].source, out[1].meal_type], [150, 7, "catalog", "dinner"]);
});

Deno.test("buildChangedCard: the correction guard, no line leaves except by removal", () => {
  for (const removes of [new Set<number>(), new Set([0]), new Set([1, 2])]) {
    const out = buildChangedCard(CARD, removes, new Map([[1, item("Dal", 300)]]), [], "dinner");
    // Every line not removed is on the card, once.
    assertEquals(out.length, CARD.length - removes.size);
  }
});

Deno.test("pickEditedLine: one item, else the same food, never a second line", () => {
  assertEquals(pickEditedLine(CARD[0], result([item("Roti", 360)]))?.kcal, 360);
  assertEquals(pickEditedLine(CARD[0], result([item("Onion", 20), item("Roti, whole wheat", 360)]))?.food_name, "Roti, whole wheat");
  assertEquals(pickEditedLine(CARD[0], result([])), null);
  // Several items and none is this food: no guess, the line stays.
  assertEquals(pickEditedLine(CARD[0], result([item("Onion", 20), item("Paneer", 200)])), null);
  assertEquals(pickEditedLine(CARD[0], null), null);
});

// ── The loop ────────────────────────────────────────────────────────────────

Deno.test("one turn, three changes: edit, removal and addition apply together, in order", async () => {
  const log: string[] = [];
  const out = await runFoodAgent(LATER, deps(scripted([[
    // Called in the "wrong" order on purpose: code applies edits, removals, additions.
    { name: "add_lines", input: { text: "2 boiled eggs" } },
    { name: "remove_lines", input: { line_ids: ["L3"] } },
    { name: "edit_line", input: { line_id: "L1", change: "3 pieces", summary: "Made it 3 roti, took off the onion salad, added the eggs." } },
  ]]), log));
  assertEquals(out.kind, "log");
  if (out.kind !== "log" || !out.result.parsed) return;
  const p = out.result.parsed;
  assertEquals(p.items.map((i) => i.food_name), ["Roti (edited)", "Dal", "2 boiled eggs"]);
  assertEquals(p.corrects_previous, true);
  // Only line 1 went back through the parse; the dal was copied.
  assertEquals(log.filter((l) => l.startsWith("edit:")), ["edit:0:3 pieces"]);
  assertEquals(p.items[1].kcal, 150);
  assertEquals(p.drona_line, "Made it 3 roti, took off the onion salad, added the eggs.");
  assertEquals(out.turns.length, 1);
});

Deno.test("a conflict goes back to the agent with nothing applied; the next turn lands", async () => {
  const log: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(LATER, deps(scripted([
    [
      { name: "edit_line", input: { line_id: "L2", change: "half" } },
      { name: "remove_lines", input: { line_ids: ["L2"] } },
    ],
    [{ name: "remove_lines", input: { line_ids: ["L2"] } }],
  ], bodies), log));
  // Turn 1 ran no edit at all.
  assertEquals(log.filter((l) => l.startsWith("edit:")), []);
  const turn2 = bodies[1].messages as { role: string; content: { content?: string }[] }[];
  const results = turn2.at(-1)!.content;
  assert(results.every((r) => String(r.content).includes("two changes")));
  assertEquals(out.kind, "log");
  if (out.kind === "log") assertEquals(out.result.parsed?.items.map((i) => i.food_name), ["Roti", "Onion salad"]);
});

Deno.test("a conflict on the last turn ends with the card as it was", async () => {
  const conflict: Use[] = [
    { name: "edit_line", input: { line_id: "L1", change: "a" } },
    { name: "edit_line", input: { line_id: "L1", change: "b" } },
  ];
  const out = await runFoodAgent(LATER, deps(scripted([conflict])));
  assertEquals(out.kind, "failed");
  if (out.kind === "failed") assertEquals(out.reason, "card_changes_rejected");
  assertEquals(out.turns.length, MAX_TURNS_LATER);
});

Deno.test("an edit that cannot be worked out leaves its line as it was, and says so", async () => {
  const d = deps(scripted([[
    { name: "edit_line", input: { line_id: "L2", change: "the special one", summary: "Updated the dal." } },
    { name: "add_lines", input: { text: "a lassi" } },
  ]]));
  d.editLine = async () => ({ ...noParseResult() });
  const out = await runFoodAgent(LATER, d);
  assertEquals(out.kind, "log");
  if (out.kind !== "log" || !out.result.parsed) return;
  assertEquals(out.result.parsed.items.map((i) => i.food_name), ["Roti", "Dal", "Onion salad", "a lassi"]);
  assertEquals(out.result.parsed.items[1].kcal, 150);
  // Code writes the line: the agent's "Updated the dal" did not happen.
  assert(out.result.parsed.drona_line.includes("could not change Dal"));
  assertFalse(out.result.parsed.drona_line.includes("Updated the dal"));
});

Deno.test("a reply beside a change is the card's line, and the message counts as answered", async () => {
  const out = await runFoodAgent(LATER, deps(scripted([[
    { name: "reply", input: { text: "650 is fine for dinner on a cut if lunch was light." } },
    { name: "add_lines", input: { text: "a bowl of curd" } },
  ]])));
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  assertEquals(out.answered, true);
  assertEquals(out.result.parsed?.drona_line, "650 is fine for dinner on a cut if lunch was light.");
  assertEquals(out.result.parsed?.items.length, 4);
});

Deno.test("no card: a reply sent before log_food never drops the food (log wins every tie)", async () => {
  const out = await runFoodAgent({ text: "x", defaultMeal: "dinner", later: true }, deps(scripted([[
    { name: "reply", input: { text: "That is a fair dinner for a cut." } },
    { name: "log_food", input: { text: "dinner about 650 calories", summary: "Dinner, 650 cal." } },
  ]])));
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  assertEquals(out.result.parsed?.items.length, 1);
  assertEquals(out.result.parsed?.drona_line, "That is a fair dinner for a cut.");
  assertEquals(out.answered, true);
});

Deno.test("a claimed log in the agent's words is replaced by code", async () => {
  const withCard = await runFoodAgent(LATER, deps(scripted([[{ name: "reply", input: { text: "I've logged your dinner." } }]])));
  assertEquals(withCard.kind, "reply");
  if (withCard.kind === "reply") assertFalse(withCard.text.includes("logged your dinner"));
  const change = await runFoodAgent(LATER, deps(scripted([[{ name: "remove_lines", input: { line_ids: ["L3"], summary: "Logged it without the salad." } }]])));
  if (change.kind === "log") assertEquals(change.result.parsed?.drona_line, "Took off Onion salad.");
});

Deno.test("a later message gets six turns; the off path keeps five", async () => {
  assertEquals(MAX_TURNS_LATER, 6);
  assertEquals(MAX_TURNS, 5);
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(LATER, deps(scripted([[{ name: "coach_list_saved_meals", input: {} }]], bodies)));
  assertEquals(bodies.length, 6);
  const lastMsgs = bodies[5].messages as { role: string; content: string }[];
  assert(lastMsgs.at(-1)!.content.includes("LAST turn"));
});

Deno.test("tools and words for a later message beside a card: line tools, ids, no edit_card", async () => {
  const names = toolsForLater(CARD).map((t) => t.name);
  for (const n of ["edit_line", "remove_lines", "add_lines", "save_card_as_meal", "reply"]) assert(names.includes(n), n);
  for (const n of ["edit_card", "remove_card_lines", "log_food"]) assertFalse(names.includes(n), n);
  assert(toolsForLater(null).some((t) => t.name === "log_food"));
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(LATER, deps(scripted([[{ name: "reply", input: { text: "Sure." } }]], bodies)));
  assert(String(bodies[0].system).startsWith(FOOD_AGENT_SYSTEM_LATER));
  assert(String(bodies[0].system).includes(CARD_NOTE_LATER));
  const first = (bodies[0].messages as { content: string }[])[0].content;
  assert(first.includes("[L1] Roti"), first);
  assert(first.includes("[L3] Onion salad"));
});

// ── The food box around it ─────────────────────────────────────────────────

function configure(callAnthropic: (b: Record<string, unknown>) => Promise<{ ok: true; data: unknown }>): void {
  configureFoodBar({
    intentMode: "on",
    anthropicApiKey: "test",
    parseModel: "haiku",
    agentModel: "sonnet",
    jev: null,
    callAnthropic: callAnthropic as never,
  });
}

function agentArgs(over: Record<string, unknown> = {}) {
  return {
    intentP: Promise.resolve(null),
    supportsCreate: true,
    text: "ok cool",
    mealHint: "dinner" as const,
    localHour: 20,
    localDate: "2026-11-06",
    mode: "super" as const,
    savedMealsP: Promise.resolve([]),
    readDiary: async () => ({ meals: [] }),
    contextPromise: Promise.resolve({ recentFoods: [], todayTotals: null, targets: null }),
    parseDeps: () => ({}) as never,
    logUsage: () => {},
    userId: "u",
    recentTurns: [{ role: "user" as const, text: "2 roti and dal" }],
    pendingMeal: null,
    card: { lines: CARD, previousText: "2 roti and dal", previousWords: null, previousItems: CARD.map((c) => ({ ...c, food_id: null })) },
    ...over,
  };
}

Deno.test("runLaterMessage: a bare ack beside a card starts nothing and changes nothing", async () => {
  let calls = 0;
  configure(async () => { calls++; return { ok: true, data: { content: [] } }; });
  let parsed = false;
  const r = await runLaterMessage({ agent: agentArgs(), cardOpen: true, fallbackParse: async () => { parsed = true; return noParseResult(); } });
  assertEquals(r.outcome.action, "reply");
  assertEquals(r.outcome.reply, BARE_ACK_REPLY);
  assertEquals(calls, 0);
  assertFalse(parsed);
});

Deno.test("runLaterMessage: a failed agent beside a card keeps the card, and no parse runs", async () => {
  // The model call fails: so does the agent.
  configure((async () => ({ ok: false, status: 500, body: "down" })) as never);
  let parsed = false;
  const r = await runLaterMessage({
    agent: agentArgs({ text: "make the dal a big bowl" }),
    cardOpen: true,
    fallbackParse: async () => { parsed = true; return noParseResult(); },
  });
  assertEquals(r.outcome.action, "reply");
  assertEquals(r.outcome.reply, AGENT_FAILED_CARD_REPLY);
  assertEquals(r.outcome.agent?.kind, "failed");
  assertFalse(parsed);
});

Deno.test("runLaterMessage: a failed agent with no card falls back to the parse, so the food is logged", async () => {
  configure((async () => ({ ok: false, status: 500, body: "down" })) as never);
  const r = await runLaterMessage({
    agent: agentArgs({ text: "2 eggs", card: null }),
    cardOpen: false,
    fallbackParse: async () => result([item("Egg", 155)]),
  });
  assertEquals(r.outcome.action, "log");
  assertEquals(r.result.parsed?.items[0].food_name, "Egg");
  assert(r.firstParse);
});

Deno.test("words with no tool call: a later message answers with them (checked); the off path still fails", async () => {
  const words = (text: string): FoodAgentDeps["callModel"] => async () => ({
    ok: true,
    data: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text }] },
  });
  const later = await runFoodAgent(LATER, deps(words("The dal is 150 kcal for one katori — it is the catalog figure.")));
  assertEquals(later.kind, "reply");
  if (later.kind === "reply") assertEquals(later.text, "The dal is 150 kcal for one katori, it is the catalog figure.");
  // A claimed log in plain words is replaced too.
  const claim = await runFoodAgent(LATER, deps(words("Logged your dinner.")));
  if (claim.kind === "reply") assertFalse(claim.text.includes("Logged your dinner"));
  const off = await runFoodAgent({ ...LATER, later: false }, deps(words("The dal is 150 kcal.")));
  assertEquals(off.kind, "failed");
});

Deno.test("a later log that finds no food goes back to the agent, which can try again", async () => {
  const log: string[] = [];
  const d = deps(scripted([
    [{ name: "log_food", input: { text: "a rough dinner" } }, { name: "reply", input: { text: "Put it on the card." } }],
    [{ name: "log_food", input: { text: "dal and 2 roti" } }],
  ]), log);
  d.parseFood = async (t) => {
    log.push(`parse:${t}`);
    return t === "a rough dinner" ? { ...noParseResult(), declined: { message: "no food" } } : result([item("Dal", 150), item("Roti", 240)]);
  };
  const out = await runFoodAgent({ text: "x", defaultMeal: "dinner", later: true }, d);
  assertEquals(out.kind, "log");
  if (out.kind === "log") assertEquals(out.result.parsed?.items.length, 2);
  assertEquals(out.turns.length, 2);
  // The first parse is not paid twice.
  assertEquals(log.filter((l) => l === "parse:a rough dinner").length, 1);
});

Deno.test("a diary read in the same turn holds the change: the read runs, the addition waits, nothing is lost", async () => {
  const log: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const d = deps(scripted([
    [{ name: "coach_list_logged_meals", input: { days_ago: 1 } }, { name: "add_lines", input: { text: "2 boiled eggs" } }],
    [{ name: "add_lines", input: { text: "2 boiled eggs" } }, { name: "add_lines", input: { text: "dal" } }],
  ], bodies), log);
  d.readDiary = async () => { log.push("diary"); return { meals: [] }; };
  const out = await runFoodAgent(LATER, d);
  assertEquals(log.filter((l) => l === "diary").length, 1);
  assertEquals(out.turns.length, 2);
  const turn2 = bodies[1].messages as { content: { content?: string }[] }[];
  assert(String(turn2.at(-1)!.content[1].content).includes("Not applied yet"));
  if (out.kind === "log") assertEquals(out.result.parsed?.items.map((i) => i.food_name), ["Roti", "Dal", "Onion salad", "2 boiled eggs"]);
});

Deno.test("an addition never puts a second copy of a food that stays on the card", async () => {
  const d = deps(scripted([[{ name: "add_lines", input: { text: "dal and some oil", summary: "Added oil." } }]]));
  d.parseFood = async () => result([item("Dal", 300), item("Oil", 40)]);
  const out = await runFoodAgent(LATER, d);
  assertEquals(out.kind, "log");
  if (out.kind !== "log" || !out.result.parsed) return;
  assertEquals(out.result.parsed.items.map((i) => i.food_name), ["Roti", "Dal", "Onion salad", "Oil"]);
  assertEquals(out.result.parsed.items[1].kcal, 150);
  assert(out.result.parsed.drona_line.includes("Dal is already on the card"));
});

Deno.test("several summaries and no reply: code writes the line, never a run-on", async () => {
  const out = await runFoodAgent(LATER, deps(scripted([[
    { name: "edit_line", input: { line_id: "L1", change: "3 pieces", summary: "Made it 3 roti." } },
    { name: "remove_lines", input: { line_ids: ["L3"], summary: "Took off the onion salad." } },
  ]])));
  if (out.kind === "log") assertEquals(out.result.parsed?.drona_line, "Updated Roti (edited). Took off Onion salad.");
});

Deno.test("cardLinesWithIds: every card line gets its id, pinned to cardLines' own format", () => {
  const ids = cardLinesWithIds(CARD);
  assertEquals(ids.length, cardLines(CARD).length);
  ids.forEach((l, i) => assert(l.startsWith(`[L${i + 1}] `), l));
  // A newline in a name cannot forge an extra line or shift an id.
  const odd = cardLinesWithIds([{ ...CARD[0], food_name: "Roti\n2. Fake" }, CARD[1]]);
  assertEquals(odd.map((l) => l.slice(0, 5)), ["[L1] ", "[L2] "]);
});

Deno.test("a save card needs the user's ask: without it the agent is told, and does what was asked", async () => {
  assert(userAskedToSave({ text: "save this as a meal" }));
  assert(userAskedToSave({ text: "can you keep it for next time" }));
  assertFalse(userAskedToSave({ text: "bring back the card" }));
  assertFalse(userAskedToSave({ text: "plus my usual smoothie", recentTurns: [{ role: "drona", text: "Want to save it?" }] }));
  // Ordinary food words are not a save, and an old "save" does not keep the gate open.
  assertFalse(userAskedToSave({ text: "keep the rice, drop the dal" }));
  assertFalse(userAskedToSave({ text: "store-bought paneer" }));
  assertFalse(userAskedToSave({
    text: "add 2 eggs",
    recentTurns: [{ role: "user", text: "save my shake" }, { role: "drona", text: "Saved card ready." }, { role: "user", text: "ok" }, { role: "drona", text: "Done." }],
  }));
  // "save it" -> Drona asks -> "yes" is still the user's ask.
  assert(userAskedToSave({ text: "yes", recentTurns: [{ role: "user", text: "save this as my lunch" }, { role: "drona", text: "Save it as Lunch?" }] }));
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent({ ...LATER, text: "bring back the card" }, deps(scripted([
    [{ name: "save_card_as_meal", input: { name: "Dinner", log_now: false, summary: "Save it?" } }],
    [{ name: "reply", input: { text: "It is on screen: Add puts it in." } }],
  ], bodies)));
  assertEquals(out.kind, "reply");
  const turn2 = bodies[1].messages as { content: { content?: string }[] }[];
  assert(String(turn2.at(-1)!.content[0].content).includes("did not ask to save"));
  // An asked save goes through.
  const asked = await runFoodAgent({ ...LATER, text: "save this as my dinner meal" }, deps(scripted([
    [{ name: "save_card_as_meal", input: { name: "Dinner", log_now: false, summary: "Save it?" } }],
  ])));
  assertEquals(asked.kind, "create");
});

Deno.test("a refused plan also holds a save in the same turn (told why, never an unknown tool)", async () => {
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent({ ...LATER, text: "save it and fix the roti" }, deps(scripted([
    [
      { name: "edit_line", input: { line_id: "L9", change: "x" } },
      { name: "save_card_as_meal", input: { name: "Dinner", log_now: false, summary: "Save it?" } },
    ],
    [{ name: "reply", input: { text: "Which line did you mean?" } }],
  ], bodies)));
  assertEquals(out.kind, "reply");
  const turn2 = bodies[1].messages as { content: { content?: string }[] }[];
  assert(String(turn2.at(-1)!.content[1].content).includes("not on the card"));
});

Deno.test("two additions of one food in one turn: the second is left off", async () => {
  const d = deps(scripted([[{ name: "add_lines", input: { text: "an egg" } }, { name: "add_lines", input: { text: "one more egg" } }]]));
  d.parseFood = async () => result([item("Egg", 78)]);
  const out = await runFoodAgent(LATER, d);
  if (out.kind === "log") assertEquals(out.result.parsed?.items.filter((i) => i.food_name === "Egg").length, 1);
});

Deno.test("runLaterMessage: a bare 'yes' after Drona asked something goes to the agent", async () => {
  let calls = 0;
  configure(async () => {
    calls++;
    return { ok: true, data: { usage: {}, content: [{ type: "tool_use", id: "t", name: "reply", input: { text: "Done thinking." } }] } };
  });
  const r = await runLaterMessage({
    agent: agentArgs({ text: "yes", recentTurns: [{ role: "user", text: "2 roti and dal" }, { role: "drona", text: "Dal is already on the card: add a second portion, or skip?" }] }),
    cardOpen: true,
    fallbackParse: async () => noParseResult(),
  });
  assertEquals(calls, 1);
  assertEquals(r.outcome.agent?.kind, "reply");
});

Deno.test("a save in the same turn as card changes: the changes land, and the user is told the save waits", async () => {
  const out = await runFoodAgent({ ...LATER, text: "make it 3 roti and save it" }, deps(scripted([[
    { name: "edit_line", input: { line_id: "L1", change: "3 pieces" } },
    { name: "save_card_as_meal", input: { name: "Dinner", log_now: false, summary: "Save it?" } },
  ]])));
  assertEquals(out.kind, "log");
  if (out.kind === "log") assert(out.result.parsed?.drona_line.endsWith("Ask me to save it once the card looks right."));
});

// ── Before the switch goes on (review of b8428bf4) ─────────────────────────

Deno.test("editLineInput: the edit works on the card line's own food, never a mismatched one", async () => {
  const { editLineInput } = await import("./foodBar.ts");
  const prev = CARD.map((c) => ({ ...c, food_id: null }));
  assertEquals(editLineInput({ lines: CARD, previousItems: prev }, 1, "half")?.item.food_name, "Dal");
  // previousItems out of order against the card: the edit fails, whatever comes back.
  const swapped = [prev[1], prev[0], prev[2]];
  assertEquals(editLineInput({ lines: CARD, previousItems: swapped }, 0, "3 pieces"), null);
  assertEquals(editLineInput({ lines: CARD, previousItems: prev.slice(0, 1) }, 2, "skip"), null);
});

Deno.test("editLineInput: the line's own change goes to its parse, and nothing else", async () => {
  const { editLineInput } = await import("./foodBar.ts");
  const prev = CARD.map((c) => ({ ...c, food_id: null }));
  // The agent carries the user's number in its change; the parse reads it there.
  assertEquals(editLineInput({ lines: CARD, previousItems: prev }, 1, "the user says it is 161 kcal")?.text, "the user says it is 161 kcal");
});

Deno.test("save gate: negation and past tense are not an ask", () => {
  for (const t of ["don't save it", "no need to save this", "I already saved it", "my meals today were light", "do not save, just log", "I don't think I'd want to save this"]) {
    assertFalse(userAskedToSave({ text: t }), t);
  }
  for (const t of ["save this as a meal", "can you save it", "add it to my meals"]) assert(userAskedToSave({ text: t }), t);
});

Deno.test("save beside card changes: the 'ask me to save' note only when the user asked to save", async () => {
  const out = await runFoodAgent({ ...LATER, text: "make it 3 roti" }, deps(scripted([[
    { name: "edit_line", input: { line_id: "L1", change: "3 pieces" } },
    { name: "save_card_as_meal", input: { name: "Dinner", log_now: false, summary: "Save it?" } },
  ]])));
  if (out.kind === "log") assertFalse(out.result.parsed?.drona_line.includes("Ask me to save"));
});

Deno.test("a number the user states for a line: the agent is told to put it on, with no question", () => {
  assert(FOOD_AGENT_SYSTEM_LATER.includes("number the user gives for a food"));
});

Deno.test("answeredByLabel: a bare ack is marked; a later run whose agent never ran is not called one", async () => {
  const { answeredByLabel } = await import("./foodBar.ts");
  configure(async () => ({ ok: true, data: { content: [] } }));
  const ack = await runLaterMessage({ agent: agentArgs(), cardOpen: true, fallbackParse: async () => noParseResult() });
  assertEquals(answeredByLabel(ack.outcome), "bare_ack");
  // The agent did not run (no outcome): the card is kept, and the label says so.
  assertEquals(answeredByLabel({ action: "reply", planned: "agent", decision: null, reply: AGENT_FAILED_CARD_REPLY }), "canned_agent_failed");
  assertEquals(answeredByLabel(null), null);
});

Deno.test("a Precise correction (tier precise, no speed) is a later message for the agent", async () => {
  const { isPreciseRequest } = await import("./foodIntent.ts");
  const later = (body: Record<string, unknown>) => laterMessageGoesToAgent({
    mode: "on", precise: isPreciseRequest(body, { superOn: true, freeTier: false }), supportsCreate: true, hasModelKey: true,
    turns: 2, cardLines: 3, cardOpen: true, pending: false,
  });
  // What the app sends for a correction beside a Precise card: no speed.
  assert(later({ tier: "precise" }));
  assert(later({ speed: "super" }));
  // Quick, and an app too old to send tier: today's path.
  assertFalse(later({ tier: "quick" }));
  assertFalse(later({}));
});

// ── Before the switch goes on (review of 01780201) ─────────────────────────

Deno.test("planCardChanges: at most 8 edits and additions in one turn, else the plan goes back", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: "add_lines", input: { text: `food ${i}` } }));
  const p = planCardChanges(CARD, many);
  assertFalse(p.ok);
  if (!p.ok) assert(p.error.includes("at most 8"), p.error);
  const eight = planCardChanges(CARD, many.slice(0, 8));
  assert(eight.ok);
});

Deno.test("isPreciseRequest: tier alone never unlocks Precise for an account that may not use it", async () => {
  const { isPreciseRequest } = await import("./foodIntent.ts");
  const ok = { superOn: true, freeTier: false };
  assert(isPreciseRequest({ tier: "precise" }, ok));
  assert(isPreciseRequest({ speed: "super" }, ok));
  // A free account, or Precise switched off on the server: today's path.
  assertFalse(isPreciseRequest({ tier: "precise" }, { superOn: true, freeTier: true }));
  assertFalse(isPreciseRequest({ tier: "precise" }, { superOn: false, freeTier: false }));
  assertFalse(isPreciseRequest({ speed: "super" }, { superOn: false, freeTier: false }));
});

Deno.test("applyCardChanges: a line with no section gets the card's own meal, the same one the result says", async () => {
  const card: CardLine[] = [{ ...CARD[0], meal_type: "lunch" }, { ...CARD[1], meal_type: undefined }];
  const out = await runFoodAgent({ ...LATER, card, defaultMeal: "dinner" }, deps(scripted([[
    { name: "edit_line", input: { line_id: "L1", change: "3 pieces" } },
  ]])));
  assertEquals(out.kind, "log");
  if (out.kind !== "log" || !out.result.parsed) return;
  assertEquals(out.result.parsed.meal_type, "lunch");
  assertEquals(out.result.parsed.items[1].meal_type, "lunch");
});

Deno.test("save gate: 'do not forget to save it' is an ask", () => {
  assert(userAskedToSave({ text: "do not forget to save it" }));
  assert(userAskedToSave({ text: "don't forget to save this as a meal" }));
  assertFalse(userAskedToSave({ text: "don't save it" }));
});

Deno.test("save gate: a no counts only in the same part of the sentence as the save", () => {
  for (const t of ["not sure but save it", "nope, save it anyway", "don't forget to please go ahead and save", "no, save it"]) {
    assert(userAskedToSave({ text: t }), t);
  }
  for (const t of ["do not under any circumstances and for any condition save it", "don't save it", "nope don't save that"]) {
    assertFalse(userAskedToSave({ text: t }), t);
  }
});

Deno.test("applyCardChanges: a first line with no section takes the default; a line's own section stays", async () => {
  const card: CardLine[] = [{ ...CARD[0], meal_type: undefined }, { ...CARD[1], meal_type: "lunch" }];
  const out = await runFoodAgent({ ...LATER, card, defaultMeal: "dinner" }, deps(scripted([[
    { name: "edit_line", input: { line_id: "L2", change: "half" } },
  ]])));
  if (out.kind !== "log" || !out.result.parsed) throw new Error(out.kind);
  assertEquals(out.result.parsed.items.map((i) => i.meal_type), ["dinner", "lunch"]);
});

Deno.test("tierSelectedOf: a Precise correction (tier precise, no speed) is recorded as precise", async () => {
  const { tierSelectedOf } = await import("./foodIntent.ts");
  assertEquals(tierSelectedOf({ tier: "precise" }), "precise");
  assertEquals(tierSelectedOf({ speed: "super" }), "precise");
  assertEquals(tierSelectedOf({ speed: "fast", tier: "quick" }), "fast");
  assertEquals(tierSelectedOf({}), "thorough");
});

// ── Review of 6c7f0f10 ──────────────────────────────────────────────────────

Deno.test("words with no tool on an early turn: the agent is asked once to use its tools, so food is not lost", async () => {
  const bodies: Record<string, unknown>[] = [];
  let n = 0;
  const call: FoodAgentDeps["callModel"] = async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    n++;
    return n === 1
      ? { ok: true, data: { usage: {}, content: [{ type: "text", text: "Sounds like a good dinner." }] } }
      : { ok: true, data: { usage: {}, content: [{ type: "tool_use", id: "t", name: "log_food", input: { text: "2 eggs", summary: "2 eggs." } }] } };
  };
  const out = await runFoodAgent({ text: "had 2 eggs for dinner", defaultMeal: "dinner", later: true }, deps(call));
  assertEquals(out.kind, "log");
  assertEquals(bodies.length, 2);
  const msgs = bodies[1].messages as { role: string; content: unknown }[];
  assert(JSON.stringify(msgs.at(-1)).includes("use your tools"));
});

Deno.test("additions never take a card past 12 lines: what does not fit is left off and named", async () => {
  const card: CardLine[] = Array.from({ length: 10 }, (_, i) => ({ ...CARD[1], food_name: `Food ${i}` }));
  const d = deps(scripted([[{ name: "add_lines", input: { text: "four things" } }]]));
  d.parseFood = async () => result([item("Apple", 95), item("Pear", 100), item("Plum", 30), item("Fig", 40)]);
  const out = await runFoodAgent({ ...LATER, card }, d);
  if (out.kind !== "log" || !out.result.parsed) throw new Error(out.kind);
  assertEquals(out.result.parsed.items.length, 12);
  assertEquals(out.result.parsed.items.slice(0, 10).map((i) => i.food_name), card.map((c) => c.food_name));
  assert(out.result.parsed.drona_line.includes("Plum and Fig"), out.result.parsed.drona_line);
});

Deno.test("save gate: a save word needs something to save ('saving calories' is not an ask)", () => {
  assertFalse(userAskedToSave({ text: "I'm saving calories for dinner" }));
  assertFalse(userAskedToSave({ text: "it saves me time" }));
  for (const t of ["save it", "please save", "can you save this as a meal", "save the card", "save"]) assert(userAskedToSave({ text: t }), t);
});
