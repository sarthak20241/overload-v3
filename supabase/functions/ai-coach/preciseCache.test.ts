// Run with: deno test supabase/functions/ai-coach/preciseCache.test.ts
//
// Two things can go wrong in a cache of nutrition facts, and both of them are
// silent: serving a number that has aged out, and calling something "verified"
// on the strength of one source that answered twice.

import { assertEquals } from "jsr:@std/assert@1";
import {
  cacheKey,
  independenceKey,
  isFresh,
  kcalAgrees,
  meetsVerificationBar,
  PRECISE_CACHE_TTL_DAYS,
  type SourceReading,
} from "./preciseCache.ts";

const NOW = new Date("2026-08-27T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const reading = (
  source: SourceReading["source"],
  kcal: number,
  extra: Partial<SourceReading> = {},
): SourceReading => ({
  source,
  per_100: { kcal, protein_g: 10, carb_g: 5, fat_g: 8 },
  ...extra,
});

// ── freshness ──────────────────────────────────────────────────────────────

Deno.test("a row one day inside the TTL still serves", () => {
  assertEquals(isFresh(daysAgo(PRECISE_CACHE_TTL_DAYS - 1), NOW), true);
});

Deno.test("the failure this prevents: a reformulated product served forever", () => {
  // Past the TTL the row must be unusable, not merely deprioritised. A stale hit
  // does not degrade to an estimate, it ships a wrong number wearing a badge.
  assertEquals(isFresh(daysAgo(PRECISE_CACHE_TTL_DAYS + 1), NOW), false);
});

Deno.test("exactly at the TTL is already stale", () => {
  // The boundary belongs to expiry. Re-looking-up one day early costs a lookup;
  // one day late is the bug above.
  assertEquals(isFresh(daysAgo(PRECISE_CACHE_TTL_DAYS), NOW), false);
});

Deno.test("a timestamp we cannot read is stale, not fresh", () => {
  // A null or garbled column must not become an unexpiring row.
  assertEquals(isFresh("not a date", NOW), false);
});

Deno.test("a future timestamp does not buy extra life", () => {
  // Clock skew or a bad write should not create a row that outlives the TTL.
  assertEquals(isFresh(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW), false);
});

// ── keys ───────────────────────────────────────────────────────────────────

Deno.test("the same food typed two ways is one cache entry", () => {
  // Punctuation, case, accents and stray spacing are noise, not identity.
  assertEquals(
    cacheKey("  Milky-Mist   LOW FAT Panéer ", "Milky Mist"),
    cacheKey("milky mist low fat paneer", "milky  mist"),
  );
});

Deno.test("the failure this prevents: chocolate milk served as milk chocolate", () => {
  // Sorting the words would raise the hit rate and hand people a 535 kcal bar
  // when they drank a 60 kcal glass. Word order is identity.
  assertEquals(cacheKey("chocolate milk") === cacheKey("milk chocolate"), false);
});

Deno.test("a typo misses rather than collides", () => {
  // Fuzzy keys would let "creatine" hit "creatinine". A miss costs one lookup.
  assertEquals(cacheKey("panner") === cacheKey("paneer"), false);
});

// ── independence ───────────────────────────────────────────────────────────

Deno.test("FatSecret can never be one of the two sources", () => {
  // Their terms cover serving a request, not replicating the database, and a
  // promoted row IS a copy. Excluded at the identity level so no later rule can
  // accidentally let it back in.
  assertEquals(independenceKey(reading("fatsecret", 190)), null);
});

Deno.test("the failure this prevents: FatSecret laundered through OFF", () => {
  // An OFF row imported from a FatSecret export agreeing with FatSecret is one
  // reading, not two. Independence follows the origin, not the messenger.
  assertEquals(independenceKey(reading("off", 190, { derived_from: "fatsecret" })), null);
});

Deno.test("our own catalog cannot confirm itself", () => {
  // The web lookup exists to check the catalog row. Counting that row as evidence
  // would let every wrong row vouch for itself.
  assertEquals(independenceKey(reading("catalog", 190)), null);
});

Deno.test("two pages on one site are one source", () => {
  const a = independenceKey(reading("web", 190, { ref: "https://www.nutritionix.com/a" }));
  const b = independenceKey(reading("web", 190, { ref: "https://nutritionix.com/b" }));
  assertEquals(a, b);
});

// ── the verification bar ───────────────────────────────────────────────────

Deno.test("two independent sources within 10% verify", () => {
  const r = meetsVerificationBar(190, [
    reading("off", 190),
    reading("web", 200, { ref: "https://milkymist.com/paneer" }),
  ]);
  assertEquals(r.verified, true);
  assertEquals(r.agreeing, ["off", "web:milkymist.com"]);
});

Deno.test("the failure this prevents: one site quoted three times reads as consensus", () => {
  const r = meetsVerificationBar(190, [
    reading("web", 190, { ref: "https://nutritionix.com/a" }),
    reading("web", 191, { ref: "https://nutritionix.com/b" }),
    reading("web", 189, { ref: "https://www.nutritionix.com/c" }),
  ]);
  assertEquals(r.verified, false);
  assertEquals(r.agreeing, ["web:nutritionix.com"]);
});

Deno.test("agreement is with the value we kept, not between any two readings", () => {
  // 283 and 290 agree with each other and both disagree with the 190 we stored.
  // A pairwise test would verify a pair that lost the argument.
  const r = meetsVerificationBar(190, [
    reading("off", 283),
    reading("web", 290, { ref: "https://example.com/x" }),
  ]);
  assertEquals(r.verified, false);
});

Deno.test("a FatSecret-only row is never verified however many readings it has", () => {
  const r = meetsVerificationBar(190, [
    reading("fatsecret", 190, { ref: "https://platform.fatsecret.com/1" }),
    reading("fatsecret", 191, { ref: "https://platform.fatsecret.com/2" }),
  ]);
  assertEquals(r.verified, false);
  assertEquals(r.agreeing, []);
});

Deno.test("near-zero foods are not split by percentages", () => {
  // Black coffee at 2 kcal and 3 kcal is 50% apart and identical to a person.
  assertEquals(kcalAgrees(2, 3), true);
  // The absolute floor must not swallow a real gap on a real food.
  assertEquals(kcalAgrees(190, 283), false);
});
