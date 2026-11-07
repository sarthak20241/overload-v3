// Run with: deno test --allow-all supabase/functions/ai-coach/recipe.test.ts
//
// Step 5 of .planning/precise-food-logger-plan.md (FOOD_BUILD_RECIPE): a home
// dish built from its parts. What these pin:
//   - the sum: every number on the dish line is code's sum of each part's
//     per 100 x grams / 100, never a model's number
//   - the assumption: a fat or sweetener with no amount takes the table's
//     amount, and the line says it was assumed
//   - the one question: asked once per thread, never again for the same part
//   - the agent's limits: dish parts count toward the 8 parses per turn

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { type FoodAgentDeps, planCardChanges, runFoodAgent } from "./foodAgent.ts";
import type { CardLine } from "./foodContext.ts";
import type { ParsedItem, ParseMealResult } from "./parseMeal.ts";
import {
  assumedAmount,
  type PartFound,
  partLookupText,
  readRecipeParts,
  recipeQuestion,
  sumRecipe,
} from "./recipe.ts";

const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };

// Rows per 100 g, as the lookup would return them.
const ROWS: Record<string, { kcal: number; protein_g: number; carb_g: number; fat_g: number; source: ParsedItem["source"] }> = {
  "low fat paneer": { kcal: 254, protein_g: 25, carb_g: 4, fat_g: 15, source: "catalog" },
  "oil": { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100, source: "catalog" },
  "onion": { kcal: 40, protein_g: 1.1, carb_g: 9.3, fat_g: 0.1, source: "catalog" },
};

/** A fake parse: "<n> g <food>" returns that food's row at n grams. A food
 *  with no grams returns one 50 g serving, the way the parse picks one. */
function fakeParse(log: string[] = []): (text: string) => Promise<ParseMealResult> {
  return async (text) => {
    log.push(text);
    const m = text.match(/^(\d+(?:\.\d+)?)\s*g\s+(.+)$/);
    const name = (m ? m[2] : text).trim().toLowerCase();
    const grams = m ? Number(m[1]) : 50;
    const row = ROWS[name];
    if (!row) return { parsed: null, declined: { message: "no food" }, usage: USAGE, tool_calls: [], steps: [], iterations: 1 } as ParseMealResult;
    const f = grams / 100;
    const item: ParsedItem = {
      food_id: null, food_name: name, quantity: grams, serving_label: "g", grams,
      kcal: row.kcal * f, protein_g: row.protein_g * f, carb_g: row.carb_g * f, fat_g: row.fat_g * f,
      fiber_g: null, source: row.source, assumption: null, confidence: "medium",
    };
    return {
      parsed: { meal_type: "lunch", items: [item], drona_line: "", corrects_previous: false },
      declined: null, usage: USAGE, tool_calls: [], steps: [], iterations: 1, tier: "precise",
    };
  };
}

function part(name: string, grams: number, assumed: string | null = null): PartFound {
  const r = ROWS[name];
  return { name, grams, per100: { kcal: r.kcal, protein_g: r.protein_g, carb_g: r.carb_g, fat_g: r.fat_g, fiber_g: null }, source: r.source, assumed };
}

// ── The sum ────────────────────────────────────────────────────────────────

Deno.test("sumRecipe: the dish is each part's per 100 x grams / 100, added up in code", () => {
  const line = sumRecipe("Paneer sabji", [part("low fat paneer", 60), part("oil", 5, "1 tsp"), part("onion", 40)], "lunch");
  // 60 g paneer 152.4 + 5 g oil 44.2 + 40 g onion 16 = 212.6 kcal.
  assertEquals(line.kcal, 212.6);
  assertEquals(line.protein_g, 15.4); // 15 + 0 + 0.44
  assertEquals(line.fat_g, 14.0); // 9 + 5 + 0.04
  assertEquals(line.carb_g, 6.1); // 2.4 + 0 + 3.72
  assertEquals(line.grams, 105);
  assertEquals(line.source, "recipe");
  // The parts stay on the line, in the shape food memory keeps.
  assertEquals(line.recipe?.map((p) => [p.name, p.grams, p.per100.kcal, p.source, !!p.assumed]), [
    ["low fat paneer", 60, 254, "catalog", false],
    ["oil", 5, 884, "catalog", true],
    ["onion", 40, 40, "catalog", false],
  ]);
});

