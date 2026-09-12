// Run with: deno test supabase/functions/revenuecat-webhook/transferDecision.test.ts
//
// Covers what a TRANSFER does to the two user_profiles rows. Getting this wrong
// is expensive and silent in BOTH directions: clobber the target and a customer
// sees the wrong plan (a monthly purchase reading "yours forever"); skip the
// source release and one purchase entitles two accounts forever.
//
// The first test is the production bug this file was written for.

import { assertEquals } from "jsr:@std/assert@1";
import { decideTransfer } from "./transferDecision.ts";

const AUG_LIFETIME = { tier: "founding_lifetime", tier_started_at: "2026-08-22T05:36:04.706688+00:00" };
const SEP_MONTHLY = { tier: "monthly", tier_started_at: "2026-09-12T10:37:40.414573+00:00" };
const FREE = { tier: "free", tier_started_at: null };

Deno.test("does not paste a stale tier over a newer purchase (the 2026-09-12 bug)", () => {
  // Same Apple ID: lifetime in August on one account, monthly today on a new
  // one. INITIAL_PURCHASE set monthly, then TRANSFER arrived carrying August.
  const { action } = decideTransfer(AUG_LIFETIME, SEP_MONTHLY);
  assertEquals(action, "release_only");
});

Deno.test("still releases the source when the target keeps its own tier", () => {
  // The receipt left the source, so the source must not keep access even though
  // nothing is written to the target.
  const { action } = decideTransfer(AUG_LIFETIME, SEP_MONTHLY);
  assertEquals(action, "release_only");
});

Deno.test("moves the entitlement onto a target that has none", () => {
  assertEquals(decideTransfer(AUG_LIFETIME, FREE).action, "move");
  assertEquals(decideTransfer(AUG_LIFETIME, null).action, "move");
  assertEquals(decideTransfer(AUG_LIFETIME, {}).action, "move");
});

Deno.test("moves when the transferred entitlement is strictly newer", () => {
  assertEquals(decideTransfer(SEP_MONTHLY, AUG_LIFETIME).action, "move");
});

Deno.test("keeps the target on an exact timestamp tie, so a replay cannot undo a purchase", () => {
  // Re-delivering the same TRANSFER must be a no-op on the target.
  assertEquals(
    decideTransfer(SEP_MONTHLY, { ...SEP_MONTHLY }).action,
    "release_only",
  );
});

Deno.test("does nothing when the source has no paid tier", () => {
  assertEquals(decideTransfer(FREE, FREE).action, "none");
  assertEquals(decideTransfer(null, FREE).action, "none");
  assertEquals(decideTransfer({ tier: null }, FREE).action, "none");
});

Deno.test("an undated entitlement never beats a dated one", () => {
  // A row with no tier_started_at is treated as infinitely old.
  assertEquals(
    decideTransfer({ tier: "annual", tier_started_at: null }, SEP_MONTHLY).action,
    "release_only",
  );
  // ...but it still moves onto a target that holds nothing.
  assertEquals(
    decideTransfer({ tier: "annual", tier_started_at: null }, FREE).action,
    "move",
  );
});

Deno.test("a garbage timestamp is treated as undated rather than throwing", () => {
  assertEquals(
    decideTransfer({ tier: "annual", tier_started_at: "not a date" }, SEP_MONTHLY).action,
    "release_only",
  );
});

Deno.test("every decision carries a reason for the production log", () => {
  for (const [source, target] of [
    [AUG_LIFETIME, SEP_MONTHLY],
    [AUG_LIFETIME, FREE],
    [FREE, FREE],
  ] as const) {
    const { reason } = decideTransfer(source, target);
    assertEquals(typeof reason === "string" && reason.length > 0, true);
  }
});
