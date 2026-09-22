// Run with: deno test --allow-all supabase/functions/ai-coach/foodAgent.test.ts
//
// The food agent loop, with a scripted model. What these pin:
//   - reads asked for in one turn all run, and run together
//   - the turn cap is enforced by code, not by the model obeying the prompt
//   - numbers are copied or parsed, never taken from the agent
//   - every finish is a shape the app already draws

import { assert, assertEquals } from "jsr:@std/assert@1";
import { FOOD_AGENT_SYSTEM, type FoodAgentDeps, LAST_TURN_NOTE, MAX_TURNS, recentDays, runFoodAgent, statusFor } from "./foodAgent.ts";
import type { ParseMealResult } from "./parseMeal.ts";

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
  assertEquals(bodies[4].system, FOOD_AGENT_SYSTEM + LAST_TURN_NOTE);
  assertEquals(bodies[3].system, FOOD_AGENT_SYSTEM);
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
