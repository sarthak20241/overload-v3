// Run with: deno test --allow-all supabase/functions/ai-coach/searchRewrite.test.ts
//
// The 2026-10-11 miss (parse_traces 709a7c27): a branded protein bar named by
// a flavour nickname its label never prints. Both fixed web searches missed,
// the catalog's plain-name search found another company's bar, and decide
// logged that bar. Then the double check looked up the WRONG bar's name.
//
// Four guards, each tested here against invented foods:
//   1. search rewrite: one model-written retry under the name the product is sold as
//   2. that name also drives the catalog, OFF and FatSecret searches
//   3. brand check: another company's row never reaches decide as a candidate
//   4. the double check looks up the user's words, not the card's name

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  cleanRewrite,
  runTavilyLookup,
  type SearchRewrite,
  type SeenResult,
  type TavilyLookupDeps,
  type WebFoodItem,
} from "./tavilyLookup.ts";
import { OTHER_BRAND_FLOOR, otherBrandRows, rowsToAsk } from "./brandCheck.ts";
import {
  type CandidateFood,
  type ParsedItem,
  type ParseMealDeps,
  type ParseMealInput,
  type ResolvedItem,
  runParseMeal,
  stampSaidNames,
} from "./parseMeal.ts";

// ── Invented foods ──────────────────────────────────────────────────────────
// The user calls the "Vanilla Wafer" flavour by a nickname, "biscotti".

const ITEM: WebFoodItem = { name: "biscotti protein bar", brand: "Fitzo" };
const SOLD_AS = "Fitzo Protein Bar Vanilla Wafer";
const PANEL = "Nutrition per 100 g: Energy 380 kcal, Protein 28 g, Carbohydrate 40 g, Fat 12 g";

const OTHER_FLAVOUR = {
  title: "Fitzo Protein Bar Choco Hazelnut",
  url: "https://shop.example.in/fitzo-choco-hazelnut",
  content: "Fitzo Choco Hazelnut. Energy 410 kcal per 100 g",
  score: 0.8,
  raw_content: "Fitzo Protein Bar Choco Hazelnut. Energy 410 kcal, Protein 25 g, Carbohydrate 42 g, Fat 15 g per 100 g",
};
const RIGHT = {
  title: "Fitzo Protein Bar Vanilla Wafer 60 g",
  url: "https://grocer.example.in/fitzo-vanilla-wafer",
  content: "Fitzo Vanilla Wafer. " + PANEL,
  score: 0.8,
  raw_content: "Fitzo Protein Bar Vanilla Wafer. " + PANEL,
};

interface Net {
  searches: string[];
  /** Food names Jev was asked to judge pages against. */
  judgedAs: string[];
  reads: number;
}

/** Tavily answers by query; Jev says yes only when the page title is the food
 *  it was asked about; the reader copies "Energy N kcal" off the page. */
