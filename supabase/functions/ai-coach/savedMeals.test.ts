// Run with: deno test --allow-all supabase/functions/ai-coach/savedMeals.test.ts
//
// A saved meal the user names is logged from ITS rows. Seen live 2026-09-22:
// "Oats with milk" was saved (48 g oats + 550 ml milk, 550 kcal), then "log the
// oat meal" came back as a 150 kcal estimate of plain oatmeal. These tests pin
// that the saved rows win, in every mode, and that nothing else is consulted.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type ParseMealDeps, runParseMeal } from "./parseMeal.ts";
import {
  findSavedMeal,
  mergeSavedLines,
  savedCount,
  savedMealLines,
  savedMealsBlock,
  type SavedMealForParse,
} from "./savedMeals.ts";

const OATS: SavedMealForParse = {
  id: "sm-oats", name: "Oats with milk", kind: "meal", servings: 1, serving_label: null,
  kcal: 550, protein_g: 25, carb_g: 60, fat_g: 20,
  items: [
    { food_id: "f-oats", food_name: "oats", quantity: 48, serving_unit: "g", grams: 48, kcal: 180, protein_g: 6, carb_g: 32, fat_g: 3, fiber_g: 5 },
    { food_id: "f-milk", food_name: "milk", quantity: 550, serving_unit: "ml", grams: 550, kcal: 370, protein_g: 19, carb_g: 28, fat_g: 17, fiber_g: null },
  ],
};

const DAL: SavedMealForParse = {
  id: "sm-dal", name: "Amma's dal", kind: "recipe", servings: 4, serving_label: "katori",
  kcal: 800, protein_g: 48, carb_g: 120, fat_g: 16, items: [],
};

// ── pure helpers ────────────────────────────────────────────────────────────

Deno.test("no saved meals, no block: the prompt is unchanged", () => {
  assertEquals(savedMealsBlock([]), "");
});

Deno.test("the block names each saved meal and says it is not food eaten", () => {
  const b = savedMealsBlock([OATS, DAL]);
  assert(b.includes('"Oats with milk" (oats, milk; 550 kcal)'));
  assert(b.includes('"Amma\'s dal" (recipe, 4 servings; 800 kcal)'));
  assert(b.includes("NOT food they ate"));
});

Deno.test("a reference matches only the exact saved name, case forgiven", () => {
  assertEquals(findSavedMeal("oats WITH milk ", [OATS])?.id, "sm-oats");
  assertEquals(findSavedMeal("oats", [OATS]), null);
  assertEquals(findSavedMeal(null, [OATS]), null);
  assertEquals(findSavedMeal("", [OATS]), null);
});

Deno.test("count: servings as given, a weight is one serving, capped at 10", () => {
  assertEquals(savedCount(2, "bowl"), 2);
  assertEquals(savedCount(200, "g"), 1);
  assertEquals(savedCount(0, "serving"), 1);
  assertEquals(savedCount(50, "serving"), 10);
  assertEquals(savedCount(undefined, undefined), 1);
});

Deno.test("a meal logs its own rows, times the count", () => {
  const lines = savedMealLines({ meal: OATS, count: 2, mealType: null });
  assertEquals(lines.map((l) => l.food_name), ["oats", "milk"]);
  assertEquals(lines.map((l) => l.kcal), [360, 740]);
  assertEquals(lines.map((l) => l.grams), [96, 1100]);
  assertEquals(lines.map((l) => l.food_id), ["f-oats", "f-milk"]);
  assertEquals(lines.every((l) => l.source === "manual" && l.confidence === "high"), true);
});

Deno.test("a recipe logs one line at count / yield of the batch", () => {
  const [l] = savedMealLines({ meal: DAL, count: 1, mealType: null });
  assertEquals(l.food_name, "Amma's dal");
  assertEquals(l.kcal, 200);
  assertEquals(l.protein_g, 12);
  assertEquals(l.serving_label, "katori");
});

Deno.test("merge: a decline becomes the saved meal, not a lost log", () => {
  const declined: Parameters<typeof mergeSavedLines>[0] = { parsed: null, declined: { message: "not food" } };
  const r = mergeSavedLines(
    declined,
    [{ meal: OATS, count: 1, mealType: null }],
    "breakfast",
  );
  assertEquals(r.declined, null);
  assertEquals(r.parsed!.items.map((i) => (i as { food_name: string }).food_name), ["oats", "milk"]);
  assertEquals(r.parsed!.meal_type, "breakfast");
});

// ── the pipeline ────────────────────────────────────────────────────────────

/** A model that tags the first item as the saved meal. Every lookup is counted
 *  and returns a row that WOULD win, so a saved item that still reached the
 *  catalog shows up in the lines as well as in the count. */
