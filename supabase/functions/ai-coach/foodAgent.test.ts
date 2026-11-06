// Run with: deno test --allow-all supabase/functions/ai-coach/foodAgent.test.ts
//
// The food agent loop, with a scripted model. What these pin:
//   - reads asked for in one turn all run, and run together
//   - the turn cap is enforced by code, not by the model obeying the prompt
//   - numbers are copied or parsed, never taken from the agent
//   - every finish is a shape the app already draws

import { FOOD_TURNS_KEPT } from "./foodContext.ts";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type AgentEvent, COPY_NOTE, FOOD_AGENT_SYSTEM, type FoodAgentDeps, historyMessages, pickLines, LAST_TURN_NOTE, LAST_TURN_NOTE_RESTORE, MAX_TURNS, openingText, recentDays, runFoodAgent, statusFor } from "./foodAgent.ts";
import type { ParseMealResult } from "./parseMeal.ts";
import type { ThreadCardLines } from "./foodBar.ts";
import type { ThreadLine } from "./foodThreads.ts";
import { SONNET_MODEL } from "../_shared/sonnet.ts";

type Use = { name: string; input: Record<string, unknown> };

/** A model that answers turn N with script[N]. Records every request body. */
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

const EMPTY_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };

function parseResult(items: [string, number][]): ParseMealResult {
  return {
    parsed: {
      meal_type: "lunch",
      items: items.map(([food_name, kcal]) => ({
        food_id: null, food_name, quantity: 1, serving_label: "serving", grams: 100, kcal,
        protein_g: 5, carb_g: 10, fat_g: 2, fiber_g: null, source: "estimate" as const,
        assumption: null, confidence: "medium" as const,
      })),
      drona_line: "",
    },
    declined: null, usage: EMPTY_USAGE, tool_calls: ["estimate_meal"], steps: [], iterations: 1,
  };
}

const YESTERDAY_BREAKFAST = {
  meals: [{
    meal_type: "breakfast",
    foods: [
      { food_name: "oats", kcal: 180 }, { food_name: "milk", kcal: 370 }, { food_name: "cornflakes", kcal: 110 },
      { food_name: "biscuits", kcal: 140 }, { food_name: "rice", kcal: 200 },
    ],
  }],
};

function deps(callModel: FoodAgentDeps["callModel"], log: string[] = [], statuses: string[] = []): FoodAgentDeps {
  return {
    model: "sonnet",
    callModel,
    readDiary: async (i) => { log.push(`diary:${JSON.stringify(i)}`); return YESTERDAY_BREAKFAST; },
    savedMeals: async () => { log.push("saved"); return []; },
    parseFood: async (t) => { log.push(`parse:${t}`); return parseResult([[t, 250]]); },
    onStatus: (s) => statuses.push(s),
  };
}

const INPUT = { text: "save yesterday's oat meal from breakfast as a meal and log it in lunch today", defaultMeal: "lunch" as const };

Deno.test("scenario 1: both reads in one turn, then ONE save-and-log card", async () => {
  const log: string[] = [];
  const statuses: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(INPUT, deps(scripted([
    [
      { name: "coach_list_logged_meals", input: { days_ago: 1, meal_type: "breakfast" } },
      { name: "coach_list_saved_meals", input: {} },
    ],
    [{
      name: "create_custom_meal",
      input: {
        name: "Oat meal", log_now: true, meal_type: "lunch", summary: "Oat meal, 660 cal. Save it and log it at lunch?",
        items: [{ name: "oats", kcal: 180 }, { name: "milk", kcal: 370 }, { name: "cornflakes", kcal: 110 }],
      },
    }],
  ], bodies), log, statuses));

  assertEquals(out.kind, "create");
  if (out.kind !== "create") return;
  assertEquals(out.create.tool, "create_custom_meal");
  assertEquals(out.create.input.log_now, true);
  assertEquals(out.turns.length, 2);
  assertEquals(log, ['diary:{"days_ago":1,"meal_type":"breakfast"}', "saved"]);
  assertEquals(statuses, ["Checking yesterday's breakfast", "Looking through your saved meals", "Building your meal"]);
  // Turn 2 saw both results, in one user message.
  const msgs = bodies[1].messages as { role: string; content: unknown }[];
  assertEquals((msgs.at(-1)!.content as unknown[]).length, 2);
});

Deno.test("reads in one turn run together, not one after another", async () => {
  let inFlight = 0;
  let peak = 0;
  const d = deps(scripted([
    [
      { name: "coach_list_logged_meals", input: { days_ago: 1 } },
      { name: "coach_list_saved_meals", input: {} },
      { name: "parse_food", input: { text: "a banana" } },
    ],
    [{ name: "reply", input: { text: "Done looking." } }],
  ]));
  const slow = <T>(v: T) => async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return v;
  };
  d.readDiary = slow(YESTERDAY_BREAKFAST) as FoodAgentDeps["readDiary"];
  d.savedMeals = slow([]) as FoodAgentDeps["savedMeals"];
  d.parseFood = slow(parseResult([["banana", 105]])) as FoodAgentDeps["parseFood"];
  await runFoodAgent(INPUT, d);
  assertEquals(peak, 3);
});

Deno.test("the cap is code: five calls, the last says so, and its read never runs", async () => {
  const log: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(
    INPUT,
    deps(scripted([[{ name: "coach_list_logged_meals", input: { days_ago: 1 } }]], bodies), log),
  );
  assertEquals(MAX_TURNS, 5);
  assertEquals(bodies.length, 5);
  assertEquals(out.kind, "failed");
  if (out.kind === "failed") assertEquals(out.reason, "read_on_last_turn");
  // Four reads ran. The fifth turn asked for one and did not get it.
  assertEquals(log.length, 4);
  // The note is appended to the messages on the last turn; the system prompt
  // never changes between turns.
  for (const b of bodies) assertEquals(b.system, FOOD_AGENT_SYSTEM);
  const lastMessages = bodies[4].messages as { role: string; content: unknown }[];
  assertEquals(lastMessages[lastMessages.length - 1], { role: "system", content: LAST_TURN_NOTE });
  assertEquals(lastMessages.filter((m) => m.role === "system").length, 1);
});

