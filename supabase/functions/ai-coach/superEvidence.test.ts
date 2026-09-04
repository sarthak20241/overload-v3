// Run with: deno test --allow-all supabase/functions/ai-coach/superEvidence.test.ts
//
// What Super's evidence is allowed to say, and to whom.
//
// Two consumers read the same CandidateFood.evidence and must not drift:
//   DECIDE reads it in candidatePayload, to know whether a researched number is
//          corroborated before it sets confidence.
//   THE CARD reads it as ParsedItem.verified, via verifiedForItems + verifyItems.
//
// The rule both share, and the reason this file exists: a badge is a claim about
// OUTSIDE agreement, so it may only ever be under-claimed. Every test below is a
// way of NOT earning it.

import { assertEquals } from "jsr:@std/assert@1";
import {
  candidatePayload,
  type CandidateFood,
  cacheRowToCandidate,
  type ParsedItem,
  type ParseMealDeps,
  type ResolvedItem,
  verifiedForItems,
  verifyItems,
} from "./parseMeal.ts";
import type { PreciseCacheRow, SourceReading } from "./preciseCache.ts";

const CAND = (over: Partial<CandidateFood> = {}): CandidateFood => ({
  food_id: "f1", name: "Paneer", brand: null, base_unit: "g",
  kcal: 190, protein_g: 25, carb_g: 7, fat_g: 7, fiber_g: null,
  servings: [], source: "catalog", ...over,
});

const ITEM = (over: Partial<ParsedItem> = {}): ParsedItem => ({
  food_id: "f1", food_name: "Paneer", quantity: 1, serving_label: "g", grams: 100,
  kcal: 190, protein_g: 25, carb_g: 7, fat_g: 7, fiber_g: null,
  source: "catalog", assumption: null, confidence: "high", ...over,
});

const resolved = (cands: CandidateFood[]): ResolvedItem[] => [
  { name: "paneer", brand: null, quantity: 1, unit: "g", prep: null, candidates: cands },
];

/** Deps whose row read always fails, so verifyItems takes the fallback branch
 *  and the numbers below are irrelevant to what we are actually asserting. */
const DEPS = {
  anthropicApiKey: "k", model: "m", maxTokens: 10, timeoutMs: 10,
  webSearchEnabled: false, fastGrammarMode: "off",
  searchFoods: async () => [], backfillOffFood: async () => null,
  getFoodPer100: async () => ({ kcal: 190, protein_g: 25, carb_g: 7, fat_g: 7, fiber_g: null, name: "Paneer" }),
  getFoodServings: async () => [],
} as unknown as ParseMealDeps;

// ── What decide is shown ────────────────────────────────────────────────────

Deno.test("an ordinary candidate carries NO evidence key at all", () => {
  // Absent must read as "no claim made". Emitting agreed:false on every catalog
  // row would teach the model that most candidates are disputed, which inverts
  // the meaning of the one field that is supposed to be rare.
  assertEquals("evidence" in candidatePayload(CAND()), false);
});

Deno.test("a researched candidate shows decide both the count and the verdict", () => {
  const p = candidatePayload(CAND({ evidence: { independent_sources: 2, agreed: true } }));
  assertEquals(p.evidence, { independent_sources: 2, agreed: true });
});

Deno.test("a disputed candidate still reaches decide, marked disputed", () => {
  // It is not dropped: it cost real money and is still the best number we have
  // for the exact product the user named. The prompt tells decide to log it and
  // not call it high confidence.
  const p = candidatePayload(CAND({ evidence: { independent_sources: 1, agreed: false } }));
  assertEquals(p.evidence, { independent_sources: 1, agreed: false });
});

// ── What the card is allowed to badge ───────────────────────────────────────

Deno.test("only an AGREED candidate puts its id in the verified set", () => {
  const ids = verifiedForItems(resolved([
    CAND({ food_id: "plain" }),                                                    // no evidence
    CAND({ food_id: "disputed", evidence: { independent_sources: 1, agreed: false } }),
    CAND({ food_id: "agreed", evidence: { independent_sources: 2, agreed: true } }),
  ]));
  assertEquals([...ids], ["agreed"]);
});

Deno.test("a plain catalog parse produces an EMPTY verified set", () => {
  // The overwhelmingly common case, and the one that must cost nothing: no
  // Super candidate means no badge and no work.
  assertEquals(verifiedForItems(resolved([CAND(), CAND({ food_id: "f2" })])).size, 0);
});

Deno.test("verifyItems badges the line whose id was agreed on", async () => {
  const [it] = await verifyItems(DEPS, [ITEM()], undefined, new Set(["f1"]));
  assertEquals(it.verified, true);
});

Deno.test("a line on a DIFFERENT id is never badged by proximity", async () => {
  const [it] = await verifyItems(DEPS, [ITEM({ food_id: "other" })], undefined, new Set(["f1"]));
  assertEquals(it.verified, undefined);
});

