// Run with: deno test --allow-all supabase/functions/ai-coach/missedFood.test.ts
//
// Live, 2026-11-04, Precise: "...Lunch: 1 whole egg, 2 egg whites, 280 cals of
// "poha + vegetable dalia"" logged a line called "Groundcherries
// (Cape-Gooseberries or Poha)" at 53 kcal. Three things lined up:
//   1. The line carried the user's total, and still spent four web searches
//      and a FatSecret lookup; FatSecret's top row was the berry.
//   2. Decide left that food out of a 13-food list, and the fallback logged
//      the first search row under the row's name.
//   3. The stated 280 kcal then found no line by its name and was dropped.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type CandidateFood, type ParseMealDeps, type ParsedItem, runParseMeal } from "./parseMeal.ts";

const BERRY: CandidateFood = {
  food_id: "row-berry", name: "Groundcherries (Cape-Gooseberries or Poha)", brand: null, base_unit: "g",
  kcal: 53, protein_g: 1.9, carb_g: 11.2, fat_g: 0.7, fiber_g: null, servings: [], source: "catalog",
};
const EGG_ROW: CandidateFood = {
  food_id: "row-egg", name: "Egg, whole, boiled", brand: null, base_unit: "g",
  kcal: 155, protein_g: 12.6, carb_g: 1.1, fat_g: 10.6, fiber_g: 0,
  servings: [{ label: "1 large", grams: 50, is_default: true }], source: "catalog",
};
const EGG = { name: "whole egg", brand: null, quantity: 1, unit: "piece", prep: null };
const POHA_TOTAL = {
  name: "poha + vegetable dalia", brand: null, quantity: 1, unit: "serving", prep: null,
  stated: { basis: "total", kcal: 280 },
};
const POHA_PLAIN = { name: "poha", brand: null, quantity: 1, unit: "bowl", prep: null };

const eggLine = { food_id: "row-egg", food_name: "Egg, whole, boiled", quantity: 1, serving_label: "1 large", grams: 50, source: "catalog", confidence: "high", assumption: null };
const pohaLine = {
  food_id: null, food_name: "Vegetable poha with dalia", quantity: 1, serving_label: "serving", grams: 250,
  kcal: 300, protein_g: 8, carb_g: 52, fat_g: 7, source: "estimate", confidence: "medium", assumption: null,
};

/** Extract returns `items`; each decide call returns the next of `decides`
 *  (the last one repeats). Every lookup and every decide payload is kept. */
function harness(items: Record<string, unknown>[], decides: Record<string, unknown>[][]) {
  const searched: string[] = [];
  const decidePayloads: Record<string, any>[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("anthropic")) {
      searched.push(`http:${String(url).slice(0, 40)}`);
      return Response.json({ products: [] });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const name: string = body.tool_choice?.name ?? (body.tools ?? [])[0]?.name ?? "";
    if (name === "extract_meal") {
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name, input: { declined: false, meal_type_from_text: "lunch", items } }] });
    }
    decidePayloads.push(JSON.parse(body.messages[0].content));
    const out = decides[Math.min(decidePayloads.length - 1, decides.length - 1)];
    return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name, input: { meal_type: "lunch", drona_line: "Logged.", items: out } }] });
  }) as typeof fetch;
  const deps: ParseMealDeps = {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false, fetchFn,
    searchFoods: async (q) => { searched.push(`catalog:${q}`); return /egg/i.test(q) ? [EGG_ROW] : [BERRY]; },
    searchFatSecret: async (q) => { searched.push(`fatsecret:${q}`); return []; },
    backfillOffFood: async () => null,
    getFoodPer100: async () => null,
  };
  return { deps, searched, decidePayloads };
}

const BASE = { localHour: 13, mealHint: null, recentFoods: [], todayTotals: null, targets: null, mode: null };
const named = (items: ParsedItem[], re: RegExp) => items.filter((i) => re.test(i.food_name));

