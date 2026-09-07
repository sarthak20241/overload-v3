// The zero-contamination bug, pinned.
//
// Measured against pack labels on 2026-09-04, Super's protein leaned low and
// occasionally collapsed outright. Root cause was in two halves: the report tool
// forced protein to be a number, so a page that printed none was recorded as
// "0 g", and the aggregator then let that fake zero vote in the median. These
// tests hold both halves shut.
import { assertEquals, assertObjectMatch } from "jsr:@std/assert@1";
import { reconcileReadings } from "./parseMeal.ts";
import type { SourceReading } from "./preciseCache.ts";

const r = (
  ref: string,
  kcal: number,
  protein_g: number | null,
  carb_g: number | null,
  fat_g: number | null,
  fiber_g: number | null = null,
): SourceReading => ({ source: "web", ref, per_100: { kcal, protein_g, carb_g, fat_g, fiber_g } });

const ok = (x: ReturnType<typeof reconcileReadings>) => {
  if ("reason" in x) throw new Error(`expected a result, got: ${x.reason}`);
  return x;
};

Deno.test("THE BUG: a page that did not state protein does not vote 0", () => {
  // Cadbury Gems, exactly as it came back from the web on 2026-09-04. Two of the
  // three sources published no protein figure; the label says 3.6 g.
  const out = ok(reconcileReadings([
    r("https://www.fatsecret.co.in/...", 469, null, 80, 18),
    r("https://clearcals.com/...", 472.3, 3.6, 75.1, 17.5),
    r("https://www.mynetdiary.com/...", 470, null, 80, 18),
  ]));
  assertEquals(out.per100.protein_g, 3.6, "the one source that stated protein decides it");
  // The old code returned 0 here: median([0, 3.6, 0]).
  assertEquals(out.per100.kcal, 470, "energy still uses every reading");
});

Deno.test("a STATED zero is a fact and still counts (oil is really 0 g protein)", () => {
  const out = ok(reconcileReadings([
    r("https://a.example/oil", 884, 0, 0, 100),
    r("https://b.example/oil", 884, 0, 0, 100),
  ]));
  assertEquals(out.per100.protein_g, 0);
  assertEquals(out.per100.carb_g, 0);
  // This is the case a "treat 0 as missing" shortcut would have broken, which is
  // why the fix had to be a nullable schema and not a heuristic.
});

Deno.test("stated zeros and nulls mix without the nulls diluting the zeros", () => {
  const out = ok(reconcileReadings([
    r("https://a.example/ghee", 900, 0, 0, 100),
    r("https://b.example/ghee", 898, null, null, 99.8),
  ]));
  assertEquals(out.per100.protein_g, 0, "only the source that spoke is counted");
  assertEquals(out.per100.fat_g, 99.9, "both stated fat, so both vote");
});

Deno.test("each macro is decided by its OWN sources, not by one shared pool", () => {
  const out = ok(reconcileReadings([
    r("https://a.example/x", 400, 10, null, null),
    r("https://b.example/x", 400, null, 50, null),
    r("https://c.example/x", 400, null, null, 12),
  ]));
  assertObjectMatch(out.per100, { protein_g: 10, carb_g: 50, fat_g: 12 });
});

Deno.test("a macro no source stated is a refusal, not a zero", () => {
  const out = reconcileReadings([
    r("https://a.example/x", 190, null, 7, 7),
    r("https://b.example/x", 188, null, 7, 7),
  ]);
  // Logging 190 kcal of paneer as 0 g protein is worse than admitting we do not
  // know, and a cached 0 would be served for the full 90-day TTL.
  assertObjectMatch(out as Record<string, unknown>, { reason: "no source stated protein" });
});

Deno.test("energy alone is not a reading", () => {
  const out = reconcileReadings([r("https://a.example/x", 190, null, null, null)]);
  // Caught by the no-panel drop rather than the per-macro check, which is the
  // more precise complaint: this page had no breakdown at all.
  assertObjectMatch(out as Record<string, unknown>, { reason: "no source stated any composition" });
});

Deno.test("physics still runs after the per-macro medians", () => {
  const out = reconcileReadings([
    r("https://a.example/x", 400, 60, 60, 60),
    r("https://b.example/x", 400, 60, 60, 60),
  ]);
  // 180 g of macros in 100 g of food. Sources agreeing does not make it possible.
  if (!("reason" in out)) throw new Error("expected a rejection");
  assertEquals(out.reason.includes("more than the food weighs"), true, out.reason);
});

