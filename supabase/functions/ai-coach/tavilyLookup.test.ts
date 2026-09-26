// Run with: deno test --allow-all supabase/functions/ai-coach/tavilyLookup.test.ts
//
// Precise's Tavily + Jev web lookup. The network is faked at fetch, so these
// run the real client, the real Jev call shape and the real panel/arithmetic
// code, and count what each step was asked to do.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  findPanelText,
  foodLabel,
  type PageReport,
  readingFromReport,
  runTavilyLookup,
  type TavilyLookupDeps,
} from "./tavilyLookup.ts";
import { type ParseMealDeps, superLookupOne } from "./parseMeal.ts";

// ── Pure helpers ────────────────────────────────────────────────────────────

const PANEL =
  "Nutrition Information (per 100 g): Energy 72 kcal, Protein 3.1 g, Carbohydrate 4.6 g, " +
  "of which sugars 4.6 g, Total Fat 4.5 g, Saturated Fat 2.8 g. Serving size 200 g.";

Deno.test("findPanelText finds the panel inside a long page", () => {
  const page = "Buy now! Free delivery. ".repeat(400) + PANEL + " Reviews and ratings. ".repeat(300);
  const got = findPanelText(page);
  assert(got !== null);
  assert(got!.includes("Energy 72 kcal"));
  assert(got!.includes("Total Fat 4.5 g"));
  assert(got!.length <= 1600);
});

Deno.test("findPanelText ignores marketing that only name-drops protein", () => {
  assertEquals(findPanelText("High protein snack! Packed with protein for your gym day."), null);
  assertEquals(findPanelText(null), null);
});

Deno.test("findPanelText reads prose, short words and Hindi labels, not calories alone", () => {
  assert(findPanelText("A 100 g cup gives you 72 calories, 3.1 g of protein, 4.6 g of carbs and 4.5 g of fat.") !== null);
  assert(findPanelText("Per 100g: 72 cals, 3.1g protein, 4.6g carbohydrate, 4.5g fat") !== null);
  assert(findPanelText("ऊर्जा 72 किलो कैलोरी, प्रोटीन 3.1 ग्राम, कार्बोहाइड्रेट 4.6 ग्राम, वसा 4.5 ग्राम") !== null);
  // Calories with no macros is not a panel: the row needs protein, carbs and fat.
  assertEquals(findPanelText("Amul Masti Dahi has about 72 calories per 100 g."), null);
});

Deno.test("foodLabel does not repeat a brand already in the name", () => {
  assertEquals(foodLabel({ name: "Amul masti dahi", brand: "Amul" }), "Amul masti dahi");
  assertEquals(foodLabel({ name: "rice cake", brand: "Pintola" }), "Pintola rice cake");
  assertEquals(foodLabel({ name: "banana", brand: null }), "banana");
});

const report = (over: Partial<PageReport>): PageReport => ({
  page_id: "p1", same_food: true, basis: "per_100g", serving_grams: null, serving_label: null,
  kcal: 72, energy_kj: null, protein_g: 3.1, carb_g: 4.6, fat_g: 4.5, fiber_g: null, ...over,
});

Deno.test("readingFromReport keeps a per-100 g panel as printed", () => {
  const r = readingFromReport(report({}), "https://www.bigbasket.com/pd/1");
  assertEquals(r?.per_100, { kcal: 72, protein_g: 3.1, carb_g: 4.6, fat_g: 4.5, fiber_g: null });
  assertEquals(r?.source, "web");
  assertEquals(r?.via, "web_search");
});

Deno.test("readingFromReport converts per serving to per 100 g in code", () => {
  const r = readingFromReport(
    report({ basis: "per_serving", serving_grams: 30, kcal: 150, protein_g: 6, carb_g: 18, fat_g: 6 }),
    "https://example.com/x",
  );
  assertEquals(r?.per_100, { kcal: 500, protein_g: 20, carb_g: 60, fat_g: 20, fiber_g: null });
});

Deno.test("readingFromReport converts a kJ-only label", () => {
  const r = readingFromReport(report({ kcal: null, energy_kj: 418.4 }), "https://example.com/x");
  assertEquals(r?.per_100.kcal, 100);
});

