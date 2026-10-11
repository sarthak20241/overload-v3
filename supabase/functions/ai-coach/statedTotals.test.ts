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
//     correction recomputed from the old row and never read the user's number.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { honourLineTotals, readStatedTotal, splitTotal, statedLineTotal } from "./statedNumbers.ts";
import { type ParseMealDeps, type ParsedItem, runParseMeal, scopeCorrection } from "./parseMeal.ts";

// ── The arithmetic ──────────────────────────────────────────────────────────

const DINNER_LINES = { kcal: 905, protein_g: 50.4, carb_g: 100.7, fat_g: 33.1, fiber_g: null };

Deno.test("a meal total keeps every number the user gave and fits the rest to their kcal", () => {
  const l = honourLineTotals(DINNER_LINES, { kcal: 500, protein_g: 12, carb_g: null, fat_g: null, fiber_g: null });
  assertEquals(l.kcal, 500);
  assertEquals(l.protein_g, 12);
  // "Rest fats and carbs": the 452 kcal left, split the way the lines had it.
  const atwater = 4 * l.protein_g + 4 * l.carb_g + 9 * l.fat_g;
  assert(Math.abs(atwater - 500) < 2, `adds up: ${atwater}`);
  assert(l.carb_g > 60 && l.carb_g < 70, `carbs ${l.carb_g}`);
});

