// Run with: deno test --allow-all supabase/functions/ai-coach/savedMeals.test.ts
//
// A saved meal the user names is logged from ITS rows. Seen live 2026-09-22:
// "Oats with milk" was saved (48 g oats + 550 ml milk, 550 kcal), then "log the
// oat meal" came back as a 150 kcal estimate of plain oatmeal. These tests pin
// that the saved rows win, in every mode, and that nothing else is consulted.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type ParseMealDeps, runParseMeal } from "./parseMeal.ts";
import { openingText } from "./foodAgent.ts";
import {
  findSavedMeal,
  hintOfferTarget,
  mergeSavedLines,
  type SavedMealHint,
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
  assertEquals(lines.every((l) => l.saved_meal === "Oats with milk"), true);
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
  extraction: Record<string, unknown> = {},
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
        content: [{ type: "tool_use", name, input: { declined: false, meal_type_from_text: null, items, ...extraction } }],
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
    stub([], [{ ...OATMEAL_ITEM, saved_meal: "Oats with milk" }], seen, { corrects_previous: true }),
    {
      ...INPUT, mode: "fast", savedMeals: [OATS],
      previousText: "oatmeal",
      previousItems: [{ food_id: null, food_name: "oatmeal", quantity: 1, serving_label: "serving", grams: 40, kcal: 150 }],
    },
  ).catch(() => null);
  assertEquals(seen.some((m) => m.includes("<saved_meals>")), true);
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

// ── Seen live 2026-10-22: "2 boiled eggs" offered the saved "Bread butter" ──
// That meal holds 2 boiled eggs AND a slice of toast. Matching one of its items
// is not the user naming it: the swap would log bread they never mentioned.

const BREAD_BUTTER: SavedMealForParse = {
  id: "sm-bb", name: "Bread butter", kind: "meal", servings: 1, serving_label: null,
  kcal: 234, protein_g: 15, carb_g: 16, fat_g: 11,
  items: [
    { food_id: "f-egg", food_name: "Eggs, boiled", quantity: 2, serving_unit: "egg", grams: 100, kcal: 155, protein_g: 12.6, carb_g: 1.1, fat_g: 10.6, fiber_g: 0 },
    { food_id: "f-toast", food_name: "Bread, white, toasted", quantity: 1, serving_unit: "slice", grams: 27, kcal: 79, protein_g: 2.4, carb_g: 15, fat_g: 1, fiber_g: 0.7 },
  ],
};

Deno.test("one item of a bigger saved meal is not offered as that meal", () => {
  assertEquals(suggestSavedMeal("boiled egg", [BREAD_BUTTER]), null);
  assertEquals(suggestSavedMeal("toast", [BREAD_BUTTER]), null);
  // Its name is still the user naming it.
  assertEquals(suggestSavedMeal("bread butter", [BREAD_BUTTER])?.id, "sm-bb");
});

Deno.test("a saved meal of one food is offered for that food", () => {
  const CHEELA: SavedMealForParse = {
    ...OATS, id: "sm-cheela", name: "Monday Breakfast",
    items: [{ ...OATS.items[0], food_name: "Besan cheela" }],
  };
  assertEquals(suggestSavedMeal("besan cheela", [CHEELA])?.id, "sm-cheela");
});

Deno.test("2 boiled eggs: estimate logged, no Bread butter offer", async () => {
  const r = await runParseMeal(
    stub([], [{ ...OATMEAL_ITEM, name: "boiled egg", quantity: 2, unit: "piece" }]),
    { ...INPUT, text: "2 boiled eggs", mode: "fast", savedMeals: [BREAD_BUTTER] },
  );
  assertEquals(r.parsed!.items.map((i) => i.food_name), ["boiled egg"]);
  assertEquals(r.saved_suggestions, undefined);
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

// ── Seen on device: the model missed "not from saved meals" ─────────────────

import { rejectsSavedMeal } from "./savedMeals.ts";

Deno.test("plain words that turn the saved meal down are caught in code", () => {
  for (const t of ["not from saved meals", "don't use my saved one", "do not use the saved meal", "without my saved meal", "no, not my meals", "Don’t use my saved meal"]) {
    assertEquals(rejectsSavedMeal(t), true, t);
  }
  for (const t of [
    "make it 2 servings", "save this as a meal", "add a banana", "not the milk",
    // Confirmations that happen to contain a "no" word: never a rejection.
    "no, keep my saved oats", "no, that's right, log my saved meal", "don't change anything, keep the saved oats",
  ]) {
    assertEquals(rejectsSavedMeal(t), false, t);
  }
});

Deno.test("the rejection fires even when the model does not flag it", async () => {
  let call = 0;
  const deps = stub([], []);
  deps.fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    call++;
    const name = JSON.parse(String(init?.body ?? "{}")).tool_choice?.name;
    // What the device trace showed: no rejects_saved, no items.
    const input = call === 1
      ? { declined: false, items: [] }
      : { declined: false, meal_type_from_text: null, items: [OATMEAL_ITEM] };
    return new Response(JSON.stringify({
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name, input }],
    }), { status: 200 });
  }) as typeof fetch;
  const r = await runParseMeal(deps, {
    ...INPUT, text: "not from saved meals", mode: null, savedMeals: [OATS],
    previousText: "log the oat meal",
    previousItems: [{ food_id: "f-oats", food_name: "oats", quantity: 48, serving_label: "g", grams: 48, kcal: 180, source: "manual" }],
  });
  // Thorough mode: the fresh parse lands on the catalog row, not the saved oats.
  assertEquals(r.parsed?.items.map((i) => i.food_name), ["Oatmeal, cooked"]);
  assertEquals(r.parsed?.corrects_previous, true);
});