Deno.test("log_food with text reuses the parse already done for that text", async () => {
  const log: string[] = [];
  const out = await runFoodAgent(INPUT, deps(scripted([
    [{ name: "parse_food", input: { text: "2 eggs" } }],
    [{ name: "log_food", input: { text: "2 Eggs ", meal_type: "breakfast", summary: "Two eggs for breakfast." } }],
  ]), log));
  assertEquals(log.filter((l) => l.startsWith("parse:")).length, 1);
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  assertEquals(out.result.parsed!.meal_type, "breakfast");
  assertEquals(out.result.parsed!.items.map((i) => [i.food_name, i.kcal, i.meal_type]), [["2 eggs", 250, "breakfast"]]);
});

Deno.test("log_food copies diary lines as the user's own numbers", async () => {
  const out = await runFoodAgent(INPUT, deps(scripted([
    [{ name: "coach_list_logged_meals", input: { days_ago: 1, meal_type: "breakfast" } }],
    [{
      name: "log_food",
      input: {
        summary: "Same breakfast as yesterday.",
        items: [{ food_name: "oats", kcal: 180, protein_g: 6 }, { food_name: "milk", kcal: 370 }, { food_name: "", kcal: 5 }],
      },
    }],
  ])));
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  const items = out.result.parsed!.items;
  assertEquals(items.map((i) => [i.food_name, i.kcal, i.source, i.meal_type]), [
    ["oats", 180, "manual", "lunch"],
    ["milk", 370, "manual", "lunch"],
  ]);
  assertEquals(out.result.parsed!.drona_line, "Same breakfast as yesterday.");
});

Deno.test("a finish wins over reads asked for in the same turn", async () => {
  const log: string[] = [];
  const out = await runFoodAgent(INPUT, deps(scripted([
    [{ name: "coach_list_saved_meals", input: {} }, { name: "reply", input: { text: "Which breakfast — Monday or Tuesday?" } }],
  ]), log));
  assertEquals(log, []);
  assertEquals(out.kind, "reply");
  if (out.kind === "reply") assert(!out.text.includes("—"));
});

Deno.test("no tool call, an unknown tool, or an empty log all fail honestly", async () => {
  const none: FoodAgentDeps["callModel"] = async () => ({ ok: true, data: { content: [{ type: "text", text: "hi" }] } });
  assertEquals((await runFoodAgent(INPUT, deps(none))).kind, "failed");
  assertEquals((await runFoodAgent(INPUT, deps(scripted([[{ name: "delete_everything", input: {} }]])))).kind, "failed");
  assertEquals((await runFoodAgent(INPUT, deps(scripted([[{ name: "log_food", input: { summary: "x" } }]])))).kind, "failed");
  const down: FoodAgentDeps["callModel"] = async () => ({ ok: false, status: 529, body: "overloaded" });
  const out = await runFoodAgent(INPUT, deps(down));
  assertEquals(out.kind === "failed" && out.reason, "http_529");
});

Deno.test("status lines say what is being checked", () => {
  assertEquals(statusFor("coach_list_logged_meals", { days_ago: 0 }), "Checking today's logs");
  assertEquals(statusFor("coach_list_logged_meals", { days_ago: 3, meal_type: "snack" }), "Checking your snacks from 3 days ago");
  assertEquals(statusFor("parse_food", { text: "2 eggs" }), "Working out 2 eggs");
  assertEquals(statusFor("reply", { text: "x" }), null);
});

Deno.test("a 'copied' line the reads never returned is flagged, not trusted", async () => {
  const out = await runFoodAgent(INPUT, deps(scripted([
    [{ name: "coach_list_logged_meals", input: { days_ago: 1 } }],
    [{
      name: "log_food",
      input: {
        summary: "Yesterday's breakfast, half the milk.",
        items: [
          { food_name: "oats", kcal: 180 },      // as logged
          { food_name: "milk", kcal: 185 },      // changed: half of 370
          { food_name: "honey", kcal: 60 },      // never in the diary
        ],
      },
    }],
  ])));
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  assertEquals(out.result.parsed!.items.map((i) => [i.food_name, i.source, i.confidence]), [
    ["oats", "manual", "high"],
    ["milk", "manual", "medium"],
    ["honey", "estimate", "low"],
  ]);
  assertEquals(out.result.parsed!.items[1].assumption, "Adjusted from 370 kcal in your log.");
});

Deno.test("a save card takes food_name or name, and marks lines it cannot vouch for", async () => {
  const out = await runFoodAgent(INPUT, deps(scripted([
    [{ name: "coach_list_logged_meals", input: { days_ago: 1 } }],
    [{
      name: "create_custom_meal",
      input: {
        name: "Oat meal", log_now: false, summary: "Oat meal. Want it in My Meals?",
        items: [{ food_name: "oats", kcal: 180 }, { name: "milk", kcal: 370 }, { name: "honey", kcal: 60 }],
      },
    }],
  ])));
  assertEquals(out.kind, "create");
  if (out.kind !== "create") return;
  const items = out.create.input.items as Record<string, unknown>[];
  assertEquals(items.map((i) => [i.name, i.food_name, i.estimated]), [
    ["oats", undefined, undefined],
    ["milk", undefined, undefined],
    ["honey", undefined, true],
  ]);
});

Deno.test("an unknown tool on the last turn says unknown, not read", async () => {
  const script: Use[][] = [0, 1, 2, 3].map(() => [{ name: "coach_list_saved_meals", input: {} }]);
  script.push([{ name: "delete_everything", input: {} }]);
  const out = await runFoodAgent(INPUT, deps(scripted(script)));
  assertEquals(out.kind === "failed" && out.reason, "unknown_tool_delete_everything");
});

Deno.test("which date a weekday was is worked out in code", () => {
  const d = recentDays("Thursday 2026-09-24")!;
  assert(d.startsWith("Today is Thursday 2026-09-24."));
  assert(d.includes("days_ago 1 = Wednesday 2026-09-23"));
  assert(d.includes("days_ago 3 = Monday 2026-09-21"));
  assert(d.includes("days_ago 7 = Thursday 2026-09-17"));
  assertEquals(recentDays("no date here"), null);
});

