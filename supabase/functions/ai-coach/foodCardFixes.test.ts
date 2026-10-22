// Run with: deno test --allow-all supabase/functions/ai-coach/foodCardFixes.test.ts
//
// One real thread, 2026-10-19, and the four things that went wrong in it:
//   "i had 3 pooris and chana navratri vaale in lunch and some 40g halwa"
//   "i think I had just 75g of chana ..."  -> card showed poori and halwa twice
//   "still suji halwa is duplicated ..."   -> 3 pooris became 216 g / 639 kcal
//   "u say puri is 640 cals? what?"        -> stock answer, "no label behind it"
//   "I had just 3 puris they were small"   -> the same stock answer again
// and, for another user the same morning, "1 dried fig" at 125 kcal because
// food memory copied a past log that had one fig at 50 g.
// Nothing here calls a real model, Jev or the database.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type CandidateFood,
  checkRememberedPiece,
  sameFoodName,
  copiesCardLines,
  type ExtractedItem,
  gramsPerUnit,
  type ParseMealDeps,
  perOneServing,
  perOneServings,
  type PreviousItem,
  runParseMeal,
  STATES_FIX_NOTE,
} from "./parseMeal.ts";
import type { MemoryFood } from "./userFoodMemory.ts";
import type { PreciseCacheRow } from "./preciseCache.ts";

const line = (name: string, quantity: number, unit: string, extra: Partial<ExtractedItem> = {}): ExtractedItem =>
  ({ name, brand: null, quantity, unit, prep: null, ...extra }) as ExtractedItem;
const prev = (food_name: string, quantity: number, serving_label: string, grams: number, kcal: number, source = "catalog"): PreviousItem =>
  ({ food_id: null, food_name, quantity, serving_label, grams, kcal, protein_g: 0, carb_g: 0, fat_g: 0, source }) as PreviousItem;

const CARD: PreviousItem[] = [
  prev("poori", 3, "piece", 108, 321),
  prev("boiled chana", 1, "1 cup, cooked (164g)", 164, 269),
  prev("Suji halwa", 40, "g", 40, 180, "estimate"),
];

// ── 1. A copied card is a correction, not an addition ───────────────────────

Deno.test("the failure this prevents: lines copied back from the card were added a second time", () => {
  // The real turn: poori and halwa came back unchanged, chana changed.
  assert(copiesCardLines([line("poori", 3, "piece"), line("Navratri chana", 75, "g"), line("suji halwa", 40, "g")], CARD));
});

Deno.test("a real addition is still an addition", () => {
  // "and another poori": one line, a different amount.
  assertEquals(copiesCardLines([line("poori", 1, "piece")], CARD), false);
  // "another poori and another halwa": two card foods again, but new amounts,
  // so nothing is a copy and both are added.
  assertEquals(copiesCardLines([line("poori", 1, "piece"), line("suji halwa", 20, "g")], CARD), false);
  // A plural unit is the same unit, "es" endings too.
  assert(copiesCardLines([line("juice", 1, "boxes"), line("suji halwa", 40, "g")], [prev("juice", 1, "box", 200, 90), CARD[2]]));
  // A stored label's own "1" is not part of the unit: "1 piece" is "piece".
  assert(copiesCardLines([line("poori", 3, "piece"), line("chana", 1, "cup, cooked (164g)")],
    [prev("poori", 3, "1 piece", 108, 321), prev("chana", 1, "1 cup, cooked (164g)", 164, 269)]));
  // A plural ending only: "can" is not "candy".
  assertEquals(copiesCardLines([line("cola", 1, "candy"), line("suji halwa", 40, "g")], [prev("cola", 1, "can", 330, 140), CARD[2]]), false);
  // Only one line copied exactly: could be the same food again.
  assertEquals(copiesCardLines([line("poori", 3, "piece"), line("dosa", 1, "piece")], CARD), false);
  // A line with the user's own numbers is an edit, never a copy.
  assertEquals(copiesCardLines([
    line("poori", 3, "piece"),
    line("suji halwa", 40, "g", { stated: { kcal: 120 } } as Partial<ExtractedItem>),
  ], CARD), false);
});