function stub(
  lookups: string[],
  items: Record<string, unknown>[],
  seen: string[] = [],
): ParseMealDeps {
  const hit = (s: string) => { lookups.push(s); };
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000,
    webSearchEnabled: false,
    searchFoods: async (q) => {
      hit(`search:${q}`);
      return [{
        food_id: "row-1", name: "Oatmeal, cooked", brand: null,
        base_unit: "g", kcal: 71, protein_g: 2.5, carb_g: 12, fat_g: 1.5, fiber_g: null,
        servings: [{ label: "1 cup", grams: 234, is_default: true }], source: "catalog",
      }];
    },
    searchFatSecret: async (q) => { hit(`fatsecret:${q}`); return []; },
    backfillOffFood: async () => { hit("off_backfill"); return null; },
    preciseCacheGet: async (k) => { hit(`precise:${k}`); return null; },
    getFoodPer100: async (id) => { hit(`per100:${id}`); return null; },
    getFoodServings: async (id) => { hit(`servings:${id}`); return []; },
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes("anthropic")) {
        hit(`http:${String(url).slice(0, 60)}`);
        return new Response("[]", { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      const msg = body.messages?.[0]?.content;
      if (typeof msg === "string") seen.push(msg);
      const name = body.tool_choice?.name ?? "estimate_meal";
      if (name !== "estimate_meal" && name !== "extract_meal") hit(`model:${name}`);
      return new Response(JSON.stringify({
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "tool_use", name, input: { declined: false, meal_type_from_text: null, items } }],
      }), { status: 200 });
    }) as typeof fetch,
  };
}

const OATMEAL_ITEM = {
  name: "oatmeal", brand: null, quantity: 1, unit: "serving", prep: null,
  label_applies: false, label_serving_g: null, label_serving_kcal: null, label_pieces_per_serving: null,
  est_kcal: 150, est_protein_g: 5, est_carb_g: 27, est_fat_g: 3, est_total_g: 40,
};

const INPUT = {
  text: "Can you log the oat meal to breakfast", localHour: 8, mealHint: null,
  recentFoods: [], todayTotals: null, targets: null,
};

for (const mode of ["fast", "super", null] as const) {
  Deno.test(`${mode ?? "smart"}: a named saved meal logs its rows and looks nothing up`, async () => {
    const lookups: string[] = [];
    const r = await runParseMeal(
      stub(lookups, [{ ...OATMEAL_ITEM, saved_meal: "Oats with milk" }]),
      { ...INPUT, mode, savedMeals: Promise.resolve([OATS]) },
    );
    assertEquals(lookups, []);
    assertEquals(r.parsed!.items.map((i) => [i.food_name, i.kcal, i.source]), [
      ["oats", 180, "manual"],
      ["milk", 370, "manual"],
    ]);
    assert(r.parsed!.drona_line.includes("Oats with milk"));
  });
}

Deno.test("the saved meals reach the model, below the user's words", async () => {
  const seen: string[] = [];
  await runParseMeal(stub([], [OATMEAL_ITEM], seen), { ...INPUT, mode: "fast", savedMeals: [OATS] });
  assert(seen[0].startsWith("Can you log the oat meal to breakfast\n\n<saved_meals>"));
  assert(seen[0].includes('"Oats with milk"'));
});

Deno.test("no saved meals: the model gets exactly the user's words", async () => {
  const seen: string[] = [];
  await runParseMeal(stub([], [OATMEAL_ITEM], seen), { ...INPUT, mode: "fast" });
  assertEquals(seen[0], "Can you log the oat meal to breakfast");
});

Deno.test("a saved meal plus other food: saved rows first, the rest estimated", async () => {
  const banana = { ...OATMEAL_ITEM, name: "banana", est_kcal: 155, est_total_g: 118 };
  const r = await runParseMeal(
    stub([], [{ ...OATMEAL_ITEM, saved_meal: "Oats with milk" }, banana]),
    { ...INPUT, mode: "fast", savedMeals: [OATS] },
  );
  assertEquals(r.parsed!.items.map((i) => [i.food_name, i.kcal]), [["oats", 180], ["milk", 370], ["banana", 155]]);
});

Deno.test("a tag naming no saved meal is ignored, the estimate stands", async () => {
  const r = await runParseMeal(
    stub([], [{ ...OATMEAL_ITEM, saved_meal: "Porridge" }]),
    { ...INPUT, mode: "fast", savedMeals: [OATS] },
  );
  assertEquals(r.parsed!.items.map((i) => [i.food_name, i.kcal, i.source]), [["oatmeal", 150, "estimate"]]);
});

