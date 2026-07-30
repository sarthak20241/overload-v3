# Paywall & Pricing Plan

## SHIP STATE (2026-07-28 evening, branch claude/paywall-design-pricing-379c47)

**Live in prod as of this pass** (via Supabase MCP + supabase CLI + browser MCP driving ASC/RC):
- Migration 0088 applied (Supabase MCP).
- ai-coach edge function v69 deployed (supabase CLI).
- App Store Connect subscriptions on "Overload: AI Coach & Tracker" (app id 6773063775, sub group "Overload Premium"):
  - Overload Annual (`overload_annual`): base $29.99 US, India override ₹999, other regions auto-mapped (Canada CAD $39.99, EU €34.99, Australia AUD $49.99, etc.).
  - Overload Annual intro offer: 7-day Free trial, all 175 regions, Jul 28 2026 → no end date.
  - Overload Monthly (`overload_monthly`): base $7.99 US, India override ₹299, other regions auto-mapped (EU €8.99, Australia AUD $12.99). No intro offer.
  - Founding Lifetime NOT created in ASC yet — see gap below.
- RevenueCat project "Overload: Workout Tracker" (rc project id 7ed661f5) is wired correctly:
  - Default offering has `$rc_annual`→`overload_annual`, `$rc_monthly`→`overload_monthly`.
  - Founding offering has `$rc_annual`→`overload_annual`, `$rc_lifetime`→`overload_founding_lifetime`.
  - Product statuses show "Could not check" — expected while ASC products are in Prepare-for-Submission, RC can't verify against Apple yet.
- Play Store product `overload_monthly:monthly` present but "Not found" (Play billing still blocked on BillDesk, matches project memory).

**Founding Lifetime status (updated 2026-07-30):** REPRICED via Global Price Change to $99 US, effective immediately. All 175 storefronts auto-scaled from the US base — India landed at ₹9,900 (nearest Apple tier to the planned ₹10,000; Apple's pricing grid doesn't offer ₹10,000 as an exact tier). Confirmed live in ASC's Current Price modal: US $99 / IN ₹9,900 / AU $149 / EUR €99. Product is complete (name + availability + price) and can be added for review with the app on the next TestFlight submission.

Historical (pre-reprice) steps — kept for reference only, no longer actionable:
  1. Open `https://appstoreconnect.apple.com/apps/6773063775/distribution/iaps/6773349598`
  2. Expand "In-App Purchase Pricing" → click "Current Price" link → click "Edit Price" (bottom-left of modal)
  3. Choose "Recalculate prices for all countries or regions", Country = US, Price = $99.00, Next
  4. Region filter → "Africa, Middle East, and India" → scroll to India (INR) → set to ₹10,000.00 (or nearest tier)
  5. Next → Confirm.

Once done, TestFlight-ready. Product is complete (name + availability + price) and can be added for review with the app.

## BUILD STATE (2026-07-28, branch claude/paywall-design-pricing-379c47)

Implemented, typechecked, NOT committed / NOT applied live:
- Migration `supabase/migrations/0088_free_tier_access.sql`: `free` state with
  chat + parse counters replaces eligible_for_trial/trial_ended; trialing
  grandfathered. NOT applied to live yet (apply via Supabase MCP, never db push).
- `supabase/functions/ai-coach/index.ts`: free tier passes the gate metered
  (3 chat/24h, 3 parse/24h → 402 `free_cap_hit`), generate/refine/discuss modes
  402 `pro_required` for free, terminal tools stripped from free chat + system
  note. ALSO fixes a pre-existing TDZ bug: `mode` was read (retrieval skip)
  before its declaration; the resolution block is now hoisted above retrieval.
  Needs redeploy.
- `app/upgrade.tsx`: warm-up → reminder → paywall funnel + reusable paywall
  (contexts: cap_chat, cap_parse, milestone). Android gets "Pro is coming".
- `app/(app)/_layout.tsx`: after drainPendingOnboarding, signed-in iOS converts
  route to /upgrade?flow=onboarding (guests + Android skip).
- `app/onboarding.tsx`: reveal headline always dated ("Visibly stronger by X"
  fallback); PLAN_TITLES removed.
- `hooks/useCoachAccess.ts` + `components/ai/CoachAccessGate.tsx`: `free`
  state passes through; parse fields added.
- `components/ai/AICoachModal.tsx`: 402 → onCapHit; Drona-voice cap line in
  the bubble + upgrade banner with 3-pip meter above the input; free users'
  menu shows a messages-left banner; plan/workout menu items open the paywall.