Deno.test("negatives are rejected rather than averaged away", () => {
  // A negative is filtered out as not-stated; with nothing left, protein refuses.
  const out = reconcileReadings([r("https://a.example/x", 400, -5, 50, 10)]);
  assertObjectMatch(out as Record<string, unknown>, { reason: "no source stated protein" });
});

Deno.test("an even number of stated values takes the midpoint", () => {
  const out = ok(reconcileReadings([
    r("https://a.example/x", 100, 4, 10, 2),
    r("https://b.example/x", 110, 6, 12, 3),
  ]));
  assertEquals(out.per100.protein_g, 5);
  assertEquals(out.per100.kcal, 105);
});

Deno.test("fiber follows the same rule and stays null when nobody said", () => {
  const both = ok(reconcileReadings([
    r("https://a.example/x", 400, 10, 50, 12, 3),
    r("https://b.example/x", 400, 10, 50, 12, null),
  ]));
  assertEquals(both.fiber_g, 3, "one stated value decides it");
  const neither = ok(reconcileReadings([
    r("https://a.example/x", 400, 10, 50, 12, null),
  ]));
  assertEquals(neither.fiber_g, null);
});

Deno.test("no readings at all is a refusal", () => {
  assertObjectMatch(reconcileReadings([]) as Record<string, unknown>, { reason: "no readings" });
});

// ── The regression the first attempt at this fix caused ────────────────────
// Per-macro medians alone took measured protein bias from -4% to -16%. These
// pin the second half of the rule: a reading with no panel at all is dropped
// whole, BEFORE the per-macro pools are built.

Deno.test("REGRESSION: a reading with no panel at all does not vote its zeros", () => {
  // Cadbury Gems as it actually came back on 2026-09-04: FatSecret returned
  // energy with 0/0/0 macros, which is a page with no panel, not a food with no
  // protein. Counting it gave median([0, 3.6]) = 1.8 - exactly half, three runs
  // running.
  const out = ok(reconcileReadings([
    r("https://www.fatsecret.co.in/...", 469, 0, 0, 0),
    r("https://clearcals.com/...", 472.3, 3.6, 75.1, 17.5),
  ]));
  assertEquals(out.per100.protein_g, 3.6);
  assertEquals(out.per100.carb_g, 75.1);
  assertEquals(out.per100.kcal, 470.7, "energy still counts BOTH readings");
});

Deno.test("oil survives the no-panel drop: 0 protein beside real fat is a panel", () => {
  const out = ok(reconcileReadings([
    r("https://a.example/oil", 884, 0, 0, 100),
    r("https://b.example/oil", 884, 0, 0, 100),
  ]));
  assertEquals(out.per100.protein_g, 0, "a real zero next to real fat is kept");
  assertEquals(out.per100.fat_g, 100);
});

Deno.test("every reading lacking a panel is a refusal, not a plate of zeros", () => {
  const out = reconcileReadings([
    r("https://a.example/x", 469, 0, 0, 0),
    r("https://b.example/x", 470, null, null, null),
  ]);
  assertObjectMatch(out as Record<string, unknown>, { reason: "no source stated any composition" });
});

// ── Near-zero foods must survive the no-panel drop ─────────────────────────
// Sarthak's objection, and it was right: a food can genuinely be close to 0 g
// protein. What makes an all-zero panel wrong is the CALORIES beside it, not the
// zeros. These pin that the drop is conditional on energy.

Deno.test("black coffee is really 0/0/0 and keeps its zeros", () => {
  const out = ok(reconcileReadings([
    r("https://a.example/coffee", 2, 0, 0, 0),
    r("https://b.example/coffee", 1, 0, 0, 0),
  ]));
  assertObjectMatch(out.per100, { protein_g: 0, carb_g: 0, fat_g: 0 });
});

Deno.test("a zero-calorie drink survives even beside a page that has a panel", () => {
  const out = ok(reconcileReadings([
    r("https://a.example/soda", 0, 0, 0, 0),
    r("https://b.example/soda", 1, 0, 0.1, 0),
  ]));
  assertEquals(out.per100.protein_g, 0);
});

Deno.test("sugar keeps 0 protein because its carbs are a real panel", () => {
  const out = ok(reconcileReadings([
    r("https://a.example/sugar", 400, 0, 100, 0),
    r("https://b.example/sugar", 399, 0, 99.8, 0),
  ]));
  assertObjectMatch(out.per100, { protein_g: 0, carb_g: 99.9 });
});

