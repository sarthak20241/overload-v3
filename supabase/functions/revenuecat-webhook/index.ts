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
import { pickTransferIds } from "./transferIds.ts";
import { decideTransfer } from "./transferDecision.ts";
import { effectiveProductId } from "./eventProduct.ts";
import { ensureProfileRow } from "./profileRow.ts";
import {
  buildProductMap,
  CONNECT_CLEARED,
  connectEndClears,
  connectStart,
  connectWriteSkip,
  type ConnectPlan,
  type Plan,
  type ProTier,
  productIdToPlan,
} from "./plans.ts";

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
// comma-separated list so one plan can map to BOTH the Apple and Google
// product IDs without needing separate env vars per platform.
//
// Example: RC_PRODUCT_MONTHLY="overload.monthly,com.overload.monthly"
//   - "overload.monthly" is your Apple product id from App Store Connect
//   - "com.overload.monthly" is your Google product id from Play Console
//
// Pro: RC_PRODUCT_MONTHLY, RC_PRODUCT_ANNUAL, RC_PRODUCT_FOUNDING_LIFETIME.
// Connect: RC_PRODUCT_CONNECT_MONTHLY, RC_PRODUCT_CONNECT_ANNUAL,
// RC_PRODUCT_CONNECT_LIFETIME. The list lives in plans.ts.
const PRODUCT_MAP = buildProductMap((name) => Deno.env.get(name));

