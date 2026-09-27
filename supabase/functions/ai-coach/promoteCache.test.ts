// Run with: deno test supabase/functions/ai-coach/promoteCache.test.ts
//
// Promotion writes to the shared catalog with nobody watching. Every test here
// names the row we must never publish, because a bad promoted row is worse than a
// missing one: search cannot tell it from a curated row, and the meal it wrecks
// does not fall back to an estimate, it ships a confident wrong number.

import { assertEquals } from "jsr:@std/assert@1";
import {
  applyCatalogMatch,
  badDisplayName,
  brandFromName,
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
  // These readings carry no `via`, so their provenance is unknown and they do not
  // count - see the api-derived case below, and the public-page case after it.
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
  const published = row({ id: "food-1", brand: "Milky Mist", kcal: 190, protein_g: 18, carb_g: 2, fat_g: 12, source: "web_verified", last_verified_at: daysAgo(200) });
  const d = promotionDecision(cand({ promoted_food_id: "food-1" }), [published], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "already-current");
});

Deno.test("a row someone deleted is not silently re-inserted", () => {
  const d = promotionDecision(cand({ promoted_food_id: "food-gone" }), [], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "promoted-row-missing");
});


// ── the FatSecret split, at the level that actually writes to the catalog ──
// promotionDecision calls meetsVerificationBar itself, so the rule has to be
// exercised here and not only in preciseCache.test.ts. Flagged by the PR bot on
// #144: the cases above all used refless readings and so never touched the new
// behaviour at the promotion boundary, which is the one with legal consequences.

Deno.test("a FatSecret PAGE plus one other host promotes", () => {
  // Changed 2026-09-05 on Sarthak's call: a page a web search landed on is public,
  // read under no agreement, carrying the manufacturer's own printed numbers.
  const d = promotionDecision(
    cand({
      evidence: [
        {
          source: "fatsecret",
          ref: "https://www.fatsecret.co.in/calories-nutrition/milky-mist/paneer/100g",
          via: "web_search",
          per_100: { kcal: 190, protein_g: 18, carb_g: 2, fat_g: 12 },
        },
        web(189, "https://www.mynetdiary.com/food/paneer.html"),
      ],
    }),
    [],
    NOW,
  );
  assertEquals(d.action, "promote");
});

Deno.test("API-DERIVED FatSecret evidence still cannot promote, URL or not", () => {
  // The regression that matters most in this file. FatSecret's food.get returns a
  // food_url; citing it must never turn paid-API evidence into a promotable
  // source. Provenance is stated on the reading, never inferred from the ref.
  const d = promotionDecision(
    cand({
      evidence: [
        {
          source: "fatsecret",
          ref: "https://www.fatsecret.com/calories-nutrition/milky-mist/paneer",
          via: "api",
          per_100: { kcal: 190, protein_g: 18, carb_g: 2, fat_g: 12 },
        },
        web(189, "https://www.mynetdiary.com/food/paneer.html"),
      ],
    }),
    [],
    NOW,
  );
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "unverified");
});

Deno.test("two FatSecret pages on one host are still one source at promotion", () => {
  const d = promotionDecision(
    cand({
      evidence: [
        {
          source: "fatsecret", ref: "https://www.fatsecret.co.in/a", via: "web_search",
          per_100: { kcal: 190, protein_g: 18, carb_g: 2, fat_g: 12 },
        },
        {
          source: "fatsecret", ref: "https://www.fatsecret.co.in/b", via: "web_search",
          per_100: { kcal: 191, protein_g: 18, carb_g: 2, fat_g: 12 },
        },
      ],
    }),
    [],
    NOW,
  );
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "unverified");
});


// ── weak sources (2026-09-27) ──────────────────────────────────────────────
// Rows this job really published on a seller listing, an AI calorie app, or two
// user-typed databases. Those pages may still answer one meal; they may not be
// one of the two sources that publish to everyone.

Deno.test("the failure this prevents: a seller's listing as the second source", () => {
  const d = promotionDecision(
    cand({ evidence: [off(190), web(192, "https://spice.alibaba.com/sweet-potato")] }),
    [],
    NOW,
  );
  assertEquals(d.action, "skip");
  if (d.action === "skip") {
    assertEquals(d.reason, "unverified");
    assertEquals(d.detail, "only off (not counted: spice.alibaba.com)");
  }
});