function rejectionDeps(firstItems: Record<string, unknown>[], seen: string[]) {
  let call = 0;
  const deps = stub([], []);
  deps.fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    call++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (call > 1) seen.push(String(body.messages?.[0]?.content ?? ""));
    const input = call === 1
      ? { declined: false, items: firstItems }
      : { declined: false, meal_type_from_text: null, items: [OATMEAL_ITEM] };
    return new Response(JSON.stringify({
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", name: body.tool_choice?.name, input }],
    }), { status: 200 });
  }) as typeof fetch;
  return deps;
}

const SAVED_CARD = {
  previousText: "log the oat meal",
  previousItems: [{ food_id: "f-oats", food_name: "oats", quantity: 48, serving_label: "g", grams: 48, kcal: 180, source: "manual" as const }],
};

Deno.test("rejecting the saved meal AND adding food keeps the new food", async () => {
  const seen: string[] = [];
  const eggs = { name: "eggs", quantity: 2, unit: "piece" };
  await runParseMeal(rejectionDeps([eggs], seen), {
    ...INPUT, text: "not using my saved meal, add 2 eggs", mode: null, savedMeals: [OATS], ...SAVED_CARD,
  });
  assertEquals(seen[0], "log the oat meal. not using my saved meal, add 2 eggs");
});

Deno.test("the code check never fires on a card with no saved-meal lines", async () => {
  const seen: string[] = [];
  const r = await runParseMeal(rejectionDeps([], seen), {
    ...INPUT, text: "no, not my meals", mode: null, savedMeals: [OATS],
    previousText: "2 eggs",
    previousItems: [{ food_id: null, food_name: "eggs", quantity: 2, serving_label: "piece", grams: 100, kcal: 140, source: "estimate" }],
  });
  assertEquals(seen, []);
  assertEquals(r.steps.some((s) => s.tool === "rejects_saved"), false);
});

// ── the router's pick (Jev) is a pointer and an offer, never a log ──────────
//
// Live, 21 days to 2026-10-22: Jev was sure 7 times. Twice the parse agreed.
// Twice "10g doctor's choice oats" pointed at a whole 426 kcal saved serving
// for 10 g of it, and once "yesterday's oat meal" pointed at a saved meal when
// the diary was meant. So Jev's pick steers the model and offers a swap; the
// parse keeps the amount, and only the model's own tag logs the saved rows.

const HINT: SavedMealHint = { id: "sm-oats", name: "Oats with milk", confidence: 0.84 };

Deno.test("the block carries the router's pick as a pointer, only for a listed meal", () => {
  const b = savedMealsBlock([OATS], HINT);
  assert(b.includes('router read the message as naming "Oats with milk" (84% sure)'), b);
  assert(b.includes("A pointer, not a verdict"), b);
  assert(b.endsWith("\n</saved_meals>"), b);
  assertEquals(savedMealsBlock([OATS], { ...HINT, id: "sm-gone" }), savedMealsBlock([OATS]));
  assertEquals(savedMealsBlock([OATS], null), savedMealsBlock([OATS]));
  assertEquals(savedMealsBlock([], HINT), "");
});