if (!REVENUECAT_WEBHOOK_SECRET) {
  throw new Error(
    "REVENUECAT_WEBHOOK_SECRET must be set in Edge Function secrets " +
    "(set it in RevenueCat dashboard → Project → Integrations → Webhooks → Authorization header)",
  );
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function productPlan(productId: string | undefined): Plan | null {
  return productIdToPlan(PRODUCT_MAP, productId);
}

/** The Pro tier of a product, or null for Connect and unknown products. */
function productIdToTier(productId: string | undefined): ProTier | null {
  const plan = productPlan(productId);
  return plan?.kind === "pro" ? plan.tier : null;
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
  // On PRODUCT_CHANGE this is the product switched TO; `product_id` is the one
  // switched FROM. See eventProduct.ts.
  new_product_id?: string;
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
  transferred_from?: string[];
  transferred_to?: string[];
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

  // On a PRODUCT_CHANGE, product_id is the plan being LEFT, so log both — a
  // trace showing only the old plan is exactly what made this event type hard
  // to read when the switch bug was being diagnosed.
  const loggedProduct = event.new_product_id && event.new_product_id !== event.product_id
    ? `${event.product_id}->${event.new_product_id}`
    : event.product_id;
  console.log(
    `[revenuecat] type=${event.type} user=${event.app_user_id} product=${loggedProduct} env=${event.environment}`,
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
        await handleTransfer(event);
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

/**
 * Drop an account back to the free tier. Called on the SOURCE of a transfer:
 * the store receipt has left that account, so its entitlement has to go with
 * it. Recoverable by the user — Restore Purchases transfers the receipt back
 * and this webhook moves the tier again.
 */
async function releaseTier(clerkUserId: string): Promise<void> {
  const { error } = await admin
    .from("user_profiles")
    .update({
      tier: "free",
      tier_started_at: null,
      tier_expires_at: null,
      purchase_provider: null,
      purchase_id: null,
    })
    .eq("clerk_user_id", clerkUserId);
  if (error) throw new Error(`release of ${clerkUserId} failed: ${error.message}`);
  console.log(`[revenuecat] released tier for ${clerkUserId} (receipt transferred away)`);
}

// deno-lint-ignore no-explicit-any
type ProfileRow = Record<string, any> | null;

/**
 * The Connect half of a TRANSFER. decideTransfer reads `tier` and
 * `tier_started_at`; Connect's columns are fed in under those names, which
 * works because connect_plan is never 'free' (null means none).
 */
async function transferConnect(
  oldClerkId: string,
  newClerkId: string,
  oldProfile: ProfileRow,
  newProfile: ProfileRow,
): Promise<void> {
  const view = (p: ProfileRow) => ({ tier: p?.connect_plan ?? null, tier_started_at: p?.connect_started_at ?? null });
  const { action, reason } = decideTransfer(view(oldProfile), view(newProfile));
  console.log(`[revenuecat] TRANSFER connect ${oldClerkId} -> ${newClerkId}: ${action} — ${reason}`);
  if (action === "none") return;
  if (action === "move") {
    await ensureProfileRow(admin, newClerkId);
    const { data, error } = await admin
      .from("user_profiles")
      .update({
        connect_plan: oldProfile!.connect_plan,
        connect_started_at: oldProfile!.connect_started_at,
        connect_expires_at: oldProfile!.connect_expires_at,
      })
      .eq("clerk_user_id", newClerkId)
      .select("clerk_user_id");
    if (error) throw new Error(`connect transfer update failed: ${error.message}`);
    if (!data || data.length === 0) throw new Error(`no user_profiles row for new_user=${newClerkId}`);
  }
  const { error } = await admin.from("user_profiles").update(CONNECT_CLEARED).eq("clerk_user_id", oldClerkId);
  if (error) throw new Error(`connect release of ${oldClerkId} failed: ${error.message}`);
}

/**
 * A TRANSFER MOVES a receipt between accounts; it does not clone it. See
 * transferDecision.ts for why the naive copy was wrong in both directions.
 */
async function handleTransfer(event: RcEvent): Promise<void> {
  const { newClerkId, oldClerkId } = pickTransferIds(event);

  if (!newClerkId) {
    console.error("[revenuecat] TRANSFER has no non-anonymous transferred_to ID");
    return;
  }
  if (!oldClerkId) {
    // Anonymous source: there is no row to read a tier from. The follow-up
    // INITIAL_PURCHASE / RENEWAL carries product_id and activates the target.
    console.log(
      `[revenuecat] TRANSFER from (anonymous) to ${newClerkId}; ` +
      `target will activate on its own purchase event`,
    );
    return;
  }

  const [{ data: oldProfile }, { data: newProfile }] = await Promise.all([
    admin
      .from("user_profiles")
      .select("tier, tier_started_at, tier_expires_at, purchase_provider, purchase_id, connect_plan, connect_started_at, connect_expires_at")
      .eq("clerk_user_id", oldClerkId)
      .maybeSingle(),
    admin
      .from("user_profiles")
      .select("tier, tier_started_at, connect_plan, connect_started_at")
      .eq("clerk_user_id", newClerkId)
      .maybeSingle(),
  ]);

  // Connect moves by the same rule as Pro (a newer plan on the target wins;
  // the source always loses it), decided on its own columns.
  await transferConnect(oldClerkId, newClerkId, oldProfile, newProfile);

  const { action, reason } = decideTransfer(oldProfile, newProfile);
  console.log(`[revenuecat] TRANSFER ${oldClerkId} -> ${newClerkId}: ${action} — ${reason}`);

  if (action === "none") return;

  if (action === "move") {
    await ensureProfileRow(admin, newClerkId);
    const { data, error } = await admin
      .from("user_profiles")
      .update({
        tier: oldProfile!.tier,
        tier_started_at: oldProfile!.tier_started_at,
        tier_expires_at: oldProfile!.tier_expires_at,
        purchase_provider: oldProfile!.purchase_provider,
        purchase_id: oldProfile!.purchase_id,
      })
      .eq("clerk_user_id", newClerkId)
      .select("clerk_user_id");

    if (error) throw new Error(`transfer update failed: ${error.message}`);
    if (!data || data.length === 0) {
      // The target has no profile row yet. Throw so RevenueCat retries rather
      // than releasing the source and losing the entitlement entirely.
      console.error(
        `[revenuecat] transfer matched 0 user_profiles rows for new_user=${newClerkId} — forcing retry`,
      );
      throw new Error(`no user_profiles row for new_user=${newClerkId}`);
    }

    // Bookkeeping only, and deliberately NOT allowed to abort the handler. If
    // it threw, RevenueCat would retry — but by then the target already holds
    // the copied tier with a timestamp equal to the source's, so decideTransfer
    // returns release_only and this RPC is never reached again. Throwing would
    // therefore lose the conversion record anyway AND risk re-running the
    // release. Log loudly instead and let the entitlement move stand.
    const { error: convErr } = await admin.rpc("mark_trial_converted", {
      p_clerk_user_id: newClerkId,
    });
    if (convErr) {
      console.error(
        `[revenuecat] mark_trial_converted failed for ${newClerkId} after transfer: ` +
        `${convErr.message} — entitlement moved, conversion bookkeeping lost`,
      );
    }
    console.log(
      `[revenuecat] transferred tier=${oldProfile!.tier} from=${oldClerkId} to=${newClerkId}`,
    );
  }

  // Both "move" and "release_only" end the same way: the receipt is no longer
  // on the source account, so neither may keep serving Pro from it.
  await releaseTier(oldClerkId);
}

/**
 * Write a Connect purchase or renewal. Touches only the connect_* columns, so
 * a Pro tier on the same row is never changed by a Connect event (plans.ts).
 */
async function writeConnect(event: RcEvent, plan: ConnectPlan): Promise<void> {
  if (!event.app_user_id) {
    console.error(`[revenuecat] missing app_user_id on ${event.type} (connect)`);
    return;
  }
  const row = connectStart(plan, event);
  await ensureProfileRow(admin, event.app_user_id);
  const { data: stored, error: readErr } = await admin
    .from("user_profiles")
    .select("connect_plan, connect_expires_at")
    .eq("clerk_user_id", event.app_user_id)
    .maybeSingle();
  if (readErr) throw new Error(`connect read failed: ${readErr.message}`);

  const skip = connectWriteSkip(stored, plan, event.type, row.connect_expires_at);
  if (skip) {
    console.warn(`[revenuecat] connect ${plan} ${event.type} not written (${skip}): user=${event.app_user_id}`);
    return;
  }

  // Write only if the row still holds what was just read. A Connect event
  // that landed in between (a lifetime, a newer renewal) makes this match 0
  // rows; the throw below makes RevenueCat retry, and the retry decides again
  // on the new values. The expiry filter is a timestamptz compare: PostgREST
  // casts the text it is given, so it matches by value, not by spelling.
  let update = admin
    .from("user_profiles")
    .update(row)
    .eq("clerk_user_id", event.app_user_id);
  update = stored?.connect_plan == null
    ? update.is("connect_plan", null)
    : update.eq("connect_plan", stored.connect_plan);
  update = stored?.connect_expires_at == null
    ? update.is("connect_expires_at", null)
    : update.eq("connect_expires_at", stored.connect_expires_at);
  const { data, error } = await update.select("clerk_user_id");
  if (error) throw new Error(`connect update failed: ${error.message}`);
  if (!data || data.length === 0) {
    // No row yet, or the row changed since the read: retry, never drop.
    console.error(
      `[revenuecat] connect ${event.type} matched 0 user_profiles rows for app_user_id=${event.app_user_id} — forcing retry`,
    );
    throw new Error(`no matching user_profiles row for app_user_id=${event.app_user_id}`);
  }
  // No mark_trial_converted here: it closes an open Drona trial, and Connect
  // does not include Drona. A trial runs on to its own end.
  console.log(
    `[revenuecat] connect set: ${plan} expires=${row.connect_expires_at} user=${event.app_user_id} (${event.type})`,
  );
}

async function handleSubscriptionStart(event: RcEvent): Promise<void> {
  // NOT event.product_id: on a PRODUCT_CHANGE that is the plan being LEFT.
  // See eventProduct.ts for why reading the wrong one costs real money.
  const productId = effectiveProductId(event);
  const plan = productPlan(productId);
  if (plan?.kind === "connect") {
    // A Pro -> Connect PRODUCT_CHANGE arrives when the user asks, but Apple
    // keeps them on Pro until the paid period ends. Pro is left alone here;
    // its own expiry date ends it (plans.ts).
    await writeConnect(event, plan.plan);
    return;
  }
  const tier = productIdToTier(productId);
  if (!tier) {
    console.error(`[revenuecat] unknown product on ${event.type}: ${productId}`);
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

  // A buyer who never saved anything has no row; see profileRow.ts.
  await ensureProfileRow(admin, event.app_user_id);
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
  const plan = productPlan(event.product_id);
  if (plan?.kind === "connect") {
    // Connect lifetime: no cap, no founding claim. Just the Connect columns.
    if (plan.plan !== "lifetime") {
      console.error(`[revenuecat] NON_RENEWING_PURCHASE for Connect subscription ${event.product_id}`);
      return;
    }
    await writeConnect(event, "lifetime");
    return;
  }
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

  // claim_founding_tier locks the buyer's row and fails without one.
  await ensureProfileRow(admin, event.app_user_id);
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
  const plan = productPlan(event.product_id);
  if (plan?.kind === "connect") {
    if (plan.plan === "lifetime") return;
    if (!event.expiration_at_ms) {
      console.warn(`[revenuecat] connect ${plan.plan} RENEWAL has no expiry, not written: user=${event.app_user_id}`);
      return;
    }
    // A renewal re-states the whole Connect row: it also activates a start
    // that was missed, and lands a deferred Pro -> Connect switch.
    await writeConnect(event, plan.plan);
    return;
  }
  const tier = productIdToTier(event.product_id);
  if (!tier || tier === "founding_lifetime") return;  // lifetime doesn't renew
  if (!event.app_user_id || !event.expiration_at_ms) return;

  // Check the user's current tier. If it's "free", the INITIAL_PURCHASE was
  // missed (e.g. sandbox gate was active when it fired). Treat this renewal as
  // a full activation so the user isn't stuck on free forever.
  await ensureProfileRow(admin, event.app_user_id);
  const { data: profile } = await admin
    .from("user_profiles")
    .select("tier")
    .eq("clerk_user_id", event.app_user_id)
    .single();

  const needsActivation = !profile?.tier || profile.tier === "free";

  const expiresAt = new Date(event.expiration_at_ms).toISOString();
  const updatePayload: Record<string, unknown> = {
    tier_expires_at: expiresAt,
  };
  if (needsActivation) {
    updatePayload.tier = tier;
    updatePayload.tier_started_at = event.purchased_at_ms
      ? new Date(event.purchased_at_ms).toISOString()
      : new Date().toISOString();
    updatePayload.purchase_provider = storeToProvider(event.store);
    updatePayload.purchase_id = event.original_transaction_id ?? event.transaction_id ?? null;
  }

  const { data, error } = await admin
    .from("user_profiles")
    .update(updatePayload)
    .eq("clerk_user_id", event.app_user_id)
    .select("clerk_user_id");

  if (error) throw new Error(`renewal update failed: ${error.message}`);
  if (!data || data.length === 0) {
    console.error(
      `[revenuecat] renewal matched 0 user_profiles rows for app_user_id=${event.app_user_id} — forcing retry`,
    );
    throw new Error(`no user_profiles row for app_user_id=${event.app_user_id}`);
  }
  if (needsActivation) {
    await admin.rpc("mark_trial_converted", { p_clerk_user_id: event.app_user_id });
    console.log(`[revenuecat] renewal activated missed grant: ${tier} expires=${expiresAt} user=${event.app_user_id}`);
  } else {
    console.log(`[revenuecat] renewed: ${tier} expires=${expiresAt} user=${event.app_user_id}`);
  }
}

/**
 * End a Connect plan (expiry or refund). Only the Connect columns change, so a
 * Pro tier on the same row is untouched. Only the plan that ended is cleared:
 * a row that holds another Connect plan, or a newer period of the same one,
 * keeps it (plans.ts connectEndClears).
 */
async function endConnect(event: RcEvent, why: "expiration" | "refund", ended: ConnectPlan): Promise<void> {
  if (!event.app_user_id) return;
  const { data: stored, error: readErr } = await admin
    .from("user_profiles")
    .select("connect_plan, connect_expires_at")
    .eq("clerk_user_id", event.app_user_id)
    .maybeSingle();
  if (readErr) throw new Error(`connect read failed: ${readErr.message}`);
  if (!connectEndClears(stored, ended, why, event.expiration_at_ms)) {
    console.log(
      `[revenuecat] connect ${ended} ${why} kept the row's Connect ` +
      `(holds ${stored?.connect_plan ?? "none"} until ${stored?.connect_expires_at ?? "-"}): user=${event.app_user_id}`,
    );
    return;
  }
  // Clear only if the row still holds what was just read; a Connect write in
  // between leaves it alone.
  let update = admin
    .from("user_profiles")
    .update(CONNECT_CLEARED)
    .eq("clerk_user_id", event.app_user_id)
    .eq("connect_plan", ended);
  update = stored?.connect_expires_at == null
    ? update.is("connect_expires_at", null)
    : update.eq("connect_expires_at", stored.connect_expires_at);
  const { error } = await update;
  if (error) throw new Error(`connect ${why} failed: ${error.message}`);
  console.log(`[revenuecat] connect ${why} → cleared: user=${event.app_user_id}`);
}

async function handleExpiration(event: RcEvent): Promise<void> {
  if (!event.app_user_id) return;

  // A Connect product's end clears Connect only. Before this branch existed,
  // ANY expiration dropped `tier` to free, which would have ended a Pro plan
  // the day a separate Connect subscription lapsed.
  const plan = productPlan(event.product_id);
  if (plan?.kind === "connect") {
    await endConnect(event, "expiration", plan.plan);
    return;
  }

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

  const plan = productPlan(event.product_id);
  if (plan?.kind === "connect") {
    await endConnect(event, "refund", plan.plan);
    return;
  }

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
