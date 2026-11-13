// Run with: deno test supabase/functions/revenuecat-webhook/plans.test.ts
//
// Which plan a product is, and which columns its events write. The expensive
// mistake is a Connect product landing in `tier`: every Pro check reads
// `tier <> 'free'` as Pro, so a $2.99 buyer would get Drona.

import { assertEquals } from "jsr:@std/assert@1";
import {
  buildProductMap,
  CONNECT_CLEARED,
  connectEndClears,
  connectStart,
  connectWriteSkip,
  isLifetimePlan,
  productIdToPlan,
} from "./plans.ts";

const ENV: Record<string, string> = {
  RC_PRODUCT_MONTHLY: "overload_monthly, overload_monthly:monthly",
  RC_PRODUCT_ANNUAL: "overload_annual,overload_annual:annual",
  RC_PRODUCT_FOUNDING_LIFETIME: "overload_founding_lifetime",
  RC_PRODUCT_CONNECT_MONTHLY: "overload_connect_monthly,overload_connect:monthly",
  RC_PRODUCT_CONNECT_ANNUAL: "overload_connect_annual,overload_connect:annual",
  RC_PRODUCT_CONNECT_LIFETIME: "overload_connect_lifetime",
};
const map = buildProductMap((k) => ENV[k]);

Deno.test("Pro products map to a Pro tier, Apple and Play ids alike", () => {
  assertEquals(productIdToPlan(map, "overload_monthly"), { kind: "pro", tier: "monthly" });
  assertEquals(productIdToPlan(map, "overload_monthly:monthly"), { kind: "pro", tier: "monthly" });
  assertEquals(productIdToPlan(map, "overload_annual"), { kind: "pro", tier: "annual" });
});

Deno.test("Connect products never map to a Pro tier", () => {
  for (const id of ["overload_connect_monthly", "overload_connect:monthly", "overload_connect_annual",
    "overload_connect:annual", "overload_connect_lifetime"]) {
    assertEquals(productIdToPlan(map, id)?.kind, "connect", id);
  }
  assertEquals(productIdToPlan(map, "overload_connect:annual"), { kind: "connect", plan: "annual" });
});

Deno.test("an unknown or missing product is no plan", () => {
  assertEquals(productIdToPlan(map, "something_else"), null);
  assertEquals(productIdToPlan(map, undefined), null);
});

Deno.test("an unset Connect env var maps nothing and breaks nothing", () => {
  const proOnly = buildProductMap((k) => (k.includes("CONNECT") ? undefined : ENV[k]));
  assertEquals(productIdToPlan(proOnly, "overload_connect_monthly"), null);
  assertEquals(productIdToPlan(proOnly, "overload_annual"), { kind: "pro", tier: "annual" });
});

Deno.test("lifetimes are the two one-time products", () => {
  assertEquals(isLifetimePlan({ kind: "pro", tier: "founding_lifetime" }), true);
  assertEquals(isLifetimePlan({ kind: "connect", plan: "lifetime" }), true);
  assertEquals(isLifetimePlan({ kind: "pro", tier: "annual" }), false);
  assertEquals(isLifetimePlan({ kind: "connect", plan: "monthly" }), false);
});

Deno.test("a Connect start writes only Connect columns", () => {
  const row = connectStart("annual", { purchased_at_ms: Date.UTC(2026, 10, 12), expiration_at_ms: Date.UTC(2027, 10, 12) });
  assertEquals(Object.keys(row).sort(), ["connect_expires_at", "connect_plan", "connect_started_at"]);
  assertEquals(row.connect_plan, "annual");
  assertEquals(row.connect_started_at, "2026-11-12T00:00:00.000Z");
  assertEquals(row.connect_expires_at, "2027-11-12T00:00:00.000Z");
});

Deno.test("a Connect lifetime has no expiry even if the event carries one", () => {
  const row = connectStart("lifetime", { purchased_at_ms: Date.UTC(2026, 10, 12), expiration_at_ms: Date.UTC(2027, 0, 1) });
  assertEquals(row.connect_expires_at, null);
});

Deno.test("a start with no purchase time uses now", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  assertEquals(connectStart("monthly", {}, now).connect_started_at, "2026-11-12T10:00:00.000Z");
});

Deno.test("clearing Connect touches only Connect columns", () => {
  assertEquals(Object.keys(CONNECT_CLEARED).sort(), ["connect_expires_at", "connect_plan", "connect_started_at"]);
});

const JAN = "2027-01-01T00:00:00.000Z";
const FEB = "2027-02-01T00:00:00.000Z";

Deno.test("a subscription expiry never erases a Connect lifetime", () => {
  const life = { connect_plan: "lifetime", connect_expires_at: null };
  assertEquals(connectEndClears(life, "monthly", "expiration", Date.parse(JAN)), false);
  assertEquals(connectEndClears(life, "monthly", "refund"), false);
  // A refund of the lifetime itself clears it.
  assertEquals(connectEndClears(life, "lifetime", "refund"), true);
});

Deno.test("an end clears only the plan the row holds", () => {
  const annual = { connect_plan: "annual", connect_expires_at: FEB };
  // A monthly event late after the annual was written keeps the annual.
  assertEquals(connectEndClears(annual, "monthly", "expiration", Date.parse(JAN)), false);
  assertEquals(connectEndClears(annual, "monthly", "refund"), false);
  assertEquals(connectEndClears(annual, "annual", "expiration", Date.parse(FEB)), true);
  assertEquals(connectEndClears(annual, "annual", "refund"), true);
  assertEquals(connectEndClears(null, "monthly", "expiration", Date.parse(JAN)), false);
});

Deno.test("an expiry keeps a newer period of the same plan", () => {
  const renewed = { connect_plan: "monthly", connect_expires_at: FEB };
  assertEquals(connectEndClears(renewed, "monthly", "expiration", Date.parse(JAN)), false);
  assertEquals(connectEndClears(renewed, "monthly", "expiration", Date.parse(FEB)), true);
});

Deno.test("a subscription never replaces a Connect lifetime", () => {
  const life = { connect_plan: "lifetime", connect_expires_at: null };
  assertEquals(connectWriteSkip(life, "monthly", "INITIAL_PURCHASE", JAN) !== null, true);
  assertEquals(connectWriteSkip(life, "annual", "RENEWAL", JAN) !== null, true);
  // A lifetime may replace a subscription.
  assertEquals(connectWriteSkip({ connect_plan: "monthly", connect_expires_at: JAN }, "lifetime", "NON_RENEWING_PURCHASE", null), null);
});

Deno.test("a subscription with no expiry is never written", () => {
  assertEquals(connectWriteSkip(null, "monthly", "INITIAL_PURCHASE", null) !== null, true);
  assertEquals(connectWriteSkip(null, "monthly", "INITIAL_PURCHASE", JAN), null);
});

Deno.test("a late renewal never moves the expiry back", () => {
  const renewed = { connect_plan: "monthly", connect_expires_at: FEB };
  assertEquals(connectWriteSkip(renewed, "monthly", "RENEWAL", JAN) !== null, true);
  assertEquals(connectWriteSkip(renewed, "monthly", "RENEWAL", FEB) !== null, true);
  assertEquals(connectWriteSkip({ connect_plan: "monthly", connect_expires_at: JAN }, "monthly", "RENEWAL", FEB), null);
  // A plan change may bring an earlier date.
  assertEquals(connectWriteSkip({ connect_plan: "annual", connect_expires_at: FEB }, "monthly", "RENEWAL", JAN), null);
});
