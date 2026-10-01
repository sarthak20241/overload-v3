import { assert, assertEquals } from "jsr:@std/assert@1";
import { type ParseMealDeps, type ParseMealInput, runParseMeal } from "./parseMeal.ts";
import { cacheKey, type PreciseCacheRow } from "./preciseCache.ts";
import type { MemoryEntry } from "./userFoodMemory.ts";
import type { SavedMealForParse } from "./savedMeals.ts";

const canonical = "Doctor's Choice banana caramel protein oats";
const panel = { kcal: 400, protein_g: 25, carb_g: 50, fat_g: 11, fiber_g: 8 };
const now = () => new Date().toISOString();
const memory = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  food_name: canonical, food_id: null, grams: 100, quantity: 100, serving_unit: "g",
  ...panel, source: "manual", tier: "precise", logged_via: "manual", logged_at: now(), persistent: true,
  confirmed_aliases: ["doctors oats"], ...over,
});
const oats = { name: "Doctors oats", brand: null, quantity: 50, unit: "g", prep: null, meal: "snack" };
const milk = {
  food_id: null, food_name: "milk", quantity: 200, serving_label: "ml", grams: 200,
  kcal: 120, protein_g: 6, carb_g: 10, fat_g: 6, fiber_g: null,
  source: "manual" as const, meal_type: "breakfast" as const, assumption: "Own label",
};
const base: ParseMealInput = {
  text: "Doctors oats also please add", localHour: 13, mealHint: "snack",
  recentFoods: [], todayTotals: null, targets: null, previousText: "200ml milk",
  previousItems: [milk],
};
const row: PreciseCacheRow = {
  id: "cache-oats", cache_key: cacheKey(oats.name), display_name: canonical,
  brand: "Doctor's Choice", base_unit: "g", ...panel,
  servings: [{ label: "serving", grams: 50 }], evidence: [], verified: true,
  source_note: "Label", last_verified_at: now(),
};
const saved: SavedMealForParse = {
  id: "saved-oats", name: "My oat bowl", kind: "meal", servings: 1, serving_label: null,
  ...panel, items: [{
    food_id: null, food_name: canonical, quantity: 50, serving_unit: "g", grams: 50,
    kcal: 200, protein_g: 12.5, carb_g: 25, fat_g: 5.5, fiber_g: 4,
  }],
};

// Real parser/resolver/guardrails, with network and storage boundaries faked.
// Decide deliberately drops every item to exercise reconciliation as well.
function harness(options: {
  extraction?: Record<string, unknown>;
  entries?: MemoryEntry[];
  cache?: PreciseCacheRow | null;
  aliasEntries?: MemoryEntry[];
  web?: boolean;
} = {}) {
  const calls: string[] = [], aliasKeys: string[][] = [], extractionMessages: string[] = [];
  let historyReads = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).includes("typesafe.ai")) {
      calls.push("jev");
      const answers = Object.fromEntries(Object.keys(body.questions).map((key) => [key, {
        type: "score", probabilities: { "0": 0.01, "1": 0.01, "2": 0.98 },
      }]));
      return Response.json({ answers });
    }
    if (!String(url).includes("anthropic")) {
      calls.push("off");
      return Response.json({ products: [] });
    }
    const tools: string[] = (body.tools ?? []).map((t: { name: string }) => t.name);
    const tool = tools.includes("report_sources") ? "report_sources" : body.tool_choice.name;
    calls.push(tool);
    let input: Record<string, unknown>;
    if (tool === "extract_meal") {
      extractionMessages.push(body.messages[0].content);
      input = { declined: false, items: [oats], ...options.extraction };
    } else if (tool === "report_sources") {
      input = { results: options.web ? [{
        for_item: oats.name, found: true, serving_label: "serving", serving_grams: 50,
        readings: ["https://manufacturer.example/oats", "https://retailer.example/oats"]
          .map((url) => ({ url, per_100: panel })),
      }] : [] };
    } else {
      input = { meal_type: "snack", drona_line: "Added.", items: [] };
    }
    return Response.json({
      stop_reason: "tool_use", usage: {},
      content: [{ type: "tool_use", name: tool, input }],
    });
  }) as typeof fetch;
  const deps: ParseMealDeps = {
    anthropicApiKey: "test", model: "test", maxTokens: 1000, timeoutMs: 1000,
    webSearchEnabled: true, fetchFn,
    searchFoods: async () => { calls.push("catalog"); return []; },
    backfillOffFood: async () => null,
    getFoodPer100: async () => null,
    preciseCacheGet: async () => { calls.push("cache"); return options.cache ?? null; },
    preciseCachePut: async () => { calls.push("cache_write"); },
    jev: { apiKey: "test", timeoutMs: 1000, fetchFn },
    userMemory: {
      load: async () => { historyReads++; return { entries: options.entries ?? [], timeZone: "Asia/Kolkata" }; },
      lookupAliases: async (keys) => { aliasKeys.push(keys); return options.aliasEntries ?? []; },
    },
  };
  return { deps, calls, aliasKeys, extractionMessages, reads: () => historyReads };
}