Deno.test("the failure this prevents: 280 cals of poha + vegetable dalia logged as Groundcherries", async () => {
  // The first decide leaves the poha out, the retry returns it.
  const h = harness([EGG, POHA_TOTAL], [[eggLine], [pohaLine]]);
  const r = await runParseMeal(h.deps, { ...BASE, text: 'Lunch: 1 whole egg, 280 cals of "poha + vegetable dalia"' });
  const items = r.parsed!.items;
  assertEquals(named(items, /groundcherr/i).length, 0, items.map((i) => i.food_name).join(" | "));
  const poha = named(items, /poha/i);
  assertEquals(poha.length, 1);
  // Her number, exactly; the macros she left out fill the rest of it.
  assertEquals([poha[0].kcal, poha[0].source], [280, "manual"]);
  assert(Math.abs(4 * poha[0].protein_g + 4 * poha[0].carb_g + 9 * poha[0].fat_g - 280) < 3);
  assertEquals(items.length, 2);
});

Deno.test("a line with the user's total is not looked up anywhere", async () => {
  const h = harness([EGG, POHA_TOTAL], [[eggLine, pohaLine]]);
  const r = await runParseMeal(h.deps, { ...BASE, text: 'Lunch: 1 whole egg, 280 cals of "poha + vegetable dalia"' });
  assertEquals(h.searched.filter((s) => /poha|dalia/i.test(s)), []);
  // Decide sees no rows for it, only her total, and estimates around it.
  const sent = h.decidePayloads[0].items.find((i: { name: string }) => /poha/.test(i.name));
  assertEquals(sent.candidates, []);
  assertEquals(sent.user_total.kcal, 280);
  assert(r.steps.some((s) => s.tool === "user_stated" && (s.result as { lookup?: string })?.lookup === "skipped"));
  // Nothing was missed, so no second call.
  assertEquals(h.decidePayloads.length, 1);
  assertEquals(named(r.parsed!.items, /poha/i)[0].kcal, 280);
});

Deno.test("the retry asks only for the missed food and says what is already logged", async () => {
  const h = harness([EGG, POHA_PLAIN], [[eggLine], [pohaLine]]);
  const r = await runParseMeal(h.deps, { ...BASE, text: "1 whole egg and a bowl of poha" });
  assertEquals(h.decidePayloads.length, 2);
  assertEquals(h.decidePayloads[1].items.map((i: { name: string }) => i.name), ["poha"]);
  assertEquals(h.decidePayloads[1].already_logged, ["Egg, whole, boiled"]);
  const step = r.steps.find((s) => s.tool === "decide_retry")!;
  assertEquals((step.input as { missed: string[] }).missed, ["poha"]);
  assertEquals(r.parsed!.items.map((i) => i.food_name), ["Egg, whole, boiled", "Vegetable poha with dalia"]);
});

Deno.test("a retry line for a food already logged is dropped, never doubled", async () => {
  const h = harness([EGG, POHA_PLAIN], [[eggLine], [eggLine, pohaLine]]);
  const r = await runParseMeal(h.deps, { ...BASE, text: "1 whole egg and a bowl of poha" });
  assertEquals(named(r.parsed!.items, /egg/i).length, 1);
  assertEquals(named(r.parsed!.items, /poha/i).length, 1);
});

Deno.test("when the retry misses it too, the fallback keeps the user's words, not the first row's name", async () => {
  const h = harness([EGG, POHA_PLAIN], [[eggLine]]);
  const r = await runParseMeal(h.deps, { ...BASE, text: "1 whole egg and a bowl of poha" });
  assertEquals(h.decidePayloads.length, 2);
  const poha = named(r.parsed!.items, /poha/i);
  assertEquals(poha.length, 1);
  assertEquals(poha[0].food_name, "poha");
  assertEquals([poha[0].confidence, poha[0].assumption], ["low", "I may have missed this item, tap to check it"]);
});

Deno.test("the user's total still finds a line decide named in its own words", async () => {
  // Every word of "poha + vegetable dalia" is in "Vegetable poha with dalia",
  // though neither name contains the other. Two foods, so the one-line
  // shortcut in honourStatedTotals cannot place it.
  const h = harness([EGG, POHA_TOTAL], [[eggLine, { ...pohaLine, kcal: 410, protein_g: 11, carb_g: 70, fat_g: 10 }]]);
  const r = await runParseMeal(h.deps, { ...BASE, text: 'Lunch: 1 whole egg, 280 cals of "poha + vegetable dalia"' });
  assertEquals(named(r.parsed!.items, /poha/i).map((i) => [i.food_name, i.kcal]), [["Vegetable poha with dalia", 280]]);
});