Deno.test("an adjusted line cites the logged number closest to it", async () => {
  const d = deps(scripted([
    [{ name: "coach_list_logged_meals", input: { days_ago: 1 } }, { name: "coach_list_logged_meals", input: { days_ago: 2 } }],
    [{ name: "log_food", input: { summary: "x", items: [{ food_name: "rice", kcal: 140 }] } }],
  ]));
  d.readDiary = async (i) => ({ meals: [{ foods: [{ food_name: "rice", kcal: i.days_ago === 1 ? 300 : 150 }] }] });
  const out = await runFoodAgent(INPUT, d);
  assertEquals(out.kind === "log" && out.result.parsed!.items[0].assumption, "Adjusted from 150 kcal in your log.");
});

// ── Seen live 2026-09-23: the box forgot the card it had just drawn ─────────
// "log the same meal in breakfast and snacks" answered "you haven't told me
// what meal to log", and a bare "yes" got a greeting. The turns were being
// sent by the app and dropped by the server.

Deno.test("history: Drona's turns come back as the assistant, oldest first", () => {
  assertEquals(
    historyMessages([
      { role: "user", text: "save my breakfast as a meal" },
      { role: "drona", text: "Monday Breakfast, 1 item, 80 cal. Want it saved?" },
    ], "yes"),
    [
      { role: "user", content: "save my breakfast as a meal" },
      { role: "assistant", content: "Monday Breakfast, 1 item, 80 cal. Want it saved?" },
      { role: "user", content: "yes" },
    ],
  );
});

Deno.test("history: no two turns in a row from one side, and never starts with Drona", () => {
  const out = historyMessages([
    { role: "drona", text: "leading drona turn" },
    { role: "user", text: "one" },
    { role: "user", text: "two" },
    { role: "drona", text: "a" },
    { role: "drona", text: "b" },
  ], "three");
  assertEquals(out, [
    { role: "user", content: "one\ntwo" },
    { role: "assistant", content: "a\nb" },
    { role: "user", content: "three" },
  ]);
});

Deno.test("history: empty turns, and only the last few travel", () => {
  assertEquals(historyMessages(undefined, "hi"), [{ role: "user", content: "hi" }]);
  assertEquals(historyMessages([{ role: "user", text: "  " }], "hi"), [{ role: "user", content: "hi" }]);
  const many = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "drona" : "user") as "user" | "drona", text: `t${i}` }));
  const out = historyMessages(many, "now");
  // FOOD_TURNS_KEPT turns, plus the new message.
  assertEquals(out.length <= FOOD_TURNS_KEPT + 1, true);
  assertEquals(out.at(-1), { role: "user", content: "now" });
  assertEquals(out.some((m) => m.content.includes("t0")), false);
});

Deno.test("the agent is told what was said before, not just the new message", async () => {
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { ...INPUT, text: "log the same meal in breakfast and snacks", recentTurns: [
      { role: "user", text: "save my breakfast as a meal" },
      { role: "drona", text: "Monday Breakfast, 1 item, 80 cal." },
    ] },
    deps(scripted([[{ name: "reply", input: { text: "ok" } }]], bodies)),
  );
  const msgs = bodies[0].messages as { role: string; content: string }[];
  assertEquals(msgs.map((m) => m.role), ["user", "assistant", "user"]);
  assert(msgs[1].content.includes("Monday Breakfast"));
  assert(msgs[2].content.includes("breakfast and snacks"));
});

Deno.test("log_food can put one message's food in two sections", async () => {
  const out = await runFoodAgent(INPUT, deps(scripted([
    [{ name: "coach_list_logged_meals", input: { days_ago: 1 } }],
    [{
      name: "log_food",
      input: {
        summary: "Same oats twice.", meal_type: "breakfast",
        items: [
          { food_name: "oats", kcal: 180 },
          { food_name: "oats", kcal: 180, meal_type: "snack" },
        ],
      },
    }],
  ])));
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  assertEquals(out.result.parsed!.items.map((i) => [i.food_name, i.meal_type]), [["oats", "breakfast"], ["oats", "snack"]]);
});

Deno.test("Sonnet 5.5: no forced tool_choice, and no thinking, on every turn", async () => {
  // Sonnet 5.5 returns a 400 for tool_choice "any" or "tool"; one left in
  // would fail every multi-step food message.
  const bodies: Record<string, unknown>[] = [];
  const base = deps(scripted([
    [{ name: "coach_list_logged_meals", input: { days_ago: 1 } }],
    [{ name: "reply", input: { text: "Nothing logged yesterday." } }],
  ], bodies), []);
  await runFoodAgent(INPUT, { ...base, model: SONNET_MODEL });
  assertEquals(bodies.length, 2);
  for (const b of bodies) {
    assertEquals(b.tool_choice, undefined);
    assertEquals(b.thinking, { type: "between_tools" });
  }
});

// The food box trace stamps agent turn i at the end of model call i
// (index.ts startFoodAgent callEnds). That holds only while every call that
// came back is a turn, and a failed call ends the run without one.
Deno.test("one model call per turn: call i is turn i, and a failed call adds no turn and ends the run", async () => {
  const bodies: Record<string, unknown>[] = [];
  const ok = await runFoodAgent(INPUT, deps(scripted([
    [{ name: "coach_list_logged_meals", input: { days_ago: 1 } }],
    [{ name: "coach_list_saved_meals", input: {} }],
    [{ name: "reply", input: { text: "Done looking." } }],
  ], bodies)));
  assertEquals(ok.turns.length, bodies.length);
  assertEquals(ok.turns.map((t) => t.turn), bodies.map((_, i) => i + 1));
  // Read turns carry what each read returned.
  assert(ok.turns[0].results?.[0].summary?.includes("oats"));

  let calls = 0;
  const failing: FoodAgentDeps["callModel"] = async () => {
    calls++;
    if (calls === 2) return { ok: false, status: 529, body: "overloaded" };
    return { ok: true, data: { usage: {}, content: [{ type: "tool_use", id: `t${calls}`, name: "coach_list_saved_meals", input: {} }] } };
  };
  const failed = await runFoodAgent(INPUT, deps(failing));
  assertEquals(failed.kind, "failed");
  assertEquals([calls, failed.turns.length], [2, 1]);
});

