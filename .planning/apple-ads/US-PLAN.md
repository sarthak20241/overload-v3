# Apple Ads, US, first test (written 2026-11-27)

Goal: learn which search words bring people who start the trial, for a
small fixed spend. Not growth yet.

## Facts read today

- App: Overload: AI Coach & Tracker, id 6773063775, 1.0.5 live (2026-11-25).
- US ratings: 0. Ads convert worse with no stars. Expect a low tap-to-install rate.
- Hard paywall: every new account must start the 7-day trial or pay.
- Prices: Pro $9.99/mo, $49.99/yr. Connect $2.99/mo, $14.99/yr, $49.99 lifetime.
- 8 custom product pages, all APPROVED, all visible (ppid in brackets):
  - Workout tracker (80af6a5b-118d-4bab-bfef-568dcd5eafb0)
  - Calorie counter (54c51234-2fb1-482b-ab42-1c7bf5152ee6)
  - Log food in seconds (b6108e07-f064-497d-aba1-b8e101fd14a4)
  - Accurate food log (a813b07c-6fbf-4f93-b023-7e45e1e9b830)
  - A plan that adapts (4648e428-446f-42af-be6f-bf67884f8430)
  - Lose the fat (ca0232b9-45a3-4183-86cb-31dd422c0566)
  - One app (82601fe7-97b3-40a5-8128-71eed8b012c1)
  - Use your own AI (bfbaced2-1404-4067-8a7d-d4ca20c68c83)
- Tracking gap: the app does not send the Apple Ads token to RevenueCat
  (no `enableAdServicesAttributionTokenCollection` call in `lib/revenuecat.ts`).
  Apple Ads still counts installs. Without the token we cannot see which
  keyword brought a trial or a payment.

## Keyword data (Sonar, US iOS, popularity 5-100, difficulty 0-100)

| Keyword | Popularity | Difficulty |
|---|---|---|
| workout tracker | 53 | 74 |
| ai calorie tracker | 46 | 69 |
| ai workout | 26 | 44 |
| ai personal trainer | 21 | 37 |
| progressive overload | 8 (below Apple's floor) | 18 |

Sonar free tier gives 5 scores a day. The Apple Ads keyword tool shows
popularity for every word, so we read the rest there while we build.

## Campaigns (all US, iPhone, Search results)

Match rule: Exact match in Brand, Category and Competitor. Broad match only
in Discovery. Each exact keyword is also a negative in Discovery, so the
campaigns do not bid against each other.

| Campaign | Ad groups -> custom page | Keywords (exact) | Start max CPT | Daily budget |
|---|---|---|---|---|
| 1 Brand | Brand -> default page | overload, overload app, overload ai, overload ai coach, overload tracker, drona | $1.00 | $2 |
| 2 Category | Workout -> Workout tracker | workout tracker, gym tracker, workout log, workout planner, lifting tracker, progressive overload, gym workout plan | $2.50 | $5 |
| | AI coach -> A plan that adapts | ai workout, ai personal trainer, ai fitness coach, ai fitness app, ai gym coach, personal trainer app | $2.00 | (shared) |
| | Food -> Log food in seconds | ai calorie tracker, calorie counter, macro tracker, protein tracker, food tracker | $2.50 | (shared) |
| | Own AI -> Use your own AI | chatgpt calorie tracker, chatgpt workout, claude fitness | $1.00 | (shared) |
| 3 Competitor | Rivals -> One app | hevy, strong workout tracker, fitbod, cal ai, myfitnesspal, macrofactor | $1.50 | $4 |
| 4 Discovery | Broad -> default page | broad: ai workout, workout tracker, calorie counter; Search Match ON | $1.00 | $4 |

Category gets one campaign budget of $10/day shared by its 4 ad groups.
Total: $20/day, about $280 for 14 days.

## Money check

- Apple keeps 15% (small business). A yearly Pro buyer pays us about $42.
- Rough path: tap -> install 35%, install -> trial 15%, trial -> paid 35%.
  At $2 a tap that is about $110 per paying user. That is more than one
  year of Pro. So this test is to find the few keywords that do better,
  not to make money in week 1.
- Rule after 7 days: pause any keyword with 20+ taps and 0 installs. Lower
  the bid on any keyword over $8 per install. Raise the bid 20% on any
  keyword with a trial start below $15.

## Built 2026-11-27 (all PAUSED, spend ₹0)

The Apple Ads account bills in INR.
Converted at about ₹88 per $1. Total about ₹1,755/day.

| Campaign | Budget/day | Ad groups (max CPT) -> page | Keywords |
|---|---|---|---|
| US 1 Brand Exact | ₹175 | Brand (₹88) -> default | overload, overload app, overload ai, overload ai coach, overload tracker, drona |
| US 2 Category Exact | ₹880 | Workout (₹220) -> Workout tracker | workout tracker, gym tracker, workout log, workout planner, lifting tracker, progressive overload, gym workout plan, weight lifting app, strength training app |
| | | AI coach (₹175) -> A plan that adapts | ai workout, ai personal trainer, ai fitness coach, ai fitness app, ai gym coach, personal trainer app, ai workout planner, ai coach |
| | | Food (₹220) -> Log food in seconds | ai calorie tracker, calorie counter, macro tracker, protein tracker, food tracker, calorie tracker, ai calorie counter, food log |
| | | Own AI (₹88) -> Use your own AI | chatgpt calorie tracker, chatgpt workout, chatgpt fitness, claude fitness, chatgpt food tracker |
| US 3 Competitor Exact | ₹350 | Rivals (₹130) -> One app | hevy, strong workout tracker, fitbod, cal ai, myfitnesspal, macrofactor |
| US 4 Discovery Broad | ₹350 | Broad (₹88), Search Match ON -> default | broad: ai workout, workout tracker, calorie counter; all 42 exact words above are campaign negatives |

Exact campaigns have Search Match OFF. Audience: all eligible users.

AppTweak (Ads -> Campaign Manager) already reads these
campaigns. Its Apple Ads tools are free under $25,000 a month of spend. Auto
rules may need the "Account Read & Write" link (Add integrations -> Apple Ads
Integration; the owner signs in to Apple).

## Order of work

1. DONE in PR #416: the Apple Ads token in `lib/revenuecat.ts`
   (`enableAppleAdsToken`, iOS only, runs once after a fresh `configure`).
   JS only, so an OTA update ships it. Still to check on a device build
   that the token reaches RevenueCat.
2. TODO (owner): RevenueCat dashboard: Integrations -> Apple Search Ads -> on.
3. DONE 2026-11-27: the 4 campaigns are built in Apple Ads, all PAUSED.
4. TODO (owner): read the paused campaigns and turn them on.
