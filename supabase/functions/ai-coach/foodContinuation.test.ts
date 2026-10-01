import { assertEquals } from "jsr:@std/assert@1";
import { readFoodContext } from "./foodContext.ts";
import { decideFoodAction, routeFoodIntent } from "./foodIntent.ts";
import { runParseMeal, type ParseMealDeps } from "./parseMeal.ts";

Deno.test("incident replay: clarification rebuilds five foods in breakfast and snacks, without an existing parsed card", async () => {
  const original = "1 scoop ON mango whey, 6g chia seeds for breakfast\n150g apple 2 whole eggs 2 cucumber for snacks";
  const question = "I have more than one saved match for cucumber. Add the brand, flavour or variant so I use the right one.";
  const text = "No brand, assume on it own";
  const context = readFoodContext([{ role: "user", text: original }, { role: "drona", text: question }], null);
  const decision = await routeFoodIntent(text, {
    classify: async (state) => {
      const input = JSON.parse(state);
      assertEquals(input.pending_meal.text, original);
      assertEquals(input.pending_meal.question, question);
      return "continue";
    },
  }, context);
  const items = [
    { name: "ON mango whey", quantity: 1, unit: "scoop", meal: "breakfast", est_total_g: 32, est_kcal: 120, est_protein_g: 24, est_carb_g: 3, est_fat_g: 1 },
    { name: "chia seeds", quantity: 6, unit: "g", meal: "breakfast", est_total_g: 6, est_kcal: 30, est_protein_g: 1, est_carb_g: 2, est_fat_g: 2 },
    { name: "apple", quantity: 150, unit: "g", meal: "snack", est_total_g: 150, est_kcal: 78, est_protein_g: 0, est_carb_g: 20, est_fat_g: 0 },
    { name: "whole eggs", quantity: 2, unit: "piece", meal: "snack", est_total_g: 100, est_kcal: 143, est_protein_g: 13, est_carb_g: 1, est_fat_g: 10 },
    { name: "cucumber", quantity: 2, unit: "piece", meal: "snack", est_total_g: 200, est_kcal: 30, est_protein_g: 1, est_carb_g: 6, est_fat_g: 0 },
  ];
  const forbidden = async () => { throw new Error("Quick clarification must not call the catalog"); };
  const deps: ParseMealDeps = {
    anthropicApiKey: "test", model: "test", maxTokens: 1000, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: forbidden, backfillOffFood: forbidden, getFoodPer100: forbidden, getFoodServings: forbidden,
    fetchFn: (async (_url, init) => {
      const request = JSON.parse(String(init!.body));
      const input = JSON.parse(request.messages[0].content);
      assertEquals(input.text, text);
      assertEquals(input.pending_meal.text, original);
      return new Response(JSON.stringify({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name: "estimate_meal", input: { declined: false, accepts_generic_estimate: true, meal_type_from_text: null, items } }] }), { status: 200 });
    }) as typeof fetch,
  };
  // Reproduce the conflicting personal aliases that blocked the real meal.
  deps.userMemory = { load: async () => ({ timeZone: "Asia/Kolkata", entries: ["cucumber", "Cucumber, raw"].map((food_name) => ({
    food_name, food_id: null, grams: 100, quantity: 100, serving_unit: "g",
    kcal: 16, protein_g: 1, carb_g: 3, fat_g: 0, fiber_g: null,
    source: "manual" as const, tier: "precise" as const, logged_via: "manual", logged_at: new Date().toISOString(),
    persistent: true, confirmed_aliases: ["cucumber"],
  })) }) };
  deps.jev = { apiKey: "test", timeoutMs: 1000, fetchFn: (async (_url, init) => {
    const request = JSON.parse(String(init!.body));
    return Response.json({ answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "score", probabilities: { "0": 1, "1": 0, "2": 0 } }])) });
  }) as typeof fetch };
  const result = await runParseMeal(deps, {
    text, localHour: 19, mealHint: "dinner", mode: "fast", previousItems: [],
    pendingMeal: decision.intent === "continue" ? context.pendingMeal : null,
    recentFoods: [], todayTotals: null, targets: null,
  });
  assertEquals(decideFoodAction({ decision, mode: "on", parseFoundFood: !!result.parsed, clientSupportsCreate: true }), "log");
  assertEquals(result.declined, null);
  assertEquals(result.parsed!.items.map((i) => i.food_name), items.map((i) => i.name));
  assertEquals(result.parsed!.items.map((i) => i.meal_type), ["breakfast", "breakfast", "snack", "snack", "snack"]);
  assertEquals(result.parsed!.continued_pending, true);
  assertEquals(result.steps.some((s) => s.tool === "pending_estimate"), true);
});