- `components/insights/MilestoneUpsellCard.tsx` (+ dashboard wiring): rides a
  `victory` insight, free users only, 1/week max, Not-now snoozes 14 days.
- `lib/notifications.ts` + package.json (`expo-notifications ~0.32.0`): lazy
  wrapper; day-5 local reminder scheduled on verified annual purchase;
  permission requested on the reminder screen. RUN `npx expo install
  expo-notifications` before the next native build (worktree node_modules is
  symlinked from the main checkout — install from the main checkout).

## PAYWALL v5.2 (2026-07-29 pivot: readiness out, Weekly Reports + Coach Nudges in as "Soon")

Sarthak pivoted the Pro tier mid-turn: readiness dropped entirely (was
never gated client-side, so advertising it was false-advertising bait);
Weekly Reports and Proactive Coach Nudges added to the CORE comparison
table with "SOON" chips per the RC "Coming soon" pattern. Two build tasks
spawned (task_1dfd7f89 weekly reports, task_d6e8cb33 coach nudges) as
deadline commitments — the chip becomes stale if either feature doesn't
ship within a few weeks. Readiness gating task (task_bd77464b) dismissed.

CORE now 4 rows (real Pro deltas only, no roadmap noise): Coach chat,
Fast/accurate AI food logs, Personalized plans + workouts, Weekly plan
rewrites. MORE (behind "See the full comparison") holds Refine any plan
in chat, Weekly progress reports (SOON), Proactive coach nudges (SOON),
and the two both-included trust rows (Workout+diet tracking, Unlimited
routines+history). Sarthak moved the SOON rows to MORE mid-turn: default
view should show what's real today, expanded view carries the roadmap.
CompareCell type extended to include `'soon'`; renders as an outlined
chip (accent border, small caps text) so the eye reads "yes, and it's
in flight" without competing visually with real checks.

## PAYWALL v5 (2026-07-28 late, superseded by v5.2)

Sarthak flagged v4 as overloaded (three overlapping explainers) but also that
buyers couldn't see what Pro includes. v5 resolves both with ONE explainer:
a Free → Pro comparison table (Vivid pattern) replacing BOTH the timeline
strip and the value lines:
  Coach chat            3/day    Unlimited
  AI food logging       3/day    Unlimited
  Weekly plan rewrites    -        check
  Readiness + deep trends -        check
Sub is one sentence (mechanism only). Annual note trimmed to "$2.50/mo,
billed yearly" (protein-shake anchor cut). Screen rhythm: promise → delta
table → choose → go.