Deno.test("but 469 kcal of zeros is still a missing panel, not an empty food", () => {
  // The distinction the whole rule turns on: calories come from macros, so this
  // page contradicts itself, while the coffee above does not.
  const out = ok(reconcileReadings([
    r("https://www.fatsecret.co.in/...", 469, 0, 0, 0),
    r("https://clearcals.com/...", 472.3, 3.6, 75.1, 17.5),
  ]));
  assertEquals(out.per100.protein_g, 3.6);
});

// ── An impossible MIX must not become an estimate ──────────────────────────
// Measured live 2026-09-06, twice out of two: Bingo Mad Angles was rejected with
// "its macros total 121 g per 100, more than the food weighs" and Super fell
// back to a guess, having already spent two searches. Per-macro pools let carbs
// come from one site and fat from another, so the row was right per column and
// impossible as a row. Coherent readings are now tried before giving up.

Deno.test("THE BUG: an impossible mix falls back to a coherent panel", () => {
  // The first version of this test did NOT reach the fallback - its tier-1
  // medians totalled 97 g, so it passed on the unfixed code too and protected
  // nothing. Caught on review. These numbers actually break tier 1:
  //   carb medians [58, 60, 95, 95] -> 77.5, fat [30, 32, 55, 55] -> 43.5,
  //   protein [7, 7] -> 7. Total 128 g in 100 g of food, so tier 1 is rejected.
  // The two complete panels are individually sane, so tier 2 rescues it.
  const out = ok(reconcileReadings([
    r("https://a.example/x", 540, 7, 58, 32),
    r("https://b.example/x", 545, 7, 60, 30),
    r("https://c.example/x", 700, null, 95, 55),
    r("https://d.example/x", 705, null, 95, 55),
  ]));
  assertEquals(out.how, "complete panels", "must reach the rescue, not tier 1");
  const total = out.per100.protein_g + out.per100.carb_g + out.per100.fat_g;
  assertEquals(total <= 105, true, `macros totalled ${total} g per 100`);
  // Energy comes from the complete panels too, never the 700s of the partials.
  assertEquals(out.per100.kcal, 542.5);
  // The old code returned { reason } here and the parse silently estimated.
});

Deno.test("a coherent mix is untouched, so nothing that worked changes", () => {
  // Three sources that broadly agree: the per-macro pools survive physics and
  // are used, exactly as before. Every stated number still votes.
  const out = ok(reconcileReadings([
    r("https://a.example/x", 540, 7, 58, 32),
    r("https://b.example/x", 545, 8, 57, 33),
    r("https://c.example/x", 542, 6, 59, 31),
  ]));
  assertObjectMatch(out.per100, { protein_g: 7, carb_g: 58, fat_g: 32 });
});

Deno.test("a partial reading cannot rescue an impossible mix on its own", () => {
  // No complete panel exists, so there is nothing coherent to fall back to and
  // the refusal stands. Better an honest estimate than an invented panel.
  const out = reconcileReadings([
    r("https://a.example/x", 540, 7, 70, null),
    r("https://b.example/x", 545, 7, null, 45),
  ]);
  if (!("reason" in out)) throw new Error("expected a refusal");
  assertEquals(out.reason.includes("more than the food weighs"), true, out.reason);
});

Deno.test("the rescue keeps the protein fix: an omitted protein still cannot vote 0", () => {
  // Same fixture that actually breaks tier 1, so the rescue really runs. c and d
  // omit protein, so they are not complete panels and cannot vote in tier 2
  // either. Protein stays 7 and never becomes median([0, 7]).
  const out = ok(reconcileReadings([
    r("https://a.example/x", 540, 7, 58, 32),
    r("https://b.example/x", 545, 7, 60, 30),
    r("https://c.example/x", 700, null, 95, 55),
    r("https://d.example/x", 705, null, 95, 55),
  ]));
  assertEquals(out.how, "complete panels", "must reach the rescue, not tier 1");
  assertEquals(out.per100.protein_g, 7);
  const total = out.per100.protein_g + out.per100.carb_g + out.per100.fat_g;
  assertEquals(total <= 105, true, `macros totalled ${total} g per 100`);
});

