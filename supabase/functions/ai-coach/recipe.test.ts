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
import { lineSourceTail } from "./foodContext.ts";
import {
  assumedAmount,
  buildRecipe,
  type PartFound,
  partLookupText,
  per100FromParse,
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
  assertEquals(line.origin, "recipe");
  // The parts stay on the line, in the shape food memory keeps.
  assertEquals(line.recipe?.map((p) => [p.name, p.grams, p.per100?.kcal, p.source, !!p.assumed]), [
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
      assumption: "Assumed 1 tsp oil. Parts: 60 g low fat paneer, 5 g oil, 40 g onion." },
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

Deno.test("readRecipeParts: parts sent back by the app are checked (step 4's parseRecipe)", () => {
  assertEquals(readRecipeParts("x", "recipe"), undefined);
  const oil = { name: "oil", grams: 5, per100: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 }, source: "catalog" as const, assumed: true };
  assertEquals(readRecipeParts([oil], "recipe"), [oil]);
  // One part with no name or no weight: the parts are not kept at all.
  assertEquals(readRecipeParts([oil, { name: "", grams: 5 }], "recipe"), undefined);
});
// ── Review fixes (PR #359) ─────────────────────────────────────────────────

Deno.test("recipeQuestion: the second part of a two-part question is not asked again", () => {
  const dish = sumRecipe("Dal", [part("onion", 40), part("oil", 5, "1 tsp")], "lunch");
  const ghee: PartFound = { ...part("oil", 5, "1 tsp"), name: "ghee" };
  const both = sumRecipe("Dal", [part("onion", 40), part("oil", 5, "1 tsp"), ghee], "lunch");
  const asked = recipeQuestion([both], [], []);
  assertEquals(asked, "I assumed 1 tsp oil and 1 tsp ghee. Change them?");
  // Next message, the dish rebuilt with only ghee still assumed: already asked.
  const gheeOnly = sumRecipe("Dal", [part("onion", 40), part("oil", 10), ghee], "lunch");
  assertEquals(recipeQuestion([gheeOnly], [], [{ role: "drona", text: asked! }]), null);
  assert(dish.recipe);
});

Deno.test("recipeNote: a long dish keeps its assumed parts in the note, so the note-only check still holds", () => {
  const long = (i: number): PartFound => ({ ...part("onion", 40), name: `chopped fresh garden vegetable number ${i}` });
  const parts = [...Array.from({ length: 7 }, (_, i) => long(i)), part("oil", 5, "1 tsp")];
  const dish = sumRecipe("Mixed vegetable curry", parts, "dinner");
  assert(dish.assumption!.length <= 160, dish.assumption!);
  assert(/1 tsp oil/.test(dish.assumption!), dish.assumption!);
  const noteOnly: CardLine = { food_name: "Mixed vegetable curry", quantity: 1, serving_label: "serving", grams: 285, kcal: 156, source: "recipe", assumption: dish.assumption };
  assertEquals(recipeQuestion([dish], [noteOnly], []), null);
});

Deno.test("agent: a dish with two parts not found is not put on the card", async () => {
  const twoMissing = { name: "build_recipe", input: { name: "Stew", parts: [{ name: "low fat paneer", amount: "60 g" }, { name: "zzz root" }, { name: "qqq leaf" }] } };
  const out = await runFoodAgent(
    { text: "x", defaultMeal: "lunch", later: true, card: [{ food_name: "Rice", quantity: 1, serving_label: "katori", grams: 150, kcal: 195, meal_type: "lunch" }] },
    { model: "m", callModel: scripted([[twoMissing]]), readDiary: async () => ({}), savedMeals: async () => [], parseFood: fakeParse(), buildRecipe: true },
  );
  // Nothing changed: the card stays, and the line says which dish failed.
  assertEquals(out.kind, "reply");
  if (out.kind === "reply") assert(/Stew/.test(out.text), out.text);
  // One part missing still lands, at low confidence, with the part named.
  const oneMissing = { name: "build_recipe", input: { name: "Stew", parts: [{ name: "low fat paneer", amount: "60 g" }, { name: "oil" }, { name: "zzz root" }] } };
  const out2 = await runFoodAgent(
    { text: "x", defaultMeal: "lunch", later: true, first: true },
    { model: "m", callModel: scripted([[oneMissing]]), readDiary: async () => ({}), savedMeals: async () => [], parseFood: fakeParse(), buildRecipe: true },
  );
  assertEquals(out2.kind, "log");
  if (out2.kind === "log") assertEquals(out2.result.parsed!.items[0].confidence, "low");
});

Deno.test("readRecipeParts: parts are kept only on a line whose source is recipe", () => {
  const raw = [{ name: "oil", grams: 5, per100: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 }, source: "catalog" }];
  assertEquals(readRecipeParts(raw, "recipe")?.length, 1);
  assertEquals(readRecipeParts(raw, "estimate"), undefined);
  assertEquals(readRecipeParts(raw, undefined), undefined);
});

Deno.test("agent: with no card, a dish whose parts are all not found makes no card, only a line saying so", async () => {
  const none = { name: "build_recipe", input: { name: "Stew", parts: [{ name: "zzz root" }, { name: "qqq leaf" }] } };
  const out = await runFoodAgent(
    { text: "x", defaultMeal: "lunch", later: true, first: true },
    { model: "m", callModel: scripted([[none]]), readDiary: async () => ({}), savedMeals: async () => [], parseFood: fakeParse(), buildRecipe: true },
  );
  assertEquals(out.kind, "reply");
  if (out.kind === "reply") assert(/Stew is not on the card/.test(out.text), out.text);
});

// ── Review fixes, round 3 (PR #359) ────────────────────────────────────────