for (const mode of [undefined, "fast", "super"] as const) {
  Deno.test(`follow-up ${mode ?? "thorough"}: confirmed shorthand uses personal nutrition at the new portion`, async () => {
    const h = harness({ aliasEntries: [memory()] });
    const r = await runParseMeal(h.deps, { ...base, mode });
    const item = r.parsed!.items[0];
    assertEquals([item.food_name, item.grams, item.kcal, item.numbers_tier], [canonical, 50, 200, "precise"]);
    assertEquals(item.meal_type, "snack");
    assertEquals(item.memory_input_name, "Doctors oats");
    assertEquals(r.parsed!.corrects_previous, false); // client appends to the card
    assertEquals(h.aliasKeys, [["doctors oats"]]);
    assertEquals(h.calls, ["extract_meal", "log_meal"]);
    assertEquals(h.reads(), 1);
  });

  Deno.test(`follow-up ${mode ?? "thorough"}: precise cache hit avoids all catalog and web work`, async () => {
    const h = harness({ cache: row });
    const r = await runParseMeal(h.deps, { ...base, mode });
    const item = r.parsed!.items[0];
    assertEquals([item.food_name, item.grams, item.kcal, item.verified, item.food_id], [canonical, 50, 200, true, null]);
    assert(r.tool_calls.includes("precise_cache_hit"));
    assertEquals(h.calls, ["extract_meal", "cache", "log_meal"]);
  });
}

Deno.test("follow-up new shorthand uses Jev before cache/catalog", async () => {
  const h = harness({ entries: [memory({ confirmed_aliases: [] })] });
  const r = await runParseMeal(h.deps, base);
  assertEquals(r.parsed!.items[0].food_name, canonical);
  assertEquals(h.calls, ["extract_meal", "jev", "log_meal"]);
});

Deno.test("Precise follow-up cache miss researches and writes the verified panel", async () => {
  const h = harness({ web: true });
  const r = await runParseMeal(h.deps, { ...base, mode: "super" });
  assertEquals(r.tier, "precise");
  assertEquals(r.parsed!.items[0].kcal, 200);
  assertEquals(r.parsed!.items[0].verified, true);
  assert(h.calls.includes("report_sources"));
  assert(h.calls.includes("cache_write"));
  assert(!h.calls.includes("catalog"));
});

Deno.test("Thorough follow-up miss still uses catalog resolution", async () => {
  const h = harness();
  const r = await runParseMeal(h.deps, base);
  assert(h.calls.includes("cache"));
  assert(h.calls.includes("catalog"));
  assert(!h.calls.includes("report_sources"));
  assertEquals(r.parsed!.items[0].food_name, "Doctors oats");
});

Deno.test("Precise follow-up retains our-sources matching before web fallback", async () => {
  const h = harness({ web: true });
  h.deps.preciseMatch = {
    mode: "on", findCandidates: async () => { h.calls.push("our_sources"); return []; },
  };
  const r = await runParseMeal(h.deps, { ...base, mode: "super" });
  assert(h.calls.indexOf("our_sources") > h.calls.indexOf("cache"));
  assert(h.calls.indexOf("report_sources") > h.calls.indexOf("our_sources"));
  assert(r.steps.some((s) => s.tool === "our_sources"));
  assertEquals(r.parsed!.items[0].kcal, 200);
});

Deno.test("Precise follow-up does not promote Quick-only history into a precise answer", async () => {
  const h = harness({
    entries: [memory({ source: "estimate", logged_via: "drona", tier: "fast" })], cache: row,
  });
  const r = await runParseMeal(h.deps, { ...base, mode: "super" });
  assert(!r.tool_calls.includes("user_memory_match"));
  assert(r.tool_calls.includes("precise_cache_hit"));
  assertEquals(h.calls, ["extract_meal", "cache", "log_meal"]);
});

Deno.test("mixed card update: only the added food uses memory; manual milk and its section survive", async () => {
  const h = harness({ entries: [memory()], extraction: {
    corrects_previous: true, items: [
      { name: "milk", quantity: 200, unit: "ml", unchanged: true }, oats,
    ],
  } });
  const r = await runParseMeal(h.deps, { ...base, mode: "super" });
  assertEquals(r.parsed!.corrects_previous, true);
  assertEquals(h.aliasKeys, [["doctors oats"]]);
  const carried = r.parsed!.items.find((i) => i.food_name === "milk")!;
  assertEquals([carried.kcal, carried.grams, carried.source, carried.meal_type, carried.assumption],
    [120, 200, "manual", "breakfast", "Own label"]);
  assertEquals(r.parsed!.items.find((i) => i.food_name === canonical)!.kcal, 200);
});