Deno.test("the parse marks a copied card as a correction, so the app replaces the card", async () => {
  const deps: ParseMealDeps = {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null,
    fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const tool = body.tool_choice?.name;
      const input = tool === "extract_meal"
        ? { declined: false, corrects_previous: false, meal_type_from_text: null, items: [
          { name: "poori", brand: null, quantity: 3, unit: "piece", prep: null },
          { name: "boiled chana", brand: null, quantity: 75, unit: "g", prep: null, corrects_food_name: "boiled chana" },
          { name: "Suji halwa", brand: null, quantity: 40, unit: "g", prep: null },
        ] }
        : { meal_type: "lunch", drona_line: "ok", items: [] };
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input }] });
    }) as typeof fetch,
  };
  const r = await runParseMeal(deps, {
    text: "i think I had just 75g of chana", previousText: "3 pooris, chana, 40g halwa", previousItems: CARD,
    localHour: 18, mealHint: "lunch", recentFoods: [], todayTotals: null, targets: null,
  });
  assert(r.steps.some((s) => s.tool === "correction_inferred"));
  assertEquals(r.parsed?.corrects_previous, true);
  // One poori line, one halwa line: nothing doubled.
  assertEquals(r.parsed!.items.filter((i) => i.food_name === "poori").length, 1);
});

// ── 2. "2 each = 72 g" is two pieces ────────────────────────────────────────

const POORI_ROW: PreciseCacheRow = {
  id: "row-poori", cache_key: "poori", display_name: "poori", brand: null, base_unit: "g",
  kcal: 296, protein_g: 6, carb_g: 40, fat_g: 13, fiber_g: null,
  servings: [{ label: '2 each - 4 4/5" diameter', grams: 72 }],
  evidence: [], verified: true, source_note: null, last_verified_at: "2026-10-18T00:00:00Z",
};

Deno.test("a serving for two pieces is restated as one piece", () => {
  assertEquals(perOneServing({ label: '2 each - 4 4/5" diameter', grams: 72 }), { label: '1 piece - 4 4/5" diameter', grams: 36 });
  assertEquals(perOneServing({ label: "2 pooris (72 g)", grams: 72 }), { label: "1 poori", grams: 36 });
  assertEquals(perOneServing({ label: "3 biscuits", grams: 30 }), { label: "1 biscuit", grams: 10 });
  // A weight outside brackets goes too, or the label would say 30g at 10 g.
  assertEquals(perOneServing({ label: "3 biscuits 30g", grams: 30 }), { label: "1 biscuit", grams: 10 });
  // The noun is the last word, after any size word.
  assertEquals(perOneServing({ label: "2 large eggs", grams: 100 }), { label: "1 large egg", grams: 50 });
  // A slice is a piece: two slices at 60 g are 30 g each.
  assertEquals(perOneServing({ label: "2 slices (60 g)", grams: 60 }), { label: "1 slice", grams: 30 });
  // No guessed singular: the plural still contains what the user types ("cookie").
  assertEquals(perOneServing({ label: "2 cookies", grams: 22 }), { label: "1 cookies", grams: 11 });
  assertEquals(perOneServing({ label: "2 potatoes", grams: 300 }), { label: "1 potatoes", grams: 150 });
  assertEquals(perOneServing({ label: "2 leaves", grams: 2 }), { label: "1 leaves", grams: 1 });
  // Left alone: a weight, a fraction, one piece already, and amounts that are not pieces.
  for (const sv of [
    { label: "100 g", grams: 100 }, { label: "1/2 cup", grams: 120 }, { label: "1 piece", grams: 36 },
    { label: "2 cups", grams: 300 }, { label: "12 fl oz", grams: 355 }, { label: "2 tbsp", grams: 30 },
    { label: "8 oz", grams: 227 }, { label: "10 inch", grams: 400 }, { label: "12 inch pizza", grams: 900 },
    { label: "12 count box", grams: 360 }, { label: "6 pack", grams: 1980 }, { label: "2 1/2 cups", grams: 375 },
  ]) {
    assertEquals(perOneServing(sv), sv);
  }
});

