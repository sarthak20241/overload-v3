// Run with: deno test lib/xp.test.ts
//
// lib/xp.ts has no imports, so Deno can test it directly even though the rest
// of the app is Metro-only. Two properties matter here and neither is obvious
// from reading the table:
//
//   1. Levels 1-11 must never move. The thresholds are applied to a stored
//      user_profiles.xp, so editing an early one silently re-levels every
//      existing account.
//   2. Every title must be reachable. The table used to stop at level 11 while
//      TITLE_TIERS promised Dedicated at 15 and Legend at 50, so six of the
//      eight titles were dead and "Regular" was the ceiling for everyone.

import { assertEquals } from "jsr:@std/assert@1";
import { getLevelInfo, getTierForLevel, getXpForWorkout, isMaxLevel, TITLE_TIERS, XP_PER_LEVEL } from "./xp.ts";

/** The original table, hardcoded. Do not "fix" these to match a change. */
const FROZEN_PREFIX = [0, 283, 600, 1000, 1500, 2200, 3100, 4200, 5500, 7000, 9000];

Deno.test("levels 1-11 keep their original thresholds", () => {
  assertEquals(XP_PER_LEVEL.slice(0, FROZEN_PREFIX.length), FROZEN_PREFIX);
});

Deno.test("every title tier is reachable", () => {
  const maxLevel = XP_PER_LEVEL.length;
  for (const tier of TITLE_TIERS) {
    assertEquals(
      tier.minLevel <= maxLevel,
      true,
      `${tier.title} needs level ${tier.minLevel} but the cap is ${maxLevel}`,
    );
  }
});

Deno.test("every level from 1 to the cap resolves to a title", () => {
  for (let level = 1; level <= XP_PER_LEVEL.length; level++) {
    const tier = getTierForLevel(level);
    assertEquals(
      level >= tier.minLevel && level <= tier.maxLevel,
      true,
      `level ${level} fell through to ${tier.title}`,
    );
  }
});

Deno.test("each level costs strictly more than the one before", () => {
  const steps = XP_PER_LEVEL.slice(1).map((v, i) => v - XP_PER_LEVEL[i]);
  for (let i = 1; i < steps.length; i++) {
    assertEquals(
      steps[i] > steps[i - 1],
      true,
      `level ${i + 2} costs ${steps[i]}, not more than level ${i + 1}'s ${steps[i - 1]}`,
    );
  }
});

Deno.test("a threshold lands exactly on its level, one XP short stays below", () => {
  for (let level = 2; level <= XP_PER_LEVEL.length; level++) {
    const at = XP_PER_LEVEL[level - 1];
    assertEquals(getLevelInfo(at).level, level, `${at} XP should be level ${level}`);
    assertEquals(getLevelInfo(at - 1).level, level - 1, `${at - 1} XP should be level ${level - 1}`);
  }
});

Deno.test("xpInLevel and xpNeeded describe progress inside the level", () => {
  // 8,109 was a real account: level 10 (7,000) with 1,109 of the 2,000 needed.
  assertEquals(getLevelInfo(8109), { level: 10, xpInLevel: 1109, xpNeeded: 2000 });
});

Deno.test("zero and negative XP do not crash or produce level 0", () => {
  assertEquals(getLevelInfo(0).level, 1);
  assertEquals(getLevelInfo(-5).level, 1);
});

Deno.test("past the cap the bar reads full instead of against a ghost threshold", () => {
  const cap = XP_PER_LEVEL.length;
  const info = getLevelInfo(XP_PER_LEVEL[cap - 1] + 999_999);
  assertEquals(info.level, cap);
  assertEquals(info.xpInLevel / info.xpNeeded, 1);
});

Deno.test("Legend is the title at the cap", () => {
  assertEquals(getTierForLevel(XP_PER_LEVEL.length).title, "Legend");
});

Deno.test("workout XP is sets x 2 plus volume / 100, floored", () => {
  assertEquals(getXpForWorkout(20, 5000), 90);
  assertEquals(getXpForWorkout(0, 0), 0);
  assertEquals(getXpForWorkout(1, 50), 2); // 2 + 0.5 -> floor
});

Deno.test("isMaxLevel matches getLevelInfo's own clamp", () => {
  const cap = XP_PER_LEVEL.length;
  assertEquals(isMaxLevel(cap), true);
  assertEquals(isMaxLevel(cap + 1), true);
  assertEquals(isMaxLevel(cap - 1), false);
  assertEquals(isMaxLevel(1), false);
  // The clamp and the predicate must agree, or a caller prints "1 / 1".
  assertEquals(isMaxLevel(getLevelInfo(XP_PER_LEVEL[cap - 1]).level), true);
});