Deno.test("buildRecipe: a dish whose biggest stated part is not found stays off the card", async () => {
  const ask = { name: "Sabji", parts: [{ name: "zzz paneer", amount: "50 g" }, { name: "onion", amount: "40 g" }, { name: "oil", amount: null }] };
  const r = await buildRecipe(ask, "lunch", fakeParse());
  assertEquals(r.item, null);
  assertEquals(r.missing, ["zzz paneer"]);
  // A small part missing still lands.
  const small = { name: "Sabji", parts: [{ name: "low fat paneer", amount: "60 g" }, { name: "zzz herb", amount: "2 g" }, { name: "oil", amount: null }] };
  assert((await buildRecipe(small, "lunch", fakeParse())).item);
});

Deno.test("partLookupText: an assumed amount is a flag, with the label apart", () => {
  assertEquals(partLookupText({ name: "oil", amount: null }), { text: "5 g oil", grams: 5, assumed: true, label: "1 tsp" });
  assertEquals(partLookupText({ name: "onion", amount: null }), { text: "onion", grams: null, assumed: true, label: null });
  assertEquals(partLookupText({ name: "oil", amount: "2 tsp" }), { text: "2 tsp oil", grams: null, assumed: false, label: null });
});

Deno.test("lineSourceTail: a recipe line with its parts lists every part, not a cut note", () => {
  const parts = Array.from({ length: 8 }, (_, i) => part("onion", 40 + i));
  const dish = sumRecipe("Big curry", parts.map((p, i) => ({ ...p, name: `long vegetable name number ${i}` })), "dinner");
  const tail = lineSourceTail({ source: "recipe", assumption: dish.assumption, recipe: dish.recipe });
  for (let i = 0; i < 8; i++) assert(tail.includes(`long vegetable name number ${i}`), tail);
});

Deno.test("planCardChanges: with no card, a line tool is refused with a plain reason", () => {
  const r = planCardChanges([], [{ name: "build_recipe", input: { name: "Dal", parts: [{ name: "dal" }] } }, { name: "edit_line", input: { line_id: "L1", change: "x" } }], false, true);
  assertFalse(r.ok);
  if (!r.ok) {
    assertFalse(r.error.includes("L1 to L0"), r.error);
    assert(/no card/i.test(r.error), r.error);
  }
});

Deno.test("agent: a rebuild that fails on a card line says the line is as before", async () => {
  const card: CardLine[] = [{ food_name: "Sabji", quantity: 1, serving_label: "serving", grams: 105, kcal: 212.6, source: "recipe", meal_type: "lunch" }];
  const rebuild = { name: "build_recipe", input: { name: "Sabji", line_id: "L1", parts: [{ name: "zzz a" }, { name: "zzz b" }] } };
  const out = await runFoodAgent(
    { text: "x", defaultMeal: "lunch", later: true, card },
    { model: "m", callModel: scripted([[rebuild]]), readDiary: async () => ({}), savedMeals: async () => [], parseFood: fakeParse(), buildRecipe: true },
  );
  assertEquals(out.kind, "reply");
  if (out.kind === "reply") {
    assert(/as before/.test(out.text), out.text);
    assertFalse(/not on the card/.test(out.text), out.text);
  }
});

// ── Review fixes, round 4 (PR #359) ────────────────────────────────────────

Deno.test("assumedAmount: a food packed in oil or syrup is not a cooking fat", () => {
  assertEquals(assumedAmount("tuna in oil"), null);
  assertEquals(assumedAmount("peaches in syrup with sugar"), null);
  assertEquals(assumedAmount("olive oil"), { grams: 5, label: "1 tsp" });
});

Deno.test("per100FromParse: an item with no weight does not add to the per-100 numbers", () => {
  const withWeight: ParsedItem = { food_id: null, food_name: "dal", quantity: 100, serving_label: "g", grams: 100, kcal: 120, protein_g: 7, carb_g: 18, fat_g: 2, fiber_g: null, source: "catalog", assumption: null, confidence: "medium" };
  const noWeight: ParsedItem = { ...withWeight, food_name: "tadka", grams: 0, kcal: 90, fat_g: 10 };
  const r = { parsed: { meal_type: "lunch", items: [withWeight, noWeight], drona_line: "", corrects_previous: false }, declined: null, usage: USAGE, tool_calls: [], steps: [], iterations: 1 } as ParseMealResult;
  assertEquals(per100FromParse(r)?.kcal, 120);
});

// ── Review fixes, round 5 (PR #359) ────────────────────────────────────────

Deno.test("assumedAmount: butter and sugar only when they are the cooking kind", () => {
  assertEquals(assumedAmount("biscoff butter"), null);
  assertEquals(assumedAmount("shea butter"), null);
  assertEquals(assumedAmount("butter"), { grams: 5, label: "1 tsp" });
  assertEquals(assumedAmount("unsalted butter"), { grams: 5, label: "1 tsp" });
  assertEquals(assumedAmount("brown sugar"), { grams: 4, label: "1 tsp" });
  assertEquals(assumedAmount("date sugar"), null);
});

Deno.test("per100FromParse: fiber is per 100 only when every item has a figure", () => {
  const a: ParsedItem = { food_id: null, food_name: "dal", quantity: 100, serving_label: "g", grams: 100, kcal: 120, protein_g: 7, carb_g: 18, fat_g: 2, fiber_g: 4, source: "catalog", assumption: null, confidence: "medium" };
  const b: ParsedItem = { ...a, food_name: "rice", fiber_g: null };
  const r = { parsed: { meal_type: "lunch", items: [a, b], drona_line: "", corrects_previous: false }, declined: null, usage: USAGE, tool_calls: [], steps: [], iterations: 1 } as ParseMealResult;
  assertEquals(per100FromParse(r)?.fiber_g, null);
});