// Live 2026-11-05 15:23: "save this paneer sabji as a meal" beside a lunch
// card. The agent saw the card as names and calories only, called
// create_custom_food with the kcal alone, and the saved meal had 0 g macros.
const NOV5_CARD = [
  { food_name: "Milky Mist Low Fat Paneer Sabji (60 g paneer, onion, oil)", quantity: 60, serving_label: "g", grams: 60, kcal: 150, protein_g: 11, carb_g: 4, fat_g: 10, source: "estimate" as const, meal_type: "lunch" as const },
  { food_name: "Jeera Rice", quantity: 100, serving_label: "g", grams: 100, kcal: 171, protein_g: 2.6, carb_g: 26.6, fat_g: 5.6, source: "catalog" as const, meal_type: "lunch" as const },
];

Deno.test("a save drafted from one card line copies that line's macros", async () => {
  const out = await runFoodAgent(
    { text: "now save this milky mist low fat paneer sabji as a meal", defaultMeal: "lunch", card: NOV5_CARD },
    deps(scripted([[{
      name: "create_custom_food",
      input: { name: "Milky Mist Low Fat Paneer Sabji", kcal: 150, log_now: false, summary: "Milky Mist sabji, 150 cal. Want it in My Meals?" },
    }]])),
  );
  assertEquals(out.kind, "create");
  if (out.kind !== "create") return;
  const i = out.create.input;
  assertEquals([i.protein_g, i.carb_g, i.fat_g], [11, 4, 10]);
  // The card line was itself an estimate, so the save says so.
  assert((i.estimated as string[]).includes("protein_g"));
});

Deno.test("a save meal built from card lines copies each line's macros; an unmatched line is left alone", async () => {
  const out = await runFoodAgent(
    { text: "save the rice and a banana as my lunch bowl", defaultMeal: "lunch", card: NOV5_CARD },
    deps(scripted([[{
      name: "create_custom_meal",
      input: {
        name: "Lunch bowl",
        items: [{ name: "Jeera rice", kcal: 171 }, { name: "Banana", kcal: 105, protein_g: 1.3, estimated: true }],
        log_now: false, summary: "Lunch bowl. Want it saved?",
      },
    }]])),
  );
  assertEquals(out.kind, "create");
  if (out.kind !== "create") return;
  const [rice, banana] = out.create.input.items as Record<string, unknown>[];
  assertEquals([rice.protein_g, rice.carb_g, rice.fat_g], [2.6, 26.6, 5.6]);
  // Copied from a catalog line on the card: the user's working copy, not a guess.
  assertEquals(rice.estimated, undefined);
  assertEquals([banana.protein_g, banana.carb_g, banana.estimated], [1.3, undefined, true]);
});

Deno.test("a save whose calories differ from every card line takes nothing from the card", async () => {
  const out = await runFoodAgent(
    { text: "save half the sabji as a snack", defaultMeal: "lunch", card: NOV5_CARD },
    deps(scripted([[{ name: "create_custom_food", input: { name: "Milky Mist Low Fat Paneer Sabji", kcal: 75, log_now: false, summary: "Half the sabji?" } }]])),
  );
  if (out.kind !== "create") throw new Error(out.kind);
  assertEquals(out.create.input.protein_g, undefined);
});

Deno.test("a card line with no figure for a macro leaves the model's figure, never a 0 g", async () => {
  const card = [{ food_name: "Masala dosa", quantity: 1, serving_label: "dosa", grams: 0, kcal: 350, protein_g: 7, source: "catalog" as const }];
  const out = await runFoodAgent(
    { text: "save this dosa", defaultMeal: "breakfast", card },
    deps(scripted([[{ name: "create_custom_food", input: { name: "Masala dosa", kcal: 350, carb_g: 45, fat_g: 15, estimated: ["carb_g", "fat_g"], log_now: false, summary: "Dosa?" } }]])),
  );
  if (out.kind !== "create") throw new Error(out.kind);
  const i = out.create.input;
  assertEquals([i.protein_g, i.carb_g, i.fat_g], [7, 45, 15]);
  assertEquals(i.estimated, ["carb_g", "fat_g"]);
});

Deno.test("two card lines that both fit a save line: nothing is copied (no guessing which)", async () => {
  const card = [
    { food_name: "Roti", quantity: 1, serving_label: "roti", grams: 40, kcal: 120, protein_g: 3, carb_g: 20, fat_g: 3 },
    { food_name: "Roti (ghee)", quantity: 1, serving_label: "roti", grams: 40, kcal: 120, protein_g: 4, carb_g: 18, fat_g: 4 },
  ];
  const out = await runFoodAgent(
    { text: "save the roti", defaultMeal: "lunch", card },
    deps(scripted([[{ name: "create_custom_food", input: { name: "Roti", kcal: 120, log_now: false, summary: "Roti?" } }]])),
  );
  if (out.kind !== "create") throw new Error(out.kind);
  assertEquals(out.create.input.protein_g, undefined);
});

Deno.test("a meal line matched to a card line under a shorter name is a copy, not a guess", async () => {
  const card = [{ food_name: "Paneer sabji (60 g paneer, onion, oil)", quantity: 1, serving_label: "serving", grams: 120, kcal: 150, protein_g: 11, carb_g: 4, fat_g: 10, source: "catalog" as const }];
  const out = await runFoodAgent(
    { text: "save the sabji and a banana as my bowl", defaultMeal: "lunch", card },
    deps(scripted([[{ name: "create_custom_meal", input: { name: "Bowl", items: [{ name: "Paneer sabji", kcal: 150, estimated: true }, { name: "Banana", kcal: 105 }], log_now: false, summary: "Bowl?" } }]])),
  );
  if (out.kind !== "create") throw new Error(out.kind);
  const [sabji, banana] = out.create.input.items as Record<string, unknown>[];
  assertEquals([sabji.protein_g, sabji.estimated], [11, undefined]);
  assertEquals(banana.estimated, true);
});

