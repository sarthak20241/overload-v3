# Lifetime deal + launch sites for Overload Connect (started 2026-11-13, updated 2026-11-14 IST)

**Status:** AppSumo refused us (see "Outcome" below). The AppSumo sections
("How AppSumo works", "What we build") are SUPERSEDED: do not build the AppSumo
webhook or OAuth page from them. The redeem flow waits for StackSocial's terms.
What still holds: what we sell, no Pro lifetime, the listing text, and the
launch site shortlist at the end.

Rules for ANY redeem flow (StackSocial codes or another deal site), kept from
the AppSumo plan:
- A code sets `connect_plan = 'lifetime'`, `connect_expires_at = null`. Never
  touch `tier` (every `tier <> 'free'` check reads as Pro).
- A refund clears Connect lifetime only if that code gave it (compare-and-set,
  like the RevenueCat webhook).
- Already Pro: keep Pro, still record Connect lifetime. Already on a store
  Connect subscription: lifetime wins; tell them to cancel the store plan.
- One code, one account. Admin can search by code.
- iPhone: redeem only on the website, never inside the iOS app (App Store
  3.1.3(b) multiplatform; Connect lifetime is also an in-app purchase).

## What we sell

- AppSumo Tier 1 = Overload Connect, lifetime. Same thing as the store's
  `overload_connect_lifetime` ($49.99): the full tracker plus the ChatGPT/Claude
  connector. No Drona, no in-app AI.
- Pro is NOT sold on AppSumo (open question for the owner, see below). The
  listing tells buyers about Pro as an in-app upgrade: $9.99 a month or $49.99 a
  year, 7-day free trial. Reason: Pro costs us model money every month
  (diligent user about $7.50/month), so a one-time Pro price loses money. Rule
  from the Connect plan: "a feature that costs us model money goes in Pro only".
- Suggested AppSumo price: $39 (owner decides). Below the store's $49.99 because
  the store takes 15-30% and AppSumo buyers expect a deal.

## How AppSumo works (SUPERSEDED: AppSumo refused us; kept for reference)

1. Owner applies: https://partners.appsumo.com/self-submission . About 10% are
   accepted. Risk: AppSumo lists "consumer-only products" as not a fit. Pitch
   Overload as a tool for people who already use ChatGPT/Claude every day.
2. If accepted, Launch Operations gives a Partner Portal. There we save two URLs.
   AppSumo tests both before it saves them:
   - Webhook URL (POST, JSON). Events: purchase, activate, upgrade, downgrade,
     deactivate (= refund), migrate (add-ons only). Answer 200 with
     `{"event": "<event>", "success": true}`. A `test: true` call must also get 200.
     Signature: `X-Appsumo-Signature` (HMAC-SHA256) + `X-Appsumo-Timestamp`.
     Exact HMAC input: check the code tab on the security page before building.
   - OAuth redirect URL (GET, gets `?code=`). Exchange the code at
     `POST https://appsumo.com/openid/token/`, then read the key with
     `GET https://appsumo.com/openid/license_key/?access_token=...`.
3. Buyer flow: buys on AppSumo -> clicks Activate -> lands on our redirect page
   -> signs in or signs up (AppSumo never sends the email) -> we link the key to
   the account and set Connect lifetime.
4. Refund (deactivate webhook, 60-day window): we must remove Connect. We must
   never activate, deactivate or refund a key ourselves.
5. Money: we keep 70% of sales AppSumo brings, 95% of sales we bring. Paid 60
   days after each sales month.

## What we build (SUPERSEDED: was the AppSumo plan; the deal site picks the redeem flow)

1. Migration `appsumo_licenses`: license_key (pk), prev_license_key, tier,
   status, clerk_user_id (null until linked), events log, timestamps.
   service_role only. A PGlite check.
2. Edge function `appsumo-webhook` (`verify_jwt = false` block in
   supabase/config.toml): verify the signature, store every event, answer
   `success: true`. On deactivate: clear Connect lifetime only if this key gave
   it (compare-and-set, like the RevenueCat webhook). Never touch `tier`.