function fakeNet(byQuery: (q: string) => unknown[], net: Net, opts: { failFrom?: number } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.includes("api.tavily.com/search")) {
      net.searches.push(body.query);
      if (opts.failFrom !== undefined && net.searches.length > opts.failFrom) return new Response("x", { status: 432 });
      return Response.json({ results: byQuery(body.query) });
    }
    if (u.includes("api.tavily.com/extract")) return Response.json({ results: [] });
    if (u.includes("typesafe.ai")) {
      const food = body.state.food.name as string;
      net.judgedAs.push(food);
      const answers: Record<string, unknown> = {};
      for (const r of body.state.results) {
        const same = r.title.toLowerCase().includes("vanilla wafer") && /wafer/i.test(food);
        answers[r.id] = { type: "noul", noul: same ? 0.92 : 0.05 };
        if (body.questions[`${r.id}_piece`]) {
          answers[`${r.id}_piece`] = { type: "choice", choice: "p1", confidence: 0.9, probabilities: { p1: 0.9 } };
        }
      }
      return Response.json({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

function reader(net: Net) {
  return async (payload: Record<string, unknown>) => {
    net.reads++;
    const msg = JSON.parse((payload.messages as Array<{ content: string }>)[0].content);
    return {
      content: [{
        type: "tool_use",
        name: "report_page_panels",
        input: {
          pages: msg.pages.map((p: { page_id: string; text: string }) => ({
            page_id: p.page_id, same_food: true, basis: "per_100g",
            kcal: Number(/Energy (\d+) kcal/.exec(p.text)?.[1] ?? NaN), protein_g: 28, carb_g: 40, fat_g: 12,
          })),
        },
      }],
    };
  };
}

const newNet = (): Net => ({ searches: [], judgedAs: [], reads: 0 });

function deps(fetchFn: typeof fetch, net: Net, suggest?: TavilyLookupDeps["suggestSearch"]): TavilyLookupDeps {
  return {
    tavily: { apiKey: "t", timeoutMs: 1000, fetchFn },
    jev: { apiKey: "j", timeoutMs: 1000, fetchFn },
    country: "india",
    model: "m",
    callModel: reader(net),
    suggestSearch: suggest,
  };
}

/** Pages under the user's words are other flavours; under the sold name, the right one. */
const byQuery = (q: string) => (/wafer/i.test(q) ? [RIGHT] : [OTHER_FLAVOUR]);

// ── 1. The search rewrite ───────────────────────────────────────────────────

Deno.test("a nickname the label never prints: the rewrite searches under the sold name and finds it", async () => {
  const net = newNet();
  let seenByRewrite: SeenResult[] = [];
  const out = await runTavilyLookup(
    deps(fakeNet(byQuery, net), net, async (_item, seen) => {
      seenByRewrite = seen;
      return { name: SOLD_AS, queries: [`${SOLD_AS} nutrition facts`] };
    }),
    ITEM,
  );
  assertEquals(net.searches.length, 3);
  assertEquals(out.finding?.readings.map((r) => r.per_100.kcal), [380]);
  assertEquals(out.finding?.searched_as, SOLD_AS);
  assertEquals(out.renamed, SOLD_AS);
  assertEquals(out.unavailable, false);
  // It learned from what came back, and pages were judged as the sold name.
  assert(seenByRewrite.some((s) => s.title.includes("Choco Hazelnut")));
  assert(net.judgedAs.includes(SOLD_AS));
  assert(out.steps.some((s) => s.tool === "search_rewrite"));
});

Deno.test("the rewrite never runs when the user's own words find the label", async () => {
  const net = newNet();
  let asked = 0;
  const out = await runTavilyLookup(
    deps(fakeNet(() => [RIGHT], net), net, async () => { asked++; return null; }),
    { name: "vanilla wafer protein bar", brand: "Fitzo" },
  );
  assertEquals(asked, 0);
  assertEquals(net.searches.length, 1);
  assertEquals(out.finding?.readings.length, 1);
});

Deno.test("the rewrite cannot loosen the match: a different flavour under the new name is still refused", async () => {
  const net = newNet();
  const out = await runTavilyLookup(
    deps(fakeNet(() => [OTHER_FLAVOUR], net), net, async () => ({ name: SOLD_AS, queries: ["fitzo bar wafer label"] })),
    ITEM,
  );
  assertEquals(out.finding, null);
  assertEquals(net.reads, 0);
  // Still reported, so the catalog can search by it.
  assertEquals(out.renamed, SOLD_AS);
});

Deno.test("an outage during the rewrite's search is not an outage of the lookup", async () => {
  const net = newNet();
  const out = await runTavilyLookup(
    deps(fakeNet(byQuery, net, { failFrom: 2 }), net, async () => ({ name: SOLD_AS, queries: ["q wafer"] })),
    ITEM,
  );
  // The fixed searches ran and answered "nothing": no paid fallback for that.
  assertEquals(out.unavailable, false);
  assertEquals(out.finding, null);
});

Deno.test("no rewrite dep, or a rewrite that adds nothing: two searches and done", async () => {
  const net = newNet();
  await runTavilyLookup(deps(fakeNet(byQuery, net), net), ITEM);
  assertEquals(net.searches.length, 2);
  const net2 = newNet();
  await runTavilyLookup(deps(fakeNet(byQuery, net2), net2, async () => ({ name: ITEM.name, queries: [] })), ITEM);
  assertEquals(net2.searches.length, 2);
});

Deno.test("cleanRewrite drops searches already run, caps the rest, and fills one in for a bare new name", () => {
  const asked = ["Fitzo biscotti protein bar nutrition facts per 100g"];
  const r = cleanRewrite(
    { name: ` ${SOLD_AS} `, queries: [asked[0].toUpperCase(), "a", "b", "c"] } as SearchRewrite,
    ITEM,
    asked,
  );
  assertEquals(r, { name: SOLD_AS, queries: ["a", "b"] });
  assertEquals(cleanRewrite({ name: SOLD_AS, queries: [] }, ITEM, asked)?.queries, [`${SOLD_AS} nutrition facts`]);
  assertEquals(cleanRewrite({ name: "Fitzo biscotti protein bar", queries: [] }, ITEM, asked), null);
  assertEquals(cleanRewrite(null, ITEM, asked), null);
  assertEquals(cleanRewrite({ name: "", queries: ["x"] }, ITEM, asked), null);
});

// ── 3. The brand check ──────────────────────────────────────────────────────

Deno.test("rows already under the user's brand, in any spelling, are not asked about", () => {
  const rows = [
    { name: "FITZO Protein Bar", brand: null },
    { name: "Protein Bar Vanilla", brand: "Fit Zo" },
    { name: "Nova Vanilla Wafer Bar", brand: "Nova" },
    { name: "Protein bar", brand: null },
  ];
  assertEquals(rowsToAsk("Fitzo", rows), [2, 3]);
});

function jevAnswering(other: (rowName: string) => number, seen: string[][], status = 200): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    if (status !== 200) return new Response("x", { status });
    const body = JSON.parse(String(init?.body));
    seen.push(body.state.rows.map((r: { name: string }) => r.name));
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) answers[r.id] = { type: "noul", noul: other(r.name) };
    return Response.json({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;
}

Deno.test("another company's row is dropped; a generic row and a short form of the brand stay", async () => {
  const seen: string[][] = [];
  const rows = [
    { name: "Nova Vanilla Wafer Bar", brand: "Nova" },
    { name: "Protein bar", brand: null },
    { name: "FZ Protein Bar Vanilla Wafer", brand: "FZ" },
  ];
  const fetchFn = jevAnswering((n) => (n.startsWith("Nova") ? 0.96 : 0.1), seen);
  const r = await otherBrandRows({ apiKey: "j", timeoutMs: 1000, fetchFn }, { name: "bar", brand: "Fitzo" }, rows);
  assertEquals(r.drop, [0]);
  assertEquals(seen.length, 1);
});

Deno.test("an unsure answer below the floor keeps the row", async () => {
  const fetchFn = jevAnswering(() => OTHER_BRAND_FLOOR - 0.05, []);
  const r = await otherBrandRows(
    { apiKey: "j", timeoutMs: 1000, fetchFn },
    { name: "bar", brand: "Fitzo" },
    [{ name: "Nova Bar", brand: "Nova" }],
  );
  assertEquals(r.drop, []);
});

Deno.test("Jev down: nothing is dropped", async () => {
  const r = await otherBrandRows(
    { apiKey: "j", timeoutMs: 1000, fetchFn: jevAnswering(() => 1, [], 500) },
    { name: "bar", brand: "Fitzo" },
    [{ name: "Nova Bar", brand: "Nova" }],
  );
  assertEquals(r.drop, []);
});

// ── 2 + 3 end to end: Precise, nothing on the web, another brand in the catalog ──

const NOVA: CandidateFood = {
  food_id: "nova-1", name: "Nova Biscotti Protein Bar", brand: "Nova", base_unit: "g",
  kcal: 388, protein_g: 35, carb_g: 30, fat_g: 16, fiber_g: 2, servings: [{ label: "1 bar", grams: 60 }], source: "catalog",
};

interface Run {
  catalogQueries: string[];
  fatsecretQueries: string[];
  decidePayload: Record<string, any> | null;
  tools: string[];
}

function preciseDeps(run: Run, catalog: (q: string) => CandidateFood[]): ParseMealDeps {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.includes("api.tavily.com/search")) return Response.json({ results: [OTHER_FLAVOUR] });
    if (u.includes("api.tavily.com/extract")) return Response.json({ results: [] });
    if (u.includes("typesafe.ai")) {
      const answers: Record<string, unknown> = {};
      // Brand check rows, and every web page: "different company" / "not this food".
      for (const r of body.state.rows ?? []) answers[r.id] = { type: "noul", noul: r.name.startsWith("Nova") ? 0.97 : 0.1 };
      for (const r of body.state.results ?? []) answers[r.id] = { type: "noul", noul: 0.05 };
      return Response.json({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (u.includes("openfoodfacts")) return Response.json({ products: [] });
    const tools: string[] = (body.tools ?? []).map((t: { name: string }) => t.name);
    const name = tools.find((t) => t !== "web_search") ?? "";
    run.tools.push(name);
    const reply = (input: unknown) =>
      Response.json({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name, input }] });
    if (name === "extract_meal") {
      return reply({ declined: false, meal_type_from_text: null, items: [{ name: "biscotti protein bar", brand: "Fitzo", quantity: 1, unit: "piece", prep: null }] });
    }
    if (name === "search_again") return reply({ name: SOLD_AS, queries: ["fitzo vanilla wafer bar label"] });
    if (name === "log_meal") {
      run.decidePayload = JSON.parse(body.messages[0].content);
      return reply({
        meal_type: "snack", drona_line: "ok",
        items: [{ food_name: "Fitzo protein bar", food_id: null, quantity: 1, serving_label: "1 bar", grams: 60, kcal: 230, protein_g: 18, carb_g: 24, fat_g: 8, source: "estimate", confidence: "low", assumption: "Couldn't find this exact label, so this is my estimate" }],
      });
    }
    throw new Error(`unexpected model call ${name}`);
  }) as typeof fetch;
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: true,
    searchFoods: async (q) => { run.catalogQueries.push(q); return catalog(q); },
    searchFatSecret: async (q) => { run.fatsecretQueries.push(q); return []; },
    backfillOffFood: async () => null, getFoodPer100: async () => null,
    fetchFn,
    webLookup: "tavily",
    tavily: { apiKey: "t", timeoutMs: 1000, fetchFn },
    jev: { apiKey: "j", timeoutMs: 1000, fetchFn },
    searchCountry: "india",
  };
}

