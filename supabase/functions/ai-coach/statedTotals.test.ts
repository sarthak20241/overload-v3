// Run with: deno test --allow-all supabase/functions/ai-coach/statedTotals.test.ts
//
// Totals the user writes win in every tier (owner decision 2026-09-29). The
// cases that drove it, all from one real user:
//   - "Add roughly 500 cal for dinner having 12g protein rest fats and carbs
//     (i had chicken curry, poha, rice, salad and watermelon)" logged 905 kcal
//     and 50 g protein in Precise: the numbers were for the meal, not a food.
//   - "Track daliya in lunch (roughly 80 cal, most carbs and rest fat, 1g
//     protein)": a line total with no weight, which nothing read.
//   - "No, 145g apple should be 90 cals" came back 75 kcal: the fast
//     correction recomputed from the old row and never read her number.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { honourLineTotals, readStatedTotal, statedLineTotal } from "./statedNumbers.ts";
import { type ParseMealDeps, type ParsedItem, runParseMeal, scopeCorrection } from "./parseMeal.ts";

// ── The arithmetic ──────────────────────────────────────────────────────────

const DINNER_LINES = { kcal: 905, protein_g: 50.4, carb_g: 100.7, fat_g: 33.1, fiber_g: null };

Deno.test("a meal total keeps every number she gave and fits the rest to her kcal", () => {
  const l = honourLineTotals(DINNER_LINES, { kcal: 500, protein_g: 12, carb_g: null, fat_g: null, fiber_g: null });
  assertEquals(l.kcal, 500);
  assertEquals(l.protein_g, 12);
  // "Rest fats and carbs": the 452 kcal left, split the way the lines had it.
  const atwater = 4 * l.protein_g + 4 * l.carb_g + 9 * l.fat_g;
  assert(Math.abs(atwater - 500) < 2, `adds up: ${atwater}`);
  assert(l.carb_g > 60 && l.carb_g < 70, `carbs ${l.carb_g}`);
});

Deno.test("with no kcal given, the kcal moves by the macros she changed", () => {
  const l = honourLineTotals({ kcal: 100, protein_g: 5, carb_g: 10, fat_g: 4, fiber_g: null }, { kcal: null, protein_g: 10, carb_g: null, fat_g: null, fiber_g: null });
  assertEquals(l.protein_g, 10);
  assertEquals(l.kcal, 120);
});

Deno.test("a line total with no weight is a line total; a typed weight is left to per-100", () => {
  assertEquals(statedLineTotal({ basis: "total", serving_g: null, kcal: 80, protein_g: 1, carb_g: null, fat_g: null, fiber_g: null }, 1, false)?.kcal, 80);
  assertEquals(statedLineTotal({ basis: "total", serving_g: null, kcal: 90, protein_g: null, carb_g: null, fat_g: null, fiber_g: null }, 145, true), null);
  // "2 scoops, 120 kcal and 24 g protein a scoop", no scoop weight.
  const two = statedLineTotal({ basis: "per_serving", serving_g: null, kcal: 120, protein_g: 24, carb_g: null, fat_g: null, fiber_g: null }, 2, false);
  assertEquals([two?.kcal, two?.protein_g], [240, 48]);
});

Deno.test("a total past any meal is a misread, not her meal", () => {
  assertEquals(readStatedTotal({ kcal: 25000 }), null);
  assertEquals(readStatedTotal({ kcal: null, protein_g: null }), null);
  assertEquals(readStatedTotal({ kcal: 500, protein_g: 12 })?.protein_g, 12);
});

Deno.test("a correction line carrying her numbers is never restored as unchanged", () => {
  const prev = [{ food_id: "usda-apple", food_name: "apple", quantity: 145, serving_label: "g", grams: 145 }];
  const it = { name: "apple", brand: null, quantity: 145, unit: "g", prep: null, correctsFoodName: null, meal: null, est: null, savedMeal: null };
  const plain = scopeCorrection([it, { ...it, name: "banana" }] as never, prev, new Set());
  const hers = scopeCorrection([{ ...it, stated: { basis: "total", serving_g: null, kcal: 90, protein_g: null, carb_g: null, fat_g: null, fiber_g: null } }, { ...it, name: "banana" }] as never, prev, new Set());
  assertEquals(plain.toResolve.map((x) => x.name), ["banana"]);
  assertEquals(hers.toResolve.map((x) => x.name), ["apple", "banana"]);
});

// ── End to end ──────────────────────────────────────────────────────────────

const BASE = { localHour: 21, mealHint: null, recentFoods: [], todayTotals: null, targets: null };
const EST0 = { label_applies: false, label_serving_g: null, label_serving_kcal: null, label_pieces_per_serving: null };

