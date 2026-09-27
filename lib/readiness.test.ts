// Run with:
//   deno test --unstable-sloppy-imports --import-map=lib/test-import-map.json lib/readiness.test.ts
//
// readiness.ts imports '@/constants/theme' for band colours; the import map
// points '@/' at the repo root and sloppy imports resolve the missing '.ts'.
//
// The parts are what the coach reads to learn WHY a score is what it is, and
// what could not be read. They must add up to the score the person saw.

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { computeReadiness, READINESS_FORMULA_VERSION, type BaselineStat } from "./readiness.ts";

const base = (mean: number, sd: number, n = 20): BaselineStat => ({ mean, sd, n });
const full = {
  sleepMinutes: base(450, 40),
  restingHrBpm: base(60, 3),
  hrvMs: base(50, 8),
};

Deno.test("A1: sleep, resting HR and HRV all used, shares 0.2 / 0.3 / 0.5", () => {
  const r = computeReadiness({ today: { sleepMinutes: 490, restingHrBpm: 57, hrvMs: 58 }, baseline: full });
  const p = r.parts;
  assertEquals(r.tier, "A1");
  assertEquals(p.formula, READINESS_FORMULA_VERSION);
  assertEquals([p.sleep.basis, p.rhr.why, p.hrv.why], ["personal", "used", "used"]);
  assertAlmostEquals(p.sleep.share, 0.2);
  assertAlmostEquals(p.rhr.share, 0.3);
  assertAlmostEquals(p.hrv.share, 0.5);
  // sleep z 1, rhr z +1 (lower is better), hrv z 1: every signal adds 15 x its share.
  assertAlmostEquals(p.sleep.points, 3);
  assertAlmostEquals(p.rhr.points, 4.5);
  assertAlmostEquals(p.hrv.points, 7.5);
});

Deno.test("the parts add up to the score: 50 + signal points = base score", () => {
  const r = computeReadiness({ today: { sleepMinutes: 400, sleepQuality: 2, restingHrBpm: 64, hrvMs: 41 }, baseline: full });
  const p = r.parts;
  assertEquals(p.baseScore, Math.round(50 + p.sleep.points + p.rhr.points + p.hrv.points));
  assertEquals(p.score, r.score);
  assertEquals(p.baseScore, r.score); // no load, no diet
});

Deno.test("HRV without resting HR is read but not used", () => {
  const r = computeReadiness({ today: { sleepMinutes: 450, hrvMs: 58 }, baseline: full });
  assertEquals(r.tier, "A3");
  assertEquals(r.parts.hrv.why, "needs_rhr");
  assertEquals(r.parts.hrv.share, 0);
  assertEquals(r.parts.hrv.points, 0);
  assertEquals(r.parts.rhr.why, "no_reading");
  assertAlmostEquals(r.parts.sleep.share, 1);
});

Deno.test("resting HR with under 7 days of history is read but not used", () => {
  const r = computeReadiness({
    today: { sleepMinutes: 450, restingHrBpm: 58 },
    baseline: { ...full, restingHrBpm: base(60, 3, 3) },
  });
  assertEquals(r.parts.rhr.why, "short_baseline");
  assertEquals(r.parts.rhr.baselineN, 3);
  assertEquals(r.parts.rhr.share, 0);
});

Deno.test("under 7 nights of sleep history: scored against the population", () => {
  const r = computeReadiness({ today: { sleepMinutes: 465 }, baseline: { sleepMinutes: base(450, 40, 2) } });
  assertEquals(r.provisional, true);
  assertEquals(r.parts.sleep.basis, "population");
  assertEquals(r.parts.sleep.baselineN, 2);
});

Deno.test("no sleep: no score, and the heart signals could not count", () => {
  const r = computeReadiness({ today: { restingHrBpm: 57, hrvMs: 58 }, baseline: full });
  assertEquals(r.score, null);
  assertEquals(r.tier, "none");
  assertEquals(r.parts.sleep.basis, null);
  assertEquals([r.parts.rhr.why, r.parts.hrv.why], ["needs_sleep", "needs_sleep"]);
  assertEquals(r.parts.score, null);
});

Deno.test("training load: twice the usual week costs 10 points (the cap)", () => {
  const r = computeReadiness({
    today: { sleepMinutes: 450 },
    baseline: full,
    acuteLoad: { last7dSets: 80, typicalWeeklySets: 40 },
  });
  assertEquals(r.parts.load?.ratio, 2);
  assertEquals(r.parts.load?.points, -10);
  assertEquals(r.score, (r.parts.baseScore ?? 0) - 10);
});

Deno.test("training load under 130% of usual is recorded at 0 points", () => {
  const r = computeReadiness({ today: { sleepMinutes: 450 }, baseline: full, acuteLoad: { last7dSets: 44, typicalWeeklySets: 40 } });
  assertEquals(r.parts.load?.points, 0);
});

Deno.test("food: protein on target adds 4 points; no food logged is null", () => {
  const fed = computeReadiness({ today: { sleepMinutes: 450 }, baseline: full, nutrition: { proteinRatio: 1, energyRatio: 1 } });
  assertEquals(fed.parts.diet?.points, 4);
  assertEquals(fed.score, (fed.parts.baseScore ?? 0) + 4);
  const unfed = computeReadiness({ today: { sleepMinutes: 450 }, baseline: full });
  assertEquals(unfed.parts.diet, null);
  assertEquals(unfed.parts.load, null);
});
