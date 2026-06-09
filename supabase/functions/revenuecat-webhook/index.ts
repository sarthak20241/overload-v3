// RevenueCat webhook handler.
//
// RevenueCat unifies Apple IAP + Google Play Billing into one webhook stream.
// Auth is dead simple — Bearer token in the Authorization header. No HMAC, no
// timestamp tolerance. The secret is whatever you set in the RevenueCat
// dashboard's webhook settings; we compare against REVENUECAT_WEBHOOK_SECRET.
//
// Deploy with verify_jwt:false. RevenueCat doesn't send a Supabase JWT — the
// Bearer token IS the auth.
//
// Events handled (RevenueCat event type → our action):
//   INITIAL_PURCHASE      → subscription/lifetime activated → set tier
//   RENEWAL               → recurring renewal → extend expiry
//   CANCELLATION          → user cancelled, lapses at period end → log only
//   EXPIRATION            → period ended → downgrade to free
//   BILLING_ISSUE         → payment failed, dunning in progress → log only
//   PRODUCT_CHANGE        → user upgraded/downgraded → re-map tier
//   NON_RENEWING_PURCHASE → one-time IAP (founding_lifetime!) → claim founding
//   REFUND                → reverted → downgrade to free
//
// Critical mapping: `app_user_id` in the RevenueCat payload IS our Clerk
// user id. This requires the mobile app to call `Purchases.logIn(clerk_user_id)`
// before initiating any purchase. Without that, app_user_id will be the
// anonymous RevenueCat id and we can't tie the purchase to a user.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REVENUECAT_WEBHOOK_SECRET = Deno.env.get("REVENUECAT_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Sandbox gate. By default we ACK sandbox events without touching the DB so
// stray test purchases never corrupt production tiers. During pre-launch IAP
// testing (TestFlight + sandbox testers), set REVENUECAT_ALLOW_SANDBOX="true"
// so sandbox events flow through the full handler and actually flip the tier.
// REMOVE / set to "false" before going live to the public App Store.
const REVENUECAT_ALLOW_SANDBOX =
  (Deno.env.get("REVENUECAT_ALLOW_SANDBOX") ?? "").toLowerCase() === "true";

// Product IDs from App Store Connect / Play Console. Each env var accepts a
// comma-separated list so one tier can map to BOTH the Apple and Google
// product IDs without needing separate env vars per platform.
//
// Example: RC_PRODUCT_MONTHLY="overload.monthly,com.overload.monthly"
//   - "overload.monthly" is your Apple product id from App Store Connect
//   - "com.overload.monthly" is your Google product id from Play Console
const RC_PRODUCT_MONTHLY = Deno.env.get("RC_PRODUCT_MONTHLY") ?? "";
const RC_PRODUCT_ANNUAL = Deno.env.get("RC_PRODUCT_ANNUAL") ?? "";
const RC_PRODUCT_FOUNDING_LIFETIME = Deno.env.get("RC_PRODUCT_FOUNDING_LIFETIME") ?? "";