Deno.test("with no kcal given, the kcal moves by the macros the user changed", () => {
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

Deno.test("a total past any meal is a misread, not the user's meal", () => {
  assertEquals(readStatedTotal({ kcal: 25000 }), null);
  assertEquals(readStatedTotal({ kcal: null, protein_g: null }), null);
  assertEquals(readStatedTotal({ kcal: 500, protein_g: 12 })?.protein_g, 12);
});

Deno.test("a correction line carrying the user's numbers is never restored as unchanged", () => {
  const prev = [{ food_id: "usda-apple", food_name: "apple", quantity: 145, serving_label: "g", grams: 145 }];
  const it = { name: "apple", brand: null, quantity: 145, unit: "g", prep: null, correctsFoodName: null, meal: null, est: null, savedMeal: null };
  const plain = scopeCorrection([it, { ...it, name: "banana" }] as never, prev, new Set());
  const stated = scopeCorrection([{ ...it, stated: { basis: "total", serving_g: null, kcal: 90, protein_g: null, carb_g: null, fat_g: null, fiber_g: null } }, { ...it, name: "banana" }] as never, prev, new Set());
  assertEquals(plain.toResolve.map((x) => x.name), ["banana"]);
  assertEquals(stated.toResolve.map((x) => x.name), ["apple", "banana"]);
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

const sum = (items: ParsedItem[], k: "kcal" | "protein_g" | "carb_g" | "fat_g") => Math.round(items.reduce((a, i) => a + i[k], 0) * 10) / 10;

function assertUserDinner(items: ParsedItem[]) {
  // Every food stays its own line; together they are the user's total.
  assertEquals(items.length, 5, JSON.stringify(items.map((i) => [i.food_name, i.kcal])));
  assertEquals(sum(items, "kcal"), 500);
  assertEquals(sum(items, "protein_g"), 12);
  for (const it of items) {
    // Our arithmetic, not the user's numbers: the lowest trust.
    assertEquals([it.source, it.numbers_tier], ["estimate", "fast"]);
    assertEquals(it.assumption, "Scaled to fit your meal total: 500 kcal, 12 g protein");
  }
  // Grams follow the calories, so each food keeps a believable density.
  const poha = items.find((i) => /poha/i.test(i.food_name))!;
  assert(poha.grams < 258 && poha.grams > 100, String(poha.grams));
}

Deno.test("the failure this prevents: a meal total in Thorough logged as 905 kcal and 50 g protein", async () => {
  const r = await runParseMeal(
    mealDeps({ declined: false, meal_type_from_text: "dinner", stated_meal_total: MEAL_TOTAL, items: DINNER_ITEMS }, DINNER_DECIDE),
    { ...BASE, text: DINNER_TEXT, mode: null },
  );
  assertUserDinner(r.parsed!.items);
  // The sentence is rebuilt from the user's numbers, not decide's 50 g.
  assert(!r.parsed!.drona_line.includes("50g"), r.parsed!.drona_line);
});

Deno.test("a meal total holds in Quick too", async () => {
  const r = await runParseMeal(
    mealDeps({ declined: false, meal_type_from_text: "dinner", stated_meal_total: MEAL_TOTAL, items: DINNER_ITEMS }, []),
    { ...BASE, text: DINNER_TEXT, mode: "fast" },
  );
  assertUserDinner(r.parsed!.items);
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

Deno.test("the failure this prevents: a correction with the user's number came back with the old row's", async () => {
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

Deno.test("a meal total over lines in different meals still adds up, each line keeping its meal", async () => {
  const r = await runParseMeal(
    mealDeps({
      declined: false, meal_type_from_text: null, stated_meal_total: { kcal: 300 },
      items: [{ ...est("eggs", 150, 12, 1, 10, 100), meal: "breakfast" }, { ...est("dal", 250, 12, 30, 8, 200), meal: "dinner" }],
    }, []),
    { ...BASE, text: "2 eggs for breakfast and dal for dinner, 300 kcal", mode: "fast" },
  );
  const items = r.parsed!.items;
  assertEquals(items.map((i) => i.meal_type), ["breakfast", "dinner"]);
  assertEquals(sum(items, "kcal"), 300);
});

const PANEER_TEXT = "67g milky mist paneer (per 100g 190 kcal, 25g protein, 6.7g carbs, 7g fat), roti and sabzi, 300 kcal total";
const PANEER_ITEMS = [
  { ...est("paneer", 130, 17, 4, 5, 67), quantity: 67, unit: "g", stated: { basis: "per_100g", kcal: 190, protein_g: 25, carb_g: 6.7, fat_g: 7 } },
  est("roti", 120, 3, 18, 3.6, 40), est("sabzi", 90, 2, 8, 5, 100),
];

Deno.test("a meal total keeps the user's own lines and splits what is left", async () => {
  // Paneer from the user's label (67 g x 190/100 = 127 kcal); the roti and
  // sabzi share the other 173 kcal, each still its own line.
  const r = await runParseMeal(
    mealDeps({ declined: false, meal_type_from_text: "lunch", stated_meal_total: { kcal: 300 }, items: PANEER_ITEMS }, []),
    { ...BASE, text: PANEER_TEXT, mode: "fast" },
  );
  const items = r.parsed!.items;
  assertEquals(items.length, 3);
  assertEquals(sum(items, "kcal"), 300);
  assertEquals(items[0].assumption, "Your numbers: 190 kcal per 100 g");
  assertEquals(Math.round(items[0].kcal), 127);
});

Deno.test("the total still wins when the user's own lines already exceed it", async () => {
  // Paneer alone is 127; a 100 kcal total used to be skipped. Now every line
  // shares the 100.
  const r = await runParseMeal(
    mealDeps({ declined: false, meal_type_from_text: "lunch", stated_meal_total: { kcal: 100 }, items: PANEER_ITEMS }, []),
    { ...BASE, text: PANEER_TEXT.replace("300", "100"), mode: "fast" },
  );
  const items = r.parsed!.items;
  assertEquals(items.length, 3);
  assertEquals(sum(items, "kcal"), 100);
});

Deno.test("the failure this prevents: a meal total on a correction merged the card's foods into one line", async () => {
  // The restored lines used to be folded into one combined line.
  const prev = [
    { ...line("eggs", 155, 13, 1, 11, 100), source: "catalog" as const, confidence: "high" as const, meal_type: "breakfast" as const },
    { ...line("toast", 80, 3, 15, 1, 30), source: "catalog" as const, confidence: "high" as const, meal_type: "breakfast" as const },
    { ...line("orange juice", 110, 2, 26, 0.5, 250), source: "catalog" as const, confidence: "high" as const, meal_type: "breakfast" as const },
  ];
  const copy = (n: string, k: number, p: number, c: number, f: number, g: number) => ({ ...est(n, k, p, c, f, g), corrects_food_name: null });
  const r = await runParseMeal(
    mealDeps({
      declined: false, corrects_previous: true, meal_type_from_text: null, stated_meal_total: { kcal: 400 },
      items: [copy("eggs", 155, 13, 1, 11, 100), copy("toast", 80, 3, 15, 1, 30), copy("orange juice", 110, 2, 26, 0.5, 250)],
    }, prev),
    { ...BASE, text: "make the whole meal 400 kcal", mode: "fast", previousText: "2 eggs, toast and orange juice", previousItems: prev },
  );
  const items = r.parsed!.items;
  assertEquals(items.map((i) => i.food_name), ["eggs", "toast", "orange juice"]);
  assertEquals(sum(items, "kcal"), 400);
});

Deno.test("the failure this prevents: a total-only correction looked every food up again", async () => {
  // Real model, 2026-10-11: "make the whole meal 400 kcal" changed no food, yet
  // every line was searched again and "toast" came back as Toaster pastries.
  const prev = [
    { ...line("boiled eggs", 155, 13, 1, 11, 100), source: "estimate" as const, confidence: "medium" as const, meal_type: "breakfast" as const },
    { ...line("toast", 80, 3, 15, 1, 30), source: "estimate" as const, confidence: "medium" as const, meal_type: "breakfast" as const },
    { ...line("orange juice", 110, 2, 26, 0.5, 250), source: "estimate" as const, confidence: "medium" as const, meal_type: "breakfast" as const },
  ];
  const copy = (n: string, k: number, p: number, c: number, f: number, g: number) => ({ ...est(n, k, p, c, f, g), corrects_food_name: null });
  const searched: string[] = [];
  const r = await runParseMeal(
    mealDeps({
      declined: false, corrects_previous: true, meal_type_from_text: null, stated_meal_total: { kcal: 400 },
      items: [copy("boiled eggs", 155, 13, 1, 11, 100), copy("toast", 80, 3, 15, 1, 30), copy("orange juice", 110, 2, 26, 0.5, 250)],
    }, [line("Toaster pastries, brown-sugar-cinnamon", 410, 4, 70, 12, 100)], {
      searchFoods: async (q: string) => { searched.push(q); return []; },
    }),
    { ...BASE, text: "make the whole meal 400 kcal", mode: "fast", previousText: "2 boiled eggs, 1 toast and a glass of orange juice", previousItems: prev },
  );
  assertEquals(searched, []);
  const items = r.parsed!.items;
  assertEquals(items.map((i) => i.food_name), ["boiled eggs", "toast", "orange juice"]);
  assertEquals(items.map((i) => i.meal_type), ["breakfast", "breakfast", "breakfast"]);
  assertEquals(sum(items, "kcal"), 400);
  assert(r.steps.some((s) => s.tool === "meal_total_correction"));
});

Deno.test("the failure this prevents: a reworded name on a total-only correction was looked up as a new food", async () => {
  // Real model, 2026-10-11: the card said "toast", the model wrote "Toasted
  // Bread" back with no change marked, so it matched nothing on the card.
  const prev = [
    { ...line("boiled eggs", 155, 13, 1, 11, 100), source: "estimate" as const, confidence: "medium" as const, meal_type: "breakfast" as const },
    { ...line("toast", 80, 3, 15, 1, 30), source: "estimate" as const, confidence: "medium" as const, meal_type: "breakfast" as const },
    { ...line("orange juice", 110, 2, 26, 0.5, 250), source: "estimate" as const, confidence: "medium" as const, meal_type: "breakfast" as const },
  ];
  const copy = (n: string, k: number, p: number, c: number, f: number, g: number) => ({ ...est(n, k, p, c, f, g), corrects_food_name: null });
  const searched: string[] = [];
  const run = (items: unknown[]) => runParseMeal(
    mealDeps({ declined: false, corrects_previous: true, meal_type_from_text: null, stated_meal_total: { kcal: 400 }, items },
      [line("Toaster pastries, brown-sugar-cinnamon", 410, 4, 70, 12, 100)], {
        searchFoods: async (q: string) => { searched.push(q); return []; },
      }),
    { ...BASE, text: "make the whole meal 400 kcal", mode: "fast", previousText: "2 boiled eggs, 1 toast and a glass of orange juice", previousItems: prev },
  );
  const r = await run([copy("Boiled Egg", 155, 13, 1, 11, 100), copy("Toasted Bread", 80, 3, 15, 1, 30), copy("Orange Juice", 110, 2, 26, 0.5, 250)]);
  assertEquals(searched, []);
  assertEquals(r.parsed!.items.map((i) => i.food_name), ["boiled eggs", "toast", "orange juice"]);
  assertEquals(sum(r.parsed!.items, "kcal"), 400);
  // A food added in the same message changes the count: it is not swallowed.
  const added = await run([copy("boiled eggs", 155, 13, 1, 11, 100), copy("toast", 80, 3, 15, 1, 30), copy("orange juice", 110, 2, 26, 0.5, 250), copy("banana", 105, 1, 27, 0.4, 118)]);
  assert(added.parsed!.items.some((i) => /banana/i.test(i.food_name)), JSON.stringify(added.parsed!.items.map((i) => i.food_name)));
});

Deno.test("a meal total counts a saved meal the user named, and the rest fits", async () => {
  // PR #236 review: saved lines joined the card after the total, so "my oat
  // bowl and a banana, 500 kcal" came to 400 + 500.
  const saved = {
    id: "saved-bowl", name: "My oat bowl", kind: "meal" as const, servings: 1, serving_label: null,
    kcal: 400, protein_g: 25, carb_g: 50, fat_g: 11, fiber_g: 8,
    items: [{ food_id: null, food_name: "oats", quantity: 100, serving_unit: "g", grams: 100, kcal: 400, protein_g: 25, carb_g: 50, fat_g: 11, fiber_g: 8 }],
  };
  const r = await runParseMeal(
    mealDeps({
      declined: false, meal_type_from_text: "snack", stated_meal_total: { kcal: 500 },
      items: [
        { name: "My oat bowl", saved_meal: "My oat bowl", quantity: 1, unit: "serving", prep: null, brand: null },
        est("banana", 105, 1.3, 27, 0.4, 118),
      ],
    }, []),
    { ...BASE, text: "my oat bowl and a banana, 500 kcal", mode: "fast", savedMeals: Promise.resolve([saved]) },
  );
  const items = r.parsed!.items;
  assertEquals(sum(items, "kcal"), 500);
  assertEquals(items.find((i) => i.food_name === "oats")!.kcal, 400);
  assertEquals(items.find((i) => /banana/.test(i.food_name))!.kcal, 100);
});

Deno.test("a meal total far below the estimate never rounds a food away", async () => {
  // 5 kcal over a 2000 kcal guess: every portion shrinks to 1/400 or less,
  // which rounds to 0 servings and 0 g without a floor.
  const r = await runParseMeal(
    mealDeps({
      declined: false, meal_type_from_text: "snack", stated_meal_total: { kcal: 5 },
      items: [est("cake", 2000, 20, 250, 100, 500), est("mint", 10, 0, 2.5, 0, 2)],
    }, []),
    { ...BASE, text: "cake and a mint, 5 kcal total", mode: "fast" },
  );
  const items = r.parsed!.items;
  assertEquals(items.length, 2);
  for (const it of items) {
    assert(it.quantity > 0 && it.grams > 0, JSON.stringify([it.food_name, it.quantity, it.grams]));
    // The steps are the card's own: two decimals of a serving, one of a gram.
    assertEquals(it.quantity, Math.round(it.quantity * 100) / 100);
    assertEquals(it.grams, Math.round(it.grams * 10) / 10);
  }
  // Portions still follow the kcal where there is room to.
  assertEquals(items[0].grams, 1.3); // 500 g x 5/2000
});

Deno.test("fiber moves with the carbs it is part of and never exceeds them", () => {
  const [salad] = splitTotal([{ kcal: 13, protein_g: 1, carb_g: 1.6, fat_g: 0.4, fiber_g: 1.5 }, { kcal: 892, protein_g: 49, carb_g: 99, fat_g: 32.7, fiber_g: 5 }],
    { kcal: 500, protein_g: 12, carb_g: null, fat_g: null, fiber_g: null });
  assert(salad.line.fiber_g! <= salad.line.carb_g, JSON.stringify(salad.line));
  assert(salad.line.fiber_g! < 1.5);
});

Deno.test("a line total is not lost because another food's name has no Latin letters", async () => {
  // A name in another script cleans to an empty key, which "contained" every
  // line and left the user's roti total matching two lines.
  const r = await runParseMeal(
    mealDeps({
      declined: false, meal_type_from_text: "lunch",
      items: [est("पनीर", 130, 17, 4, 5, 67), { ...est("roti", 120, 3, 18, 3.6, 40), stated: { basis: "total", kcal: 90 } }],
    }, []),
    { ...BASE, text: "पनीर and 1 roti (90 kcal)", mode: "fast" },
  );
  assertEquals(r.parsed!.items.find((i) => i.food_name === "roti")!.kcal, 90);
});

Deno.test("a number too big to be a meal is traced when it is ignored", async () => {
  const r = await runParseMeal(
    mealDeps({ declined: false, meal_type_from_text: "lunch", stated_meal_total: { kcal: 25000 }, items: [est("roti", 120, 3, 18, 3.6, 40)] }, []),
    { ...BASE, text: "1 roti, 25000 kcal", mode: "fast" },
  );
  assertEquals(r.parsed!.items[0].kcal, 120);
  const step = r.steps.find((st) => st.tool === "user_stated_total");
  assert(JSON.stringify(step?.result ?? "").includes("meal total past"), JSON.stringify(step));
});

Deno.test("the user's own numbers for a food beat that food in their memory", async () => {
  // Memory knows paneer at 150 kcal per 100 g; the user says this bowl was 127.
  const jevFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "score", probabilities: { "0": 0.01, "1": 0.01, "2": 0.98 } }]));
    return Response.json({ answers });
  }) as typeof fetch;
  const remembered = {
    food_name: "paneer", food_id: null, kcal: 150, protein_g: 18, carb_g: 4, fat_g: 7, fiber_g: null, grams: 100, quantity: 1,
    serving_unit: "bowl", source: "catalog", logged_via: "ai", tier: "precise", logged_at: new Date(Date.now() - 86_400_000).toISOString(),
  };
  const r = await runParseMeal(
    mealDeps(
      { declined: false, meal_type_from_text: "lunch", items: [{ ...est("paneer", 150, 18, 4, 7, 100), unit: "bowl", stated: { basis: "total", kcal: 127 } }] },
      [],
      { jev: { apiKey: "k", timeoutMs: 1000, fetchFn: jevFetch }, userMemory: { load: () => Promise.resolve({ entries: [remembered], timeZone: null }) } },
    ),
    { ...BASE, text: "1 bowl paneer, 127 kcal", mode: "fast" },
  );
  const it = r.parsed!.items[0];
  assertEquals([it.kcal, it.source], [127, "manual"]);
});