const INPUT: ParseMealInput = {
  text: "had a fitzo biscotti protein bar", localHour: 10, mealHint: null, mode: "super",
  recentFoods: [], todayTotals: null, targets: null,
};
const newRun = (): Run => ({ catalogQueries: [], fatsecretQueries: [], decidePayload: null, tools: [] });

Deno.test("another company's bar never reaches decide as a candidate, only as a range for the estimate", async () => {
  const run = newRun();
  const r = await runParseMeal(preciseDeps(run, () => [NOVA]), INPUT);
  const item = run.decidePayload!.items[0];
  assertEquals(item.candidates, []);
  assertEquals(item.similar_products.map((s: { name: string }) => s.name), ["Nova Biscotti Protein Bar"]);
  assertEquals(item.similar_products[0].food_id, undefined);
  assertEquals(item.label_not_found, true);
  assert(r.steps.some((s) => s.tool === "brand_check"));
  assertEquals(r.parsed!.items[0].source, "estimate");
});

Deno.test("the rewrite's name leads the catalog search and is what FatSecret is asked", async () => {
  const run = newRun();
  await runParseMeal(preciseDeps(run, () => []), INPUT);
  assertEquals(run.catalogQueries[0], SOLD_AS);
  assertEquals(run.fatsecretQueries, [SOLD_AS]);
  assertEquals(run.decidePayload!.items[0].looked_up_as, SOLD_AS);
  assert(run.tools.includes("search_again"));
});