/** A mock model: extract/estimate return `ext`; decide returns `decide`. */
function mealDeps(ext: Record<string, unknown>, decide: Record<string, unknown>[], extra: Partial<ParseMealDeps> = {}): ParseMealDeps {
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const name: string = (body.tools ?? [])[0]?.name ?? "";
    if (name === "estimate_meal" || name === "extract_meal") {
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name, input: ext }] });
    }
    if (name === "report_sources" || name === "report_page_panels" || name === "report_labels") {
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name, input: { results: [], pages: [] } }] });
    }
    // food_id "pick": the first candidate decide is shown, as a real decide would.
    const shown = /"food_id\\?":\\?"([^"\\]+)/.exec(JSON.stringify(body.messages ?? []))?.[1] ?? null;
    const items = decide.map((d) => (d.food_id === "pick" ? { ...d, food_id: shown } : d));
    return Response.json({
      stop_reason: "tool_use", usage: {},
      content: [{ type: "tool_use", name, input: { meal_type: "dinner", drona_line: "50g protein in there. That is how you build.", items } }],
    });
  }) as typeof fetch;
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: async () => [],
    backfillOffFood: async () => null,
    getFoodPer100: async () => null,
    fetchFn,
    ...extra,
  };
}

const est = (name: string, kcal: number, p: number, c: number, f: number, g: number) => ({
  name, brand: null, quantity: 1, unit: "serving", prep: null, ...EST0,
  est_kcal: kcal, est_protein_g: p, est_carb_g: c, est_fat_g: f, est_total_g: g,
});
const line = (food_name: string, kcal: number, protein_g: number, carb_g: number, fat_g: number, grams: number) => ({
  food_name, food_id: null, quantity: 1, serving_label: "serving", grams, kcal, protein_g, carb_g, fat_g,
  source: "estimate", confidence: "medium", assumption: null,
});

const DINNER_TEXT = "Add roughly 500 cal for dinner having 12g protein rest fats and carbs (i had chicken curry, poha, rice, salad and watermelon)";
const DINNER_ITEMS = [
  est("chicken curry", 326, 38, 5, 16.5, 212), est("poha", 410, 8.5, 60, 15, 258), est("rice", 110, 2, 22.5, 1, 65),
  est("salad", 13, 1, 1.6, 0.4, 100), est("watermelon", 46, 1, 11.6, 0.3, 152),
];
const DINNER_DECIDE = [
  line("Chicken Curry", 326, 38, 5, 16.5, 212), line("Poha", 410, 8.5, 60, 15, 258), line("Rice", 110, 2, 22.5, 1, 65),
  line("Salad, green", 13, 1, 1.6, 0.4, 100), line("Watermelon, raw", 46, 1, 11.6, 0.3, 152),
];
const MEAL_TOTAL = { kcal: 500, protein_g: 12, carb_g: null, fat_g: null, fiber_g: null };

function assertHerDinner(items: ParsedItem[]) {
  assertEquals(items.length, 1, JSON.stringify(items.map((i) => [i.food_name, i.kcal])));
  const it = items[0];
  assertEquals(it.kcal, 500);
  assertEquals(it.protein_g, 12);
  assertEquals(it.source, "manual");
  assertEquals(it.numbers_tier, "precise");
  assertEquals(it.assumption, "Your numbers: 500 kcal, 12 g protein for the meal, the rest estimated");
  assert(it.food_name.startsWith("Chicken"), it.food_name);
}

Deno.test("the failure this prevents: a meal total in Thorough logged as 905 kcal and 50 g protein", async () => {
  const r = await runParseMeal(
    mealDeps({ declined: false, meal_type_from_text: "dinner", stated_meal_total: MEAL_TOTAL, items: DINNER_ITEMS }, DINNER_DECIDE),
    { ...BASE, text: DINNER_TEXT, mode: null },
  );
  assertHerDinner(r.parsed!.items);
  // The sentence is rebuilt from her numbers, not decide's 50 g.
  assert(!r.parsed!.drona_line.includes("50g"), r.parsed!.drona_line);
});

Deno.test("a meal total holds in Quick too", async () => {
  const r = await runParseMeal(
    mealDeps({ declined: false, meal_type_from_text: "dinner", stated_meal_total: MEAL_TOTAL, items: DINNER_ITEMS }, []),
    { ...BASE, text: DINNER_TEXT, mode: "fast" },
  );
  assertHerDinner(r.parsed!.items);
});