Deno.test("the agent's card view shows ? for a macro the line has no figure for, never 0", () => {
  const view = openingText({ text: "save it", card: [{ food_name: "Dosa", quantity: 1, serving_label: "dosa", grams: 0, kcal: 350, protein_g: 7 }] }, null);
  assert(view.includes("P 7 C ? F ?"), view);
});

Deno.test("a food save copied from a catalog card line drops a model-set kcal estimate mark", async () => {
  const out = await runFoodAgent(
    { text: "save the rice", defaultMeal: "lunch", card: NOV5_CARD },
    deps(scripted([[{ name: "create_custom_food", input: { name: "Jeera Rice", kcal: 171, estimated: ["kcal"], log_now: false, summary: "Rice?" } }]])),
  );
  if (out.kind !== "create") throw new Error(out.kind);
  assertEquals(out.create.input.estimated, []);
});

// ── restore_card (FOOD_THREADS=on) ───────────────────────────────────────────

const INDEX = "index: 1 earlier card in this thread: [C1 v2] lunch card, 4 lines, 359 kcal, open. restore_card brings one back as the card on screen.";

Deno.test("restore_card brings an earlier card back whole, as the card on screen", async () => {
  const bodies: Record<string, unknown>[] = [];
  const asked: [string, number | null][] = [];
  const out = await runFoodAgent(
    { text: "can u bring back that card", defaultMeal: "lunch", threadIndex: INDEX },
    {
      ...deps(scripted([[{ name: "restore_card", input: { card: "c1", summary: "Your lunch is back." } }]], bodies)),
      restoreCard: async (ref, version) => {
        asked.push([ref, version]);
        return { items: parseResult([["Jeera Rice", 171], ["Paneer sabji", 150]]).parsed!.items, meal_type: "lunch" };
      },
    },
  );
  assertEquals(asked, [["C1", null]]);
  if (out.kind !== "log") throw new Error(out.kind);
  assertEquals(out.result.parsed!.items.map((i) => [i.food_name, i.kcal]), [["Jeera Rice", 171], ["Paneer sabji", 150]]);
  assertEquals(out.result.parsed!.corrects_previous, true);
  // The index line was in the agent's opening message, and the tool was offered.
  assert(JSON.stringify(bodies[0].messages).includes("[C1 v2] lunch card"));
  assert((bodies[0].tools as { name: string }[]).some((t) => t.name === "restore_card"));
});

Deno.test("restore_card is not offered without a thread, and fails when called anyway", async () => {
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(
    { text: "bring back that card", defaultMeal: "lunch" },
    deps(scripted([[{ name: "restore_card", input: { card: "C1", summary: "Back." } }]], bodies)),
  );
  assert(!(bodies[0].tools as { name: string }[]).some((t) => t.name === "restore_card"));
  assertEquals(out.kind === "failed" && out.reason, "restore_without_thread");
});

Deno.test("restore_card on a ref the thread does not have fails honestly", async () => {
  const out = await runFoodAgent(
    { text: "bring back that card", defaultMeal: "lunch", threadIndex: INDEX },
    { ...deps(scripted([[{ name: "restore_card", input: { card: "C7", summary: "Back." } }]])), restoreCard: async () => null },
  );
  assertEquals(out.kind === "failed" && out.reason, "restore_not_found");
});

Deno.test("restore_card is not offered while a card is on screen (it would replace the card whole)", async () => {
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "make the rice 150 g", defaultMeal: "lunch", card: NOV5_CARD, threadIndex: INDEX },
    { ...deps(scripted([[{ name: "reply", input: { text: "ok" } }]], bodies)), restoreCard: async () => null },
  );
  assert(!(bodies[0].tools as { name: string }[]).some((t) => t.name === "restore_card"));
  // Nor the index that promises it.
  assert(!JSON.stringify(bodies[0].messages).includes("earlier card in this thread"));
});

Deno.test("the last-turn note names restore_card only when it is offered", () => {
  assert(!LAST_TURN_NOTE.includes("restore_card"));
  assert(LAST_TURN_NOTE_RESTORE.includes("restore_card"));
  // Built by a replace on the base note: if its wording changes, this fails.
  assert(LAST_TURN_NOTE_RESTORE !== LAST_TURN_NOTE);
});

Deno.test("a meal line copied from a card line with some macros missing keeps the model's estimate mark", async () => {
  const card = [{ food_name: "Dal", quantity: 1, serving_label: "katori", grams: 150, kcal: 180, protein_g: 9, source: "catalog" as const }];
  const out = await runFoodAgent(
    { text: "save the dal and a roti as my thali", defaultMeal: "lunch", card },
    deps(scripted([[{ name: "create_custom_meal", input: { name: "Thali", items: [{ name: "Dal", kcal: 180, carb_g: 25, fat_g: 5, estimated: true }, { name: "Roti", kcal: 120 }], log_now: false, summary: "Thali?" } }]])),
  );
  if (out.kind !== "create") throw new Error(out.kind);
  const [dal] = out.create.input.items as Record<string, unknown>[];
  assertEquals([dal.protein_g, dal.carb_g, dal.fat_g, dal.estimated], [9, 25, 5, true]);
});

// ── Safe restore, copy_lines, read_card (owner design 2026-11-06) ───────────

const tl = (line_id: string, name: string, kcal: number, more: Partial<ThreadLine> = {}): ThreadLine => ({
  line_id, name, grams: 100, quantity: 1, unit: "serving", kcal, protein_g: 4, carb_g: 20, fat_g: 3, source: "catalog", ...more,
});
const EARLIER: ThreadCardLines = {
  id: "card-1", ref: "C1", version: 2, latest_version: 2, meal_type: "lunch",
  lines: [
    tl("L1", "Jeera Rice", 171, { source_ref: "food-rice", protein_g: 2.6, carb_g: 26.6, fat_g: 5.6 }),
    tl("L2", "Dal tadka", 140, { source: "web", protein_g: 7.2, carb_g: 16, fat_g: 5.1, fiber_g: 3 }),
    tl("L3", "Milky Mist Low Fat Paneer Sabji (60 g paneer, onion, oil)", 150, { source: "estimate" }),
  ],
};
const THREAD_INDEX = "index: earlier cards in this thread, newest first: [C1 v2] lunch card: L1 Jeera Rice, L2 Dal tadka, L3 Milky Mist Low Fat Paneer Sabji.";
const ONE_ROTI = [{ food_name: "Roti", quantity: 1, serving_label: "piece", grams: 40, kcal: 120, protein_g: 3.5, carb_g: 18, fat_g: 3.7, source: "catalog" as const, meal_type: "dinner" as const }];

