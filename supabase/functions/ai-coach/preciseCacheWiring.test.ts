// Run with: deno test --allow-all supabase/functions/ai-coach/preciseCacheWiring.test.ts
//
// Phase 7b's half of the cache: the conversion into a candidate, and the
// promises the short-circuit makes by returning early from resolveOneItem.
// preciseCache.test.ts already owns the key/freshness/verification rules.

import { assertEquals } from "jsr:@std/assert@1";
import { cacheRowToCandidate } from "./parseMeal.ts";
import { cacheKey, type PreciseCacheRow } from "./preciseCache.ts";

const row = (over: Partial<PreciseCacheRow> = {}): PreciseCacheRow => ({
  id: "r1",
  cache_key: "milky mist|low fat paneer",
  display_name: "Milky Mist Low Fat Paneer",
  brand: "Milky Mist",
  base_unit: "g",
  kcal: 190,
  protein_g: 24,
  carb_g: 4,
  fat_g: 9,
  fiber_g: null,
  servings: [{ label: "100 g", grams: 100 }],
  evidence: [],
  verified: true,
  source_note: null,
  last_verified_at: new Date().toISOString(),
  ...over,
});

Deno.test("cache row carries NO food_id", () => {
  // The row is not in `foods` - 7d's nightly job decides that separately. An id
  // here would send verifyItems to the catalog to re-read numbers that are not
  // there, and blank the line. Same reason FatSecret candidates are id-less.
  assertEquals(cacheRowToCandidate(row()).food_id, null);
});

Deno.test("cache row keeps its own macros and identity", () => {
  const c = cacheRowToCandidate(row());
  assertEquals([c.kcal, c.protein_g, c.carb_g, c.fat_g], [190, 24, 4, 9]);
  assertEquals(c.name, "Milky Mist Low Fat Paneer");
  assertEquals(c.brand, "Milky Mist");
});

Deno.test("base_unit is narrowed, never passed through raw", () => {
  assertEquals(cacheRowToCandidate(row({ base_unit: "ml" })).base_unit, "ml");
  // The column is text in the DB; anything that is not ml must land on g
  // rather than widening CandidateFood's union by accident.
  assertEquals(cacheRowToCandidate(row({ base_unit: "kg" as never })).base_unit, "g");
});

Deno.test("zero-gram servings are dropped", () => {
  // A serving with no weight cannot convert a quantity, and gramsPerUnit would
  // reject it downstream anyway. Dropping it here keeps the candidate honest.
  const c = cacheRowToCandidate(row({
    servings: [{ label: "1 slice", grams: 0 }, { label: "100 g", grams: 100 }],
  }));
  assertEquals(c.servings.length, 1);
  assertEquals(c.servings[0].label, "100 g");
});

Deno.test("a null servings column does not throw", () => {
  assertEquals(cacheRowToCandidate(row({ servings: null as never })).servings, []);
});

Deno.test("the key the resolver looks up is the key the cache stores", () => {
  // The short-circuit calls cacheKey(item.name, item.brand). If the resolver
  // and the writer ever normalise differently, every lookup misses silently
  // and the cache costs money without ever paying out.
  assertEquals(cacheKey("Low Fat Paneer", "Milky Mist"), cacheKey("  low  fat   paneer ", "milky mist"));
});

// ── superLookupOne: the miss path ───────────────────────────────────────────
// The lookup itself is a model call, so these drive it through a stubbed
// fetchFn and assert on what the function DECIDES: the median, the physics
// gate, the verdict it stores, and that a write failure cannot cost the meal.

import { superLookupOne } from "./parseMeal.ts";
import type { ParseMealDeps } from "./parseMeal.ts";

const reading = (url: string | null, kcal: number) => ({
  url,
  per_100: { kcal, protein_g: 5, carb_g: 10, fat_g: 2, fiber_g: 1 },
});