3. Website page `tryoverload.app/appsumo` (the OAuth redirect): exchange the
   code on the server, Clerk sign-in/sign-up (prod Clerk works only on
   *.tryoverload.app), then link the key: `connect_plan = 'lifetime'`,
   `connect_expires_at = null`. Then "Get the app" buttons.
4. Edge cases: account already Pro (keep Pro, still record Connect lifetime);
   account already has a store Connect subscription (lifetime wins, tell them to
   cancel the store plan); one key, one account.
5. iPhone: redeem only on the website, never inside the iOS app. Allowed by App
   Store 3.1.3(b) (multiplatform) because Connect lifetime is also an in-app
   purchase. The app just reads `connect_plan` after sign-in.
6. Admin: a search by license key (AppSumo support asks by key).

## Listing text (draft, coach voice, no em dashes)

**Overload: log food and workouts by talking to ChatGPT or Claude.**

You already ask your AI about food and training. Now it can log for you.
Connect Overload to ChatGPT or Claude once. Then say "I had 2 eggs and toast"
or "bench 3x8 at 60 kg". It lands in your Overload diary with real calories,
macros, sets and volume.

What you get, for life:
- Food and workout tracker on iPhone and Android
- Log, edit and delete food and workouts from ChatGPT and Claude
- Ask your AI about your week: protein, volume, PRs, weight trend
- Your AI can read your plan and save routines and programs
- Charts and history

Want a coach built in? Upgrade to Overload Pro any time.
Pro adds Drona, the coach inside the app: say a meal and it is logged, a plan
that adapts to you each week, and weekly insights. Pro is $9.99 a month or
$49.99 a year, with a 7-day free trial. Your Connect lifetime stays yours if you
cancel Pro.

## Open decisions for the owner

1. Pro on AppSumo? Recommended: no (Connect only, Pro as the in-app upgrade).
2. AppSumo price for Tier 1 (suggested $39).

## Outcome (form sent 2026-11-13, StackSocial replied 2026-11-14)

- AppSumo: REFUSED by the automatic check at partners.appsumo.com/self-submission
  ("Tryoverload isn't a fit for AppSumo right now"). AppSumo wants B2B software;
  Overload is consumer. No person reviewed it.
- StackSocial (StackCommerce): seller form SENT at
  stackcommerce.com/become-a-merchant-partner. Digital Products, Shops,
  product "Overload Connect (lifetime)", the owner's work email, no phone, no
  newsletter, sent 2026-11-13. A day later (2026-11-14) StackSocial emailed
  partnership questions: direct sale (not affiliate), a lifetime promo,
  redemption by unique codes or URLs, ideal customer, past promos, 90-day goal.
- Pro is NOT sold as a lifetime deal anywhere (owner agreed): it costs model money
  every month. Pro shows only as the in-app upgrade.
- The redeem build (webhook/codes, redeem page on the website) waits for the
  deal site's terms; StackSocial usually sends redemption codes, not OAuth.

## Launch sites shortlist (researched 2026-11-13)

Batch 1, free, fits Overload (consumer fitness + ChatGPT/Claude connector):
1. Uneed (uneed.best): daily board, free queue (can be months), paid skip. Draft
   started 2026-11-13 from tryoverload.app; needs an account to save.
2. Peerlist Launchpad (peerlist.io/launchpad): weekly, free, opens Monday
   12:00 am UTC. Needs a Peerlist profile.
3. Product Hunt: biggest. Needs sign-in, a planned day (Tue-Thu, 12:01 am PT),
   gallery images, maker comment. Launch "Overload Connect: log food and
   workouts from ChatGPT and Claude".
4. Official MCP Registry (registry.modelcontextprotocol.io): server.json via
   mcp-publisher; domain auth by a file at tryoverload.app/.well-known/.
   Glama and others copy from it. PulseMCP paused submissions (Oct 2026).
5. mcp.so and MCP Market: manual forms.
6. Show HN: owner posts from their own HN account; we draft the text.
Lifetime deal: DealMirror (broad catalog) if StackSocial says no.
Skip: PitchGround, Dealify (B2B), DevHunt (dev tools only).