Deno.test("readingFromReport rejects what cannot be a per-100 g panel", () => {
  // Per-pack numbers read as per 100 g.
  assertEquals(readingFromReport(report({ kcal: 2400 }), "https://e.com"), null);
  assertEquals(readingFromReport(report({ protein_g: 60, carb_g: 40, fat_g: 20 }), "https://e.com"), null);
  // A serving with no grams cannot be converted.
  assertEquals(readingFromReport(report({ basis: "per_serving", serving_grams: null }), "https://e.com"), null);
  assertEquals(readingFromReport(report({ same_food: false }), "https://e.com"), null);
  assertEquals(readingFromReport(report({ basis: "none" }), "https://e.com"), null);
});

Deno.test("readingFromReport classifies FatSecret and Open Food Facts pages", () => {
  assertEquals(readingFromReport(report({}), "https://www.fatsecret.co.in/x")?.source, "fatsecret");
  assertEquals(readingFromReport(report({}), "https://world.openfoodfacts.org/p/1")?.source, "off");
});

// ── The whole lookup, network faked ─────────────────────────────────────────

interface Calls {
  search: string[];
  extract: number;
  jev: number;
  /** 1 or 2 per Jev call: which look it was. */
  jevLooks: number[];
  read: number;
  readPages: string[][];
  readTexts: string[][];
}

const RIGHT = {
  title: "Amul Masti Dahi 400 g",
  url: "https://www.bigbasket.com/pd/amul-masti-dahi",
  content: "Amul Masti Dahi. " + PANEL,
  score: 0.8,
  raw_content: "Amul Masti Dahi product page. " + PANEL,
};
const WRONG = {
  title: "Amul Mishti Doi 100 g",
  url: "https://www.blinkit.com/prn/amul-mishti-doi",
  content: "Sweet. Energy 150 kcal, Protein 3 g, Carbohydrate 22 g, Fat 4 g",
  score: 0.9,
  raw_content: "Amul Mishti Doi. Energy 150 kcal, Protein 3 g, Carbohydrate 22 g, Fat 4 g per 100 g",
};

