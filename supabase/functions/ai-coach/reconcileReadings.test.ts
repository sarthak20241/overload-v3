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