Deno.test("SEARCH_REWRITE=off: no rewrite call, the user's words drive every search", async () => {
  const run = newRun();
  const d = preciseDeps(run, () => []);
  d.searchRewrite = false;
  await runParseMeal(d, INPUT);
  assert(!run.tools.includes("search_again"));
  assertEquals(run.fatsecretQueries, ["Fitzo biscotti protein bar"]);
  assertEquals(run.decidePayload!.items[0].looked_up_as, undefined);
});

// ── 4. The double check looks up what the user said ────────────────────────

const LINE: ParsedItem = {
  food_id: "nova-1", food_name: "Nova Biscotti Protein Bar", quantity: 1, serving_label: "1 bar", grams: 60,
  kcal: 233, protein_g: 21, carb_g: 18, fat_g: 9.6, fiber_g: 1.2, source: "catalog", assumption: null, confidence: "medium",
};

Deno.test("a line filled from a row named differently carries the user's words", () => {
  const resolved = [{
    name: "biscotti protein bar", brand: "Fitzo", quantity: 1, unit: "piece", prep: null, candidates: [NOVA],
  }] as ResolvedItem[];
  assertEquals(stampSaidNames([LINE], resolved)[0].said_name, "Fitzo biscotti protein bar");
  // Same words as the card: nothing to add.
  const same = [{ ...resolved[0], name: "Nova Biscotti Protein Bar", brand: null }] as ResolvedItem[];
  assertEquals(stampSaidNames([LINE], same)[0].said_name, undefined);
});