Deno.test("3 pooris from a '2 each' row are 108 g in code, not 216 g", () => {
  const cand: CandidateFood = {
    food_id: "f", name: "poori", brand: null, base_unit: "g", kcal: 296, protein_g: 6, carb_g: 40, fat_g: 13, fiber_g: null,
    servings: POORI_ROW.servings, source: "catalog",
  };
  assertEquals(gramsPerUnit("piece", perOneServings(cand))?.grams, 36);
});

Deno.test("the failure this prevents: decide saw the 72 g pair and read it as one poori", async () => {
  const decideBodies: string[] = [];
  const deps: ParseMealDeps = {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null,
    preciseCacheGet: async () => POORI_ROW,
    fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const tool = body.tool_choice?.name;
      if (tool === "extract_meal") {
        return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input: { declined: false, meal_type_from_text: null, items: [{ name: "poori", brand: null, quantity: 3, unit: "piece", prep: null }] } }] });
      }
      decideBodies.push(String(body.messages[0].content));
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input: { meal_type: "lunch", drona_line: "ok", items: [] } }] });
    }) as typeof fetch,
  };
  await runParseMeal(deps, { text: "3 pooris", localHour: 13, mealHint: null, mode: "super", recentFoods: [], todayTotals: null, targets: null });
  assertEquals(decideBodies.length, 1);
  assert(decideBodies[0].includes('"label":"1 piece - 4 4/5\\" diameter","grams":36'), decideBodies[0].slice(0, 600));
  assert(!decideBodies[0].includes('"grams":72'), "the pair weight must not reach decide");
});

Deno.test("a hand-made line's own serving is not divided again in a fast correction", async () => {
  // "2 pieces" at 60 g a unit, typed by the user: 3 of them is 180 g, not 90 g.
  const deps: ParseMealDeps = {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null,
    fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const tool = body.tool_choice?.name;
      const input = tool === "extract_meal"
        ? { declined: false, corrects_previous: true, meal_type_from_text: null, items: [
          { name: "momos", brand: null, quantity: 3, unit: "2 pieces", prep: null, corrects_food_name: "momos" },
        ] }
        : { meal_type: "snack", drona_line: "ok", items: [] };
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input }] });
    }) as typeof fetch,
  };
  const r = await runParseMeal(deps, {
    text: "make it 3", previousText: "momos", localHour: 18, mealHint: "snack", recentFoods: [], todayTotals: null, targets: null,
    previousItems: [{ food_id: null, food_name: "momos", quantity: 1, serving_label: "2 pieces", grams: 60, kcal: 120, protein_g: 5, carb_g: 16, fat_g: 4, source: "manual" } as PreviousItem],
  });
  assert(r.tool_calls.includes("fast_correction"), r.tool_calls.join(","));
  assertEquals(r.parsed!.items[0].grams, 180);
});

Deno.test("a remembered portion is the user's one unit, never divided", async () => {
  // Memory holds "2 pieces" at 100 g as ONE unit of what they logged.
  const bodies: string[] = [];
  const memoryEntry = {
    food_name: "Ghar ke momos", food_id: null, kcal: 200, protein_g: 8, carb_g: 26, fat_g: 7, fiber_g: null,
    grams: 100, quantity: 1, serving_unit: "2 pieces", source: "catalog", logged_via: "ai", tier: "precise", logged_at: "2026-10-18T08:00:00Z",
  };
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    if (String(url).includes("typesafe.ai")) {
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "score", probabilities: { "0": 0.01, "1": 0.01, "2": 0.98 } }]));
      return Response.json({ model: "jev-test", usage: {}, answers });
    }
    const tool = body.tool_choice?.name;
    if (tool === "extract_meal") {
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input: { declined: false, meal_type_from_text: null, items: [{ name: "ghar ke momos", brand: null, quantity: 1, unit: "2 pieces", prep: null }] } }] });
    }
    bodies.push(String(body.messages[0].content));
    return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input: { meal_type: "snack", drona_line: "ok", items: [] } }] });
  }) as typeof fetch;
  const deps: ParseMealDeps = {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null,
    fetchFn, jev: { apiKey: "j", timeoutMs: 1000, fetchFn },
    userMemory: { load: async () => ({ entries: [memoryEntry], timeZone: "Asia/Kolkata" }), lookupAliases: async () => [] },
  } as ParseMealDeps;
  const r = await runParseMeal(deps, { text: "2 pieces ghar ke momos", localHour: 17, mealHint: null, recentFoods: [], todayTotals: null, targets: null });
  assert(r.tool_calls.includes("user_memory_match"), r.tool_calls.join(","));
  assertEquals(bodies.length, 1);
  assert(bodies[0].includes('"label":"2 pieces","grams":100'), bodies[0].slice(0, 500));
});