Deno.test("a correction turn never swaps in a saved meal", async () => {
  // With a card on screen the turn edits that card; the correction paths own it.
  const seen: string[] = [];
  const r = await runParseMeal(
    stub([], [{ ...OATMEAL_ITEM, saved_meal: "Oats with milk" }], seen),
    {
      ...INPUT, mode: "fast", savedMeals: [OATS],
      previousText: "oatmeal",
      previousItems: [{ food_id: null, food_name: "oatmeal", quantity: 1, serving_label: "serving", grams: 40, kcal: 150 }],
    },
  ).catch(() => null);
  assertEquals(seen.some((m) => m.includes("<saved_meals>")), false);
  assertEquals(r?.parsed?.items.some((i) => i.food_name === "milk") ?? false, false);
});

// ── decision 1A: part of a saved meal is offered, not logged ────────────────

import { suggestSavedMeal } from "./savedMeals.ts";

Deno.test("a food inside a saved meal is offered as a swap", () => {
  assertEquals(suggestSavedMeal("oats", [OATS])?.id, "sm-oats");
  assertEquals(suggestSavedMeal("Milk", [OATS])?.id, "sm-oats");
  assertEquals(suggestSavedMeal("chicken", [OATS]), null);
  assertEquals(suggestSavedMeal("oats and honey", [OATS]), null);
});

Deno.test("an untagged food that is part of a saved meal: estimate logged, swap offered", async () => {
  const r = await runParseMeal(
    stub([], [{ ...OATMEAL_ITEM, name: "oats" }]),
    { ...INPUT, text: "oats in breakfast", mode: "fast", savedMeals: [OATS] },
  );
  assertEquals(r.parsed!.items.map((i) => [i.food_name, i.source]), [["oats", "estimate"]]);
  assertEquals(r.saved_suggestions, [{ food_name: "oats", saved_id: "sm-oats", saved_name: "Oats with milk" }]);
});

// ── scenario 2: "not from saved meals" ──────────────────────────────────────

Deno.test("rejecting the saved meal re-logs the original words without it", async () => {
  // Turn 1 of the stub is the correction extract saying rejects_saved; every
  // later call is the fresh first-shot parse of the ORIGINAL text.
  const seen: string[] = [];
  let call = 0;
  const deps = stub([], [], seen);
  const inner = deps.fetchFn!;
  deps.fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    call++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const name = body.tool_choice?.name;
    const input = call === 1
      ? { declined: false, rejects_saved: true, corrects_previous: true, items: [] }
      : { declined: false, meal_type_from_text: null, items: [OATMEAL_ITEM] };
    await inner(url, init); // keeps `seen` honest
    return new Response(JSON.stringify({
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name, input }],
    }), { status: 200 });
  }) as typeof fetch;

  const r = await runParseMeal(deps, {
    ...INPUT, text: "not from saved meals", mode: "fast", savedMeals: [OATS],
    previousText: "Can you log the oat meal to breakfast",
    previousItems: [
      { food_id: "f-oats", food_name: "oats", quantity: 48, serving_label: "g", grams: 48, kcal: 180 },
      { food_id: "f-milk", food_name: "milk", quantity: 550, serving_label: "ml", grams: 550, kcal: 370 },
    ],
  });
  assertEquals(r.parsed!.items.map((i) => [i.food_name, i.source]), [["oatmeal", "estimate"]]);
  assertEquals(r.parsed!.corrects_previous, true);
  assertEquals(seen.at(-1), "Can you log the oat meal to breakfast"); // no <saved_meals> block
});

Deno.test("joining words do not block a swap offer", () => {
  const DAL_RICE: SavedMealForParse = { ...OATS, id: "sm-dr", name: "Dal rice", items: [] };
  assertEquals(suggestSavedMeal("rice and dal", [DAL_RICE])?.id, "sm-dr");
  assertEquals(suggestSavedMeal("rice and chicken", [DAL_RICE]), null);
});

Deno.test("rejecting the saved meal keeps the cost of BOTH calls", async () => {
  let call = 0;
  const deps = stub([], []);
  deps.fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    call++;
    const name = JSON.parse(String(init?.body ?? "{}")).tool_choice?.name;
    const input = call === 1
      ? { declined: false, rejects_saved: true, items: [] }
      : { declined: false, meal_type_from_text: null, items: [OATMEAL_ITEM] };
    return new Response(JSON.stringify({
      stop_reason: "tool_use", usage: { input_tokens: 100 * call, output_tokens: 10 * call },
      content: [{ type: "tool_use", name, input }],
    }), { status: 200 });
  }) as typeof fetch;
  const r = await runParseMeal(deps, {
    ...INPUT, text: "not from saved meals", mode: "fast", savedMeals: [OATS],
    previousText: "Can you log the oat meal to breakfast",
    previousItems: [{ food_id: "f-oats", food_name: "oats", quantity: 48, serving_label: "g", grams: 48, kcal: 180 }],
  });
  assertEquals(r.usage.input_tokens, 300);
  assertEquals(r.usage.output_tokens, 30);
  assertEquals(r.tool_calls.length, 2);
});