Deno.test("two user-typed databases agreeing are not two sources", () => {
  const d = promotionDecision(
    cand({ evidence: [web(44, "https://www.carbmanager.com/food/x"), web(44, "https://prospre.io/y")], kcal: 44, protein_g: 1.5, carb_g: 8, fat_g: 0.3 }),
    [],
    NOW,
  );
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "unverified");
});

Deno.test("a weak page beside two good sources does not block, and is not credited", () => {
  const d = promotionDecision(
    cand({ evidence: [off(190), web(191, "https://milkymist.com/p"), web(190, "https://nutriscan.app/p")] }),
    [],
    NOW,
  );
  assertEquals(d.action, "promote");
  if (d.action === "promote") assertEquals(d.agreeing, ["off", "web:milkymist.com"]);
});

// ── brand from the name ────────────────────────────────────────────────────

const BRANDS = new Set(["pintola", "yogabar", "raw", "sunfeast", "dark fantasy", "banana", "amul"]);
const FOOD_WORDS = new Set(["raw", "chicken", "breast", "rice", "cake", "banana", "dark", "milk", "oats"]);

Deno.test("the failure this prevents: a packaged product published as a plain food", () => {
  assertEquals(brandFromName("Pintola rice cake", BRANDS, FOOD_WORDS), "Pintola");
});

Deno.test("a brand at the end of the name is found, in the name's spelling", () => {
  assertEquals(brandFromName("Kesar pista oats yogabar", BRANDS, FOOD_WORDS), "Yogabar");
});

Deno.test("a junk brand that is really a food word is not a brand", () => {
  assertEquals(brandFromName("raw chicken breast", BRANDS, FOOD_WORDS), null);
});

Deno.test("the whole name is never its own brand", () => {
  // A product logged by brand alone names the product, not a brand of something.
  assertEquals(brandFromName("Yogabar", BRANDS, FOOD_WORDS), null);
});

Deno.test("the earliest brand wins", () => {
  assertEquals(brandFromName("Sunfeast Dark Fantasy Choco Fills", BRANDS, FOOD_WORDS), "Sunfeast");
});

Deno.test("an unknown brand stays unknown", () => {
  assertEquals(brandFromName("Country delight low fat milk", BRANDS, FOOD_WORDS), null);
});

Deno.test("a brand found after publishing is written to the row we published", () => {
  const published = row({ id: "food-1", name: "Pintola rice cake", brand: null, kcal: 190, protein_g: 18, carb_g: 2, fat_g: 12, source: "web_verified", last_verified_at: daysAgo(1) });
  const d = promotionDecision(cand({ promoted_food_id: "food-1", brand: "Pintola" }), [published], NOW);
  assertEquals(d.action, "refresh");
});

Deno.test("a link to someone else's row is never 'refreshed'", () => {
  const usda = row({ id: "food-1", name: "Egg, whole, raw, fresh", kcal: 143, source: "usda", last_verified_at: null });
  const d = promotionDecision(cand({ promoted_food_id: "food-1", kcal: 150, evidence: [off(150), web(149, "https://a.com/x")] }), [usda], NOW);
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "linked");
});

// ── the Jev catalog match ──────────────────────────────────────────────────

const promote = { action: "promote" as const, agreeing: ["off", "web:a.com"] };

Deno.test("the failure this prevents: 'eggs' published beside USDA's egg", () => {
  const d = applyCatalogMatch(promote, { kcal: 143 }, {
    status: "matched",
    row: { id: "usda-egg", name: "Egg, whole, raw, fresh", source: "usda", kcal: 143 },
  });
  assertEquals(d, { action: "link", food_id: "usda-egg" });
});

Deno.test("the same food with different energy is a conflict, not a link", () => {
  const d = applyCatalogMatch(promote, { kcal: 190 }, {
    status: "matched",
    row: { id: "p", name: "Paneer", source: "curated", kcal: 283 },
  });
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "catalog-conflict");
});

Deno.test("no matching row: the promotion stands", () => {
  assertEquals(applyCatalogMatch(promote, { kcal: 190 }, { status: "none" }), promote);
});

Deno.test("no trustworthy answer: nothing is published", () => {
  const d = applyCatalogMatch(promote, { kcal: 190 }, { status: "unavailable", detail: "no JEV_API_KEY" });
  assertEquals(d.action, "skip");
  if (d.action === "skip") assertEquals(d.reason, "match-unavailable");
});

Deno.test("only a promotion is changed by the match", () => {
  const skip = { action: "skip" as const, reason: "expired" as const };
  assertEquals(applyCatalogMatch(skip, { kcal: 1 }, { status: "unavailable", detail: "x" }), skip);
});