// ── 3. A complaint that states the fix changes the line ─────────────────────

function challengeDeps(statesFix: number, log: { systems: string[]; jev: string[][] }, retryFlag = true, removeOnly = false): ParseMealDeps {
  let extracts = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    if (String(url).includes("typesafe.ai")) {
      log.jev.push(Object.keys(body.questions));
      return Response.json({ model: "jev-test", usage: {}, answers: { states_fix: { type: "noul", noul: statesFix } } });
    }
    const tool = body.tool_choice?.name;
    if (tool === "extract_meal") {
      extracts++;
      log.systems.push(JSON.stringify(body.system));
      const input = extracts === 1
        ? { declined: false, asks_about_previous: true, meal_type_from_text: null, items: [] }
        : removeOnly
        ? { declined: false, corrects_previous: true, meal_type_from_text: null, items: [], removed_food_names: ["Suji halwa"] }
        : {
          declined: false, corrects_previous: retryFlag, meal_type_from_text: null, items: [
            { name: "poori", brand: null, quantity: 3, unit: "small piece", prep: null, corrects_food_name: "poori" },
            { name: "boiled chana", brand: null, quantity: 75, unit: "g", prep: null, corrects_food_name: null },
            { name: "Suji halwa", brand: null, quantity: 40, unit: "g", prep: null, corrects_food_name: null },
          ],
        };
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input }] });
    }
    return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input: { meal_type: "lunch", drona_line: "Updated.", items: [] } }] });
  }) as typeof fetch;
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: false,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null,
    fetchFn, jev: { apiKey: "j", timeoutMs: 1000, fetchFn },
  };
}

const BIG_CARD: PreviousItem[] = [prev("poori", 3, "piece", 216, 639.4), CARD[1], CARD[2]];
const challenge = (text: string) => ({
  text, previousText: "3 pooris, chana, 40g halwa", previousItems: BIG_CARD,
  localHour: 18, mealHint: "lunch" as const, recentFoods: [], todayTotals: null, targets: null,
});

Deno.test("the failure this prevents: 'they were small' got the stock answer and the line never changed", async () => {
  const log = { systems: [] as string[], jev: [] as string[][] };
  const r = await runParseMeal(challengeDeps(0.92, log), challenge("I had just 3 puris they were small"));
  assertEquals(log.jev, [["states_fix"]]);
  assertEquals(log.systems.length, 2, "the extract is asked once more");
  assert(log.systems[1].includes(STATES_FIX_NOTE.trim().slice(0, 60)));
  const step = r.steps.find((s) => s.tool === "challenge_states_fix");
  assertEquals((step?.result as { applied: boolean }).applied, true);
  assertEquals(r.declined, null, `still the stock answer: ${r.declined?.message}`);
});