// ── The assumption ─────────────────────────────────────────────────────────

Deno.test("assumedAmount: fats and sweeteners with no amount take 1 tsp; spreads and other foods do not", () => {
  assertEquals(assumedAmount("oil"), { grams: 5, label: "1 tsp" });
  assertEquals(assumedAmount("mustard oil"), { grams: 5, label: "1 tsp" });
  assertEquals(assumedAmount("desi ghee"), { grams: 5, label: "1 tsp" });
  assertEquals(assumedAmount("Amul butter"), { grams: 5, label: "1 tsp" });
  assertEquals(assumedAmount("sugar"), { grams: 4, label: "1 tsp" });
  assertEquals(assumedAmount("peanut butter"), null);
  assertEquals(assumedAmount("onion"), null);
});

Deno.test("partLookupText: the user's amount wins; no amount takes the table's grams, marked assumed", () => {
  assertEquals(partLookupText({ name: "oil", amount: "2 tsp" }), { text: "2 tsp oil", grams: null, assumed: null });
  assertEquals(partLookupText({ name: "oil", amount: null }), { text: "5 g oil", grams: 5, assumed: "1 tsp" });
  // Not in the table: the parse picks one usual serving, still an assumption.
  assertEquals(partLookupText({ name: "onion", amount: null }), { text: "onion", grams: null, assumed: "" });
});

// ── The one question ───────────────────────────────────────────────────────

Deno.test("recipeQuestion: one question for the assumed parts, never asked twice", () => {
  const dish = sumRecipe("Paneer sabji", [part("low fat paneer", 60), part("oil", 5, "1 tsp")], "lunch");
  assertEquals(recipeQuestion([dish], [], []), "I assumed 1 tsp oil. Change it?");
  // An earlier Drona turn already asked: no second question.
  assertEquals(recipeQuestion([dish], [], [{ role: "drona", text: "Paneer sabji is on the card. I assumed 1 tsp oil. Change it?" }]), null);
  // The card already has this dish with the oil assumed (an app that keeps
  // `recipe`, or one that only keeps the note): no second question.
  const onCard: CardLine = { food_name: "Paneer sabji", quantity: 1, serving_label: "serving", grams: 65, kcal: 196, source: "recipe", recipe: dish.recipe };
  assertEquals(recipeQuestion([dish], [onCard], []), null);
  const noteOnly: CardLine = { ...onCard, recipe: undefined, assumption: dish.assumption };
  assertEquals(recipeQuestion([dish], [noteOnly], []), null);
  // Nothing assumed: nothing to ask.
  const given = sumRecipe("Paneer sabji", [part("low fat paneer", 60), part("oil", 10)], "lunch");
  assertEquals(recipeQuestion([given], [], []), null);
});

Deno.test("recipeQuestion: two assumed parts are one sentence, at most two named", () => {
  const dish = sumRecipe("Dal", [part("onion", 40, "40 g"), part("oil", 5, "1 tsp")], "lunch");
  assertEquals(recipeQuestion([dish], [], []), "I assumed 40 g onion and 1 tsp oil. Change them?");
});

// ── The agent ──────────────────────────────────────────────────────────────

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

const SABJI = {
  name: "build_recipe",
  input: { name: "Paneer sabji", parts: [{ name: "low fat paneer", amount: "60 g" }, { name: "oil" }, { name: "onion", amount: "40 g" }] },
};

Deno.test("agent: build_recipe with no card makes the card from the parts, summed in code, and asks once", async () => {
  const log: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const out = await runFoodAgent(
    { text: "lunch was a sabji", defaultMeal: "lunch", later: true, first: true },
    { model: "m", callModel: scripted([[SABJI]], bodies), readDiary: async () => ({}), savedMeals: async () => [], parseFood: fakeParse(log), buildRecipe: true },
  );
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  const p = out.result.parsed!;
  assertEquals(p.items.length, 1);
  assertEquals(p.items[0].kcal, 212.6);
  assertEquals(p.items[0].source, "recipe");
  assertFalse(p.corrects_previous);
  // One parse per part; the oil looked up at the table's 5 g.
  assertEquals(log.sort(), ["40 g onion", "5 g oil", "60 g low fat paneer"]);
  assert(p.drona_line.endsWith("I assumed 1 tsp oil. Change it?"), p.drona_line);
  // The tool is offered only behind the switch.
  assert((bodies[0].tools as { name: string }[]).some((t) => t.name === "build_recipe"));
});