function threadDeps(callModel: FoodAgentDeps["callModel"], events: AgentEvent[] = [], asked: [string, number | null][] = []): FoodAgentDeps {
  return {
    ...deps(callModel),
    restoreCard: async () => { throw new Error("restore must not run"); },
    threadCard: async (ref, version) => {
      asked.push([ref, version]);
      return ref === "C1" && (version === null || version === 2) ? EARLIER : null;
    },
    onEvent: (e) => events.push(e),
  };
}

Deno.test("safe restore: with a card on screen, a restore_card call is refused in code and the card is never replaced", async () => {
  const bodies: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [];
  const out = await runFoodAgent(
    { text: "bring back the lunch card", defaultMeal: "dinner", card: ONE_ROTI, threadIndex: THREAD_INDEX },
    threadDeps(scripted([
      [{ name: "restore_card", input: { card: "C1", summary: "Back." } }],
      [{ name: "reply", input: { text: "Your roti card is still open. Want the lunch foods added to it?" } }],
    ], bodies), events),
  );
  // Not offered, not run (restoreCard throws), and the agent heard why.
  assert(!(bodies[0].tools as { name: string }[]).some((t) => t.name === "restore_card"));
  assertEquals(out.kind, "reply");
  assert(JSON.stringify(bodies[1].messages).includes("restore_card would replace it"));
  assertEquals(events, [{ tool: "restore_card", ok: false, reason: "card_open" }]);
});

Deno.test("safe restore: refused on the last turn too, as a failure, never a replaced card", async () => {
  const out = await runFoodAgent(
    { text: "bring it back", defaultMeal: "dinner", card: ONE_ROTI, threadIndex: THREAD_INDEX },
    threadDeps(scripted([...Array(MAX_TURNS - 1).fill([{ name: "coach_list_saved_meals", input: {} }]), [{ name: "restore_card", input: { card: "C1", summary: "Back." } }]])),
  );
  assertEquals(out.kind === "failed" && out.reason, "restore_card_open");
});

Deno.test("copy_lines from an earlier card: the store's numbers and source, added beside the card", async () => {
  const bodies: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [];
  const asked: [string, number | null][] = [];
  const out = await runFoodAgent(
    { text: "add the dal from the lunch card", defaultMeal: "dinner", card: ONE_ROTI, threadIndex: THREAD_INDEX },
    threadDeps(scripted([[{ name: "copy_lines", input: { source: { card: "c1" }, lines: ["L2"], summary: "Added the dal." } }]], bodies), events, asked),
  );
  if (out.kind !== "log") throw new Error(out.kind);
  const p = out.result.parsed!;
  assertEquals(p.corrects_previous, false);
  assertEquals(p.items.map((i) => [i.food_name, i.kcal, i.protein_g, i.carb_g, i.fat_g, i.fiber_g, i.source, i.meal_type]), [
    ["Dal tadka", 140, 7.2, 16, 5.1, 3, "web", "dinner"],
  ]);
  assertEquals(out.result.tool_calls, ["food_agent", "copy_lines"]);
  assertEquals(asked, [["C1", null]]);
  assertEquals(events, [{ tool: "copy_lines", source_kind: "thread", asked: 1, copied: 1, already_on_card: 0, not_found: 0, finished: true, error: null }]);
  // Offered with the index, and the index tells it restore is off beside a card.
  const tools = (bodies[0].tools as { name: string }[]).map((t) => t.name);
  assert(tools.includes("copy_lines") && tools.includes("read_card") && !tools.includes("restore_card"));
  assert(JSON.stringify(bodies[0].messages).includes("restore_card is not available"));
  assert(String(bodies[0].system).includes(COPY_NOTE.slice(0, 60)));
});

Deno.test("copy_lines: a food already on the card is not copied; the agent asks, and copies on add_again", async () => {
  const bodies: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [];
  const card = [{ ...ONE_ROTI[0], food_name: "Jeera rice", kcal: 171, meal_type: "lunch" as const }];
  const out = await runFoodAgent(
    { text: "add the rice and dal from before", defaultMeal: "lunch", card, threadIndex: THREAD_INDEX },
    threadDeps(scripted([
      [{ name: "copy_lines", input: { source: { card: "C1" }, lines: ["L1", "L2"], summary: "Added." } }],
      [{ name: "reply", input: { text: "Jeera rice is already on the card. Add a second portion, or skip?" } }],
    ], bodies), events),
  );
  assertEquals(out.kind, "reply");
  // Nothing was added (not even the dal): the agent saw each line's result.
  const results = JSON.stringify(bodies[1].messages);
  assert(results.includes("already_on_card") && results.includes("Nothing was added"), results);
  assertEquals(events[0], { tool: "copy_lines", source_kind: "thread", asked: 2, copied: 1, already_on_card: 1, not_found: 0, finished: false, error: null });

  const again = await runFoodAgent(
    { text: "add it", defaultMeal: "lunch", card, threadIndex: THREAD_INDEX },
    threadDeps(scripted([[{ name: "copy_lines", input: { source: { card: "C1" }, lines: ["L1", "L2"], add_again: true, summary: "Added." } }]])),
  );
  if (again.kind !== "log") throw new Error(again.kind);
  assertEquals(again.result.parsed!.items.map((i) => [i.food_name, i.food_id]), [["Jeera Rice", "food-rice"], ["Dal tadka", null]]);
});