Deno.test("the offer lands on the line sharing the most words with the saved meal", () => {
  assertEquals(hintOfferTarget(HINT, [OATS], ["kesar pista oats", "banana"]), "kesar pista oats");
  assertEquals(hintOfferTarget(HINT, [OATS], ["oats with honey", "milk"]), "oats with honey");
  // No line shares a word: nothing to swap, so no offer.
  assertEquals(hintOfferTarget(HINT, [OATS], ["chicken", "rice"]), null);
  assertEquals(hintOfferTarget(HINT, [OATS], []), null);
  // A pick that is not among the saved meals is ignored.
  assertEquals(hintOfferTarget({ ...HINT, id: "sm-gone" }, [OATS], ["oats"]), null);
  // A one-item saved meal IS that food: its item's words count too.
  const plate: SavedMealForParse = {
    ...OATS, id: "sm-roti", name: "My Roti Plate",
    items: [{ ...OATS.items[0], food_name: "Roti / Chapati" }],
  };
  assertEquals(hintOfferTarget({ id: "sm-roti", name: "My Roti Plate", confidence: 0.86 }, [plate], ["chapati"]), "chapati");
});

Deno.test("the failure this prevents: the router's pick is offered, the parsed amount is logged", async () => {
  const seen: string[] = [];
  const r = await runParseMeal(
    stub([], [{ ...OATMEAL_ITEM, name: "kesar pista oats" }], seen),
    { ...INPUT, text: "yesterday's oat meal in breakfast", mode: "fast", savedMeals: [OATS], savedHint: HINT },
  );
  // The model saw the pointer under the list.
  assert(seen[0].includes('router read the message as naming "Oats with milk" (84% sure)'), seen[0]);
  // The parse's own line stands, as an estimate: nothing was logged from the saved rows.
  assertEquals(r.parsed!.items.map((i) => [i.food_name, i.source]), [["kesar pista oats", "estimate"]]);
  // The card gets the one-tap swap on that line.
  assertEquals(r.saved_suggestions, [{ food_name: "kesar pista oats", saved_id: "sm-oats", saved_name: "Oats with milk" }]);
  const step = r.steps.find((s) => s.tool === "saved_hint");
  assertEquals(step?.result, "offered:kesar pista oats");
  assertEquals(step?.input, { id: "sm-oats", name: "Oats with milk", confidence: 0.84 });
});

Deno.test("when the model tags the saved meal itself, the pick is logged and not offered again", async () => {
  const r = await runParseMeal(
    stub([], [{ ...OATMEAL_ITEM, saved_meal: "Oats with milk" }]),
    { ...INPUT, mode: "fast", savedMeals: [OATS], savedHint: HINT },
  );
  assertEquals(r.parsed!.items.map((i) => i.source), ["manual", "manual"]);
  assertEquals(r.saved_suggestions, undefined);
  assertEquals(r.steps.find((s) => s.tool === "saved_hint")?.result, "logged");
});

Deno.test("a pick no line can carry is recorded, not forced onto the card", async () => {
  const r = await runParseMeal(
    stub([], [{ ...OATMEAL_ITEM, name: "chicken" }]),
    { ...INPUT, text: "chicken", mode: "fast", savedMeals: [OATS], savedHint: HINT },
  );
  assertEquals(r.saved_suggestions, undefined);
  assertEquals(r.steps.find((s) => s.tool === "saved_hint")?.result, "no_line");
});

Deno.test("the word check and the router's pick never offer the same meal twice", async () => {
  const r = await runParseMeal(
    stub([], [{ ...OATMEAL_ITEM, name: "oats" }]),
    { ...INPUT, text: "oats in breakfast", mode: "fast", savedMeals: [OATS], savedHint: HINT },
  );
  assertEquals(r.saved_suggestions, [{ food_name: "oats", saved_id: "sm-oats", saved_name: "Oats with milk" }]);
});

Deno.test("words that turn the saved meal down beat the router's pick", async () => {
  const r = await runParseMeal(
    stub([], [{ ...OATMEAL_ITEM, name: "kesar pista oats" }]),
    { ...INPUT, text: "kesar pista oats, not from my saved meals", mode: "fast", savedMeals: [OATS], savedHint: HINT },
  );
  assertEquals(r.saved_suggestions, undefined);
});

Deno.test("no pick, no pointer and no step: the prompt is exactly as before", async () => {
  const seen: string[] = [];
  const r = await runParseMeal(stub([], [OATMEAL_ITEM], seen), { ...INPUT, mode: "fast", savedMeals: [OATS] });
  assert(!seen[0].includes("router read"), seen[0]);
  assertEquals(r.steps.find((s) => s.tool === "saved_hint"), undefined);
});

Deno.test("the agent gets the pick as one line, with the query to fetch that meal", () => {
  const text = openingText({ text: "my usual oats", savedHint: HINT }, "Today is Thursday 2026-10-22.");
  assert(text.includes('saved meal "Oats with milk", 84% sure'), text);
  assert(text.includes('list_saved_meals (query "Oats with milk")'), text);
  assert(text.endsWith("my usual oats"), text);
  assertEquals(openingText({ text: "my usual oats", savedHint: null }, null), "my usual oats");
});
