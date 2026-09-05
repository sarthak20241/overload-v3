// Run with: deno test supabase/functions/ai-coach/preciseCache.test.ts
//
// Two things can go wrong in a cache of nutrition facts, and both of them are
// silent: serving a number that has aged out, and calling something "verified"
// on the strength of one source that answered twice.

import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  cacheKey,
  independenceKey,
  isFresh,
  kcalAgrees,
  kcalSpread,
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

Deno.test("a FatSecret reading of unknown provenance is excluded", () => {
  // The API is a contract: we accepted terms to call it, and those terms cover
  // serving a request rather than replicating the database. Absent `via` means we
  // cannot show the reading came off a public page, so it does not count.
  assertEquals(independenceKey(reading("fatsecret", 190)), null);
  assertEquals(independenceKey(reading("fatsecret", 190, { ref: "food_id:12345" })), null);
});

Deno.test("A URL DOES NOT MAKE IT PUBLIC: api-derived evidence stays excluded", () => {
  // The regression this guards is subtle and was in the first cut of this rule.
  // FatSecret's food.get returns a food_url, so the natural thing to do when
  // citing sources is to attach it - and a "has an http(s) ref" test would then
  // have let paid-API evidence count toward promotion into the shared catalog.
  // Provenance is stated, never inferred.
  assertEquals(
    independenceKey(reading("fatsecret", 190, {
      ref: "https://www.fatsecret.com/calories-nutrition/x", via: "api",
    })),
    null,
  );
});

Deno.test("a FatSecret PAGE found by web search counts like any other site", () => {
  // Changed 2026-09-05 on Sarthak's call. The restriction follows the API, not
  // the brand: a page a web search landed on is public, we agreed to nothing to
  // read it, and the number on it is the manufacturer's printed panel. Excluding
  // it cost real answers - the Milky Mist paneer row sat at verified: false
  // holding a correct 190 kcal only because its second source was this host.
  assertEquals(
    independenceKey(reading("fatsecret", 190, {
      ref: "https://www.fatsecret.co.in/x/100g", via: "web_search",
    })),
    "web:fatsecret.co.in",
  );
});

Deno.test("a FatSecret page and a different site verify a row together", () => {
  const r = meetsVerificationBar(190, [
    reading("fatsecret", 190, {
      ref: "https://www.fatsecret.co.in/calories-nutrition/x/100g", via: "web_search",
    }),
    reading("web", 189, { ref: "https://www.mynetdiary.com/food/x.html", via: "web_search" }),
  ]);
  assertEquals(r.verified, true);
  assertEquals(r.agreeing, ["web:fatsecret.co.in", "web:mynetdiary.com"]);
});

