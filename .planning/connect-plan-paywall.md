# Connect plan, no-card trial, new paywall (decided 2026-11-12, nothing built yet)

## 1. Plans and prices (US base)

| Plan | Monthly | Yearly | Lifetime |
|---|---|---|---|
| Connect (tracker + the user's own AI through the MCP connector) | $2.99 | $14.99 | $49.99 |
| Pro (all of Connect + Drona) | $9.99 | $49.99 | none |

- Pro was $7.99 / $29.99. Owner wants Pro to be the cheapest AI fitness coach app.
- No Pro lifetime. The old $99 Founding Lifetime leaves sale (existing owners keep it).
- Rule: a feature that costs us model money goes in Pro only.

## 2. Access model (owner, 2026-11-12: the STORE free trial)

- Considered and REJECTED: a no-card 7-day server trial that locks the app on day 8. Reason: Apple's no-card trial path ($0 "XX-day Trial" non-consumable, guideline 3.1.1) is for apps that do NOT sell subscriptions, and a developer reported a rejection for a self-run no-card trial. Owner chose the safe path.
- New accounts (from HARD_PAYWALL_FROM, 2026-11-09) meet the hard paywall at sign-up, as today. The paywall shows all prices.
- Pro keeps the store's 7-day free trial (intro offer on `overload_monthly` and `overload_annual`). The user confirms with Face ID or Google; the plan starts on day 8 unless they cancel in the store.
- Drona side button: "Try Drona free for 7 days", line "Then $49.99 a year. Cancel any time." The trial claim is read from the store (`freeTrialDays`), never hard-coded, so a user who already had a trial sees "Continue".
- Connect ALSO has the store's 7-day free trial on monthly and yearly (owner, 2026-11-12). Not on lifetime. Connect button: "Try free for 7 days" (or "Continue" when the store says no trial).
- Trial reminder: the existing local reminder (`trial_reminder_scheduled`) 2 days before the trial ends.
- This is the model live today, so no trial code changes. No `coach_trials` welcome trial, no `trial_claims` table.
- Older accounts (before 2026-11-09) keep the metered free plan.

## 3. Paywall screen

### Shared content (both variants)

- Title: "A coach for your food and workouts".
- Switch: "Drona coach" | "Your own AI". Drona and Yearly are selected first.
- Line under the switch: "The coach inside the app" / "Log and analyze in ChatGPT, Claude, and more".
- Example chat card (strong glass, the hero):
  - Drona: goal bar "72 kg by Mar 3" + one Drona message. PLACEHOLDER words. Replace with what Drona really sends.
  - Your own AI: "In your ChatGPT": log a meal, then ask about protein this week.
- Features. Drona side, all on: Say a meal, it is logged / Ask your coach / A plan that adapts to you / Weekly insights / Food and workout tracker / Log in ChatGPT, Claude, more. Your own AI side, on first: Food and workout tracker / Log in ChatGPT, Claude, more / Charts and history. Locked: Coach in the app / A plan that adapts to you / Weekly insights.
- Price boxes show only the selected side; outline only; the selected one has a lime outline. Lifetime shows only on "Your own AI".
- One lime button: "Try Drona free for 7 days" (or "Continue" when the store says no trial) / "Continue" / "Buy once". One line under it: "Then $49.99 a year. Cancel any time." / "$14.99 a year. Cancel any time." / "$49.99 one time. Yours forever."
- Restore and "Have a code?" under the button.

### Variant A (default, owner's first pick): tiles

- 6 feature tiles, 3 columns, all the same size. Icon on top, words under it.
- Quiet glass on tiles: white fill about 5.5%, 1px hairline, faint top highlight.
- Locked tiles: same size, dashed outline, lock icon, dim words.

### Variant B: icon list

- One list of 6 lines, same order on both sides, thin divider lines.
- Each line: the feature's own icon in a small quiet-glass circle, then the words.
- Not included: a lock in a dashed circle, dim words.

### Look rules

- Dark theme, flat black background. NO glow or gradient behind cards.
- Strong glass ONLY on the example chat card: diagonal white sheen inside the card (about 15% to 4%), brighter top and left edges, a soft dark shadow.
- Quiet glass on the switch, the feature tiles or icon circles, the price boxes.
- Icons white. Lime (`#bfe84a`, a new softer token beside the app lime `#c8ff00`) only on: goal bar, selected price outline, button.
- Font: plain sans at medium weight; in the app Inter 500.
- No live blur (nothing behind the cards to blur). Plain views. `expo-linear-gradient` for the chat card sheen if installed, else a flat brighter fill.
- Read colours from `useTheme()`; must also read in the light theme.
- Text contrast: no body text dimmer than `textMuted` on black.
- Rejected by owner: glow behind cards, strong glass on every card, a plain list with no boxes and no icons.

## 4. What the code looks like today (read 2026-11-12)

- `app/upgrade.tsx` (1487 lines): the paywall. Plans from `lib/revenuecat.ts` (`PlanKey = monthly | annual | founding_lifetime`, `PACKAGE_ID_MAP`, `freeTrialDays`).
- `lib/hardPaywall.ts`: `mustPay()` locks accounts made on or after 2026-11-09 in state `free`. Called in `app/(app)/_layout.tsx:478`.
- `hooks/useCoachAccess.ts` reads `get_coach_access_status` (latest version in `20261105130000_free_food_limit_9.sql`). States: `paid`, `trialing`, `free`.
- `coach_trials`: server trial rows. Invite codes (`20261031150000`), referrals (`20261109120000`), server coupons (`20261110150000`) all write it. Account delete removes the row (`20261102120000`).
- Server rule everywhere: `user_profiles.tier <> 'free'` means Pro (0088, cooldown and limit migrations, `mcp/access.ts` `hasPro`, `revenuecat-webhook/transferDecision.ts`).
- `revenuecat-webhook/index.ts` maps product ids to a tier with `RC_PRODUCT_MONTHLY`, `RC_PRODUCT_ANNUAL`, `RC_PRODUCT_FOUNDING_LIFETIME`.
- No PostHog feature flags are used in the app yet.

## 5. Design rule: Connect is NOT a tier value

Do not add `connect_*` to `user_profiles.tier`: every `tier <> 'free'` check would give a $2.99 buyer Drona.

New columns on `user_profiles`: `connect_plan` (`monthly | annual | lifetime`), `connect_started_at`, `connect_expires_at` (null for lifetime). `tier` stays Pro only. Connector access = Pro OR trial OR active Connect.

## 6. Store products (owner does these, or I drive the browser with the owner watching)

Do this FIRST: new products need store review, about 1 to 2 days.

### App Store Connect (app 6773063775)

1. Subscription group "Overload Premium" (existing). Add 2 auto-renewing subscriptions:
   - `overload_connect_monthly`: 1 month, $2.99.
   - `overload_connect_annual`: 1 year, $14.99.
   - For each: reference name, display name ("Overload Connect"), description ("Track food and workouts. Use your own AI."), review screenshot (the paywall on the "Your own AI" side), review note (how to reach it).
2. Subscription levels in the group: Pro yearly and Pro monthly on level 1 (top), Connect yearly and Connect monthly on level 2. Moving Connect to Pro is then an upgrade that applies at once.
3. Add a non-consumable in-app purchase `overload_connect_lifetime`, $49.99, same display texts, review screenshot.
4. Reprice `overload_annual` to $49.99 and `overload_monthly` to $9.99. Choose "Keep current price for existing subscribers".
5. Intro offers on `overload_annual` and `overload_monthly`: KEEP the 7-day free trial. Check it still applies after the price change. Add the same 7-day free intro offer to `overload_connect_monthly` and `overload_connect_annual` (all regions). Apple gives one intro offer per subscription GROUP, so a user who had a Pro trial gets no Connect trial and the other way round: the button then says "Continue".
6. `overload_founding_lifetime`: remove from sale. Owners keep it; Restore still works.
7. India: set prices by hand, or accept auto-mapping (open decision).
8. Submit the new products with the app update that shows them (Apple reviews first IAPs with a build).

#### DONE 2026-11-12 (Apple, by Claude in Chrome)

- `overload_connect_annual` (Apple ID 6833917369): 1 year, $14.99 US, 175 regions auto-priced, display "Overload Connect Yearly", 1-week free intro offer from 2026-11-12, no end date. Level 3.
- `overload_connect_monthly` (Apple ID 6833918533): 1 month, $2.99 US, 175 regions, display "Overload Connect Monthly", 1-week free intro offer. Level 4.
- `overload_connect_lifetime` (Apple ID 6833922562): non-consumable, $49.99 US, 175 regions, display "Overload Connect Lifetime".
- All three: "Prepare for Submission". Still missing: the review screenshot (needs the new paywall screen) and submission with the 1.0.5 build.
- NOT done yet (owner must confirm, they change live prices for new buyers at once): Pro repricing to $9.99 / $49.99, and removing Founding Lifetime from sale.
- Note: the group's customer-facing display name is "Overload Pro"; Connect buyers will see that name in their subscription settings. Consider renaming to "Overload".

### Google Play Console

DONE 2026-11-12 (developer account "build-better", Chrome Google account slot /u/2):
- `overload_connect_annual` subscription, base plan `annual` ($14.99 US, 178 regions incl. India auto-converted), offer `annual-free-trial` (1 week, new customers who never had ANY subscription in the app). Active.
- `overload_connect_monthly` subscription, base plan `monthly` ($2.99 US), offer `monthly-free-trial` (same rule). Active.
- `overload_connect_lifetime` one-time product, purchase option `lifetime`, $49.99 US. Active.
- Pro repriced for NEW subscribers (existing keep legacy price): `overload_annual:annual` $49.99, `overload_monthly:monthly` $9.99. India left at ₹999 / ₹299 on purpose (owner's India decision is still open).
- `overload_founding_lifetime` purchase option `founding-lifetime` DEACTIVATED (past buyers keep it).
- Note: Play Connect products are live and buyable as soon as an app shows them; today's app does not.

Supabase secrets to set (Apple id, Play id):
- `RC_PRODUCT_CONNECT_MONTHLY=overload_connect_monthly,overload_connect_monthly:monthly`
- `RC_PRODUCT_CONNECT_ANNUAL=overload_connect_annual,overload_connect_annual:annual`
- `RC_PRODUCT_CONNECT_LIFETIME=overload_connect_lifetime`

Apple, DONE 2026-11-12/13:
- `overload_annual`: price change to $49.99 scheduled from 2026-11-14 in 174 regions (India kept at its old price), existing subscribers preserved at their current price.
- `overload_monthly`: price change to $9.99 scheduled from 2026-11-14, same rules.
- The 7-day intro offers on both were not touched.
- `overload_founding_lifetime`: status "Developer Removed from Sale" (checked 2026-11-13).
- Subscription group display name: a new English (U.S.) version "Overload" added 2026-11-13 (Prepare for Submission); the approved "Overload Pro" shows until Apple reviews it with the next build. Buyers then see "Overload" with the plan name (Pro Yearly, Connect Yearly...).

1. Monetize, Subscriptions: create `overload_connect` with 2 auto-renewing base plans: `monthly` ($2.99) and `annual` ($14.99). Add a 7-day free-trial offer on each, for new customers.
2. Monetize, In-app products: create `overload_connect_lifetime`, $49.99, active.
3. `overload_monthly` / `overload_annual`: change base plan prices to $9.99 / $49.99, keep existing subscribers on the legacy price; KEEP the 7-day free-trial offers.
4. `overload_founding_lifetime`: set inactive.
5. Note: Play billing has a known payment-method blocker in India (memory: Play IAP BillDesk).

### RevenueCat (project 7ed661f5)

1. Import the 5 new store products (3 Connect + the 2 repriced Pro, which keep their ids).
2. New entitlement `connect`; attach the 3 Connect products. The Pro entitlement stays as is.
3. Default offering: add packages `connect_monthly`, `connect_annual`, `connect_lifetime`. Remove `$rc_lifetime` (Founding) from every offering the app reads.

DONE 2026-11-13: default offering has custom packages connect_annual, connect_monthly, connect_lifetime (Apple + Play products each; CUSTOM type so the live app ignores them). Verified in the dev client: $14.99 / $2.99 / $49.99, 7-day trial on monthly and yearly.
DONE 2026-11-12: the 3 Apple Connect products added to the App Store app in RevenueCat, and a new entitlement `connect` ("Overload Connect") with all 3 attached. The Pro entitlement is `drona_access`. Offering packages NOT added yet: do it with PR 2 (the new paywall), so today's paywall never shows them. Play products still to add once they exist.

### Supabase secrets

`RC_PRODUCT_CONNECT_MONTHLY`, `RC_PRODUCT_CONNECT_ANNUAL`, `RC_PRODUCT_CONNECT_LIFETIME` (comma lists: Apple id, Play id). Setting a secret bumps every function version.

## 7. Build plan

### Phase A. Database (one migration + a PGlite check)

1. `connect_plan`, `connect_started_at`, `connect_expires_at` on `user_profiles`, CHECK on `connect_plan`.
2. Replace `get_coach_access_status`: same states, plus `connect` (bool) and `connect_plan`. Old app bundles ignore new fields.
3. Active Connect user who is not Pro, on an account created on or after 2026-11-09 (`ai_blocked`): `daily_limit = 0`, `parse_daily_limit = 0` (no in-app AI). Older accounts keep the free meter.
4. SQL helper `has_connector_access(user)`: Pro, trial, or active Connect.
5. `supabase/migrations/checks/connect_plan.check.ts` on PGlite: Pro unchanged; Connect user is `free` + `connect`; expired Connect is plain `free`; lifetime never expires.

### Phase B. Webhook (`supabase/functions/revenuecat-webhook/`)

1. `productIdToPlan()`: `{ kind: 'pro', tier }` or `{ kind: 'connect', plan }`.
2. INITIAL_PURCHASE / RENEWAL / UNCANCELLATION: Pro writes `tier*`, Connect writes `connect_*`.
3. NON_RENEWING_PURCHASE: Connect lifetime writes `connect_plan = 'lifetime'`, no expiry; it does NOT use `claim_founding_tier`.
4. EXPIRATION: clear only the side of that product, and only when the row still holds that plan. CANCELLATION clears nothing: a cancelled plan stays paid until its period ends, and its EXPIRATION ends it.
5. PRODUCT_CHANGE (`effectiveProductId`): an event writes only its own product's side. No cross-clearing either way: each side ends on its own expiry date. Pro to Connect never clears Pro early (Apple keeps the paid Pro period until it ends).
6. TRANSFER: copy and release `connect_*` like `tier*`.
7. Tests that fail without the fix: a Connect buy never changes `tier`; a Pro expiry never clears Connect lifetime; the upgrade path; the transfer.

### Phase C. Server gates

1. `mcp/access.ts`: `hasConnectorAccess` (Pro, trial, active Connect). Refusal text names both plans. Update `mcp.test.ts`.
2. `ai-coach`, `form-check`: an `ai_blocked` Connect user (not Pro, account created on or after 2026-11-09) gets no AI. `drona-cards` and `daily-suggestion` are left ungated on purpose: they already run for free users, so Connect costs the same (0 chats, 0 AI food logs, no goal build); typed error the app maps to "This is part of Drona".
3. `_shared/aiLimits.ts`: a Connect block (all zero) for `ai_blocked` accounts only, tested against the SQL.

### Phase D. App

1. `lib/hardPaywall.ts`: `mustPay` adds `hasConnect`; Connect is never locked. Tests.
2. `lib/revenuecat.ts`: `PlanKey` adds `connect_monthly | connect_annual | connect_lifetime`; `PACKAGE_ID_MAP`; `founding_lifetime` stays readable, never offered.
3. `hooks/useCoachAccess.ts`: expose `connect` and `connectPlan`. Bump the `screenCache` key if the cached shape changes.
4. `app/upgrade.tsx`: rebuild as the approved screen. Parts in `components/paywall/`: `PlanSwitch.tsx`, `ExampleCard.tsx` (strong glass), `FeatureTiles.tsx` (variant A), `FeatureList.tsx` (variant B), `PriceBoxes.tsx`, `GlassSurface.tsx` (quiet and strong levels). Prices come from the store packages, never hard-coded. Keep: restore, "Have a code?", sign out and help on the locked paywall, store-down fail-open, pending-payment handling (`lib/purchaseErrors.ts`).
5. Drona entry points (`components/ai/Paywall.tsx`, `CoachAccessGate.tsx`, `MilestoneUpsellCard.tsx`, the food box AI send, the Drona orb, plan build, Drona cards, weekly insights): for a Connect user, a small lock and "Add Drona" that opens `/upgrade` on the Drona side.
6. Profile and plan screens: `lib/tiers.ts` gets `connectLabel()` and Connect benefits; "Manage in the store" only for subscriptions.
7. Connector setup screen (#382): open to trial, Connect, and Pro.

### Phase E. A/B test (paywall layout)

1. PostHog feature flag `paywall-layout`, variants `tiles` (A) and `list` (B), 50/50, sticky per user. Read it once with `posthog-react-native` feature flags; if the flag does not load in 1.5 s, show A.
2. Send `paywall_layout` on every paywall and purchase event.
3. Events (`lib/analytics.ts`): add `side` (`drona | own_ai`), `period`, `layout` to `paywall_viewed`, `purchase_started`, `purchase_completed`, `purchase_failed`; new `paywall_side_switched`, `paywall_period_selected`.
4. PostHog experiment: goal = `purchase_completed` (trial start counts) per paywall viewer; second goal = trial-to-paid on day 8 (from the webhook RENEWAL after a trial).
5. Honest note: at about 20 new users a day, a reliable winner needs many weeks. Read the result at 4 weeks, but treat a small gap as a tie and keep A.

### Phase F. Check before live

1. Sandbox on iPhone and Android: each of the 5 products, restore, Connect to Pro upgrade, Pro expiry with Connect lifetime kept.
2. A fresh sandbox Apple ID: the Drona button says "Try Drona free for 7 days"; an Apple ID that had a trial sees "Continue".
3. A Connect account: no Drona in the app, the server refuses AI, the connector works.
5. ChatGPT with our server (only Claude is proven). If it fails, the paywall names Claude only.
6. Replace the placeholder Drona message with real words.
7. Both themes, a small phone, Android.
8. Deno suites: webhook, mcp, ai-coach, `_shared`, the new PGlite check.

### Phase G. Ship order

1. Store products created and approved (section 6).
2. Migration applied, PostgREST schema reload.
3. Edge functions deployed (`deploy:yes` is the owner's call; an agent never adds it).
4. App: the paywall needs the new store products, which Apple approves only with a build. So: a new store build (1.0.5) with the paywall, submitted with the products. An OTA alone is not enough for iPhone.
5. Watch PostHog for 4 weeks.

### PR split

- PR 1: migration + webhook + server gates + tests. Safe to land and deploy first.
- PR 2: app (welcome trial, paywall A and B, access hook, locked Drona surfaces, analytics).

## 8. Open decisions (owner)

1. DECIDED 2026-11-12: Connect lifetime stays $49.99 (owner). The clash with Pro yearly does not matter: the two prices are on different sides of the switch.
2. DECIDED: Connect gets the 7-day store trial.
3. DECIDED: ship now without plan tools; plan tools come later (section 10).
4. India prices: by hand or auto-mapped. Still open.

## 10. Later: Connect plan tools (owner idea, 2026-11-12, not in this ship)

Give the connector tools so the user's own AI can build and save a plan in the exact shape the app uses (goal, phases, weekly routines, targets, activity goals), and read the same insights Drona sees (weekly facts, signals, phase metrics). The app then shows that plan like a Drona plan.

My view: good idea. The model cost stays on the user's own AI, so it is cheap for us, and it fixes the "no plan in the app" gap. Watch two things: (1) a saved plan must pass the same checks a Drona plan passes (exercise ids, targets, the phase rules in `lib/phaseBuildRules.ts`), and (2) Pro must keep a clear reason to exist: Drona adapts the plan by itself every week; with Connect the user must ask their AI.

## 9. Theme migration idea (owner, 2026-11-12)

The owner liked the first sketches of this paywall, which were plain black and white: white surfaces, black text, a black primary button, thin grey hairlines, one quiet accent for the selected state, no lime. Keep as a candidate look for a later app-wide theme migration. Not planned, not started.