Deno.test("a line total with no weight answers the line in Quick", async () => {
  const r = await runParseMeal(
    mealDeps({
      declined: false, meal_type_from_text: "lunch",
      items: [{ ...est("daliya", 150, 5, 27, 2.5, 150), stated: { basis: "total", kcal: 80, protein_g: 1 } }],
    }, []),
    { ...BASE, text: "Track daliya in lunch (roughly 80 cal, most carbs and rest fat, 1g protein)", mode: "fast" },
  );
  const it = r.parsed!.items[0];
  assertEquals([it.kcal, it.protein_g, it.source], [80, 1, "manual"]);
  assertEquals(it.assumption, "Your numbers: 80 kcal, 1 g protein for this line, the rest estimated");
});

Deno.test("a line total with no weight answers the line in Thorough", async () => {
  const r = await runParseMeal(
    mealDeps({
      declined: false, meal_type_from_text: "dinner",
      items: [{ name: "protein bar", brand: null, quantity: 1, unit: "bar", prep: null, stated: { basis: "total", kcal: 200, protein_g: 20 } }],
    }, [line("Protein bar", 250, 15, 25, 9, 60)]),
    { ...BASE, text: "1 protein bar, 200 kcal and 20 g protein", mode: null },
  );
  const it = r.parsed!.items[0];
  assertEquals([it.kcal, it.protein_g, it.source], [200, 20, "manual"]);
});

Deno.test("the failure this prevents: a correction with her number came back with the old row's", async () => {
  const prev = [{
    food_id: "usda-apple", food_name: "apple", quantity: 145, serving_label: "g", grams: 145,
    kcal: 75.4, protein_g: 0.4, carb_g: 20, fat_g: 0.3, fiber_g: null, source: "catalog" as const, meal_type: "snack" as const,
  }];
  const apple = { food_id: "usda-apple", name: "apple", brand: null, base_unit: "g" as const, kcal: 52, protein_g: 0.3, carb_g: 13.8, fat_g: 0.2, fiber_g: 2.4, servings: [], source: "catalog" as const };
  const r = await runParseMeal(
    mealDeps(
      {
        declined: false, corrects_previous: true, meal_type_from_text: null,
        items: [{ name: "apple", brand: null, quantity: 145, unit: "g", prep: null, corrects_food_name: "apple", stated: { basis: "total", kcal: 90 } }],
      },
      [{ ...line("apple", 75.4, 0.4, 20, 0.3, 145), food_id: "pick", quantity: 145, serving_label: "g", source: "catalog" }],
      { getFoodPer100: async () => apple, searchFoods: async () => [apple] },
    ),
    { ...BASE, text: "No, 145g apple should be 90 cals", mode: null, previousText: "145g apple for snacks", previousItems: prev },
  );
  const it = r.parsed!.items.find((i) => /apple/i.test(i.food_name))!;
  assertEquals(Math.round(it.kcal), 90);
  assert(!r.tool_calls.includes("fast_correction"), JSON.stringify(r.tool_calls));
});

Deno.test("a meal total over lines in different meals is not forced onto them", async () => {
  const r = await runParseMeal(
    mealDeps({
      declined: false, meal_type_from_text: null, stated_meal_total: { kcal: 300 },
      items: [{ ...est("eggs", 150, 12, 1, 10, 100), meal: "breakfast" }, { ...est("dal", 250, 12, 30, 8, 200), meal: "dinner" }],
    }, []),
    { ...BASE, text: "2 eggs for breakfast and dal for dinner, 300 kcal", mode: "fast" },
  );
  assertEquals(r.parsed!.items.length, 2);
  assert(r.steps.some((s) => s.tool === "user_stated_total" && (s.result as { reason?: string } | null)?.reason === "the lines span several meals"));
});

Deno.test("a meal total counts the lines that already carry her own numbers", async () => {
  // Paneer from her label (a full panel, 67 g x 190/100 = 127 kcal), then
  // 300 kcal for the whole plate: the roti and sabzi share what is left.
  const r = await runParseMeal(
    mealDeps({
      declined: false, meal_type_from_text: "lunch", stated_meal_total: { kcal: 300 },
      items: [
        { ...est("paneer", 130, 17, 4, 5, 67), quantity: 67, unit: "g", stated: { basis: "per_100g", kcal: 190, protein_g: 25, carb_g: 6.7, fat_g: 7 } },
        est("roti", 120, 3, 18, 3.6, 40), est("sabzi", 90, 2, 8, 5, 100),
      ],
    }, []),
    { ...BASE, text: "67g milky mist paneer (per 100g 190 kcal, 25g protein, 6.7g carbs, 7g fat), roti and sabzi, 300 kcal total", mode: "fast" },
  );
  const items = r.parsed!.items;
  assertEquals(items.length, 2);
  assertEquals(Math.round(items.reduce((a, i) => a + i.kcal, 0)), 300);
  assertEquals(items[0].assumption, "Your numbers: 190 kcal per 100 g");
});