/** A deps object whose one model call returns the given report_sources payload. */
function stubDeps(
  readings: unknown[],
  captured: { row?: Record<string, unknown> },
  opts: { putThrows?: boolean; serving?: [string, number] } = {},
): ParseMealDeps {
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000,
    webSearchEnabled: true, fastGrammarMode: "off",
    searchFoods: async () => [], backfillOffFood: async () => null,
    getFoodPer100: async () => null, getFoodServings: async () => [],
    preciseCachePut: async (row) => {
      if (opts.putThrows) throw new Error("db down");
      captured.row = row as unknown as Record<string, unknown>;
    },
    fetchFn: (async () => new Response(JSON.stringify({
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        name: "report_sources",
        input: {
          results: [{
            for_item: "protein bar",
            found: true,
            readings,
            ...(opts.serving ? { serving_label: opts.serving[0], serving_grams: opts.serving[1] } : {}),
            source_note: "per the label",
          }],
        },
      }],
      usage: {},
    }), { status: 200 })) as unknown as typeof fetch,
  };
}

const ITEM = { name: "protein bar", brand: null, quantity: 1, unit: "piece", prep: null };

Deno.test("two agreeing hosts verify, and the stored number is their median", () => {
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(stubDeps([reading("https://a.com/x", 380), reading("https://b.com/y", 400)], cap), ITEM, () => {}, () => {})
    .then((c) => {
      assertEquals(c?.kcal, 390);
      assertEquals(cap.row?.verified, true);
      assertEquals((cap.row?.evidence as unknown[]).length, 2);
    });
});

Deno.test("two pages of ONE host are one source, so nothing is verified", () => {
  // independenceKey folds by host. This is the failure the whole design exists
  // to prevent: a site repeating itself is not corroboration.
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(stubDeps([reading("https://a.com/x", 380), reading("https://a.com/y", 385)], cap), ITEM, () => {}, () => {})
    .then((c) => {
      assertEquals(c !== null, true);           // still usable, still cached
      assertEquals(cap.row?.verified, false);   // but never promotable
    });
});

Deno.test("an outlier is ignored by the median rather than dragging it", () => {
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(
    stubDeps([reading("https://a.com/1", 380), reading("https://b.com/2", 400), reading("https://c.com/3", 30)], cap),
    ITEM, () => {}, () => {},
  ).then((c) => {
    assertEquals(c?.kcal, 380);  // a mean would be 270 and fail its own bar
    assertEquals(cap.row?.verified, true);
  });
});

Deno.test("agreement on an impossible number is still refused", () => {
  // Physics before belief: sources agreeing does not make 900 kcal of protein
  // real, and a cached impossibility would go on to be promoted.
  const cap: { row?: Record<string, unknown> } = {};
  const huge = [
    { url: "https://a.com", per_100: { kcal: 900, protein_g: 90, carb_g: 90, fat_g: 90, fiber_g: 0 } },
    { url: "https://b.com", per_100: { kcal: 900, protein_g: 90, carb_g: 90, fat_g: 90, fiber_g: 0 } },
  ];
  return superLookupOne(stubDeps(huge, cap), ITEM, () => {}, () => {}).then((c) => {
    assertEquals(c, null);
    assertEquals(cap.row, undefined);  // nothing impossible is ever cached
  });
});

Deno.test("the pack's serving is carried onto the candidate", () => {
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(
    stubDeps([reading("https://a.com", 380), reading("https://b.com", 390)], cap, { serving: ["1 bar (60 g)", 60] }),
    ITEM, () => {}, () => {},
  ).then((c) => {
    assertEquals(c?.servings, [{ label: "1 bar (60 g)", grams: 60 }]);
  });
});

Deno.test("a failed cache write does not cost the user their line", () => {
  // The lookup already succeeded and the number is good. Losing the row costs
  // the NEXT lookup money; losing the line costs this user their meal.
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(
    stubDeps([reading("https://a.com", 380), reading("https://b.com", 390)], cap, { putThrows: true }),
    ITEM, () => {}, () => {},
  ).then((c) => assertEquals(c?.kcal, 385));
});

Deno.test("no readings means no candidate and no write", () => {
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(stubDeps([], cap), ITEM, () => {}, () => {}).then((c) => {
    assertEquals(c, null);
    assertEquals(cap.row, undefined);
  });
});
