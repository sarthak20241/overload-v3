// Run with: deno test --allow-all supabase/functions/ai-coach/foodAgent.test.ts
//
// The food agent loop, with a scripted model. What these pin:
//   - reads asked for in one turn all run, and run together
//   - the turn cap is enforced by code, not by the model obeying the prompt
//   - numbers are copied or parsed, never taken from the agent
//   - every finish is a shape the app already draws

import { FOOD_TURNS_KEPT } from "./foodContext.ts";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FOOD_AGENT_SYSTEM, type FoodAgentDeps, historyMessages, LAST_TURN_NOTE, MAX_TURNS, openingText, recentDays, runFoodAgent, statusFor } from "./foodAgent.ts";
import type { ParseMealResult } from "./parseMeal.ts";
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
