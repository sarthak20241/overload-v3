// Run with: deno test supabase/functions/revenuecat-webhook/eventProduct.test.ts
//
// The first test is the production bug: reading `product_id` on a
// PRODUCT_CHANGE records the plan the subscriber LEFT. Once Annual outranks
// Monthly in the App Store Connect subscription group, Apple applies the
// switch immediately, and getting this wrong bills someone for a year of
// Annual while recording them on Monthly.

import { assertEquals } from "jsr:@std/assert@1";
import { effectiveProductId } from "./eventProduct.ts";

const MONTHLY = "overload_monthly";
const ANNUAL = "overload_annual";

Deno.test("a plan switch resolves to the product moved TO, not FROM", () => {
  assertEquals(
    effectiveProductId({
      type: "PRODUCT_CHANGE",
      product_id: MONTHLY,
      new_product_id: ANNUAL,
    }),
    ANNUAL,
  );
});

Deno.test("a switch in the other direction resolves the same way", () => {
  assertEquals(
    effectiveProductId({
      type: "PRODUCT_CHANGE",
      product_id: ANNUAL,
      new_product_id: MONTHLY,
    }),
    MONTHLY,
  );
});

Deno.test("a plan switch with no new_product_id falls back to product_id", () => {
  // Stores other than the App Store may omit the field.
  assertEquals(
    effectiveProductId({ type: "PRODUCT_CHANGE", product_id: MONTHLY }),
    MONTHLY,
  );
});

Deno.test("every other event type uses product_id, even if new_product_id leaks in", () => {
  for (const type of ["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "EXPIRATION", "REFUND"]) {
    assertEquals(
      effectiveProductId({ type, product_id: MONTHLY, new_product_id: ANNUAL }),
      MONTHLY,
      `${type} must not read new_product_id`,
    );
  }
});

Deno.test("a missing product is passed through as undefined, not guessed", () => {
  assertEquals(effectiveProductId({ type: "INITIAL_PURCHASE" }), undefined);
  assertEquals(effectiveProductId({ type: "PRODUCT_CHANGE" }), undefined);
  assertEquals(effectiveProductId({}), undefined);
});
