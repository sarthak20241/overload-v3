// Run with: deno test supabase/functions/ai-coach/promoteCache.test.ts
//
// Promotion writes to the shared catalog with nobody watching. Every test here
// names the row we must never publish, because a bad promoted row is worse than a
// missing one: search cannot tell it from a curated row, and the meal it wrecks
// does not fall back to an estimate, it ships a confident wrong number.

import { assertEquals } from "jsr:@std/assert@1";
import {
  badDisplayName,
  type CatalogRow,
  findDuplicate,
  isSameFood,
  type PromotionCandidate,
  promotionDecision,
} from "./promoteCache.ts";
import type { SourceReading } from "./preciseCache.ts";

const NOW = new Date("2026-08-27T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const off = (kcal: number): SourceReading => ({
  source: "off",
  per_100: { kcal, protein_g: 18, carb_g: 2, fat_g: 12 },
});
const web = (kcal: number, ref: string): SourceReading => ({
  source: "web",
  ref,
  per_100: { kcal, protein_g: 18, carb_g: 2, fat_g: 12 },
});

const cand = (over: Partial<PromotionCandidate> = {}): PromotionCandidate => ({
  id: "cache-1",
  cache_key: "milky mist|milky mist low fat paneer",
  display_name: "Milky Mist Low Fat Paneer",
  brand: "Milky Mist",
  base_unit: "g",
  kcal: 190,
  protein_g: 18,
  carb_g: 2,
  fat_g: 12,
  fiber_g: 0,
  servings: [{ label: "100 g", grams: 100 }],
  evidence: [off(190), web(196, "https://milkymist.com/low-fat-paneer")],
  verified: true,
  last_verified_at: daysAgo(3),
  promoted_food_id: null,
  ...over,
});

const row = (over: Partial<CatalogRow> = {}): CatalogRow => ({
  id: "food-1",
  name: "Paneer",
  brand: null,
  kcal: 283,
  protein_g: 18,
  carb_g: 2,
  fat_g: 22,
  source: "curated",
  last_verified_at: null,
  ...over,
});

// ── the happy path ─────────────────────────────────────────────────────────

Deno.test("the canonical case: a verified, un-catalogued food is promoted", () => {
  const d = promotionDecision(cand(), [], NOW);
  assertEquals(d.action, "promote");
  if (d.action === "promote") assertEquals(d.agreeing, ["off", "web:milkymist.com"]);
});

// ── the verification bar, re-derived ───────────────────────────────────────

Deno.test("the failure this prevents: a stale `verified` flag publishing itself", () => {
  // verified:true, evidence that does not support it. The bar is re-derived from
  // the readings, so a flag written by since-changed code cannot promote a row.
  const d = promotionDecision(cand({ verified: true, evidence: [off(190)] }), [], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "unverified");
});

Deno.test("FatSecret-only evidence never reaches the catalog", () => {
  // Their terms allow serving a request, not replicating the database. A promoted
  // row is a copy, so this is the line that keeps us on the right side of it.
  const d = promotionDecision(
    cand({
      evidence: [
        { source: "fatsecret", per_100: { kcal: 190, protein_g: 18, carb_g: 2, fat_g: 12 } },
        { source: "fatsecret", per_100: { kcal: 192, protein_g: 18, carb_g: 2, fat_g: 12 } },
      ],
    }),
    [],
    NOW,
  );
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "unverified");
});

Deno.test("FatSecret evidence does not poison the independent sources beside it", () => {
  // OFF counts in full (user decision 2026-08-27), so OFF plus one web host still
  // clears the bar on a food FatSecret also happened to answer for.
  const d = promotionDecision(
    cand({
      evidence: [
        { source: "fatsecret", per_100: { kcal: 190, protein_g: 18, carb_g: 2, fat_g: 12 } },
        { source: "off", derived_from: "fatsecret", per_100: { kcal: 188, protein_g: 18, carb_g: 2, fat_g: 12 } },
        web(195, "https://milkymist.com/low-fat-paneer"),
      ],
    }),
    [],
    NOW,
  );
  assertEquals(d.action, "promote");
});