v5.1 amendments (Sarthak feedback): sub upgraded to the ecosystem line
("Drona watches your training, food and recovery, and steers you to your
goal week by week."); row labels "Personalized plans + workouts" and "Fast,
accurate AI food logs"; table is core-5 + expandable ("See the full
comparison" ↔ "Show less") adding Refine-in-chat and two both-included
trust rows (tracking, routines+history). "Weekly reports" deliberately NOT
listed: feature doesn't exist yet; add the row when it ships. Readiness
gating enforcement spun off as a separate task (paywall claims it as Pro
but nothing locks it client-side yet). Trial mechanics now carried by badge + trust chips +
CTA copy; the day-5 reminder promise lives on the funnel's reminder screen
and the scheduled local notification (re-add a one-line timeline if cap-hit
entries ever need it). Verified on sim.

## PAYWALL v4 (2026-07-28 evening, sim-iterated with Sarthak; superseded by
## v5 above; supersedes the step-4 layout described below)

Single-viewport compact paywall (scroll only as SE safety net), audited against
RevenueCat's "7 unexpected uses" + "5 conversion boosters":
- Outcome headline "Never write a training plan again." (educate/frame value);
  sub = mechanism + Opal-style results-inside-trial line ("The first rewrite
  lands inside your free week.")
- Horizontal 3-dot trial timeline (Today "Coach is yours" / Day 5 "I remind
  you first" / Day 7 "{price}/yr, your call")
- 3 outcome value lines; NO em dashes in any shipped copy
- Plan rows (radio, compact): Annual highlighted + "7 DAYS FREE" badge +
  "SAVE {pct}%" tag + "less than a protein shake a week" anchor; Monthly decoy
  "no trial"; Founding Lifetime collapsed behind "See Founding Lifetime" link
  (also hides the ASC-gap product; NOTE store shows $199, not the planned $79.99)
- Trust chips above CTA TRACK THE SELECTED PLAN (annual "No payment today",
  monthly "First charge today", lifetime "One payment, no renewals") - fixed a
  misleading-trial bug caught in sim review
- Gentle CTA pulse (1.5%, 2.2s, paused while purchasing, gated on
  useReducedMotion) + staggered plan-row entrances (RC: animation lifts 12-18%)
- Delayed soft-wall skip "Not now, I'll train on the free plan"
Deferred deliberately: social proof (no real reviews yet), post-skip survey,
14-day-trial A/B (needs only ASC change), hard-wall A/B (RC data: hard walls
convert ~5x but we grow organic).
Verified on iPhone 17 sim via overload://upgrade deep link; plan selection,
founding expand, restore path, and pulse all exercised.

## STORE CONFIG CHECKLIST (dashboards, Sarthak does these)

App Store Connect (Overload iOS app):
1. Annual subscription product: add an Introductory Offer → Free Trial →
   7 days. (This is what makes "Start my 7 days free" true.)
2. Monthly product: raise price to ₹299 (India) / $7.99 (US) via subscription
   pricing. Existing subscribers keep their price; that's fine.
3. Annual: confirm ₹999 / $29.99 across storefronts (volume-first tiers).
4. Founding Lifetime (non-consumable/one-time): ₹2,999 / $79.99.
5. Ensure all three are attached to the app's current subscription group /
   available in the build's product list.

RevenueCat dashboard:
6. Offering "default": packages $rc_annual, $rc_monthly, and the custom
   `founding_lifetime` package present (lib/revenuecat.ts maps either naming).
7. Nothing else changes: the webhook + entitlement flow is already live.

After both: a TestFlight build with expo-notifications + these changes; the
paywall reads prices/trial straight from the store so no app change needed
when prices move.



Decided 2026-07-28 with Sarthak. Model: **usage-capped freemium + card-upfront store trial**.
No standalone no-card trial anymore; the free tier's AI allowance replaces it.

## The model in one line

Tracker free forever. AI is metered on free, unlimited on Pro. The only trial is a
7-day App Store intro offer (card upfront, auto-converts) attached to the annual SKU.

## Free vs Pro

| Capability | Free | Pro |
|---|---|---|
| Workout logging, history, supersets, set types | Unlimited | Unlimited |
| Routines | Unlimited (no cap at launch; revisit if conversion weak) | Unlimited |
| Basic analytics (PRs, volume charts) | Yes | Yes |
| Manual diet logging + macro targets | Yes | Yes |
| Drona chat | 3 messages/day | Existing paid daily limit |
| AI food logging (Drona Parse) | 3 parses/day | Unlimited (fair-use daily limit) |
| Plan generation | 1 plan (the onboarding one) | Regenerate + weekly adaptive adjustments |
| Adaptive Today suggestion | Basic pick | Full adaptive engine |
| Advanced analytics (muscle balance, long-range trends) | Locked | Yes |
| Readiness score + insights | Locked | Yes |

Rationale for the line: anything with per-use LLM cost or "coach intelligence" is Pro;
anything that is local logging stays free (organic/word-of-mouth growth, and free users'
data makes Drona better when they do convert).

Routine caps explicitly rejected at launch: wedge is the coach, not the tracker; caps
punish the power users who evangelize. Back-pocket lever only.

## When the paywall shows

1. **End of onboarding (primary).** After the anonymous Drona plan generates, show the
   plan partially revealed (day names + focus visible, details teased), then the paywall.
   **Soft wall**: small, slightly delayed "Continue with free plan" link at the bottom.
2. **Contextual gates** (existing CoachAccessGate surfaces): hitting the free daily AI
   cap, tapping locked analytics/readiness, asking for plan regeneration.
3. **Milestone moments**: quiet Drona-voice card after a PR or completed week
   ("You've logged 12 sessions. Let me take over the programming."). Never on app open.

## The onboarding funnel (v3, modeled on the Cal AI recording, 2026-07-28)

Analyzed Sarthak's screen recording of Cal AI's post-quiz funnel. Our sequence mirrors
its beats: reveal → sign-up → warm-up → reminder promise → paywall. "No payment today"
(their "No Payment Due Now") repeats on the last three screens.

**Step 1, the reveal** (ZERO sell signals; revised 2026-07-28 per Sarthak: "unlock" felt
like a sell, and Cal AI's reveal is fully open):
1. DATED QUANTIFIED headline: "Visibly stronger by October 20." (goal date = 12 weeks
   out, projected from intake goal/experience/frequency; Cal AI: "Lose 11 lbs by Aug 19").
2. Projected-strength curve card, upward, lime endpoint, "+32% est." tag.
3. Full week 1 shown UNBLURRED, "Adjustable anytime" label. No lock chip, no blur.
   Consistent with the free tier (the onboarding plan was always free); Pro later sells
   the plan's future (weekly reprogramming, coaching), not this screen.
4. CTA is a plain "Continue". No trial mention, no price, no skip link. First
   monetization touch is the warm-up, two screens later. Endowment does the work.

**Generation ritual**: our commit step already runs real ~13 s Drona generation; dress it
Cal-AI-style with percent counter, per-muscle status lines, ticking checklist.

**Sign-up happens here** (existing guest funnel): required before paywall so purchases
attribute to the Clerk id (RC webhook matches clerk_user_id).

**Step 2, the warm-up**: "Try everything free for 7 days." + Drona quote ("I don't do
generic plans. Give me a week of your training and judge me on the results.") +
"No payment today" check + CTA "Try it free". Gift frame, no price anywhere.

**Step 3, the reminder promise**: "I'll remind you before you pay." Bell + badge, day-5
notification promised, "No payment today", CTA "Continue for free". Tapping continue
triggers the OS notification-permission prompt (needed for rest cues anyway).

**Step 4, the paywall** (the single reusable paywall screen):
1. Price-transparent headline: "7 days free. Then ₹83 a month." (Cal AI hides the total;
   we deliberately don't — user said yes twice already, number confirms not ambushes).
2. Benefit checklist, 4 rows, coach voice.
3. Trial timeline; day 5 row reads "I remind you. The notification I just promised."
4. Annual highlighted + preselected + "Save 72%" badge; Monthly ₹299 as DECOY (no trial;
   raised from ₹199 to widen the save gap; Cal AI uses ₹990/mo vs ₹250/mo = 75%);
   Founding Lifetime scarcity row with live counter.
5. Third "No payment today" + CTA "Start my 7 days free" + dim delayed skip link
   "I'll train on the free plan for now" (THE soft-wall escape lives here now) + legal.

Deliberately NOT copied from Cal AI: hard wall ("to continue", no skip) — we grow
organic; 3-day trial — weekly reprogramming needs 7 days to demo; mixed-currency fine
print (their bug: "$29.99 per year" under a ₹3,000 card).

Day-5 reminder notification is promised on two screens: it ships WITH the funnel.

Cap-hit sheet and milestone card CTAs open Step 4 directly with a contextual headline
("Your next four weeks, programmed." etc.). Pricing never appears squeezed into a sheet.

## Pricing (volume-first)

| SKU | US | India |
|---|---|---|
| Monthly (decoy, no trial) | $7.99 | ₹299 |
| Annual (highlighted, 7-day intro trial, "Save 72%") | $29.99 (~$2.50/mo framing) | ₹999 |
| Founding Lifetime (capped) | $79.99 | ₹2,999 |

Monthly raised from $5.99/₹199 on 2026-07-28 to widen the annual save gap (decoy
pricing per the Cal AI analysis). Still sane as a standalone price.

Set via App Store Connect regional pricing; RC picks up priceString automatically.

## Platform reality

- **iOS**: full flow as above.
- **Android**: Play billing blocked on BillDesk merchant verification. Keep the free
  tier + show "Pro is coming to Android" instead of a dead paywall. No card path at all
  on Android until Play IAP unblocks. Do NOT link out to web checkout (Play policy).

## Implementation deltas vs current code

- `get_coach_access_status` (0031) needs a new state model: `free` (with per-feature
  daily counters/limits) replaces `eligible_for_trial` / `trial_ended` on iOS. Edge
  functions (ai-coach, food parse, plan gen) enforce the free caps server-side.
- Retire `start_coach_trial` for new users; existing trialing users grandfather until
  expiry then land on `free`, not `trial_ended`.
- Configure the 7-day intro offer on the annual product in App Store Connect + RC.
- New onboarding paywall screen at the end of the guest funnel (after plan generation,
  before/around sign-up), reusing Paywall.tsx internals but with the outcome-first
  layout above.
- CoachAccessGate: `free` state passes through to content (metered) instead of blocking;
  cap-hit responses (402 with reason) open the paywall.
- Milestone paywall card on dashboard (PR / completed week trigger).