Deno.test("food replacement uses memory for the new identity and does not restore the old one", async () => {
  const h = harness({ entries: [memory()], extraction: {
    corrects_previous: true, items: [{ ...oats, corrects_food_name: "milk" }],
  } });
  const r = await runParseMeal(h.deps, base);
  assertEquals(r.parsed!.corrects_previous, true);
  assertEquals(r.parsed!.items.map((i) => i.food_name), [canonical]);
  assertEquals(h.calls, ["extract_meal", "log_meal"]);
});

Deno.test("pure quantity edit scales the current card, not conflicting personal history", async () => {
  const h = harness({ entries: [memory({ food_name: "milk", kcal: 200 })], extraction: {
    corrects_previous: true, items: [{ name: "milk", quantity: 300, unit: "ml", corrects_food_name: "milk" }],
  } });
  const r = await runParseMeal(h.deps, { ...base, text: "make the milk 300ml", mode: "super" });
  assertEquals(r.parsed!.items[0].kcal, 180);
  assertEquals(h.reads(), 0);
  assert(!h.calls.includes("cache"));
});

Deno.test("a similar-named product replacement resolves its own memory instead of scaling the old product", async () => {
  const chocolate = "Doctor's Choice chocolate protein oats";
  const h = harness({ entries: [memory({
    food_name: chocolate, confirmed_aliases: ["doctors chocolate oats"],
  })], extraction: {
    corrects_previous: true, items: [{
      ...oats, name: "Doctors chocolate oats", corrects_food_name: canonical,
    }],
  } });
  const r = await runParseMeal(h.deps, {
    ...base, previousItems: [{ ...milk, food_name: canonical, kcal: 500 }],
  });
  assertEquals(r.parsed!.items.map((i) => [i.food_name, i.kcal]), [[chocolate, 200]]);
  assertEquals(h.reads(), 1);
  assert(!r.tool_calls.includes("fast_correction"));
});

for (const extraction of [
  { declined: true, items: [] },
  { asks_about_previous: true, items: [] },
  { requests_research: true, items: [] },
  { corrects_previous: true, removed_food_names: ["milk"], items: [] },
]) {
  Deno.test(`non-addition follow-up skips history: ${Object.keys(extraction)[0]}`, async () => {
    const h = harness({ entries: [memory()], extraction });
    await runParseMeal(h.deps, { ...base, text: "check the card" });
    assertEquals(h.reads(), 0);
    assertEquals(h.aliasKeys, []);
    assert(!h.calls.includes("cache"));
    assert(!h.calls.includes("jev"));
  });
}

Deno.test("ambiguous follow-up shorthand asks for the variant without substituting a catalogue row", async () => {
  const h = harness({ entries: [
    memory(), memory({ food_name: "Doctor's Choice chocolate protein oats" }),
  ] });
  const r = await runParseMeal(h.deps, base);
  assertEquals(r.parsed, null);
  assert(r.declined!.message.includes("more than one saved match"));
  assert(!h.calls.includes("cache"));
  assert(!h.calls.includes("catalog"));
});

Deno.test("follow-up user's stated panel takes precedence over remembered nutrition", async () => {
  const h = harness({ entries: [memory()], extraction: {
    items: [{ ...oats, stated: { basis: "per_100g", kcal: 300, protein_g: 20, carb_g: 40, fat_g: 6.7 } }],
  } });
  const r = await runParseMeal(h.deps, base);
  assertEquals(r.parsed!.items[0].kcal, 150);
  assert(r.tool_calls.includes("user_stated"));
  assert(!h.calls.includes("jev"));
  assert(!h.calls.includes("cache"));
});

Deno.test("follow-up can add a saved meal with its own numbers and no lookup", async () => {
  const h = harness({ extraction: { items: [{
    name: "My oat bowl", saved_meal: "My oat bowl", quantity: 2, unit: "serving", meal: "lunch",
  }] } });
  const r = await runParseMeal(h.deps, { ...base, mode: "super", savedMeals: [saved] });
  assert(h.extractionMessages[0].includes("<saved_meals>"));
  assertEquals(r.parsed!.items.map((i) => [i.food_name, i.kcal, i.meal_type]), [[canonical, 400, "lunch"]]);
  assertEquals(r.parsed!.corrects_previous, false);
  assertEquals(h.calls, ["extract_meal"]);
  assertEquals(h.reads(), 0);
});

Deno.test("saved meal replacement retains the correction contract and untouched card lines", async () => {
  const h = harness({ extraction: { corrects_previous: true, items: [{
    name: "My oat bowl", saved_meal: "My oat bowl", quantity: 1, unit: "serving", corrects_food_name: "toast",
  }] } });
  const r = await runParseMeal(h.deps, {
    ...base, savedMeals: [saved], previousItems: [milk, { ...milk, food_name: "toast", meal_type: "snack" }],
  });
  assertEquals(r.parsed!.corrects_previous, true);
  assertEquals(r.parsed!.items.map((i) => i.food_name), [canonical, "milk"]);
  assertEquals(r.parsed!.items.find((i) => i.food_name === "milk")!.kcal, 120);
  assertEquals(h.calls, ["extract_meal"]);
});