if (!REVENUECAT_WEBHOOK_SECRET) {
  throw new Error(
    "REVENUECAT_WEBHOOK_SECRET must be set in Edge Function secrets " +
    "(set it in RevenueCat dashboard → Project → Integrations → Webhooks → Authorization header)",
  );
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Tier = "monthly" | "annual" | "founding_lifetime";

// Parse comma-separated env vars into sets for fast lookup.
const PRODUCT_MAP: Map<string, Tier> = new Map();
function registerProducts(envVal: string, tier: Tier) {
  for (const id of envVal.split(",").map((s) => s.trim()).filter(Boolean)) {
    PRODUCT_MAP.set(id, tier);
  }
}
registerProducts(RC_PRODUCT_MONTHLY, "monthly");
registerProducts(RC_PRODUCT_ANNUAL, "annual");
registerProducts(RC_PRODUCT_FOUNDING_LIFETIME, "founding_lifetime");

function productIdToTier(productId: string | undefined): Tier | null {
  if (!productId) return null;
  return PRODUCT_MAP.get(productId) ?? null;
}

// Detect provider from RevenueCat's store field. Per their docs: "APP_STORE",
// "PLAY_STORE", "STRIPE", "MAC_APP_STORE", "PROMOTIONAL", "AMAZON". We only
// care about Apple vs Google for purchase_provider tracking.
function storeToProvider(store: string | undefined): "apple" | "google" | "appsumo" {
  if (store === "APP_STORE" || store === "MAC_APP_STORE") return "apple";
  if (store === "PLAY_STORE" || store === "AMAZON") return "google";
  // Fallback — promotional purchases from RC dashboard, or unexpected stores.
  return "apple";
}

// Per RevenueCat docs, the webhook envelope is:
//   { api_version: "1.0", event: { ... } }
// The event object has type-specific fields. We treat them defensively because
// RC has been known to add fields between API versions.
interface RcEvent {
  type: string;
  event_timestamp_ms?: number;
  app_user_id?: string;          // = our clerk_user_id when SDK is logged in
  original_app_user_id?: string;
  product_id?: string;
  store?: string;                 // "APP_STORE" | "PLAY_STORE" | ...
  environment?: "PRODUCTION" | "SANDBOX";
  purchased_at_ms?: number;
  expiration_at_ms?: number | null;
  original_transaction_id?: string;
  transaction_id?: string;
  entitlement_ids?: string[];
  cancel_reason?: string;
  expiration_reason?: string;
  is_family_share?: boolean;
}

interface RcEnvelope {
  api_version: string;
  event: RcEvent;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth: shared secret in Authorization header. RevenueCat sends this exactly
  // as you configured it in their dashboard (typically "Bearer <secret>" or
  // just the raw secret — we accept both forms).
  const auth = req.headers.get("authorization");
  const expected = `Bearer ${REVENUECAT_WEBHOOK_SECRET}`;
  if (auth !== expected && auth !== REVENUECAT_WEBHOOK_SECRET) {
    console.error("[revenuecat] auth header mismatch");
    return new Response("Unauthorized", { status: 401 });
  }

  let body: RcEnvelope;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const event = body.event;
  if (!event || !event.type) {
    return new Response("Missing event", { status: 400 });
  }

  console.log(
    `[revenuecat] type=${event.type} user=${event.app_user_id} product=${event.product_id} env=${event.environment}`,
  );

  // Sandbox events arrive when the app is connected to test products
  // (TestFlight builds, dev builds, sandbox testers). By default we ack them
  // without a DB write so they can't corrupt production tiers. When
  // REVENUECAT_ALLOW_SANDBOX is set we let them through the full handler —
  // this is what makes pre-launch IAP testing actually flip the tier.
  if (event.environment === "SANDBOX" && !REVENUECAT_ALLOW_SANDBOX) {
    console.log(`[revenuecat] SANDBOX event acknowledged, no DB write (set REVENUECAT_ALLOW_SANDBOX=true to process)`);
    return new Response(JSON.stringify({ received: true, sandbox: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (event.environment === "SANDBOX") {
    console.log(`[revenuecat] SANDBOX event — processing (REVENUECAT_ALLOW_SANDBOX enabled)`);
  }

  try {
    switch (event.type) {
      case "INITIAL_PURCHASE":
      case "PRODUCT_CHANGE":
        await handleSubscriptionStart(event);
        break;
      case "RENEWAL":
        await handleRenewal(event);
        break;
      case "NON_RENEWING_PURCHASE":
        // One-time IAP (founding_lifetime). Routes through claim_founding_tier.
        await handleNonRenewingPurchase(event);
        break;
      case "CANCELLATION":
        console.log(
          `[revenuecat] cancellation (lapses at period end): user=${event.app_user_id}`,
        );
        break;
      case "EXPIRATION":
        await handleExpiration(event);
        break;
      case "BILLING_ISSUE":
        console.log(`[revenuecat] billing issue, dunning: user=${event.app_user_id}`);
        break;
      case "REFUND":
        await handleRefund(event);
        break;
      case "SUBSCRIBER_ALIAS":
        // RC merged two anonymous IDs. Not relevant to our DB — app_user_id
        // updates flow through future events.
        console.log(`[revenuecat] subscriber alias: ${event.app_user_id}`);
        break;
      case "TRANSFER":
        // Subscription moved between Apple IDs (family sharing, account swap).
        // The new app_user_id will appear in the next RENEWAL event.
        console.log(`[revenuecat] transfer: ${event.app_user_id}`);
        break;
      default:
        console.log(`[revenuecat] unhandled type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // 500 → RevenueCat retries (their default is 3 retries with backoff).
    // Our handlers are idempotent so replay is safe.
    console.error(`[revenuecat] handler threw for ${event.type}:`, String(err));
    return new Response(
      JSON.stringify({ error: "handler threw", detail: String(err).slice(0, 200) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleSubscriptionStart(event: RcEvent): Promise<void> {
  const tier = productIdToTier(event.product_id);
  if (!tier) {
    console.error(`[revenuecat] unknown product_id on ${event.type}: ${event.product_id}`);
    return;
  }
  if (tier === "founding_lifetime") {
    // Founding lifetime should arrive as NON_RENEWING_PURCHASE, not INITIAL_PURCHASE.
    // If we get here, something is misconfigured — log loudly and skip.
    console.error(
      `[revenuecat] INITIAL_PURCHASE for founding_lifetime — expected NON_RENEWING_PURCHASE. ` +
      `Check your App Store Connect IAP type (should be Non-Consumable, not Subscription).`,
    );
    return;
  }
  if (!event.app_user_id) {
    console.error(`[revenuecat] missing app_user_id on ${event.type}`);
    return;
  }

  const expiresAt = event.expiration_at_ms
    ? new Date(event.expiration_at_ms).toISOString()
    : null;

  const { data, error } = await admin
    .from("user_profiles")
    .update({
      tier,
      tier_started_at: event.purchased_at_ms
        ? new Date(event.purchased_at_ms).toISOString()
        : new Date().toISOString(),
      tier_expires_at: expiresAt,
      purchase_provider: storeToProvider(event.store),
      purchase_id: event.original_transaction_id ?? event.transaction_id ?? null,
    })
    .eq("clerk_user_id", event.app_user_id)
    .select("clerk_user_id");

  if (error) {
    console.error("[revenuecat] subscription start update failed:", error.message);
    throw new Error(`profile update failed: ${error.message}`);
  }
  if (!data || data.length === 0) {
    // Supabase reports error===null even when the filter matched 0 rows. A
    // purchase can arrive before the client has synced its Clerk id into
    // user_profiles, so app_user_id won't match yet. Returning 200 here would
    // silently drop the entitlement; throw instead so RevenueCat retries.
    console.error(
      `[revenuecat] subscription start matched 0 user_profiles rows for app_user_id=${event.app_user_id} — forcing retry`,
    );
    throw new Error(`no user_profiles row for app_user_id=${event.app_user_id}`);
  }

  // Trial conversion (if applicable). No-op if the user never trialed.
  await admin.rpc("mark_trial_converted", { p_clerk_user_id: event.app_user_id });

  console.log(`[revenuecat] tier set: ${tier} expires=${expiresAt} user=${event.app_user_id}`);
}

async function handleNonRenewingPurchase(event: RcEvent): Promise<void> {
  const tier = productIdToTier(event.product_id);
  if (tier !== "founding_lifetime") {
    console.error(
      `[revenuecat] NON_RENEWING_PURCHASE for non-lifetime product ${event.product_id} (tier=${tier})`,
    );
    return;
  }
  if (!event.app_user_id) {
    console.error("[revenuecat] missing app_user_id on NON_RENEWING_PURCHASE");
    return;
  }

  const { data, error } = await admin.rpc("claim_founding_tier", {
    p_clerk_user_id: event.app_user_id,
    p_tier: "founding_lifetime",
    p_purchase_id: event.original_transaction_id ?? event.transaction_id ?? "",
    p_purchase_provider: storeToProvider(event.store),
  });

  if (error) {
    console.error("[revenuecat] claim_founding_tier rpc error:", error.message);
    throw new Error(`claim failed: ${error.message}`);
  }

  if (!data?.ok) {
    if (data?.reason === "sold_out") {
      // Race: customer paid via StoreKit but the cap filled between the
      // client-side gate check and the webhook firing. Refund via RevenueCat
      // — they expose a refund API + Apple's own refund flow.
      //
      // We can't fully auto-refund Apple IAP from the server — Apple requires
      // the user to request a refund or the developer to issue via App Store
      // Connect. RevenueCat tracks this; we log loudly and let support handle
      // the refund manually for the (rare) race scenario.
      console.error(
        `[revenuecat] SOLD OUT race on founding_lifetime — user=${event.app_user_id} ` +
        `transaction=${event.original_transaction_id}. MANUAL REFUND REQUIRED via App Store Connect.`,
      );
      // Mark this in the DB for the admin dashboard to pick up later.
      await admin.from("user_profiles").update({
        purchase_id: `REFUND_NEEDED:${event.original_transaction_id ?? "unknown"}`,
      }).eq("clerk_user_id", event.app_user_id);
      return;
    }
    if (data?.reason === "lifetime_already_claimed") {
      // User already had a lifetime tier. Idempotent replay — ignore.
      console.log(`[revenuecat] founding_lifetime replay (already claimed): user=${event.app_user_id}`);
      return;
    }
    console.error("[revenuecat] claim not_ok:", data);
    return;
  }

  await admin.rpc("mark_trial_converted", { p_clerk_user_id: event.app_user_id });

  console.log(
    `[revenuecat] founding_lifetime claimed: slot=${data.slot_number}/${data.cap} user=${event.app_user_id}`,
  );
}

async function handleRenewal(event: RcEvent): Promise<void> {
  const tier = productIdToTier(event.product_id);
  if (!tier || tier === "founding_lifetime") return;  // lifetime doesn't renew
  if (!event.app_user_id || !event.expiration_at_ms) return;

  const expiresAt = new Date(event.expiration_at_ms).toISOString();
  const { data, error } = await admin
    .from("user_profiles")
    .update({
      tier_expires_at: expiresAt,
      // Keep tier and provider as-is. RC handles provider stability across renewals.
    })
    .eq("clerk_user_id", event.app_user_id)
    .select("clerk_user_id");

  if (error) throw new Error(`renewal update failed: ${error.message}`);
  if (!data || data.length === 0) {
    // 0 rows → the grant never landed; force RevenueCat to retry rather than
    // silently leaving the subscription unextended.
    console.error(
      `[revenuecat] renewal matched 0 user_profiles rows for app_user_id=${event.app_user_id} — forcing retry`,
    );
    throw new Error(`no user_profiles row for app_user_id=${event.app_user_id}`);
  }
  console.log(`[revenuecat] renewed: ${tier} expires=${expiresAt} user=${event.app_user_id}`);
}

async function handleExpiration(event: RcEvent): Promise<void> {
  if (!event.app_user_id) return;

  // Don't downgrade if the user has a lifetime tier (lifetime IAPs don't
  // expire, but if EXPIRATION somehow fires on one, defensively skip).
  const { data: profile } = await admin
    .from("user_profiles")
    .select("tier")
    .eq("clerk_user_id", event.app_user_id)
    .single();

  if (profile?.tier === "founding_lifetime" || profile?.tier === "appsumo_lifetime") {
    console.log(`[revenuecat] EXPIRATION but user has lifetime — ignoring`);
    return;
  }

  const { data, error } = await admin
    .from("user_profiles")
    .update({ tier: "free", tier_expires_at: null })
    .eq("clerk_user_id", event.app_user_id)
    .select("clerk_user_id");

  if (error) throw new Error(`expiration downgrade failed: ${error.message}`);
  if (!data || data.length === 0) {
    // Best-effort downgrade: no matching row means there's nothing to downgrade
    // (e.g. the account was deleted). Don't throw — that would make RevenueCat
    // retry this no-op forever.
    console.warn(`[revenuecat] expiration matched 0 rows for user=${event.app_user_id} — nothing to downgrade`);
    return;
  }
  console.log(`[revenuecat] expired → free: user=${event.app_user_id}`);
}

async function handleRefund(event: RcEvent): Promise<void> {
  if (!event.app_user_id) return;

  // Note: founding_tier_claims.claimed is NOT decremented on refund. The slot
  // is "consumed" once claimed — matches the public promise and prevents
  // refund-and-resell abuse. Operationally, if you need to reopen a slot
  // (e.g., legitimate fraud reversal), do it with a one-off SQL update and
  // document the reason.
  const { data, error } = await admin
    .from("user_profiles")
    .update({
      tier: "free",
      tier_started_at: null,
      tier_expires_at: null,
      purchase_provider: null,
      purchase_id: null,
    })
    .eq("clerk_user_id", event.app_user_id)
    .select("clerk_user_id");

  if (error) throw new Error(`refund downgrade failed: ${error.message}`);
  if (!data || data.length === 0) {
    // Best-effort downgrade (see handleExpiration) — no row to downgrade, so
    // don't force an endless retry.
    console.warn(`[revenuecat] refund matched 0 rows for user=${event.app_user_id} — nothing to downgrade`);
    return;
  }
  console.log(`[revenuecat] refunded → free: user=${event.app_user_id}`);
}