Deno.test("the failure this prevents: a retry that only removes a line was thrown away", async () => {
  // Live, 2026-10-21: "why did u add tomato and onion separately" asked for a
  // removal; the retry carried no items, was dropped, and the canned answer went out.
  const log = { systems: [] as string[], jev: [] as string[][] };
  const r = await runParseMeal(challengeDeps(0.92, log, true, true), challenge("why did you add the halwa separately?"));
  assertEquals(log.systems.length, 2, "the extract is asked once more");
  assertEquals(r.declined, null, `still the stock answer: ${r.declined?.message}`);
  assertEquals((r.parsed?.items ?? []).some((i) => /halwa/i.test(i.food_name)), false, "the halwa line must be gone");
  assertEquals(r.parsed?.corrects_previous, true);
});

Deno.test("a removal naming nothing on the card declines, instead of re-sending the card as 'taken off'", async () => {
  // A misspelled or invented name matches no line: nothing changes, so the
  // old decline stands rather than a corrects_previous of the unchanged card.
  const log = { systems: [] as string[], jev: [] as string[][] };
  const d = challengeDeps(0.92, log, true, true);
  const origFetch = d.fetchFn!;
  d.fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const r = await origFetch(url, init);
    if (String(url).includes("typesafe.ai")) return r;
    const body = await r.clone().json();
    const blk = body.content?.[0];
    if (blk?.input?.removed_food_names) blk.input.removed_food_names = ["kheer"];
    return Response.json(body);
  }) as typeof fetch;
  d.jev = { ...d.jev!, fetchFn: d.fetchFn };
  const r = await runParseMeal(d, challenge("why did you add the kheer?"));
  assert(r.declined !== null, "a no-op removal must decline");
  assertEquals(r.parsed, null);
});

Deno.test("the retry edits the card even when the model tags it as an addition", async () => {
  const log = { systems: [] as string[], jev: [] as string[][] };
  const r = await runParseMeal(challengeDeps(0.92, log, false), challenge("I had just 3 puris they were small"));
  assertEquals(log.systems.length, 2);
  assertEquals(r.parsed?.corrects_previous, true);
});

Deno.test("a bare question is still answered, now with the real numbers", async () => {
  const log = { systems: [] as string[], jev: [] as string[][] };
  const r = await runParseMeal(challengeDeps(0.1, log), challenge("u say puri is 640 cals? what?"));
  assertEquals(log.systems.length, 1, "no second extract for a question with no amount or size");
  const msg = r.declined?.message ?? "";
  assert(msg.includes("poori: 639 kcal for 216 g, which is 296 kcal per 100 g."), msg);
  // Only a line that really is an estimate says so.
  assert(msg.includes("Suji halwa: 180 kcal for 40 g, which is 450 kcal per 100 g, my own estimate."), msg);
  assert(!msg.includes("no label behind it"), msg);
});

// ── 4. A remembered piece weight is checked against the catalog ─────────────

const FIG_ROWS: CandidateFood[] = [
  { food_id: "u1", name: "Fig, dried", brand: null, base_unit: "g", kcal: 277, protein_g: 3.3, carb_g: 64, fat_g: 0.9, fiber_g: 9.8, source: "catalog",
    servings: [{ label: "100 g", grams: 100 }, { label: "1 cup", grams: 160 }, { label: "1 fig", grams: 8 }] },
  { food_id: "u2", name: "Figs, dried, uncooked", brand: null, base_unit: "g", kcal: 249, protein_g: 3.3, carb_g: 64, fat_g: 0.9, fiber_g: 9.8, source: "catalog",
    servings: [{ label: "1 fig", grams: 8.4 }, { label: "1 cup", grams: 149 }, { label: "100 g", grams: 100 }] },
];
const fig = (kcal100: number, grams: number): MemoryFood => ({
  key: "dried fig", name: "dried fig", food_id: null,
  per100: { kcal: kcal100, protein_g: 3, carb_g: 60, fat_g: 1, fiber_g: 9 },
  serving: { label: "1 piece", grams }, source: "catalog", level: "precise", times: 1, last_logged_at: "2026-10-14T04:29:00Z",
});
const search = { searchFoods: async () => FIG_ROWS };