Deno.test("copy_lines on the last turn: the copied lines are added and the rest named, never claimed", async () => {
  const card = [{ ...ONE_ROTI[0], food_name: "Dal tadka", kcal: 140 }];
  const events: AgentEvent[] = [];
  const out = await runFoodAgent(
    { text: "add the lunch", defaultMeal: "dinner", card, threadIndex: THREAD_INDEX },
    threadDeps(scripted([
      ...Array(MAX_TURNS - 1).fill([{ name: "coach_list_saved_meals", input: {} }]),
      [{ name: "copy_lines", input: { source: { card: "C1" }, lines: ["L1", "L2", "L9"], summary: "All three are on the card." } }],
    ]), events),
  );
  if (out.kind !== "log") throw new Error(out.kind);
  assertEquals(out.result.parsed!.items.map((i) => i.food_name), ["Jeera Rice"]);
  assertEquals(out.result.parsed!.drona_line, "Put Jeera Rice on the card. Dal tadka is already on the card: add a second portion, or skip? I could not find L9 there.");
  assertEquals(events.at(-1), { tool: "copy_lines", source_kind: "thread", asked: 3, copied: 1, already_on_card: 1, not_found: 1, finished: true, error: null });
});

Deno.test("copy_lines from the diary: food id, source and numbers as the diary holds them, into the card's meal", async () => {
  const reads: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [];
  const out = await runFoodAgent(
    { text: "add yesterday's dal to this", defaultMeal: "snack", card: ONE_ROTI },
    {
      ...deps(scripted([[{ name: "copy_lines", input: { source: { days_ago: 1, meal_type: "lunch" }, lines: ["dal"], summary: "Added yesterday's dal." } }]])),
      readDiaryLines: async (i) => {
        reads.push(i);
        return {
          date: "2026-11-05",
          meals: [{ meal_type: "lunch", items: [
            { name: "Rice, cooked", quantity: 1, serving_unit: "bowl", grams: 150, kcal: 195, protein_g: 4, carb_g: 42, fat_g: 0.4, food_id: "f-rice", source: "catalog", fiber_g: 0.6 },
            { name: "Dal", quantity: 1, serving_unit: "katori", grams: 150, kcal: 160, protein_g: 9, carb_g: 22, fat_g: 4, food_id: null, source: null, fiber_g: null },
          ] }],
        };
      },
      onEvent: (e) => events.push(e),
    },
  );
  assertEquals(reads, [{ days_ago: 1, meal_type: "lunch" }]);
  if (out.kind !== "log") throw new Error(out.kind);
  // A diary line logged by hand (no source) stays manual; nothing is re-guessed.
  assertEquals(out.result.parsed!.items.map((i) => [i.food_name, i.kcal, i.grams, i.serving_label, i.source, i.meal_type, i.confidence]), [
    ["Dal", 160, 150, "katori", "manual", "dinner", "high"],
  ]);
  assertEquals(events[0].tool === "copy_lines" && events[0].source_kind, "diary");
});

Deno.test("copy_lines from the diary keeps a catalog line's source and food id", async () => {
  const out = await runFoodAgent(
    { text: "log yesterday's lunch again", defaultMeal: "lunch" },
    {
      ...deps(scripted([[{ name: "copy_lines", input: { source: { days_ago: 1, meal_type: "lunch" }, summary: "Yesterday's lunch, ready to add." } }]])),
      readDiaryLines: async () => ({
        date: "2026-11-05",
        meals: [{ items: [{ name: "Rice, cooked", quantity: 1, serving_unit: "bowl", grams: 150, kcal: 195, protein_g: 4, carb_g: 42, fat_g: 0.4, food_id: "f-rice", source: "catalog", fiber_g: 0.6 }] }],
      }),
    },
  );
  if (out.kind !== "log") throw new Error(out.kind);
  assertEquals(out.result.parsed!.items.map((i) => [i.food_id, i.source, i.fiber_g, i.meal_type]), [["f-rice", "catalog", 0.6, "lunch"]]);
});

Deno.test("copy_lines with a bad source comes back as an error the agent can act on", async () => {
  const bodies: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [];
  const out = await runFoodAgent(
    { text: "add the dal from before", defaultMeal: "lunch" },
    {
      ...deps(scripted([
        [{ name: "copy_lines", input: { source: { card: "C1" }, summary: "Added." } }],
        [{ name: "reply", input: { text: "Which dal do you mean?" } }],
      ], bodies)),
      readDiaryLines: async () => ({ meals: [] }),
      onEvent: (e) => events.push(e),
    },
  );
  assertEquals(out.kind, "reply");
  assert(JSON.stringify(bodies[1].messages).includes("no earlier cards in this conversation"));
  assertEquals(events[0].tool === "copy_lines" && events[0].error !== null, true);
  // Diary only: copy_lines, but no read_card, and no index.
  const tools = (bodies[0].tools as { name: string }[]).map((t) => t.name);
  assert(tools.includes("copy_lines") && !tools.includes("read_card"));
});

Deno.test("read_card shows an earlier card's lines with ids; an older version by number", async () => {
  const bodies: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [];
  const asked: [string, number | null][] = [];
  await runFoodAgent(
    { text: "what was on the first version of that card?", defaultMeal: "lunch", threadIndex: THREAD_INDEX },
    threadDeps(scripted([
      [{ name: "read_card", input: { card: "C1", version: 1 } }, { name: "read_card", input: { card: "C1" } }],
      [{ name: "reply", input: { text: "ok" } }],
    ], bodies), events, asked),
  );
  assertEquals(asked, [["C1", 1], ["C1", null]]);
  const msgs = JSON.stringify(bodies[1].messages);
  assert(msgs.includes("No card C1 version 1") && msgs.includes("Dal tadka"), msgs);
  assertEquals(events, [{ tool: "read_card", found: false }, { tool: "read_card", found: true }]);
});

Deno.test("pickLines: line id, then exact name, then the name without brackets; each line once", () => {
  const src = [{ id: "L1", name: "Jeera Rice" }, { id: "L2", name: "Paneer sabji (60 g)" }, { id: "L3", name: "Jeera rice" }];
  assertEquals(pickLines(src, []).map((p) => p.index), [0, 1, 2]);
  // "Jeera Rice" after "jeera rice" is the same ask; "paneer sabji" is L2, already picked.
  assertEquals(pickLines(src, ["l2", "jeera rice", "Jeera Rice", "paneer sabji", "naan"]).map((p) => p.index), [1, 0, null, null]);
  assertEquals(pickLines(src, ["Paneer sabji"]).map((p) => p.index), [1]);
  assertEquals(pickLines(src, ["L1", "L1"]).map((p) => p.index), [0]);
});

