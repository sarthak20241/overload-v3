// Which plan a RevenueCat product is, and what each event writes for it.
//
// Split out of index.ts (it reads env vars and calls Deno.serve at module
// scope, so a test cannot import it), like transferIds.ts and eventProduct.ts.
//
// TWO plans live on one user_profiles row, each in its own columns:
//
//   Pro      tier, tier_started_at, tier_expires_at      (Drona + everything)
//   Connect  connect_plan, connect_started_at,           (tracker + the MCP
//            connect_expires_at                           connector, no Drona)
//
// Connect is NEVER written to `tier`: every Pro check reads `tier <> 'free'`
// as Pro, so a Connect value there would hand a $2.99 buyer Drona. See
// supabase/migrations/20261112150000_connect_plan.sql.
//
// An event only ever touches the columns of ITS product's plan. Moving between
// the plans needs no cross-clearing: each side carries its own expiry, and the
// access check ignores an expired one. That matters because the stores time a
// switch differently. Apple applies an upgrade (Connect to Pro) at once and a
// downgrade (Pro to Connect) at the end of the paid period, and RevenueCat
// sends PRODUCT_CHANGE when the user ASKS. Clearing Pro on that event would
// take away a Pro period the user already paid for.

export type ProTier = "monthly" | "annual" | "founding_lifetime";
export type ConnectPlan = "monthly" | "annual" | "lifetime";

export type Plan =
  | { kind: "pro"; tier: ProTier }
  | { kind: "connect"; plan: ConnectPlan };

/** Env var name -> plan it maps to. Each value is a comma list (Apple id, Play id). */
export const PRODUCT_ENV: ReadonlyArray<readonly [string, Plan]> = [
  ["RC_PRODUCT_MONTHLY", { kind: "pro", tier: "monthly" }],
  ["RC_PRODUCT_ANNUAL", { kind: "pro", tier: "annual" }],
  ["RC_PRODUCT_FOUNDING_LIFETIME", { kind: "pro", tier: "founding_lifetime" }],
  ["RC_PRODUCT_CONNECT_MONTHLY", { kind: "connect", plan: "monthly" }],
  ["RC_PRODUCT_CONNECT_ANNUAL", { kind: "connect", plan: "annual" }],
  ["RC_PRODUCT_CONNECT_LIFETIME", { kind: "connect", plan: "lifetime" }],
];

export function buildProductMap(env: (name: string) => string | undefined): Map<string, Plan> {
  const map = new Map<string, Plan>();
  for (const [name, plan] of PRODUCT_ENV) {
    for (const id of (env(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      map.set(id, plan);
    }
  }
  return map;
}

export function productIdToPlan(map: Map<string, Plan>, productId: string | undefined): Plan | null {
  if (!productId) return null;
  return map.get(productId) ?? null;
}

/** True for a one-time purchase (nothing renews, nothing expires). */
export function isLifetimePlan(plan: Plan): boolean {
  return plan.kind === "pro" ? plan.tier === "founding_lifetime" : plan.plan === "lifetime";
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The Connect columns a purchase or a missed-start renewal writes. */
export function connectStart(
  plan: ConnectPlan,
  event: { purchased_at_ms?: number; expiration_at_ms?: number | null },
  now: Date = new Date(),
): Record<string, string | null> {
  return {
    connect_plan: plan,
    connect_started_at: iso(event.purchased_at_ms) ?? now.toISOString(),
    // A lifetime never expires, whatever the event says.
    connect_expires_at: plan === "lifetime" ? null : iso(event.expiration_at_ms),
  };
}

/** Clearing Connect (expiry, refund, receipt moved away). */
export const CONNECT_CLEARED: Readonly<Record<string, null>> = {
  connect_plan: null,
  connect_started_at: null,
  connect_expires_at: null,
};

/**
 * May an EXPIRATION for a Connect product clear the row's Connect? Not when
 * the row holds a Connect lifetime: a lifetime and a subscription can both
 * exist on one Apple ID, and the subscription's end must not erase the
 * lifetime the user also bought.
 */
export function connectExpiryClears(currentPlan: string | null | undefined): boolean {
  return currentPlan !== "lifetime";
}
