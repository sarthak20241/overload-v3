// Run with: deno test --allow-all supabase/functions/ai-coach/fastNoCatalog.test.ts
//
// Quick (fast) mode is PURELY the model's estimate. Decided 2026-09-15 after
// three live Quick logs landed on wrong catalog rows - "chicken" as Chicken
// feet, "toast" as Melba toast, "with butter" as a 1-cup, 1664 kcal serving.
// Each was the catalog REPLACING a correct model estimate. The fix is to never
// ask: no catalog search, no OFF, no FatSecret, no precise-cache read, and no
// row re-read. These tests pin that by counting every lookup a parse makes.

import { assertEquals } from "jsr:@std/assert@1";
import { type ParseMealDeps, type ParseProgress, runParseMeal } from "./parseMeal.ts";

const EST_ITEMS = [
  {
    name: "chicken", brand: null, quantity: 1, unit: "serving", prep: null,
    label_applies: false, label_serving_g: null, label_serving_kcal: null, label_pieces_per_serving: null,
    est_kcal: 200, est_protein_g: 30, est_carb_g: 0, est_fat_g: 8, est_total_g: 120,
  },
  {
    name: "butter", brand: null, quantity: 1, unit: "serving", prep: null,
    label_applies: false, label_serving_g: null, label_serving_kcal: null, label_pieces_per_serving: null,
    est_kcal: 70, est_protein_g: 0, est_carb_g: 0, est_fat_g: 8, est_total_g: 10,
  },
];

function stub(lookups: string[], events: ParseProgress[] = []): ParseMealDeps {
  const hit = (name: string) => { lookups.push(name); };
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000,
    webSearchEnabled: false, fastGrammarMode: "off",
    // Every lookup returns a row that WOULD win if anyone asked, so a parse
    // that still consults the catalog shows up as a catalog line, not only as
    // a counted call.
    searchFoods: async (q) => {
      hit(`search:${q}`);
      return [{
        food_id: "row-1", name: q === "butter" ? "Butter, NFS" : "Chicken feet", brand: null,
        base_unit: "g", kcal: 743, protein_g: 1, carb_g: 0, fat_g: 81, fiber_g: null,
        servings: [{ label: "1 pat", grams: 7, is_default: true }], source: "catalog",
      }];
    },
    searchFatSecret: async (q) => { hit(`fatsecret:${q}`); return []; },
    backfillOffFood: async () => { hit("off_backfill"); return null; },
    preciseCacheGet: async (k) => { hit(`precise:${k}`); return null; },
    getFoodPer100: async (id) => { hit(`per100:${id}`); return null; },
    getFoodServings: async (id) => { hit(`servings:${id}`); return []; },
    onProgress: (p) => { events.push(p); },
    fetchFn: (async (url: string | URL | Request) => {
      if (!String(url).includes("anthropic")) {
        hit(`http:${String(url).slice(0, 60)}`);
        return new Response("[]", { status: 200 });
      }
      return new Response(JSON.stringify({
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "tool_use", name: "estimate_meal", input: { declined: false, meal_type_from_text: null, items: EST_ITEMS } }],
      }), { status: 200 });
    }) as typeof fetch,
  };
}

const INPUT = {
  text: "chicken with butter", localHour: 13, mealHint: null, mode: "fast" as const,
  recentFoods: [], todayTotals: null, targets: null,
};

Deno.test("fast mode makes no lookup of any kind", async () => {
  const lookups: string[] = [];
  const r = await runParseMeal(stub(lookups), INPUT);
  assertEquals(lookups, []);
  assertEquals(r.tool_calls, ["estimate_meal"]);
});

Deno.test("fast mode ships the model's own totals on every line", async () => {
  const r = await runParseMeal(stub([]), INPUT);
  const items = r.parsed!.items;
  assertEquals(items.map((i) => i.source), ["estimate", "estimate"]);
  assertEquals(items.map((i) => i.food_id), [null, null]);
  assertEquals(items.map((i) => i.food_name), ["chicken", "butter"]);
  assertEquals(items.map((i) => i.kcal), [200, 70]);
  assertEquals(items.map((i) => i.grams), [120, 10]);
});

Deno.test("fast mode still streams rows, then the fill", async () => {
  const events: ParseProgress[] = [];
  await runParseMeal(stub([], events), INPUT);
  assertEquals(events.map((e) => e.kind), ["items", "fill"]);
});

Deno.test("Thorough still searches the catalog", async () => {
  // The decision is Quick's alone. A Thorough parse with no mode must keep
  // resolving against the catalog; this stub's model reply is not a valid
  // extract, so only the absence of lookups would be a regression here.
  const lookups: string[] = [];
  await runParseMeal(stub(lookups), { ...INPUT, mode: null }).catch(() => null);
  assertEquals(lookups.some((l) => l.startsWith("search:")), true);
});

Deno.test("a stated gram or ml amount is the amount the line shows", async () => {
  // est_total_g is the model's own weight guess and it drifts: the eval logged
  // "500 ml" of milk as 515 g once the catalog stopped supplying the weight.
  // When the user typed the amount there is nothing to guess.
  const deps = stub([]);
  deps.fetchFn = (async () =>
    new Response(JSON.stringify({
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{
        type: "tool_use", name: "estimate_meal",
        input: {
          declined: false, meal_type_from_text: null,
          items: [
            { ...EST_ITEMS[0], name: "milk", quantity: 500, unit: "ml", est_kcal: 310, est_protein_g: 16, est_carb_g: 24, est_fat_g: 16, est_total_g: 515 },
            { ...EST_ITEMS[0], name: "oats", quantity: 40, unit: "gm", est_kcal: 150, est_protein_g: 5, est_carb_g: 27, est_fat_g: 3, est_total_g: 45 },
            { ...EST_ITEMS[0], name: "roti", quantity: 2, unit: "piece", est_kcal: 220, est_protein_g: 7, est_carb_g: 40, est_fat_g: 4, est_total_g: 80 },
          ],
        },
      }],
    }), { status: 200 })) as typeof fetch;
  const items = (await runParseMeal(deps, INPUT)).parsed!.items;
  assertEquals(items.map((i) => i.grams), [500, 40, 80]);
  // The calories are still the model's: only the weight label is pinned.
  assertEquals(items.map((i) => i.kcal), [310, 150, 220]);
});