// ── The last-resort tier, which had no test at all ─────────────────────────
// Flagged on PR #146. Every test above resolves at tier 1 or tier 2, so the tier
// explicitly labelled "least robust" was never exercised.
//
// Reaching it takes some doing, and the reason is worth writing down. With an
// EVEN number of complete panels, tier 2's medians are midpoints, so its macro
// total is the AVERAGE of the panels' totals - which can never exceed the
// largest of them. So tier 2 cannot fail while a plausible panel exists, unless
// one of the complete panels is itself impossible. That is the gap tier 3 fills.

Deno.test("tier 3: one impossible panel drags the medians, a real one rescues it", () => {
  // b is nonsense (140 g of macros in 100 g). Tier 1 and tier 2 both average it
  // in and land at 121 g. Tier 3 takes a's panel whole and it is fine.
  const out = ok(reconcileReadings([
    r("https://a.example/x", 500, 5, 95, 3),
    r("https://b.example/x", 505, 5, 95, 40),
  ]));
  assertEquals(out.how, "one whole panel");
  assertObjectMatch(out.per100, { protein_g: 5, carb_g: 95, fat_g: 3 });
});

Deno.test("tier 3 copies the panel's OWN energy, not the cross-source median", () => {
  // The bug the PR bot found: the tier claimed to copy one real page whole and
  // did not - it paired that page's macros with a median energy no page printed.
  // kcals includes readings hasComposition already dropped, so that number could
  // come from a page with no panel at all, and nothing downstream cross-checks
  // calories against macros.
  const out = ok(reconcileReadings([
    r("https://a.example/x", 500, 5, 95, 3),
    r("https://b.example/x", 505, 5, 95, 40),
    // No panel, wildly different energy. Before the fix this dragged the kcal
    // that got paired with a's macros.
    r("https://c.example/x", 900, null, null, null),
  ]));
  assertEquals(out.how, "one whole panel");
  assertEquals(out.per100.kcal, 500, "a's own energy, not median([500,505,900])");
});

Deno.test("the tier that answered is reported, so a rescue is visible", () => {
  const normal = ok(reconcileReadings([
    r("https://a.example/x", 540, 7, 58, 32),
    r("https://b.example/x", 545, 8, 57, 33),
  ]));
  assertEquals(normal.how, "per-macro pools");
});

// ── The PARSING half, which had no test and therefore had the bug ───────────
//
// The tests above pin reconcileReadings, and they pass on code that is wrong,
// because the fake zero was being manufactured one layer earlier - inside
// runSuperLookup, which calls the network and so could not be reached. The
// aggregator was handed a 0 and had no way to know it was invented.
//
// parseReading is that layer, extracted. These tests are the ones that would
// have caught it.
import { parseReading } from "./parseMeal.ts";

Deno.test("PARSING: an omitted macro stays null and never becomes 0", () => {
  const out = parseReading({
    url: "https://example.com/gems",
    per_100: { kcal: 469, carb_g: 80, fat_g: 18 },
  });
  assertEquals(out?.per_100.protein_g, null, "omitted must be null, not 0");
  assertEquals(out?.per_100.carb_g, 80);
  assertEquals(out?.per_100.fat_g, 18);
});

Deno.test("PARSING: an explicit null stays null", () => {
  const out = parseReading({
    url: "https://example.com/x",
    per_100: { kcal: 190, protein_g: null, carb_g: null, fat_g: null },
  });
  assertEquals(out?.per_100.protein_g, null);
  assertEquals(out?.per_100.carb_g, null);
  assertEquals(out?.per_100.fat_g, null);
});

Deno.test("PARSING: a STATED zero survives as zero", () => {
  // Oil really is 0 g protein. If this ever reads null, the fix went too far
  // and every genuinely-zero macro would silently stop counting.
  const out = parseReading({
    url: "https://example.com/oil",
    per_100: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 },
  });
  assertEquals(out?.per_100.protein_g, 0);
  assertEquals(out?.per_100.carb_g, 0);
  assertEquals(out?.per_100.fat_g, 100);
});

Deno.test("PARSING: end to end, a partial panel does not drag protein down", () => {
  // The whole bug in one assertion: two pages omit protein, one states 3.6.
  // With the coercion in place this returned median([0, 3.6, 0]) = 0.
  const readings = [
    { url: "https://a.example/1", per_100: { kcal: 469, carb_g: 80, fat_g: 18 } },
    { url: "https://b.example/2", per_100: { kcal: 472, protein_g: 3.6, carb_g: 75, fat_g: 17.5 } },
    { url: "https://c.example/3", per_100: { kcal: 470, carb_g: 80, fat_g: 18 } },
  ].map(parseReading).filter((x): x is NonNullable<typeof x> => x !== null);
  assertEquals(readings.length, 3);
  assertEquals(ok(reconcileReadings(readings)).per100.protein_g, 3.6);
});