Deno.test("OFF is a full independent source, whatever origin it declares", () => {
  // User decision 2026-08-27. An earlier rule discounted OFF rows that named a
  // FatSecret origin; derived_from is now recorded and ignored, and this test is
  // what stops it quietly coming back.
  assertEquals(independenceKey(reading("off", 190, { derived_from: "fatsecret" })), "off");
  assertEquals(independenceKey(reading("off", 190)), "off");
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

Deno.test("OFF plus one web host clears the bar even next to FatSecret evidence", () => {
  // The licensing rule removes FatSecret from the count; it does not poison the
  // readings around it.
  const r = meetsVerificationBar(190, [
    reading("fatsecret", 190),
    reading("off", 188, { derived_from: "fatsecret" }),
    reading("web", 195, { ref: "https://milkymist.com/paneer" }),
  ]);
  assertEquals(r.verified, true);
  assertEquals(r.agreeing, ["off", "web:milkymist.com"]);
});

Deno.test("two pages of one FatSecret host are still one source", () => {
  // The host rule does the work now that the blanket exclusion is gone: two pages
  // on the same site are one reading however many of them agree, exactly as for
  // any other host. So a row backed only by FatSecret still cannot verify itself.
  const r = meetsVerificationBar(190, [
    reading("fatsecret", 190, { ref: "https://platform.fatsecret.com/1", via: "web_search" }),
    reading("fatsecret", 191, { ref: "https://platform.fatsecret.com/2", via: "web_search" }),
  ]);
  assertEquals(r.verified, false);
  assertEquals(r.agreeing, ["web:platform.fatsecret.com"]);
});

Deno.test("near-zero foods are not split by percentages", () => {
  // Black coffee at 2 kcal and 3 kcal is 50% apart and identical to a person.
  assertEquals(kcalAgrees(2, 3), true);
  // The absolute floor must not swallow a real gap on a real food.
  assertEquals(kcalAgrees(190, 283), false);
});

// ── kcalSpread: the other half of the verdict ───────────────────────────────
// meetsVerificationBar answers "may anyone vouch for this"; kcalSpread answers
// "how far apart was what we read". Decide hedges on the second one.

Deno.test("readings that land together spread to zero", () => {
  assertEquals(kcalSpread([reading("web", 380), reading("web", 380)]), 0);
});

Deno.test("the spread is measured against the LARGEST reading", () => {
  // Same denominator kcalAgrees uses, so one threshold governs both: 190 vs 283
  // fails agreement, and must read as a spread above VERIFY_TOLERANCE here.
  const s = kcalSpread([reading("web", 190), reading("off", 283)]);
  assertEquals(Math.round((s ?? 0) * 100), 33);
});

Deno.test("one reading is neither agreement nor disagreement", () => {
  // Null, not 0. A lone source reported as "0% apart" would look like consensus
  // to anything downstream reading only this number, and thin evidence is what
  // `verified` exists to report.
  assertEquals(kcalSpread([reading("web", 380)]), null);
  assertEquals(kcalSpread([]), null);
});

Deno.test("near-zero foods do not read as contested either", () => {
  // The same floor kcalAgrees applies. Without it black coffee read at 2 and 3
  // kcal would ship a "sources disagree by 33%" warning on a 1 kcal gap.
  assertEquals(kcalSpread([reading("web", 2), reading("off", 3)]), 0);
});

Deno.test("spread counts sources verification is not allowed to count", () => {
  // Deliberately wider than independenceKey. FatSecret may never VOUCH for a
  // number, but a FatSecret page disagreeing with the web by a third is still
  // us failing to reconcile what we read, and the user deserves the hedge.
  const evidence = [
    reading("web", 300, { ref: "https://a.com/x" }),
    reading("fatsecret", 200, { ref: "https://platform.fatsecret.com/1" }),
  ];
  assertEquals(meetsVerificationBar(300, evidence).verified, false);
  assertEquals(Math.round((kcalSpread(evidence) ?? 0) * 100), 33);
});

// ── Non-ASCII names must not all collide on one row ────────────────────────
// Flagged by CodeRabbit on PR #139. The normaliser keeps only [a-z0-9], so a
// name written entirely outside ASCII collapsed to "" and every such food shared
// a single cache row - the expensive failure, since a false hit serves one food's
// macros for another.

Deno.test("a name with no ASCII characters still gets a key", () => {
  const k = cacheKey("पनीर");
  assertNotEquals(k, "");
  assertEquals(k.startsWith("u:"), true, k);
});

Deno.test("two different non-ASCII names do not collide", () => {
  assertNotEquals(cacheKey("पनीर"), cacheKey("豆腐"));
});

Deno.test("the fallback is stable for the same input", () => {
  assertEquals(cacheKey("豆腐"), cacheKey("豆腐"));
});

Deno.test("brand still separates two identical non-ASCII names", () => {
  assertNotEquals(cacheKey("पनीर", "अमूल"), cacheKey("पनीर", "मदर डेयरी"));
});

Deno.test("a name with ANY ascii keeps the normal key, not the fallback", () => {
  // Mixed input must not silently switch encodings - only a total collapse does.
  const k = cacheKey("पनीर paneer", "Amul");
  assertEquals(k, "amul|paneer");
});

Deno.test("the fallback key stays bounded for a pasted paragraph", () => {
  // cache_key is indexed; a long paste must not become the index entry.
  const k = cacheKey("字".repeat(500));
  assertEquals(k.startsWith("u:"), true);
  assertEquals(k.length < 900, true, `key was ${k.length} chars`);
});

Deno.test("a FatSecret web_search reading with no readable ref is still dropped", () => {
  // Stricter than the plain-web branch, which buckets a ref-less reading as
  // "web:unknown". Flagged as an asymmetry by the PR bot on #144 and kept on
  // purpose: this branch decides eligibility for the shared catalog, and "we
  // cannot tell which page this was" is not good enough for that question.
  assertEquals(independenceKey(reading("fatsecret", 190, { via: "web_search" })), null);
  assertEquals(
    independenceKey(reading("fatsecret", 190, { via: "web_search", ref: "not a url" })),
    null,
  );
  // The plain-web branch keeps its looser behaviour, unchanged.
  assertEquals(independenceKey(reading("web", 190)), "web:unknown");
});

Deno.test("providerFromRef's country domains still classify after the tidy", () => {
  // The three-condition test collapsed to one regex; these are the hosts that
  // must keep resolving to FatSecret rather than to an anonymous site.
  for (const host of ["fatsecret.co.in", "www.fatsecret.com", "platform.fatsecret.com"]) {
    assertEquals(
      independenceKey(reading("fatsecret", 190, { via: "web_search", ref: `https://${host}/x` })),
      `web:${host.replace(/^www\./, "")}`,
    );
  }
});
