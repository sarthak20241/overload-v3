// Run with: deno test lib/tiers.test.ts
//
// lib/tiers.ts has no imports, so Deno can test it directly.
//
// These rules were wrong in two screens before they lived in one file, and both
// bugs were the same shape: code that assumed founding_lifetime was the only
// lifetime tier. An AppSumo buyer was shown "Manage or cancel in the App Store"
// for a purchase redeemed with a code that no store has ever seen.

import { assertEquals } from "jsr:@std/assert@1";
import { isLifetimeTier, isStorePurchase, PLAN_BENEFITS, tierLabel } from "./tiers.ts";

/**
 * The CHECK constraint on user_profiles.tier, read from production on
 * 2026-09-12. If a migration changes the column, change this list and watch
 * which assertions break.
 */
const DB_TIERS = ["free", "monthly", "annual", "founding_lifetime", "appsumo_lifetime"];

/** Dropped by migration 0030. Anything still branching on it is dead code. */
const DROPPED_TIER = "founding_annual";

Deno.test("both lifetime tiers are lifetime, not just the founding one", () => {
  assertEquals(isLifetimeTier("founding_lifetime"), true);
  assertEquals(isLifetimeTier("appsumo_lifetime"), true);
});

Deno.test("subscriptions and free are not lifetime", () => {
  assertEquals(isLifetimeTier("monthly"), false);
  assertEquals(isLifetimeTier("annual"), false);
  assertEquals(isLifetimeTier("free"), false);
});

Deno.test("an absent tier is not lifetime", () => {
  assertEquals(isLifetimeTier(null), false);
  assertEquals(isLifetimeTier(undefined), false);
  assertEquals(isLifetimeTier(""), false);
});

Deno.test("only manageable store subscriptions point at a store", () => {
  assertEquals(isStorePurchase("monthly"), true);
  assertEquals(isStorePurchase("annual"), true);
  assertEquals(isStorePurchase("free"), false);
  assertEquals(isStorePurchase(null), false);
});

Deno.test("no lifetime tier points at a store, however it was bought", () => {
  // appsumo_lifetime was redeemed with a code, so no store has seen it.
  assertEquals(isStorePurchase("appsumo_lifetime"), false);
  // founding_lifetime DID go through the App Store, but a non-consumable never
  // appears under Manage Subscriptions and has nothing to cancel. This must be
  // false from the function itself, not from a caller remembering to add
  // "&& !isLifetimeTier(...)".
  assertEquals(isStorePurchase("founding_lifetime"), false);
  for (const tier of DB_TIERS) {
    if (!isLifetimeTier(tier)) continue;
    assertEquals(isStorePurchase(tier), false, `${tier} should not point at a store`);
  }
});

Deno.test("every paid tier the database allows has a real label", () => {
  for (const tier of DB_TIERS) {
    if (tier === "free") continue;
    const label = tierLabel(tier);
    assertEquals(
      label !== "Active",
      true,
      `${tier} falls through to the "Active" placeholder`,
    );
  }
});

Deno.test("an unrecognized tier degrades to Active rather than throwing", () => {
  assertEquals(tierLabel("something_new"), "Active");
  assertEquals(tierLabel(null), "Active");
  // The dropped tier is deliberately unhandled; it cannot appear in the column.
  assertEquals(tierLabel(DROPPED_TIER), "Active");
});

Deno.test("nothing claims the dropped tier is real", () => {
  assertEquals(isLifetimeTier(DROPPED_TIER), false);
  assertEquals(isStorePurchase(DROPPED_TIER), false);
});

Deno.test("the benefit list is non-empty and has no blank entries", () => {
  assertEquals(PLAN_BENEFITS.length > 0, true);
  for (const line of PLAN_BENEFITS) {
    assertEquals(line.trim().length > 0, true);
  }
});