function fakeNet(opts: {
  searches?: Array<{ status?: number; results?: unknown[] }>;
  jevStatus?: number;
  /** Jev's yes for one result. `pieces` is the joined piece text, present only
   *  on the second look, which is when Jev can see the page's own words. */
  jevYes?: (r: { title: string; pieces?: string }) => number;
  /** Jev's piece choice for one result; default picks the first piece with kcal. */
  jevPiece?: (pieces: string[]) => { choice: string; confidence: number; probabilities: Record<string, number> };
  extractPages?: Array<{ url: string; raw_content: string }>;
}, calls: Calls): typeof fetch {
  let searchIdx = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.includes("api.tavily.com/search")) {
      calls.search.push(body.query);
      const s = opts.searches?.[searchIdx++] ?? { results: [] };
      if (s.status && s.status !== 200) return new Response("nope", { status: s.status });
      return Response.json({ results: s.results ?? [] });
    }
    if (u.includes("api.tavily.com/extract")) {
      calls.extract++;
      return Response.json({ results: opts.extractPages ?? [] });
    }
    if (u.includes("typesafe.ai")) {
      calls.jev++;
      if (opts.jevStatus && opts.jevStatus !== 200) return new Response("x", { status: opts.jevStatus });
      calls.jevLooks.push(body.state.results.some((r: { pieces?: unknown }) => r.pieces) ? 2 : 1);
      const answers: Record<string, unknown> = {};
      for (const r of body.state.results) {
        const pieces: string[] | undefined = r.pieces?.map((p: { text: string }) => p.text);
        answers[r.id] = {
          type: "noul",
          noul: opts.jevYes ? opts.jevYes({ title: r.title, pieces: pieces?.join(" ") }) : 0.9,
        };
        if (body.questions[`${r.id}_piece`] && pieces) {
          const pick = opts.jevPiece ? opts.jevPiece(pieces) : (() => {
            const k = pieces.findIndex((t) => /kcal/i.test(t));
            const choice = k >= 0 ? `p${k + 1}` : "none";
            return { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
          })();
          answers[`${r.id}_piece`] = { type: "choice", ...pick };
        }
      }
      return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

/** The reader: reports every page it was shown as a per-100 g panel read off
 *  its own text, so a page it should never have seen shows up in the numbers. */
function reader(calls: Calls) {
  return async (payload: Record<string, unknown>) => {
    calls.read++;
    const msg = JSON.parse((payload.messages as Array<{ content: string }>)[0].content);
    calls.readPages.push(msg.pages.map((p: { site: string }) => p.site));
    calls.readTexts.push(msg.pages.map((p: { text: string }) => p.text));
    return {
      content: [{
        type: "tool_use",
        name: "report_page_panels",
        input: {
          pages: msg.pages.map((p: { page_id: string; text: string }) => {
            const kcal = Number(/Energy (\d+) kcal/.exec(p.text)?.[1] ?? NaN);
            return {
              page_id: p.page_id, same_food: true, basis: "per_100g", serving_grams: 200,
              serving_label: "1 cup (200 g)", kcal, protein_g: 3, carb_g: 5, fat_g: 4, fiber_g: null,
            };
          }),
        },
      }],
    };
  };
}

function lookupDeps(fetchFn: typeof fetch, calls: Calls, withJev = true): TavilyLookupDeps {
  return {
    tavily: { apiKey: "tvly-test", timeoutMs: 1000, fetchFn },
    jev: withJev ? { apiKey: "jev-test", timeoutMs: 1000, fetchFn } : null,
    country: "india",
    model: "m",
    callModel: reader(calls),
  };
}

const newCalls = (): Calls => ({ search: [], extract: 0, jev: 0, jevLooks: [], read: 0, readPages: [], readTexts: [] });
const DAHI = { name: "masti dahi", brand: "Amul" };

Deno.test("Jev drops the wrong product before the reader ever sees it", async () => {
  const calls = newCalls();
  const net = fakeNet({
    searches: [{ results: [WRONG, RIGHT] }],
    jevYes: (r) => (r.title.includes("Masti") ? 0.93 : 0.08),
  }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(out.unavailable, false);
  assertEquals(calls.jevLooks, [1, 2]);
  assertEquals(calls.readPages, [["bigbasket.com"]]);
  assertEquals(out.finding?.readings.map((r) => r.per_100.kcal), [72]);
  assertEquals(out.finding?.serving_grams, 200);
  assertEquals(out.credits, 1);
  assertEquals(calls.search.length, 1);
});

Deno.test("a Tavily outage is reported as unavailable, so the caller can fall back", async () => {
  const calls = newCalls();
  const net = fakeNet({ searches: [{ status: 401 }] }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(out.unavailable, true);
  assertEquals(out.finding, null);
  assertEquals(out.credits, 0);
  assertEquals(calls.read, 0);
});

Deno.test("out of credits is an outage too", async () => {
  const calls = newCalls();
  const out = await runTavilyLookup(lookupDeps(fakeNet({ searches: [{ status: 432 }] }, calls), calls), DAHI);
  assertEquals(out.unavailable, true);
});

Deno.test("credits running out on the second search still falls back", async () => {
  const calls = newCalls();
  const net = fakeNet({ searches: [{ results: [WRONG] }, { status: 432 }], jevYes: () => 0.1 }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(calls.search.length, 2);
  assertEquals(out.unavailable, true);
  assertEquals(out.finding, null);
});

Deno.test("no relevant page on the first search runs the second, and stops there", async () => {
  const calls = newCalls();
  const net = fakeNet({
    searches: [{ results: [WRONG] }, { results: [RIGHT] }],
    jevYes: (r) => (r.title.includes("Masti") ? 0.9 : 0.1),
  }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(calls.search.length, 2);
  assertEquals(out.credits, 2);
  assertEquals(out.finding?.readings.length, 1);
});

Deno.test("found nothing is an answer, not an outage", async () => {
  const calls = newCalls();
  const net = fakeNet({ searches: [{ results: [WRONG] }, { results: [] }], jevYes: () => 0.1 }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(out.unavailable, false);
  assertEquals(out.finding, null);
  assertEquals(calls.read, 0);
});

Deno.test("a relevant page with no panel in its search text is extracted", async () => {
  const calls = newCalls();
  const bare = { ...RIGHT, content: "Amul Masti Dahi, fresh and thick.", raw_content: null };
  const net = fakeNet({
    searches: [{ results: [bare] }],
    extractPages: [{ url: RIGHT.url, raw_content: "Label. " + PANEL }],
  }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(calls.extract, 1);
  assertEquals(out.credits, 2);
  assertEquals(out.finding?.readings[0].per_100.kcal, 72);
});

Deno.test("Jev down: relevance falls back to Tavily's ranking and the lookup still answers", async () => {
  const calls = newCalls();
  const net = fakeNet({ searches: [{ results: [RIGHT] }], jevStatus: 500 }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(out.unavailable, false);
  assertEquals(out.finding?.readings.length, 1);
  assert(out.steps.some((s) => s.tool === "web_relevance" && (s.input as { mode: string }).mode === "fallback"));
});

// ── Wired into Precise (superLookupOne) ─────────────────────────────────────

function preciseDeps(fetchFn: typeof fetch, provider: "anthropic" | "tavily"): ParseMealDeps {
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: true,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null,
    fetchFn,
    webLookup: provider,
    tavily: { apiKey: "tvly-test", timeoutMs: 1000, fetchFn },
    jev: { apiKey: "jev-test", timeoutMs: 1000, fetchFn },
    searchCountry: "india",
  };
}

/** Routes Tavily/Jev to fakeNet and Anthropic to a canned answer, counting
 *  which Anthropic tool each call carried. */
function preciseNet(tavilyStatus: number, anthropicTools: string[][]): typeof fetch {
  const calls = newCalls();
  const tav = fakeNet({ searches: [{ status: tavilyStatus, results: [RIGHT] }] }, calls);
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("anthropic")) return tav(url, init);
    const body = JSON.parse(String(init?.body));
    const tools = (body.tools ?? []).map((t: { name: string }) => t.name);
    anthropicTools.push(tools);
    if (tools.includes("report_page_panels")) {
      return Response.json({
        stop_reason: "tool_use",
        usage: { input_tokens: 900, output_tokens: 80 },
        content: [{
          type: "tool_use", name: "report_page_panels",
          input: { pages: [{ page_id: "p1", same_food: true, basis: "per_100g", kcal: 72, protein_g: 3.1, carb_g: 4.6, fat_g: 4.5 }] },
        }],
      });
    }
    // The old server-tool lookup.
    return Response.json({
      stop_reason: "tool_use",
      usage: { input_tokens: 20000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
      content: [{
        type: "tool_use", name: "report_sources",
        input: {
          results: [{
            for_item: "masti dahi", found: true,
            readings: [{ url: "https://amul.com/x", per_100: { kcal: 70, protein_g: 3, carb_g: 4.5, fat_g: 4.3 } }],
          }],
        },
      }],
    });
  }) as typeof fetch;
}

const ITEM = { name: "masti dahi", brand: "Amul", quantity: 1, unit: "cup" } as never;

Deno.test("Precise on tavily never calls the server-side web search", async () => {
  const tools: string[][] = [];
  const usage: any[] = [];
  const found = await superLookupOne(preciseDeps(preciseNet(200, tools), "tavily"), ITEM, (d) => usage.push(d), () => {});
  assertEquals(found?.kcal !== undefined, true);
  assertEquals(tools, [["report_page_panels"]]);
  assertEquals(usage.some((d) => d.tavily_credits === 1), true);
});

Deno.test("Precise on tavily falls back to the server-side search when Tavily is down", async () => {
  const tools: string[][] = [];
  const steps: string[] = [];
  const found = await superLookupOne(
    preciseDeps(preciseNet(401, tools), "tavily"), ITEM, () => {}, () => {}, (s) => steps.push(s.tool),
  );
  assert(found !== null);
  assertEquals(tools, [["web_search", "report_sources"]]);
  assert(steps.includes("web_fallback"));
});

Deno.test("Precise on anthropic is unchanged", async () => {
  const tools: string[][] = [];
  await superLookupOne(preciseDeps(preciseNet(200, tools), "anthropic"), ITEM, () => {}, () => {});
  assertEquals(tools, [["web_search", "report_sources"]]);
});

// ── Jev's second look (a page it could barely see) ──────────────────────────

const AMUL_SITE = {
  title: "Amul Masti Dahi",
  url: "https://amul.com/products/amul-masti-dahi",
  content: "Amul Masti Dahi",
  score: 0.5,
  raw_content: null,
};

Deno.test("an unsure page Jev could barely see is extracted and judged again with its own text", async () => {
  const calls = newCalls();
  const net = fakeNet({
    searches: [{ results: [AMUL_SITE] }],
    jevYes: (r) => (r.pieces?.includes("Energy 72") ? 0.91 : 0.64),
    extractPages: [{ url: AMUL_SITE.url, raw_content: "Amul Masti Dahi 400 g cup. " + PANEL }],
  }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(calls.extract, 1);
  assertEquals(calls.jevLooks, [1, 2]);
  assertEquals(calls.readPages, [["amul.com"]]);
  assertEquals(out.credits, 2);
  assertEquals(out.finding?.readings[0].per_100.kcal, 72);
});

Deno.test("the second look can say no, and the page is never read", async () => {
  const calls = newCalls();
  const net = fakeNet({
    searches: [{ results: [AMUL_SITE] }, { results: [] }],
    jevYes: (r) => (r.pieces?.includes("Low Fat") ? 0.05 : 0.64),
    extractPages: [{
      url: AMUL_SITE.url,
      raw_content: "Amul Low Fat Protein Dahi. Energy 60 kcal, Protein 8 g, Carbohydrate 5 g, Fat 1 g",
    }],
  }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(calls.jevLooks, [1, 2]);
  assertEquals(calls.read, 0);
  assertEquals(out.finding, null);
});

Deno.test("a page Jev rejects outright is not extracted", async () => {
  const calls = newCalls();
  const net = fakeNet({ searches: [{ results: [AMUL_SITE] }, { results: [] }], jevYes: () => 0.2 }, calls);
  await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(calls.extract, 0);
});

// ── Jev picks the piece ─────────────────────────────────────────────────────

const FILLER = " Free delivery in 10 minutes. Add to cart. ".repeat(40);
// The similar-products box carries MORE nutrition words than the real panel,
// so a word-count pick would take it. Only reading the product name tells them apart.
const SIMILAR = "You may also like: Amul Mishti Doi. Energy 150 kcal, Protein 3 g, Carbohydrate 22 g, " +
  "Total Fat 4 g, Saturated Fat 2.5 g, Trans Fat 0 g, Energy per cup 150 kcal.";
const TWO_PANELS = {
  ...RIGHT,
  raw_content: "Amul Masti Dahi 400 g." + FILLER + "Amul Masti Dahi nutrition: " + PANEL + FILLER + SIMILAR,
};
const pickMasti = (pieces: string[]) => {
  const k = pieces.findIndex((t) => t.includes("Masti Dahi nutrition"));
  return { choice: `p${k + 1}`, confidence: 0.88, probabilities: { [`p${k + 1}`]: 0.88 } };
};

Deno.test("Jev picks the product's own panel over a similar-products box", async () => {
  const calls = newCalls();
  const net = fakeNet({ searches: [{ results: [TWO_PANELS] }], jevPiece: pickMasti }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(calls.readTexts.length, 1);
  assert(calls.readTexts[0][0].includes("Energy 72 kcal"));
  assert(!calls.readTexts[0][0].includes("Mishti"));
  assertEquals(out.finding?.readings[0].per_100.kcal, 72);
});

Deno.test("Jev unsure which piece: the reader gets the top two and picks by name", async () => {
  const calls = newCalls();
  const net = fakeNet({
    searches: [{ results: [TWO_PANELS] }],
    jevPiece: (pieces) => {
      const masti = pieces.findIndex((t) => t.includes("Masti Dahi nutrition")) + 1;
      const box = pieces.findIndex((t) => t.includes("Mishti")) + 1;
      return { choice: `p${box}`, confidence: 0.5, probabilities: { [`p${box}`]: 0.5, [`p${masti}`]: 0.45, none: 0.05 } };
    },
  }, calls);
  await runTavilyLookup(lookupDeps(net, calls), DAHI);
  const text = calls.readTexts[0][0];
  assert(text.includes("Energy 72 kcal") && text.includes("Mishti"));
});

Deno.test("Jev says no piece is this food's panel: the page is not read", async () => {
  const calls = newCalls();
  const net = fakeNet({
    searches: [{ results: [TWO_PANELS] }, { results: [] }],
    jevPiece: () => ({ choice: "none", confidence: 0.8, probabilities: { none: 0.8 } }),
  }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(calls.read, 0);
  assertEquals(out.finding, null);
});

Deno.test("a kept page with only a snippet is fetched in full before it is read", async () => {
  const calls = newCalls();
  // The snippet names every macro, as percentages: pieces, but no panel.
  const snippetOnly = {
    title: "Nutrition Facts for Amul Masti Dahi",
    url: "https://tools.myfooddata.com/nutrition-facts/amul-masti-dahi",
    content: "There are 72 calories in Amul Masti Dahi coming from 17% protein, 26% carbs, 57% fat.",
    score: 0.7,
    raw_content: null,
  };
  const net = fakeNet({
    searches: [{ results: [snippetOnly] }],
    extractPages: [{ url: snippetOnly.url, raw_content: "Amul Masti Dahi. " + PANEL }],
  }, calls);
  const out = await runTavilyLookup(lookupDeps(net, calls), DAHI);
  assertEquals(calls.extract, 1);
  assert(calls.readTexts[0][0].includes("Energy 72 kcal"));
  assertEquals(out.finding?.readings[0].per_100.kcal, 72);
});
