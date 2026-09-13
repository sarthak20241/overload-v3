// Which product a RevenueCat event is actually ABOUT.
//
// Split out of index.ts for the same reason as transferIds.ts and
// transferDecision.ts: index.ts reads env vars and calls Deno.serve at module
// scope, so a test cannot import it.
//
// WHY THIS EXISTS (found 2026-09-13 from a real plan switch):
// on a PRODUCT_CHANGE, RevenueCat's `product_id` is the product the subscriber
// switched **from**, and the one they switched **to** is in a separate
// `new_product_id` field:
//
//   new_product_id — "Product the subscriber switched to. This is only included
//   on PRODUCT_CHANGE for App Store, deferred Google Play changes, and
//   RevenueCat Billing (where product_id is the product the subscriber
//   switched from)."
//   https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields
//
// The handler read `product_id` for both INITIAL_PURCHASE and PRODUCT_CHANGE,
// so a plan switch recorded the plan being LEFT. That was harmless only
// because App Store Connect ranked Overload Monthly above Overload Annual, so
// Apple deferred every monthly→annual switch to the end of the paid period and
// "monthly" happened to be the right answer. The moment Annual is ranked
// higher — which is the point, so an annual purchase applies immediately —
// Apple switches the subscriber straight away and the old code would have
// recorded them on the CHEAPER plan for a year after they paid for the dearer
// one.
//
// On a DEFERRED change `new_product_id` is present too, so this will name the
// new plan slightly before it technically starts. That is deliberate and
// harmless: both plans grant identical access, nothing is over- or
// under-granted, the label is at worst right-early rather than wrong-late, and
// the RENEWAL that follows re-states it anyway.

/** Only the fields this decision needs. */
export interface ProductEvent {
  type?: string;
  product_id?: string;
  new_product_id?: string;
}

/**
 * The product identifier the event's tier should be derived from.
 *
 * PRODUCT_CHANGE prefers `new_product_id`; every other event type uses
 * `product_id`, and PRODUCT_CHANGE falls back to it when the field is absent
 * (stores other than the App Store may omit it).
 */
export function effectiveProductId(event: ProductEvent): string | undefined {
  if (event.type === "PRODUCT_CHANGE") {
    return event.new_product_id ?? event.product_id;
  }
  return event.product_id;
}
