// Run with: deno test --allow-all supabase/functions/ai-coach/parseTier.test.ts
//
// The tier a parse reports is the tier that ran, not the one the user picked.
// Cost reporting splits parse_meal spend by it, so a correction that ran
// Thorough but reported Fast would bill Thorough's tokens to Fast.

import { assertEquals } from "jsr:@std/assert@1";
import { type ParseMealDeps, resolveParseTier, runParseMeal } from "./parseMeal.ts";

Deno.test("resolveParseTier: a first shot runs the tier asked for", () => {
  assertEquals(resolveParseTier("fast", false), "fast");
  assertEquals(resolveParseTier("super", false), "precise");
  assertEquals(resolveParseTier(null, false), "thorough");
  assertEquals(resolveParseTier(undefined, false), "thorough");
});

Deno.test("resolveParseTier: a correction runs Thorough whatever was asked for", () => {
  assertEquals(resolveParseTier("fast", true), "thorough");
  assertEquals(resolveParseTier("super", true), "thorough");
  assertEquals(resolveParseTier(null, true), "thorough");
});

// Every model call declines, so the parse ends early on either path without
// touching the catalog. The tier still has to come back on the result.
function declining(): ParseMealDeps {
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000,
    webSearchEnabled: false,
    searchFoods: async () => [],
    backfillOffFood: async () => null,
    getFoodPer100: async () => null,
    fetchFn: (async () =>
      new Response(JSON.stringify({
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: "tool_use", name: "estimate_meal", input: { declined: true, message: "not food", items: [] } },
          { type: "tool_use", name: "extract_meal", input: { declined: true, message: "not food", items: [] } },
        ],
      }), { status: 200 })) as typeof fetch,
  };
}

const BASE = {
  text: "hello", localHour: 13, mealHint: null, recentFoods: [], todayTotals: null, targets: null,
};

Deno.test("runParseMeal reports the tier asked for on a first shot", async () => {
  const r = await runParseMeal(declining(), { ...BASE, mode: "fast" });
  assertEquals(r.tier, "fast");
});

Deno.test("runParseMeal reports Thorough for a correction even when Fast was picked", async () => {
  const r = await runParseMeal(declining(), {
    ...BASE,
    mode: "fast",
    previousText: "2 eggs",
    previousItems: [{
      food_name: "egg", quantity: 2, unit: "piece", grams: 100, meal_type: "breakfast",
      kcal: 143, protein_g: 12.6, carb_g: 0.7, fat_g: 9.5,
    } as never],
  });
  assertEquals(r.tier, "thorough");
});