Deno.test("the failure this prevents: memory copied one dried fig at 50 g", async () => {
  // Oct 14's log: 50 g, 125 kcal. The per-100 numbers were right; the weight was not.
  const { food, check } = await checkRememberedPiece(search, { unit: "piece" }, fig(250, 50));
  assertEquals(check?.replaced, true);
  assertEquals(food.serving?.grams, 8);
  assertEquals(food.per100.kcal, 250);
  assertEquals(Math.round(food.per100.kcal * food.serving!.grams / 100), 20);
});

Deno.test("when the calories for one piece were the right part, they are kept", async () => {
  // "1 dried fig (25 cals)" saved at 50 g: 50 kcal per 100 g, far from a fig's ~250.
  const { food, check } = await checkRememberedPiece(search, { unit: "piece" }, fig(50, 50));
  assertEquals([check?.replaced, check?.kept], [true, "kcal_per_piece"]);
  assertEquals(Math.round(food.per100.kcal * food.serving!.grams / 100), 25);
});

Deno.test("when both remembered numbers are wrong, the catalog's numbers are used", async () => {
  // 50 g at 1000 kcal per 100 g: 500 kcal a fig. Keeping that per piece would
  // put a fig at ~6000 kcal per 100 g, so the memory is not trusted at all.
  const { food, check } = await checkRememberedPiece(search, { unit: "piece" }, fig(1000, 50));
  assertEquals([check?.replaced, check?.kept], [true, "catalog"]);
  assertEquals([food.serving?.grams, food.per100.kcal], [8, 277]);
  assert(check!.note.endsWith("and the catalog's numbers"), check!.note);
});

Deno.test("a catalog row is the remembered food only when it names all of it", () => {
  assert(sameFoodName("dried fig", "Fig, dried"));
  assert(sameFoodName("dried fig", "Figs, dried, uncooked"));
  assertEquals(sameFoodName("dried fig", "Fig newtons"), false);
  assertEquals(sameFoodName("fig", "Fig newtons bar"), false);
});

Deno.test("a sane piece weight, or a typed weight, leaves the memory alone", async () => {
  const sane = fig(250, 10);
  const a = await checkRememberedPiece(search, { unit: "piece" }, sane);
  assertEquals([a.food, a.check?.replaced], [sane, false]);
  // "1 cup" is an amount: a piece weight has nothing to say about it.
  assertEquals((await checkRememberedPiece(search, { unit: "cup" }, fig(250, 50))).check, null);
  // A per-100 ml row is no reference for a food remembered per 100 g.
  const ml: CandidateFood[] = [{ ...FIG_ROWS[0], base_unit: "ml" }];
  assertEquals((await checkRememberedPiece({ searchFoods: async () => ml }, { unit: "piece" }, fig(250, 50))).check?.replaced, false);
  // A row for another food is no reference: a fig bar does not weigh what a fig does.
  const bars: CandidateFood[] = [{ ...FIG_ROWS[0], name: "Fig newtons bar", servings: [{ label: "1 bar", grams: 40 }] }];
  assertEquals((await checkRememberedPiece({ searchFoods: async () => bars }, { unit: "piece" }, fig(250, 10))).check?.replaced, false);
  // The user typed grams: the remembered piece weight is not used at all.
  const b = await checkRememberedPiece(search, { unit: "g" }, fig(250, 50));
  assertEquals(b.check, null);
  // A search that hangs keeps the memory once the time limit passes.
  const slow = await checkRememberedPiece({ searchFoods: () => new Promise<CandidateFood[]>(() => {}) }, { unit: "piece" }, fig(250, 50));
  assertEquals(slow.food.serving?.grams, 50);
  // A search that throws before returning a promise keeps the memory too.
  const thrown = await checkRememberedPiece({ searchFoods: () => { throw new Error("bad"); } }, { unit: "piece" }, fig(250, 50));
  assertEquals(thrown.food.serving?.grams, 50);
  // The catalog search failing keeps the memory.
  const c = await checkRememberedPiece({ searchFoods: () => Promise.reject(new Error("down")) }, { unit: "piece" }, fig(250, 50));
  assertEquals(c.food.serving?.grams, 50);
});