Deno.test("no verified set means no badge, and that is the default path", async () => {
  const [it] = await verifyItems(DEPS, [ITEM()]);
  assertEquals(it.verified, undefined);
});

Deno.test("a line a guardrail demoted loses the badge", async () => {
  // Two sources agreeing on a number we then had to overrule is not something
  // to show a checkmark for. Implausible per-100 numbers demote to low.
  const deps = {
    ...DEPS,
    getFoodPer100: async () => ({ kcal: 900, protein_g: 90, carb_g: 90, fat_g: 90, fiber_g: null, name: "Paneer" }),
  } as unknown as ParseMealDeps;
  const [it] = await verifyItems(deps, [ITEM()], undefined, new Set(["f1"]));
  assertEquals(it.confidence, "low");
  assertEquals(it.verified, undefined);
});

Deno.test("a line demoted to an estimate loses its id, and with it the badge", async () => {
  // verifyItems nulls food_id when it cannot back the numbers. Stamping AFTER
  // the pass, on the FINAL id, is what makes that automatic.
  const deps = { ...DEPS, getFoodPer100: async () => null } as unknown as ParseMealDeps;
  const [it] = await verifyItems(deps, [ITEM()], undefined, new Set(["f1"]));
  assertEquals(it.source, "estimate");
  assertEquals(it.verified, undefined);
});

// ── Cache rows are judged by today's independence rule ──────────────────────

const reading = (source: SourceReading["source"], ref: string | null): SourceReading => ({
  source, ref, per_100: { kcal: 190, protein_g: 25, carb_g: 7, fat_g: 7 },
});

const row = (over: Partial<PreciseCacheRow> = {}): PreciseCacheRow => ({
  id: "r1", cache_key: "k", display_name: "Paneer", brand: null, base_unit: "g",
  kcal: 190, protein_g: 25, carb_g: 7, fat_g: 7, fiber_g: null,
  servings: [], evidence: [], verified: false, source_note: null,
  last_verified_at: new Date().toISOString(), ...over,
});

Deno.test("stored readings are counted by HOST, not by row", () => {
  const c = cacheRowToCandidate(row({
    evidence: [reading("web", "https://a.com/1"), reading("web", "https://a.com/2"), reading("web", "https://b.com/1")],
    verified: true,
  }));
  assertEquals(c.evidence, { independent_sources: 2, agreed: true });
});

Deno.test("a FatSecret reading sits in evidence and counts for nothing", () => {
  // The licensing line: their data may inform the number, but a row only they
  // vouch for must never be copyable into our catalog. Same rule, re-applied at
  // read time so an old row cannot smuggle a stale count past it.
  const c = cacheRowToCandidate(row({
    evidence: [reading("fatsecret", "https://fatsecret.co.in/x"), reading("web", "https://a.com/1")],
  }));
  assertEquals(c.evidence?.independent_sources, 1);
});

Deno.test("a row with no evidence column does not throw", () => {
  assertEquals(cacheRowToCandidate(row({ evidence: null as never })).evidence?.independent_sources, 0);
});

// ── The ceiling on the no-row-to-re-read branch ─────────────────────────────
// Every ephemeral id (FatSecret, cache hit, web lookup) skips the row read, so
// verifyItems used to flatten ALL of them to medium. That silently discarded
// decide's agreed/disputed judgement for exactly the candidates the evidence
// rule was written for, which made the rule unobservable.

/** Deps with no row to read, so the candidate's own per-100 basis is used. */
const NO_ROW = { ...DEPS, getFoodPer100: async () => null } as unknown as ParseMealDeps;
const BASIS = new Map([["f1", { kcal: 190, protein_g: 25, carb_g: 7, fat_g: 7, fiber_g: null, name: "Paneer" }]]);

Deno.test("an unbacked ephemeral line is still capped at medium", async () => {
  const [it] = await verifyItems(NO_ROW, [ITEM({ confidence: "high" })], BASIS);
  assertEquals(it.confidence, "medium");
});

Deno.test("a disputed Super line is capped at medium even if decide said high", async () => {
  // Not in the verified set, so the cap applies. Belt and braces: the prompt
  // already tells decide not to do this, and the code does not rely on that.
  const [it] = await verifyItems(NO_ROW, [ITEM({ confidence: "high" })], BASIS, new Set(["other"]));
  assertEquals(it.confidence, "medium");
});

Deno.test("an AGREED Super line keeps decide's own confidence", async () => {
  const [it] = await verifyItems(NO_ROW, [ITEM({ confidence: "high" })], BASIS, new Set(["f1"]));
  assertEquals(it.confidence, "high");
  assertEquals(it.verified, true);
});

Deno.test("agreement does not push a cautious line UP", async () => {
  // The set lifts a ceiling; it never sets a floor. If decide had a reason to
  // hedge, two sources agreeing on the panel does not answer that reason.
  const [it] = await verifyItems(NO_ROW, [ITEM({ confidence: "medium" })], BASIS, new Set(["f1"]));
  assertEquals(it.confidence, "medium");
});
