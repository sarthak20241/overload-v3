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
