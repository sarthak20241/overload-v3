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

/** The Connect columns as the row holds them now. */
export interface StoredConnect {
  connect_plan: string | null;
  connect_expires_at: string | null;
}

function ms(at: string | null | undefined): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/**
 * Why a Connect purchase or renewal must NOT be written, or null to write it.
 *
 * - A subscription with no expiry would read as active forever (the access
 *   check treats a null expiry as no end), so it is never written. A lifetime
 *   has no expiry by design.
 * - A subscription never replaces a Connect lifetime: a lifetime and a
 *   subscription can both exist on one Apple ID, and the subscription's later
 *   expiry would then clear the lifetime the user paid for.
 * - A RENEWAL retried late, after a newer renewal of the same plan, must not
 *   move the expiry back. Only the same plan is compared: a plan change may
 *   rightly bring an earlier date.
 */
export function connectWriteSkip(
  stored: StoredConnect | null | undefined,
  plan: ConnectPlan,
  eventType: string,
  expiresAt: string | null,
): string | null {
  if (plan === "lifetime") return null;
  if (!expiresAt) return "subscription event has no expiry";
  if (stored?.connect_plan === "lifetime") return "row holds a Connect lifetime";
  if (eventType === "RENEWAL" && stored?.connect_plan === plan) {
    const have = ms(stored.connect_expires_at);
    const next = ms(expiresAt);
    if (have !== null && next !== null && next <= have) return "older renewal than the stored one";
  }
  return null;
}

/**
 * May an EXPIRATION or refund of `ended` clear the row's Connect? Only when
 * the row still holds that plan. Otherwise the end belongs to a plan the row
 * has already moved past (a monthly event late after an annual was written,
 * or a subscription beside a lifetime), and clearing would take away the plan
 * the user holds now. An expiry also keeps a row whose stored period ends
 * after the expiring one: a newer renewal already landed.
 */
export function connectEndClears(
  stored: StoredConnect | null | undefined,
  ended: ConnectPlan,
  why: "expiration" | "refund",
  eventExpiresAtMs?: number | null,
): boolean {
  if (!stored?.connect_plan) return false; // nothing to clear
  if (stored.connect_plan !== ended) return false;
  if (why === "expiration" && ended !== "lifetime") {
    const have = ms(stored.connect_expires_at);
    if (have !== null && typeof eventExpiresAtMs === "number" && have > eventExpiresAtMs) return false;
  }
  return true;
}