// ── #351 review: duplicates within one turn, the card line from what was copied ──

const WITH_DUP_ROTI: ThreadCardLines = {
  ...EARLIER,
  lines: [tl("L1", "Roti", 120), tl("L2", "Dal tadka", 140), tl("L3", "Roti", 120)],
};

Deno.test("copy_lines: a food copied earlier in the SAME turn is already_on_card (two calls, or two source lines)", async () => {
  // Two copy_lines calls in one turn, the same food from two sources.
  const bodies: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [];
  const out = await runFoodAgent(
    { text: "add the rice from lunch and from yesterday", defaultMeal: "dinner", card: ONE_ROTI, threadIndex: THREAD_INDEX },
    {
      ...threadDeps(scripted([
        [
          { name: "copy_lines", input: { source: { card: "C1" }, lines: ["L1"] } },
          { name: "copy_lines", input: { source: { days_ago: 1, meal_type: "lunch" }, lines: ["Jeera rice"] } },
        ],
        [{ name: "reply", input: { text: "Jeera rice is coming in twice. Add a second portion, or skip?" } }],
      ], bodies), events),
      readDiaryLines: async () => ({ date: "2026-11-05", meals: [{ items: [{ name: "Jeera rice", quantity: 1, serving_unit: "bowl", grams: 150, kcal: 195, protein_g: 4, carb_g: 42, fat_g: 0.4, food_id: null, source: "catalog" }] }] }),
    },
  );
  // Nothing finished with the rice twice; the agent was told, and asked.
  assertEquals(out.kind, "reply");
  assertEquals(events.map((e) => e.tool === "copy_lines" ? [e.copied, e.already_on_card, e.finished] : null), [[1, 0, false], [0, 1, false]]);
  const told = JSON.stringify(bodies[1].messages);
  assert(told.includes("would_copy") && told.includes("already_on_card"), told);

  // One call whose source has the same food twice: the second is caught.
  const one = await runFoodAgent(
    { text: "add the lunch card", defaultMeal: "dinner", card: [{ ...ONE_ROTI[0], food_name: "Chicken curry", kcal: 250 }], threadIndex: THREAD_INDEX },
    {
      ...threadDeps(scripted([
        [{ name: "copy_lines", input: { source: { card: "C1" } } }],
        [{ name: "reply", input: { text: "Roti is on that card twice. Add both, or one?" } }],
      ])),
      threadCard: async () => WITH_DUP_ROTI,
    },
  );
  assertEquals(one.kind, "reply");
});

Deno.test("copy_lines: the card line names only what was copied, never the model's own summary", async () => {
  const out = await runFoodAgent(
    { text: "add the dal", defaultMeal: "dinner", card: ONE_ROTI, threadIndex: THREAD_INDEX },
    threadDeps(scripted([[{ name: "copy_lines", input: { source: { card: "C1" }, lines: ["L2"], summary: "Added the dal, rice and paneer." } }]])),
  );
  if (out.kind !== "log") throw new Error(out.kind);
  assertEquals(out.result.parsed!.drona_line, "Put Dal tadka on the card.");
  // With no card on screen the lines are a new card, not yet added.
  const fresh = await runFoodAgent(
    { text: "the dal and rice from lunch", defaultMeal: "dinner", threadIndex: THREAD_INDEX },
    { ...threadDeps(scripted([[{ name: "copy_lines", input: { source: { card: "C1" }, lines: ["L1", "L2"] } }]])), restoreCard: async () => null },
  );
  if (fresh.kind !== "log") throw new Error(fresh.kind);
  assertEquals(fresh.result.parsed!.drona_line, "Jeera Rice and Dal tadka, ready to add.");
});

Deno.test("copy_lines from the diary: an unknown source is never relabelled manual; a line with no grams keeps its unit", async () => {
  const out = await runFoodAgent(
    { text: "add yesterday's lunch", defaultMeal: "lunch" },
    {
      ...deps(scripted([[{ name: "copy_lines", input: { source: { days_ago: 1, meal_type: "lunch" } } }]])),
      readDiaryLines: async () => ({
        date: "2026-11-05",
        meals: [{ items: [
          { name: "Mystery bar", quantity: 1, serving_unit: "bar", kcal: 210, protein_g: 10, carb_g: 25, fat_g: 7, food_id: null, source: "partner_feed" },
          { name: "Dal", quantity: 2, serving_unit: "katori", kcal: 320, protein_g: 18, carb_g: 44, fat_g: 8, food_id: null, source: null },
        ] }],
      }),
    },
  );
  if (out.kind !== "log") throw new Error(out.kind);
  const [bar, dal] = out.result.parsed!.items;
  assertEquals([bar.source, bar.confidence], ["estimate", "medium"]);
  assert(bar.assumption!.includes("partner_feed"), bar.assumption!);
  // No weight in the diary: 0 = no weight known, the unit and count kept.
  // (Saved as grams_logged null: autoLog.test.ts and lib/dietData.ts.)
  assertEquals([dal.grams, dal.quantity, dal.serving_label, dal.kcal, dal.source], [0, 2, "katori", 320, "manual"]);
});

Deno.test("read_card and copy_lines on the card on screen say so, not 'no card'", async () => {
  const bodies: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [];
  await runFoodAgent(
    { text: "what's on C2?", defaultMeal: "dinner", card: ONE_ROTI, threadIndex: THREAD_INDEX },
    {
      ...threadDeps(scripted([
        [{ name: "read_card", input: { card: "C2" } }, { name: "copy_lines", input: { source: { card: "c2" } } }],
        [{ name: "reply", input: { text: "ok" } }],
      ], bodies), events),
      threadOnScreenRef: "C2",
    },
  );
  const told = JSON.stringify(bodies[1].messages);
  assert(told.includes("C2 is the card on screen now") && !told.includes("No card C2"), told);
  assertEquals(events.find((e) => e.tool === "read_card"), { tool: "read_card", found: false, on_screen: true });
});