Deno.test("PARSING: kcal alone is still a reading, and a bad kcal is not", () => {
  assertEquals(parseReading({ url: "https://x.example", per_100: { kcal: 190 } }) !== null, true);
  assertEquals(parseReading({ url: "https://x.example", per_100: { kcal: -1 } }), null);
  assertEquals(parseReading({ url: "https://x.example" }), null);
  assertEquals(parseReading(null), null);
});

Deno.test("PARSING: a FatSecret host is labelled fatsecret, not web", () => {
  // The licensing line. independenceKey excludes FatSecret by name, so a
  // mislabel here would let a FatSecret page vouch for a row we then promote.
  const fs = parseReading({ url: "https://www.fatsecret.co.in/x", per_100: { kcal: 190 } });
  assertEquals(fs?.source, "fatsecret");
  const web = parseReading({ url: "https://www.mynetdiary.com/x", per_100: { kcal: 190 } });
  assertEquals(web?.source, "web");
});

Deno.test("tier 2 takes energy from its own panels, not from every reading", () => {
  // The bug both bots found: complete-panel macros were paired with a median
  // energy computed over EVERY reading, including partial ones and pages with no
  // breakdown - the same "right per column, impossible as a row" failure this
  // file exists to prevent, one tier up. The 700s below must not move the answer.
  const out = ok(reconcileReadings([
    r("https://a.example/x", 540, 7, 58, 32),
    r("https://b.example/x", 545, 7, 60, 30),
    r("https://c.example/x", 700, null, 95, 55),
    r("https://d.example/x", 705, null, 95, 55),
  ]));
  assertEquals(out.how, "complete panels");
  assertEquals(out.per100.kcal, 542.5, "median of 540 and 545, not of all four");
});

// ── Pick the page the others agree with ────────────────────────────────────
// Sarthak's rule, 2026-09-07. Column-wise medians build a panel no page ever
// published; picking a real page cannot produce an impossible row. These pin
// that it is genuinely selected, that it wins on ALL FOUR numbers rather than
// energy alone, and that it stands down when there is no crowd to ask.

Deno.test("CONSENSUS: the outlier loses and a real page is copied whole", () => {
  // a and b agree closely; c is the odd one out.
  //
  // Asserts the CONTRACT, not the winner. a and b are near-identical, so which
  // of them is fractionally more central is an implementation detail and pinning
  // it would make the test break on a harmless change. What must hold is that c
  // loses and that the answer is one of the real panels, byte for byte, rather
  // than a blend of all three. My first version of this asserted a specifically
  // and failed because b was marginally more central - the code was right and
  // the test was over-specified.
  const panels = [
    { kcal: 540, protein_g: 7, carb_g: 58, fat_g: 32 },
    { kcal: 542, protein_g: 7.2, carb_g: 58.5, fat_g: 31.5 },
  ];
  const out = ok(reconcileReadings([
    r("https://a.example/x", 540, 7, 58, 32),
    r("https://b.example/x", 542, 7.2, 58.5, 31.5),
    r("https://c.example/x", 610, 3, 75, 20),
  ]));
  assertEquals(out.how, "the page others agree with");
  const matched = panels.some((p) =>
    p.kcal === out.per100.kcal && p.protein_g === out.per100.protein_g &&
    p.carb_g === out.per100.carb_g && p.fat_g === out.per100.fat_g
  );
  assertEquals(matched, true, `got ${JSON.stringify(out.per100)} - not one of the agreeing panels`);
});

Deno.test("CONSENSUS is judged on all four numbers, not energy alone", () => {
  // b has the most agreeable ENERGY - it sits between a and c - but its protein
  // is wildly out. Judging on kcal alone would pick it. a wins on the whole row.
  const out = ok(reconcileReadings([
    r("https://a.example/x", 500, 20, 50, 20),
    r("https://b.example/x", 505, 2, 52, 21),
    r("https://c.example/x", 510, 20.5, 51, 20.5),
  ]));
  assertEquals(out.how, "the page others agree with");
  // a and c both hold ~20 g; either winning is correct. What must never happen
  // is b winning on its agreeable energy while carrying 2 g of protein.
  assertEquals(out.per100.protein_g >= 19, true, `got ${out.per100.protein_g} g protein`);
  assertEquals(out.per100.protein_g !== 2, true, "b's odd protein must lose it the vote");
});

