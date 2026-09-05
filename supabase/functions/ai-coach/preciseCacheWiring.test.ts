// Run with: deno test --allow-all supabase/functions/ai-coach/preciseCacheWiring.test.ts
//
// Phase 7b's half of the cache: the conversion into a candidate, and the
// promises the short-circuit makes by returning early from resolveOneItem.
// preciseCache.test.ts already owns the key/freshness/verification rules.

import { assertEquals } from "jsr:@std/assert@1";
import {
  cacheRowToCandidate,
  isEphemeralId,
  type ParsedItem,
  stripEphemeralIds,
} from "./parseMeal.ts";

/** Minimal ParsedItem, so the stripper can be exercised on one field. */
const EMPTY: ParsedItem = {
  food_id: null, food_name: "x", quantity: 1, serving_label: "g", grams: 1,
  kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: null,
  source: "estimate", assumption: null, confidence: "low",
};
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

Deno.test("cache row carries an EPHEMERAL id, never a real one", () => {
  // It needs SOME id or decide cannot select it and silently estimates instead
  // - measured on the canonical case, where a correct web answer was resolved
  // and then ignored for being unaddressable. But precise_cache is not `foods`,
  // so the id must be ephemeral and get stripped before it reaches
  // meal_entries' uuid FK. Same mechanism FatSecret uses.
  const id = cacheRowToCandidate(row()).food_id;
  assertEquals(isEphemeralId(id), true);
  assertEquals(id?.startsWith("fs:"), true);
  // And it must round-trip through the stripper as null, never as a fake uuid.
  assertEquals(stripEphemeralIds([{ ...EMPTY, food_id: id }])[0].food_id, null);
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

// ── The evidence has to LEAVE the lookup ────────────────────────────────────
// superLookupOne judged the sources and then kept the verdict to itself: the
// cache row knew, and the candidate handed back to the pipeline did not. So
// decide stated a number two sources fought over exactly as flatly as one they
// agreed on, and the client had nothing to badge. These pin the carry.

import {
  buildDecideSystemPrompt,
  candidatePayload,
  type CandidateFood,
  type ParseMealInput,
  type ResolvedItem,
  verifiedForItems,
} from "./parseMeal.ts";

Deno.test("agreeing sources leave the lookup as verified, spread zero", () => {
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(
    stubDeps([reading("https://a.com/x", 380), reading("https://b.com/y", 400)], cap),
    ITEM, () => {}, () => {},
  ).then((c) => {
    assertEquals(c?.verified, true);
    assertEquals(c?.kcal_spread, 0.05);
    // Same verdict the row got. The candidate and the cache must never be able
    // to say different things about one lookup.
    assertEquals(cap.row?.verified, c?.verified);
  });
});

Deno.test("disagreeing sources leave the lookup unverified, with the gap", () => {
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(
    stubDeps([reading("https://a.com/x", 190), reading("https://b.com/y", 283)], cap),
    ITEM, () => {}, () => {},
  ).then((c) => {
    assertEquals(c?.verified, false);
    assertEquals(Math.round((c?.kcal_spread ?? 0) * 100), 33);
    assertEquals(cap.row?.verified, false);
  });
});

const candidate = (over: Partial<CandidateFood> = {}): CandidateFood => ({
  food_id: "fs:web_protein bar",
  name: "Protein Bar",
  brand: null,
  base_unit: "g",
  kcal: 380,
  protein_g: 20,
  carb_g: 40,
  fat_g: 12,
  fiber_g: null,
  servings: [],
  source: "catalog",
  ...over,
});

Deno.test("a candidate its sources agreed on says NOTHING to decide", () => {
  // The payload is cached input tokens on every meal anyone logs. A per-item
  // "sources agreed" line would pay for itself on none of them, and silence is
  // already the signal.
  const p = candidatePayload(candidate({ verified: true, kcal_spread: 0.05 }));
  assertEquals("sources_disagree_pct" in p, false);
  // Nor does an untouched catalog row, which was never put through the bar.
  assertEquals("sources_disagree_pct" in candidatePayload(candidate()), false);
});

Deno.test("a candidate its sources fought over is flagged to decide", () => {
  const p = candidatePayload(candidate({ verified: false, kcal_spread: 0.33 }));
  assertEquals(p.sources_disagree_pct, 33);
});

Deno.test("the decide prompt tells the model what that flag means", () => {
  // The flag and the rule that reads it are one mechanism. If the field is ever
  // renamed and the prompt is not, decide is handed a key it was never told
  // about and hedges on nothing.
  const input = {
    text: "one protein bar",
    localHour: 9,
    mealHint: null,
    recentFoods: [],
    todayTotals: null,
    targets: null,
  } as unknown as ParseMealInput;
  const prompt = buildDecideSystemPrompt(input);
  assertEquals(prompt.includes("sources_disagree_pct"), true);
});

Deno.test("verified rides the food_id to the logged line, then the id goes", () => {
  // stripEphemeralIds is the last moment the id exists, which is why the stamp
  // happens there: after it there is no handle back to the candidate at all.
  const c = candidate({ verified: true });
  const resolved = [{
    name: "protein bar", brand: null, quantity: 1, unit: "piece", prep: null,
    candidates: [c],
  }] as unknown as ResolvedItem[];
  const line: ParsedItem = { ...EMPTY, food_id: c.food_id, source: "catalog" };
  const [out] = stripEphemeralIds([line], verifiedForItems(resolved));
  assertEquals(out.verified, true);
  assertEquals(out.food_id, null);
});

Deno.test("a line no one researched is left unstamped, never stamped false", () => {
  // Absent means "we never asked", false means "we asked and it failed". A
  // catalog row that was never put through the bar must not be badged as a
  // failure, so it must not carry the field at all.
  const c = candidate({ food_id: "11111111-2222-3333-4444-555555555555" });
  const resolved = [{
    name: "roti", brand: null, quantity: 1, unit: "piece", prep: null,
    candidates: [c],
  }] as unknown as ResolvedItem[];
  const [out] = stripEphemeralIds(
    [{ ...EMPTY, food_id: c.food_id, source: "catalog" }],
    verifiedForItems(resolved),
  );
  assertEquals("verified" in out, false);
  assertEquals(out.food_id, c.food_id);  // a real uuid survives the strip
});

Deno.test("a cache hit carries the same evidence a fresh lookup would", () => {
  // Otherwise the badge and decide's hedging flicker on cache state: contested
  // for whoever paid for the lookup, plain fact for everyone served the row.
  const contested = cacheRowToCandidate(row({
    verified: false,
    evidence: [
      { source: "web", ref: "https://a.com", per_100: { kcal: 190, protein_g: 24, carb_g: 4, fat_g: 9 } },
      { source: "off", ref: null, per_100: { kcal: 283, protein_g: 20, carb_g: 3, fat_g: 22 } },
    ],
  }));
  assertEquals(contested.verified, false);
  assertEquals(candidatePayload(contested).sources_disagree_pct, 33);

  const agreed = cacheRowToCandidate(row({
    verified: true,
    evidence: [
      { source: "web", ref: "https://a.com", per_100: { kcal: 190, protein_g: 24, carb_g: 4, fat_g: 9 } },
      { source: "off", ref: null, per_100: { kcal: 192, protein_g: 24, carb_g: 4, fat_g: 9 } },
    ],
  }));
  assertEquals(agreed.verified, true);
  assertEquals("sources_disagree_pct" in candidatePayload(agreed), false);
});

Deno.test("a cache row with no stored evidence is unflagged, not contested", () => {
  // Rows written before evidence was kept, and rows whose readings did not
  // survive the JSON round trip. Nothing to compare is not a disagreement.
  const c = cacheRowToCandidate(row({ verified: true, evidence: [] }));
  assertEquals(c.kcal_spread, undefined);
  assertEquals("sources_disagree_pct" in candidatePayload(c), false);
});

// ── The PARSING boundary: null must survive as null ─────────────────────────
// reconcileReadings.test.ts hands reconcileReadings hand-built readings with
// real nulls, so it proves the maths and never the path that feeds it. These
// go through runSuperLookup's parsing, which is where a null was being turned
// back into a 0 - the schema was made nullable so a page could say "protein
// not printed", and four lines later that answer was overwritten.
//
// The all-null panel was never the survivor: hasComposition drops 0/0/0 beside
// real calories whole. It is the PARTIAL panel that got through - carbs and fat
// stated, protein omitted - because its carbs cleared hasComposition and then
// its fake 0 voted in the protein median.

/** A reading whose per_100 is spelled out, so a macro can be genuinely absent. */
const panel = (url: string, per: Record<string, number | null>) => ({ url, per_100: per });

Deno.test("a page that omits protein does not vote 0 into the protein median", () => {
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(
    stubDeps([
      // Two hosts print carbs and fat but no protein line at all. One host does.
      panel("https://a.com", { kcal: 470, carb_g: 80, fat_g: 18 }),
      panel("https://b.com", { kcal: 472, protein_g: 3.6, carb_g: 75, fat_g: 17.5 }),
      panel("https://c.com", { kcal: 470, carb_g: 80, fat_g: 18 }),
    ], cap),
    ITEM, () => {}, () => {},
  ).then((c) => {
    // THE BUG: with null flattened to 0 the pool was [0, 3.6, 0] -> 0 g protein
    // for a food that plainly has some. Only the source that stated it votes.
    assertEquals(c?.protein_g, 3.6);
    const ev = cap.row?.evidence as Array<{ per_100: Record<string, unknown> }>;
    assertEquals(ev[0].per_100.protein_g, null);   // recorded as "not stated"
    assertEquals(ev[1].per_100.protein_g, 3.6);
  });
});

Deno.test("a STATED zero is not a missing one: oil keeps its 0 g protein", () => {
  // The reason the fix is null-vs-0 and not "treat 0 as missing". Oil really is
  // 0 g protein and 0 g carb; a blanket rule would throw that truth away.
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(
    stubDeps([
      panel("https://a.com", { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 }),
      panel("https://b.com", { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 }),
    ], cap),
    ITEM, () => {}, () => {},
  ).then((c) => {
    assertEquals(c?.protein_g, 0);
    assertEquals(c?.carb_g, 0);
    const ev = cap.row?.evidence as Array<{ per_100: Record<string, unknown> }>;
    assertEquals(ev[0].per_100.protein_g, 0);      // stated, so kept as 0
  });
});

Deno.test("a reading with kcal and no panel at all still counts for energy", () => {
  // Unchanged by the fix, asserted so it stays that way: a page can quote
  // calories with no breakdown, and that is real evidence of the energy even
  // though it states no macro.
  const cap: { row?: Record<string, unknown> } = {};
  return superLookupOne(
    stubDeps([
      panel("https://a.com", { kcal: 380 }),
      panel("https://b.com", { kcal: 384, protein_g: 20, carb_g: 40, fat_g: 12 }),
    ], cap),
    ITEM, () => {}, () => {},
  ).then((c) => {
    assertEquals(c?.kcal, 382);        // both readings vote on energy
    assertEquals(c?.protein_g, 20);    // only the one with a panel votes on protein
  });
});