Deno.test("agent: without the switch there is no build_recipe tool", async () => {
  const bodies: Record<string, unknown>[] = [];
  await runFoodAgent(
    { text: "x", defaultMeal: "lunch", later: true, first: true },
    { model: "m", callModel: scripted([[{ name: "reply", input: { text: "ok" } }]], bodies), readDiary: async () => ({}), savedMeals: async () => [], parseFood: fakeParse() },
  );
  assertFalse((bodies[0].tools as { name: string }[]).some((t) => t.name === "build_recipe"));
});

Deno.test("agent: rebuilding a dish on its line replaces it; the answered oil is not asked again", async () => {
  const card: CardLine[] = [
    { food_name: "Rice", quantity: 1, serving_label: "katori", grams: 150, kcal: 195, source: "catalog", meal_type: "lunch" },
    { food_name: "Paneer sabji", quantity: 1, serving_label: "serving", grams: 105, kcal: 212.6, source: "recipe", meal_type: "lunch",
      assumption: "Built from parts: 60 g low fat paneer, 5 g oil (assumed), 40 g onion." },
  ];
  const rebuilt = { name: "build_recipe", input: { ...SABJI.input, line_id: "L2", parts: [{ name: "low fat paneer", amount: "60 g" }, { name: "oil", amount: "10 g" }, { name: "onion", amount: "40 g" }] } };
  const out = await runFoodAgent(
    { text: "it was 2 tsp oil", defaultMeal: "lunch", later: true, card,
      recentTurns: [{ role: "drona", text: "I assumed 1 tsp oil. Change it?" }] },
    { model: "m", callModel: scripted([[rebuilt]]), readDiary: async () => ({}), savedMeals: async () => [], parseFood: fakeParse(), buildRecipe: true },
  );
  assertEquals(out.kind, "log");
  if (out.kind !== "log") return;
  const p = out.result.parsed!;
  assertEquals(p.items.map((i) => i.food_name), ["Rice", "Paneer sabji"]);
  assertEquals(p.items[0].kcal, 195); // untouched
  assertEquals(p.items[1].kcal, 256.8); // 152.4 + 88.4 + 16
  assert(p.corrects_previous);
  assertFalse(p.drona_line.includes("I assumed"), p.drona_line);
});

// ── Limits ─────────────────────────────────────────────────────────────────

Deno.test("planCardChanges: dish parts count toward the 8 parses per turn", () => {
  const card: CardLine[] = [{ food_name: "Rice", quantity: 1, serving_label: "katori", grams: 150, kcal: 195 }];
  const parts = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `part ${i}` }));
  const ok = planCardChanges(card, [{ name: "build_recipe", input: { name: "Dal", parts: parts(6) } }, { name: "add_lines", input: { text: "1 egg" } }]);
  assert(ok.ok);
  const over = planCardChanges(card, [{ name: "build_recipe", input: { name: "Dal", parts: parts(6) } }, { name: "add_lines", input: { text: "1 egg" } }, { name: "edit_line", input: { line_id: "L1", change: "2 katori" } }, { name: "add_lines", input: { text: "1 roti" } }]);
  assertFalse(over.ok);
  // A dish and an edit on the same line: two changes, refused.
  const twice = planCardChanges(card, [{ name: "build_recipe", input: { name: "Rice", parts: parts(1), line_id: "L1" } }, { name: "edit_line", input: { line_id: "L1", change: "2 katori" } }]);
  assertFalse(twice.ok);
  // No card: only when the turn builds a dish.
  assertFalse(planCardChanges([], [{ name: "add_lines", input: { text: "1 egg" } }]).ok);
  assert(planCardChanges([], [{ name: "build_recipe", input: { name: "Dal", parts: parts(2) } }], false, true).ok);
});

Deno.test("readRecipeParts: parts sent back by the app are checked", () => {
  assertEquals(readRecipeParts("x"), undefined);
  assertEquals(readRecipeParts([{ name: "oil", grams: 5, per100: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 }, source: "catalog", assumed: true }, { name: "", grams: 5 }, { name: "bad", grams: -1, per100: {} }]), [
    { name: "oil", grams: 5, per100: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 }, source: "catalog", assumed: true },
  ]);
});