Deno.test("the winner's OWN energy travels with its macros", () => {
  // The whole point: a real published row, not a row assembled from three.
  const out = ok(reconcileReadings([
    r("https://a.example/x", 400, 10, 50, 12),
    r("https://b.example/x", 402, 10.2, 50.5, 12.1),
    r("https://c.example/x", 900, 10, 50, 12),
  ]));
  assertEquals(out.per100.kcal, 400, "a's own energy, not median([400,402,900])");
});

Deno.test("two pages are not a crowd, so the median still decides", () => {
  // With two, each is exactly as far from the other - picking one would be a
  // coin toss dressed up as consensus.
  const out = ok(reconcileReadings([
    r("https://a.example/x", 540, 7, 58, 32),
    r("https://b.example/x", 560, 9, 60, 34),
  ]));
  assertEquals(out.how, "per-macro pools");
});

Deno.test("a partial page cannot win the vote, and does not block it", () => {
  // c omits protein, so it is not a complete panel and cannot be selected. The
  // three complete ones still form a crowd.
  const out = ok(reconcileReadings([
    r("https://a.example/x", 540, 7, 58, 32),
    r("https://b.example/x", 542, 7.2, 58.5, 31.5),
    r("https://c.example/x", 700, null, 95, 55),
    r("https://d.example/x", 610, 3, 75, 20),
  ]));
  assertEquals(out.how, "the page others agree with");
  // a and b both hold ~7 g and either may win. The contract is that neither the
  // partial page (c, which states no protein) nor the outlier (d, at 3 g) does.
  assertEquals(out.per100.protein_g >= 6.9 && out.per100.protein_g <= 7.3, true,
    `got ${out.per100.protein_g} g protein`);
});

Deno.test("agreeing zeros are agreement, not infinite disagreement", () => {
  // Oil: every page says 0 g carb. A naive relative distance divides by zero and
  // would score identical pages as infinitely far apart.
  const out = ok(reconcileReadings([
    r("https://a.example/oil", 884, 0, 0, 100),
    r("https://b.example/oil", 884, 0, 0, 100),
    r("https://c.example/oil", 883, 0, 0, 99.9),
  ]));
  assertEquals(out.how, "the page others agree with");
  assertObjectMatch(out.per100, { protein_g: 0, carb_g: 0 });
});

Deno.test("the winner's fibre travels with it, not a blend of everyone's", () => {
  // MY FIRST VERSION OF THIS TEST WAS FAKE and the review did the arithmetic to
  // prove it: c won rather than the b I claimed, c's fibre was also 9, and
  // median([9, 2.5, 9]) is 9 too - so it passed under the pooled behaviour it
  // was named after. Third time I have written a test that agrees with whatever
  // the code does.
  //
  // This one cannot. b sits exactly between a and c on all four numbers, so b is
  // unambiguously the most central and wins. b is ALSO the only page with a
  // different fibre, and the pooled median of [9, 2.5, 9] is 9 - so the pooled
  // answer and the correct answer are different numbers, which is the whole
  // point of a regression test.
  const out = ok(reconcileReadings([
    r("https://a.example/x", 540, 7, 58, 32, 9),
    r("https://b.example/x", 541, 7.05, 58.1, 32.05, 2.5),
    r("https://c.example/x", 542, 7.1, 58.2, 32.1, 9),
  ]));
  assertEquals(out.how, "the page others agree with");
  assertEquals(out.per100.kcal, 541, "b is the central page");
  assertEquals(out.fiber_g, 2.5, "b's own fibre, not median([9, 2.5, 9]) = 9");
});

Deno.test("a winner that printed no fibre reports null, not a borrowed figure", () => {
  const out = ok(reconcileReadings([
    r("https://a.example/x", 540, 7, 58, 32, null),
    r("https://b.example/x", 541, 7.05, 58.1, 32.1, null),
    r("https://c.example/x", 610, 3, 75, 20, 12),
  ]));
  assertEquals(out.how, "the page others agree with");
  // c has the fibre and c is the outlier. Borrowing its 12 g would put a number
  // on the row that the page we actually used never printed.
  assertEquals(out.fiber_g, null);
});