Deno.test("the double check searches for the user's words, and the line takes the user's name back", async () => {
  const looked: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const tools: string[] = (body.tools ?? []).map((t: { name: string }) => t.name);
    const name = tools.find((t) => t !== "web_search") ?? "";
    const reply = (input: unknown) =>
      Response.json({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name, input }] });
    if (name === "extract_meal") return reply({ requests_research: true, items: [] });
    if (name === "report_labels") {
      const items = JSON.parse(body.messages[0].content) as Array<{ name: string }>;
      looked.push(...items.map((i) => i.name));
      return reply({ results: [{ for_item: items[0].name, found: true, per_100: { kcal: 380, protein_g: 28, carb_g: 40, fat_g: 12 }, source_note: "per the Fitzo label" }] });
    }
    throw new Error(`unexpected model call ${name}`);
  }) as typeof fetch;
  const d: ParseMealDeps = {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: true,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null, fetchFn,
  };
  const r = await runParseMeal(d, {
    text: "yes, look up the label for Fitzo biscotti protein bar online and check these numbers",
    localHour: 10, mealHint: null, recentFoods: [], todayTotals: null, targets: null,
    previousText: INPUT.text,
    previousItems: [{ ...LINE, said_name: "Fitzo biscotti protein bar" }],
  });
  assertEquals(looked, ["Fitzo biscotti protein bar"]);
  assertEquals(r.parsed!.items[0].food_name, "Fitzo biscotti protein bar");
  assertEquals(r.parsed!.items[0].kcal, 228);
});

// ── The double check looks up the tapped line, and only that line ───────────

function researchDeps(looked: string[]): ParseMealDeps {
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const tools: string[] = (body.tools ?? []).map((t: { name: string }) => t.name);
    const name = tools.find((t) => t !== "web_search") ?? "";
    const reply = (input: unknown) =>
      Response.json({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name, input }] });
    if (name === "extract_meal") return reply({ requests_research: true, items: [] });
    if (name === "report_labels") {
      const items = JSON.parse(body.messages[0].content) as Array<{ name: string }>;
      looked.push(...items.map((i) => i.name));
      return reply({ results: items.map((i) => ({ for_item: i.name, found: true, per_100: { kcal: 500, protein_g: 10, carb_g: 50, fat_g: 28 }, source_note: "label" })) });
    }
    throw new Error(`unexpected model call ${name}`);
  }) as typeof fetch;
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: true,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null, fetchFn,
  };
}

// Macros that add up to the kcal, so the Atwater check leaves untouched lines alone.
const line = (food_name: string, protein_g: number, carb_g: number, fat_g: number): ParsedItem => ({
  food_id: null, food_name, quantity: 100, serving_label: "g", grams: 100,
  kcal: 4 * protein_g + 4 * carb_g + 9 * fat_g, protein_g, carb_g, fat_g, fiber_g: null,
  source: "estimate", assumption: null, confidence: "medium",
});
const MEAL = [line("chicken", 27, 0, 14), line("peanuts", 26, 16, 49), line("banana", 1, 23, 0), line("chicken breast", 31, 0, 4)];
const ask = (previousItems: Array<ParsedItem & { research?: boolean }>) => ({
  text: "yes, look up the label for chicken breast online and check these numbers",
  localHour: 10, mealHint: null, recentFoods: [], todayTotals: null, targets: null,
  previousText: "chicken, peanuts, banana, chicken breast", previousItems,
});

Deno.test("the double check looks up only the tapped line, even the fourth, and leaves the rest alone", async () => {
  const looked: string[] = [];
  const r = await runParseMeal(researchDeps(looked), ask(MEAL.map((it, i) => (i === 3 ? { ...it, research: true } : it))));
  assertEquals(looked, ["chicken breast"]);
  // "chicken" matches the looked-up "chicken breast" by name and must not take its label.
  assertEquals(r.parsed!.items.map((i) => [i.food_name, i.kcal]), [
    ["chicken", 234], ["peanuts", 609], ["banana", 96], ["chicken breast", 500],
  ]);
});

Deno.test("an old app that marks no line still gets the first three looked up", async () => {
  const looked: string[] = [];
  await runParseMeal(researchDeps(looked), ask(MEAL));
  assertEquals(looked, ["chicken", "peanuts", "banana"]);
});