// ── expiry ─────────────────────────────────────────────────────────────────

Deno.test("an expired row is not published, however well evidenced", () => {
  // We do not publish to everyone a number we would no longer serve to one person.
  const d = promotionDecision(cand({ last_verified_at: daysAgo(120) }), [], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "expired");
});

// ── physics, the only gate left once the usage bar was dropped ─────────────

Deno.test("nobody has to eat it first", () => {
  // The usage bar is gone (user decision 2026-08-27). A food nobody has logged
  // still promotes on evidence alone, and this test is what will fail if someone
  // reintroduces a "logged N times" requirement without saying so.
  assertEquals(promotionDecision(cand(), [], NOW).action, "promote");
});

Deno.test("the failure this prevents: kcal that contradict the row's own macros", () => {
  // 18P + 2C + 12F is 188 kcal of food. A row claiming 400 has had a column
  // misread somewhere, and a catalog row propagates that to everyone forever.
  const d = promotionDecision(
    cand({ kcal: 400, evidence: [off(400), web(398, "https://example.com/x")] }),
    [],
    NOW,
  );
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "implausible");
});

Deno.test("a real label that breaks strict Atwater is still publishable", () => {
  // Fiber netting, sugar alcohols, alcohol and rounding all move a printed panel
  // off 4/4/9. The 30% tolerance is the measured one from checkAtwater; tightening
  // it here would reject genuine products.
  const d = promotionDecision(
    // 240 stated against 188 from 4/4/9: 22% out, inside the tolerance and typical
    // of a high-fiber or sugar-alcohol panel.
    cand({ kcal: 240, evidence: [off(240), web(246, "https://milkymist.com/x")] }),
    [],
    NOW,
  );
  assertEquals(d.action, "promote");
});

Deno.test("macros that outweigh the food never reach the catalog", () => {
  const d = promotionDecision(
    cand({
      kcal: 500,
      protein_g: 60,
      carb_g: 60,
      fat_g: 20,
      evidence: [off(500), web(505, "https://example.com/y")],
    }),
    [],
    NOW,
  );
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "implausible");
});

Deno.test("a near-zero food is not failed by a percentage", () => {
  // Black coffee: 1 kcal stated, 0 from macros. Every difference is 100% of
  // something tiny, and the row is fine.
  const d = promotionDecision(
    cand({
      kcal: 1,
      protein_g: 0.1,
      carb_g: 0,
      fat_g: 0,
      evidence: [off(1), web(2, "https://example.com/coffee")],
    }),
    [],
    NOW,
  );
  assertEquals(d.action, "promote");
});

// ── the name guard, the other half of "fully automatic" ────────────────────

Deno.test("a real food name is published unchanged", () => {
  assertEquals(badDisplayName("Milky Mist Low Fat Paneer"), null);
  assertEquals(promotionDecision(cand(), [], NOW).action, "promote");
});

Deno.test("the failure this prevents: a log line becoming a permanent catalog row", () => {
  // "200g paneer" is a fine thing to call an item on one person's card. As a
  // catalog row it is forever, it is what every future search ranks against, and
  // nothing downstream questions it.
  assertEquals(badDisplayName("200g paneer") === null, false);
  const d = promotionDecision(cand({ display_name: "200g paneer" }), [], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "bad-name");
});

Deno.test("a unit word means the amount was folded into the name", () => {
  // The exact string fastGrammar refuses to parse, for the same reason.
  assertEquals(badDisplayName("tea half cup") === null, false);
  const d = promotionDecision(cand({ display_name: "tea half cup" }), [], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "bad-name");
});

Deno.test("a sentence is not a food name", () => {
  const nine = "grilled chicken breast with rice and salad on the side";
  assertEquals(badDisplayName(nine) === null, false);
  const d = promotionDecision(cand({ display_name: nine }), [], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "bad-name");
});

Deno.test("a name too long to be a name is refused even at six words", () => {
  // Six words of forty characters each is still a description.
  assertEquals(badDisplayName("Supercalifragilistic Expialidocious Chocolatey Peanutbutter Crunchbar Deluxe") === null, false);
});

Deno.test("a spelled-out amount is refused", () => {
  assertEquals(badDisplayName("two rotis") === null, false);
});

// ── dedup ──────────────────────────────────────────────────────────────────

Deno.test("the failure this prevents: a second paneer that splits the ranking", () => {
  // Two rows for one food halve each other's popularity and history signals, so
  // neither wins its own search. Link to the existing row, write nothing.
  const existing = row({ id: "food-paneer", name: "Paneer", kcal: 265 });
  const d = promotionDecision(
    cand({
      display_name: "paneer",
      brand: null,
      kcal: 265,
      evidence: [off(265), web(258, "https://usda.gov/paneer")],
    }),
    [existing],
    NOW,
  );
  assertEquals(d.action, "link");
  if (d.action === "link") assertEquals(d.food_id, "food-paneer");
});

Deno.test("a grade the catalog is missing is NOT a duplicate", () => {
  // This is the whole point of Super: plain "Paneer" at 283 does not cover
  // "Milky Mist Low Fat Paneer" at 190, and collapsing them re-creates the exact
  // bug that started this workstream.
  assertEquals(isSameFood("Milky Mist Low Fat Paneer", "Milky Mist", row()), false);
  assertEquals(promotionDecision(cand(), [row()], NOW).action, "promote");
});

Deno.test("a typo in one of the names still counts as the same food", () => {
  assertEquals(isSameFood("Panner Tikka", null, row({ name: "Paneer Tikka" })), true);
});

Deno.test("brand words count toward identity from either column", () => {
  // The cache carries the brand separately, the catalog often folds it into the
  // name. Same food either way.
  assertEquals(
    isSameFood("Low Fat Paneer", "Milky Mist", row({ name: "Milky Mist Low Fat Paneer" })),
    true,
  );
});

Deno.test("the failure this prevents: an unattended job rewriting a curated row", () => {
  // Same name, materially different energy. Publishing ours splits the ranking;
  // overwriting theirs lets two web pages silently edit curated data. Neither.
  const conflicting = row({ name: "Milky Mist Low Fat Paneer", brand: "Milky Mist", kcal: 283 });
  const d = promotionDecision(cand(), [conflicting], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "catalog-conflict");
});

Deno.test("a duplicate is found even when a distractor sits first in the list", () => {
  const m = findDuplicate(
    { display_name: "Milky Mist Low Fat Paneer", brand: null, kcal: 190 },
    [row({ id: "bhujia", name: "Bhujia", kcal: 609 }), row({ id: "mm", name: "Milky Mist Low Fat Paneer", kcal: 190 })],
  );
  assertEquals(m?.row.id, "mm");
  assertEquals(m?.conflict, false);
});

// ── self-heal on rows we already published ─────────────────────────────────

Deno.test("re-verified evidence updates the row we published", () => {
  const published = row({ id: "food-1", name: "Milky Mist Low Fat Paneer", brand: "Milky Mist", kcal: 190, source: "web_verified", last_verified_at: daysAgo(200) });
  const d = promotionDecision(
    cand({ promoted_food_id: "food-1", kcal: 205, evidence: [off(205), web(203, "https://milkymist.com/x")] }),
    [published],
    NOW,
  );
  assertEquals(d.action, "refresh");
  if (d.action === "refresh") assertEquals(d.food_id, "food-1");
});

Deno.test("an unchanged row is not rewritten every night", () => {
  const published = row({ id: "food-1", kcal: 190, protein_g: 18, carb_g: 2, fat_g: 12, source: "web_verified", last_verified_at: daysAgo(200) });
  const d = promotionDecision(cand({ promoted_food_id: "food-1" }), [published], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "already-current");
});

Deno.test("a row someone deleted is not silently re-inserted", () => {
  const d = promotionDecision(cand({ promoted_food_id: "food-gone" }), [], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "promoted-row-missing");
});
