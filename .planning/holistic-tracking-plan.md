# Holistic Tracking Plan (Integration-First)

Status: PLAN. Owner: solo. Last revised: 2026-06-24.
Supersedes the manual-logging framing of peripheral health tracking. Workout and diet stay first-party and heavy; everything else (steps, sleep, blood pressure, HRV, resting HR, bodyweight, active energy) is READ from platform health aggregators and wearables. Manual entry survives only as a fallback and for the one signal no sensor produces: the subjective recovery/mood check-in.

> Revision note (2026-06-24): this plan was first drafted against a stale DB snapshot. Verified against the live project `rjmmslierxhvwdjgjilb` and corrected. Confirmed live: the diet workstream has already SHIPPED to prod (`foods`, `food_servings`, `meals`, `meal_entries`, `user_nutrition_stats` exist; nutrition migrations applied 2026-06-24 but their files are NOT on disk). Confirmed live: `get_user_coach_context()` is still workout-only (no nutrition references, def length ~3664), so the shared coach RPC has NOT been modified by the diet workstream. Confirmed live: `daily_metrics` / `metric_events` do not exist yet. Migration numbering reconciled below.

> Decisions locked (2026-06-24): (1) Build BOTH platforms together, not iOS-first. (2) Bodyweight canonical source = the new `daily_metrics` time series; `user_profiles.weight_kg` becomes a denormalized latest-value cache; `bodyStats.ts` weight/bodyfat logs are imported once then retired (measurements stay). (3) Nutrition stays entirely with the diet workstream: do NOT add a nutrition block to the coach RPC and do NOT wire diet into readiness here; leave a clean extension point for the diet agent. (4) Build on a new branch `feat/holistic-tracking` off `main` (see Section 7).

---

## 1. Strategy and thesis

Integration-first is the wedge. Reading Apple HealthKit (iOS) and Health Connect (Android) transitively inherits data that Whoop, Oura, Garmin, Fitbit, Apple Watch, and Omron already write into those platform stores, so a solo dev gets broad device coverage from TWO native integrations instead of N vendor OAuth pipelines that are variously gated (Garmin closed), sunsetting (Fitbit legacy API ~Sept 2026), or slow to approve (Whoop monthly review).

The payoff Drona narrates is the readiness score: a single composite that fuses the integrated recovery signals (HRV, resting HR, sleep) with workout load (read from base `workouts`/`workout_sets`). Diet is deliberately OUT of readiness v1 (locked — see §4 Mechanics); the composite leaves a neutral-default extension point so the diet workstream can wire it in later without reworking the formula. The user never sees a wall of biometrics on the dashboard. They see one directive from Drona ("Your recovery is thin today. Cut the top set, keep the volume."). Raw numbers and trends live on Analytics. The integration layer is plumbing; the readiness narrative is the product.

What we explicitly do NOT chase: proprietary scores (Whoop Recovery/Strain, Oura Readiness, Garmin Body Battery) are deliberately withheld from the platform stores by their vendors. We compute our OWN readiness from the raw biometrics that DO flow through. That keeps us off the gated direct APIs and makes the score ours, in Drona's voice, not a re-skin of someone else's number.

---

## 2. Integration architecture and tiering

### Tier 1 (build now, free, load-bearing): platform aggregators
- **iOS**: `@kingstinct/react-native-healthkit` v14 (Nitro Modules, New Arch, compatible with SDK 54 / RN 0.81 / React 19; already on a dev client). Read-only authorization for the mapped types. Anchored queries for incremental deltas + deletions; statistics queries for cross-source dedup of cumulative metrics.
- **Android**: `react-native-health-connect` (matinzd) v3.5.x + the separate `expo-health-connect` config plugin + `expo-build-properties` (minSdk 26, target/compile 35). Time-range reads with a persisted cursor + overlap window (the RN lib does not expose change tokens yet, issue #184), plus a periodic full reconcile to GC deletions, plus the `READ_HEALTH_DATA_HISTORY` permission (see 3d).

Both are native modules: NOT available in Expo Go. We already ship `expo-dev-client`, so the incremental cost is config-plugin wiring + a fresh dev/EAS build, not a stack change.

This is the XL piece and it is NOT deferred. It is the strategy. The load-bearing, calendar-time-consuming work is:
1. **Prebuild / dev-client / EAS build** changes for both platforms (entitlements, usage strings, manifest activities).
2. **iOS**: HealthKit capability + `NSHealthShareUsageDescription` (and `NSHealthUpdateUsageDescription` only if we ever write back). Background-delivery entitlement is a later refinement, not P1. Request read authorization ONLY for the types a shipped feature surfaces. Do NOT request `bloodPressureSystolic`/`bloodPressureDiastolic` read auth until the BP feature actually ships; Apple review rejects apps that request HealthKit types they do not visibly use.
3. **Android**: per-type `android.permission.health.READ_*` in the manifest, `READ_HEALTH_DATA_HISTORY` for baselines/backfill beyond 30 days, the mandatory `ViewPermissionUsageActivity` rationale alias (Android 14+) / `ACTION_SHOW_PERMISSIONS_RATIONALE` activity (13-) pointing at our privacy policy, and `getSdkStatus()` install/update handling for pre-Android-14 devices.
4. **Store declarations**: Google Play Health apps declaration form with per-data-type justifications (budget ~1-2 weeks for the access review BEFORE any Android release). Apple review scrutinizes HealthKit usage (data must be health/fitness, never ads).
5. **Privacy policy** that matches the in-app rationale screen, the Play Console declaration, AND the App Store Connect privacy-policy URL metadata field (HealthKit apps must have a published policy linked in App Store Connect, not just in-app). One policy, four places, must agree.

### Tier 2 (optional, only on explicit demand): direct or unified aggregator
Add ONE unified aggregator (Vital/Junction at ~$0.50/user with a ~$300/mo floor, or Sahha cheapest at ~$99-189/mo) ONLY if paying users demand proprietary scores the platforms cannot carry, or when we need WEB (HealthKit/Health Connect are device-only, so web has no peripheral data without an aggregator). Skip direct Whoop/Oura/Garmin/Fitbit wiring entirely as a solo dev: Garmin is closed, Fitbit is sunsetting, Whoop review is slow, and each is a forever-maintained OAuth+webhook pipeline.

### Source apps (what "connect Google Fit / Samsung Health" means)
Users think in app names, not platform stores. We present a "connect your data" list of named sources (Apple Health, Apple Watch, Google Fit, Samsung Health, Fitbit, Garmin, Oura, Whoop, smart scales), but every one of them feeds data THROUGH the two hubs, not via a direct integration. Specifically:
- **Google Fit**: its own API is CLOSED to new apps (since 2024-05-01) and shuts down end of 2026, so a direct Google Fit integration is a dead end you cannot even sign up for. Google's own replacement is Health Connect, and Google Fit syncs into it. We read Google Fit data via Health Connect.
- **Samsung Health (and Galaxy Watch)**: syncs bidirectionally with Health Connect (steps, exercise, heart rate, sleep) since 2022. The user enables it in Samsung Health > Settings > Health Connect. Read via Health Connect.
- **Fitbit**: writes to Health Connect. Read via Health Connect.
- **iOS sources** (Apple Health, Apple Watch, and anything writing to Apple Health) come via HealthKit.

The connect screen NAMES these apps (so the promise "works with Google Fit / Samsung Health" is real and recognizable) and, for Android sources, points the user to enable Health Connect sharing inside that app's own settings. The catalog is `lib/healthSources.ts`. We still do NOT build direct vendor OAuth (see Tier 2); naming an app as a source is a UI affordance over the hub, not a new pipeline.

### Build / skip recommendation
- Build both native adapters together behind one `HealthAdapter` interface (iOS HealthKit + Android Health Connect) for the Tier-1 reliable metrics (steps, sleep+stages, active energy, bodyweight, resting HR) + foreground pull + readiness. Both ship in this PR (matches the locked cross-platform decision in §1 and the Phase 1 rollout).
- Defer: iOS background delivery, Android WorkManager background, blood-pressure event table (only if a BP-cuff user appears), any Tier-2 aggregator.
- Skip indefinitely: direct vendor APIs.

---

## 3. Data model for READ / mirror data

Two new tables, additive and nullable, RLS keyed on `auth.jwt()->>'sub'`, applied via Supabase MCP `apply_migration` (never `db push`).

**Migration numbering (reconciled against live).** The live DB tracks migrations by timestamp version; the `00XX_` filenames on disk are a local-ordering convention only. Disk currently tops out at `0052_resistance_duration_metric`. The diet workstream applied its nutrition migrations to the live DB (timestamps 2026-06-24) WITHOUT committing the files to disk, so disk and live have drifted (disk is missing the nutrition files; live has them). Therefore:
- Use `0053_daily_metrics.sql` for this table (next free disk number after 0052), and a unique migration NAME the live DB does not already record.
- Before applying, re-run `list_migrations` against the live DB and confirm the name is not taken and nothing newer landed.
- Separately, the nutrition disk/live drift is a hygiene problem worth fixing (dump the live nutrition migration bodies back to disk files) but that is the diet workstream's debt, not a blocker for this plan.

### 3a. `daily_metrics` (scalar, one row per user/day/metric)
```
user_id        text   default (auth.jwt()->>'sub')
metric_date    date           -- user's LOCAL calendar day
metric_type    text           -- 'steps' | 'sleep_minutes' | 'bodyweight_kg'
                              --  | 'resting_hr_bpm' | 'hrv_sdnn_ms'
                              --  | 'active_energy_kcal' | 'readiness_score'
value          numeric
unit           text
source         text           -- 'healthkit' | 'health_connect' | 'manual'
updated_at     timestamptz default now()
PRIMARY KEY (user_id, metric_date, metric_type)
```
Upsert: `on conflict (user_id, metric_date, metric_type) do update set value = excluded.value, source = excluded.source, updated_at = now()`. The (day, type) tuple IS the idempotency key; re-syncing a day overwrites with the latest deduplicated aggregate. Last-write-wins is correct for daily aggregates. No client_id needed. (Exception: `readiness_score` is NOT blindly overwritten on re-sync for past days; see Section 5.)

### 3b. `metric_events` (event-shaped, many per day)
```
id           uuid default gen_random_uuid()
user_id      text default (auth.jwt()->>'sub')
event_type   text          -- 'blood_pressure' | 'heart_rate_sample' | ...
measured_at  timestamptz   -- the reading's own instant
local_date   date          -- the reading's LOCAL calendar day, computed at mirror time
source_uuid  text          -- HealthKit sample UUID / Health Connect record id
source       text
systolic     numeric       -- blood_pressure (nullable)
diastolic    numeric       -- blood_pressure (nullable)
bpm          numeric       -- heart_rate_sample (nullable)
value        numeric       -- generic fallback
unit         text
created_at   timestamptz default now()
UNIQUE (user_id, source_uuid)
```
Idempotency key = native sample UUID, which is stable across reads, so dupes are impossible. `on conflict (user_id, source_uuid) do nothing` (or `do update` if the native API reports edits). Daily rollups for BP/HR are DERIVED via a plain Postgres VIEW (prod lacks the schema.sql matviews, per project memory). The view buckets by `local_date` so it aligns with `daily_metrics.metric_date` (do NOT bucket by `measured_at::date` in UTC; an 11pm-local reading would land on the wrong day and misalign against the other daily metrics). We compute `local_date` at mirror time from the device timezone, which sidesteps storing per-user tz in SQL:
```
create view daily_bp as
  select user_id, local_date as day,
         round(avg(systolic)) avg_sys, round(avg(diastolic)) avg_dia,
         (array_agg(systolic  order by measured_at desc))[1] last_sys,
         (array_agg(diastolic order by measured_at desc))[1] last_dia,
         count(*) readings
  from metric_events where event_type = 'blood_pressure' group by user_id, local_date;
```

### 3c. Dedup (the steps-from-two-devices hazard)
Type-driven, not one rule:
- **Cumulative types** (steps, active energy): NEVER sum raw samples; iPhone + Watch + ring double-count. iOS uses `HKStatisticsCollectionQuery` (1-day buckets, cumulativeSum, cross-source merge matching the Health app); Android uses `aggregateGroupByPeriod`. Result lands in `daily_metrics`.
- **Discrete / event types** (BP, raw HR): store per native UUID in `metric_events`; the UNIQUE constraint makes dupes structurally impossible.

### 3d. Incremental sync and idempotency
- **iOS cursor**: persist the `HKQueryAnchor` (base64) per type for anchored reads (reports deletions); persist statistics-query date windows for daily aggregates.
- **Android cursor**: persist a `lastSync` timestamp per type (no change tokens in the lib); re-read with a 1-2 day overlap window to catch backdated writes; run a weekly full 30-day reconcile (read-and-replace) to GC orphans, since time-range reads do not surface deletions. Health Connect serves only the last 30 days by default; the rolling readiness baseline wants 14-28 days, which sits right at that edge, and any longer backfill (new-user history, coach trend asks) silently returns nothing without `READ_HEALTH_DATA_HISTORY`. Add that permission AND verify the matinzd lib actually supports history reads in v3.5.x (historically gapped, issue #192) before relying on it.
- Cursors live in AsyncStorage with the same per-user keying convention as `lib/syncQueue.ts` (signed-in keys are per-user; this read state should be too).

### 3e. Where the sync runs, and how it relates to the push queue
The READ/mirror flow is a SEPARATE module from the push queue, not a clone of it. It is a PULL: on app-open / AppState `active`, run the per-platform adapter, dedupe, upsert into `daily_metrics` / `metric_events`. State background-delivery (iOS observer + `enableBackgroundDelivery`, hourly; Android WorkManager) as a LATER refinement; foreground-on-open is the dependable source of truth on both platforms.

The existing per-domain queue pattern (clone of `routineQueue.ts`, upsert `onConflict:'id'`) is reused ONLY where the app still WRITES:
- the manual-fallback entries (bodyweight typed by hand, etc.), and
- the subjective recovery/mood check-in (phone-only, no sensor).

Reads do not go through the push queue at all. Two distinct lifecycles: `healthSync` (pull/mirror, cursor-based) and the existing write queues (push, queue-based). The `isDataError` gotcha (`lib/syncQueue.ts:177-182`) applies ONLY to the write queues, and its semantics are: a 5-char SQLSTATE-coded error is treated as a data error so the entry stays PARKED and the loop continues; a non-coded error is treated as transport, so the loop BREAKS and retries the batch. The cloned write queues for manual fallback + check-in must stamp a 5-char `code` on genuine data rejections or they will wrongly halt the flush. The read/mirror path does not touch this code at all; do not let the pattern leak into `healthSync` error handling.

Note on bodyweight reconciliation: `bodyStats.ts` currently stores weight/bodyfat in LOCAL global AsyncStorage keys only, and `origin/fix/profile-keyboard-and-weight-autolog` already touches weight autolog. The integrated `bodyweight_kg` path must reconcile with that branch and with `user_profiles.weight_kg` (read by the paused set-types bodyweight-volume math), not duplicate it. Decide single source of truth for bodyweight before wiring (see Open Decisions).

---

## 4. Domain-by-domain

For each: source (platform type + which wearables populate it), model, UI surface, effort. UI rule: nothing new on the dashboard except the readiness narrative; everything else is an Analytics `TrendCard` (chart + history + add) reusing `MiniAreaChart`/`MiniDonutChart`, one color per metric in `Colors.stat`, no inline hex, no em dashes, Drona voice.

| Domain | Source (type / populated by) | Model | UI surface | Effort |
|---|---|---|---|---|
| **Steps** | `stepCount` / Apple Watch, iPhone, Oura, Garmin, Fitbit-bridge (NOT Whoop). HC `StepsRecord` / near-universal | daily scalar, statistics-deduped | Analytics TrendCard | M |
| **Sleep** | `sleepAnalysis` (stages since iOS 16) / Apple Watch, Garmin, Oura give true stages; Whoop only asleep/awake. HC `SleepSessionRecord` | daily scalar = total minutes; stages optional later in events | Analytics TrendCard (minutes; stage breakdown later) | M |
| **Resting HR** | `restingHeartRate` / Apple Watch, Whoop, Garmin, Oura, Fitbit-bridge. HC `RestingHeartRateRecord` (moderate) | daily scalar | Analytics TrendCard + readiness input | S |
| **HRV** | `heartRateVariabilitySDNN` (ms) / RELIABLE only Apple Watch + Garmin. NOT Whoop (exports RMSSD, different metric), NOT Oura. HC `HeartRateVariabilityRmssdRecord` (mainly Oura) | daily scalar | Analytics TrendCard + readiness input; degrade gracefully when absent | S |
| **Active energy** | `activeEnergyBurned` (kcal) / Apple Watch, Oura, Garmin, Whoop(workouts), Fitbit-bridge. HC `ActiveCaloriesBurnedRecord` | daily scalar, statistics-deduped | Analytics TrendCard | S |
| **Bodyweight** | `bodyMass` (kg) / smart scales, Oura, Omron, Garmin-if-logged. HC `WeightRecord` | daily scalar (latest-per-day); reconcile with bodyStats + user_profiles | Analytics TrendCard (existing weight surface) | M (reconcile) |
| **Blood pressure** | `bloodPressureSystolic`+`Diastolic` correlation / Omron + cuffs ONLY. HC `BloodPressureRecord` (cuffs only) | EVENT -> `metric_events`; daily avg/last via view | Analytics TrendCard fed by view; DEFERRED until a cuff user exists | M, deferred |
| **Recovery/mood check-in** | NONE (subjective, phone-only) | manual write via cloned queue; feeds readiness fallback tier | Lightweight prompt (Drona-framed); stored, contributes to readiness | M |

Per-metric reality to set in-product (Drona voice, honest): HRV and full sleep stages are complete only for Apple Watch and Garmin users; Whoop and Oura users will be missing SDNN HRV; blood pressure needs a cuff; Fitbit/Samsung are best-effort. This unevenness is not cosmetic; it directly shapes which readiness tier a user lands in (Section 5).

The recovery/mood check-in copy, for example: "Quick gut check before we plan today. How recovered do you feel, 1 to 5?" Never "Log subjective recovery metric."

### Permission UX (the read-denial quirk)
For READ permission, HealthKit deliberately does NOT reveal denial (authorizationStatus is reliable only for WRITE); a denied read is indistinguishable from "no data." So we cannot build a trustworthy "permission denied" screen from read auth. Treat empty as possibly-denied-or-no-device: show a "no data yet" state + a generic deep link to Settings > Privacy & Security > Health > Overload, and use `HKSource`/`sourceRevision` on any returned samples to label provenance ("from your Apple Watch", "from Garmin"). Android Health Connect is friendlier (per-type grant sheet is inspectable) but still gate on `getSdkStatus()` and deep-link to install/update HC on pre-14 devices.

---

## 5. Readiness score

A single 0-100 composite Drona narrates. Three effective tiers, because device coverage of HRV is uneven (Section 4). Degrade gracefully:

- **Tier A1 (full objective)**: HRV (SDNN) deviation from personal baseline + resting HR deviation from baseline + last night's sleep vs baseline. Available only to Apple Watch / Garmin users (the only reliable SDNN sources). The strongest signal.
- **Tier A2 (HRV-absent objective)**: resting HR deviation + sleep vs baseline, with HRV dropped and the remaining inputs reweighted. This is what Whoop and Oura users get (RHR + sleep flow through, SDNN HRV does not). It must be defined explicitly, not treated as a degraded A1, or readiness silently means different things for different users and Drona's directive rests on sand.
- **Tier B (subjective fallback, phone-only)**: the recovery/mood check-in (1-5) when no wearable data is present. The only tier a phone-only user gets, and it is honest about being thinner.

The composite must declare its tier internally so Drona can hedge appropriately ("Based on your sleep and resting heart rate..." for A2 vs "Your HRV and recovery markers..." for A1).

Mechanics:
- **Rolling personal baseline** per signal (trailing 14-28 day mean/SD; window is an Open Decision). Compare today against the user's own history, not population norms.
- **Workout-load input** read from BASE `workouts` / `workout_sets` tables (NOT the volume matviews, absent in prod). Recent acute load tempers readiness (heavy yesterday -> lower headroom today).
- **Diet input is OUT of scope here (locked).** Even though `user_nutrition_stats` is live, wiring diet into readiness is owned by the diet workstream, not this one. Readiness v1 composes recovery + sleep + RHR/HRV + workout load only. Leave a clean, documented extension point (a nullable diet term in the composite that defaults to neutral when absent) so the diet agent can add it without reworking the formula.
- **Snapshot vs recompute (resolved).** Readiness is NOT a pure function over time: its inputs drift (the rolling baseline window slides, and past workouts are editable via the in-flight edit-past-workouts path + `editQueue.ts`). So recomputing a past day later yields a different number. Decision: TODAY's readiness is recomputed freely as the day's data arrives, then FROZEN once the day rolls over. We do NOT recompute or overwrite historical `readiness_score` rows. Rationale: a frozen daily score is what the user actually saw and what Drona actually advised on that day; silently rewriting history would be dishonest and would fight edit-past-workouts. Concretely, the `daily_metrics` upsert for `readiness_score` must guard against overwriting a past `metric_date` (only the current local day is writable).

Dashboard surface: the readiness score is the ONE new dashboard element, and even then the number is secondary; Drona leads with the directive derived from it. Raw readiness trend lives on Analytics as a TrendCard.

---

## 6. Coach hook

Single context chokepoint is `get_user_coach_context()` (feeds chat/generate/refine/discuss). Verified 2026-06-24: the live definition is still workout-only (no nutrition block), so it has NOT been clobbered by the diet workstream, but that also means whoever extends it next is the first to touch it since diet shipped. Read the live definition (`pg_get_functiondef`) and extend ADDITIVELY; never blind-replace.

All three prompt-cache breakpoints are full, so the integrated domains ride as COMPACT rolling aggregates inside the existing `<user_context>` blob, not as new cache segments. Add a small recovery block: latest readiness (with its tier), 7-day readiness trend, last-night sleep, current HRV/RHR vs baseline, recent active-energy. Keep it terse; aggregates, not raw series. Also confirm the TypeScript `<user_context>` type in `lib/userContext.ts` still matches the live RPC shape before editing, since the two can drift independently.

Live-session coaching uses the separate `WorkoutCoachContext` / `workoutCoach.ts` channel. It gets ONLY sleep / recovery / readiness (the signals that change in-session advice), not the full integrated set.

Diet coordination (locked): we add ONLY the recovery block to `get_user_coach_context()`. Nutrition stays with the diet workstream; do not fold a nutrition block in here. But the `create or replace` clobber risk is real (both edits replace the whole function), so: capture the CURRENT live function body verbatim before editing, add the recovery block additively on top of it, and structure the SQL so a nutrition block can later be appended without a rewrite. Flag to whoever owns nutrition that the function was last edited here and hand them the current body so their edit is also additive, not a blind replace that drops the recovery block.

---

## 7. Phased rollout

Ordered by value, respecting in-flight work. The native integration layer is early because it is the strategy. Both platforms ship together (locked decision), so the iOS and Android adapters are built behind one interface in the same phase.

### Branch strategy (locked)
Build on a NEW branch `feat/holistic-tracking` cut from `feat/exercise-set-types` (not `main`). Rationale:
- The data layer is designed to MIRROR and REUSE the set-types patterns (the `METRIC_TYPES` descriptor table in `lib/exercises.ts`, `formatDuration`/`parseDuration` in `lib/format.ts`). Those exist on `feat/exercise-set-types`, NOT on `main` (set-types is 16 commits ahead of main, unmerged). Branching off main would mean reimplementing or duplicating them.
- The live DB already has the set-types migrations (0043/0044/0045) applied, so the set-types branch's disk schema matches prod; main does not.
- Holistic's later write-queue work (the check-in / manual-fallback queues) edits the same `lib/syncQueue.ts` / `lib/guestStore.ts` that set-types edits. Branching on top of set-types means those edits compose instead of conflicting at a future merge.
- Cost: holistic merges to main AFTER set-types, which is the natural order anyway. When set-types lands on main, rebase `feat/holistic-tracking` onto the updated main.
- Note: Phase 1 (the read foundation) is almost entirely NEW files and touches the shared set-types files barely, so it can proceed immediately even while set-types is still in progress.

### Phase 0 — Gates (mostly cleared)
- **Design polish**: DONE (was the prior active priority). No longer a gate.
- **Set-types**: still in progress but no longer a blocking gate because we branch on top of it. Keep Phase 1 additive; do the write-queue-touching parts (Phase 3) after set-types stabilizes.
- **Migration reconciliation**: run `list_migrations` against the live DB before applying; take `0053_daily_metrics` with a unique name. Disk and live have drifted on the nutrition files (diet workstream debt, not a blocker).

### Phase 1 — Native read foundation, BOTH platforms (XL, the wedge)
`0053_daily_metrics` migration; `lib/dailyMetrics.ts` descriptor/types layer; `healthSync` pull module with BOTH the iOS HealthKit adapter (anchored + statistics queries) and the Android Health Connect adapter (time-range cursor + overlap + weekly reconcile + `READ_HEALTH_DATA_HISTORY`) behind one interface; config plugins + entitlements + usage strings + manifest activities + `expo-build-properties`; prebuild + fresh dev/EAS build; foreground-on-open sync; dedup; cursor persistence. Metrics: steps, sleep minutes, resting HR, HRV, active energy. Request read auth only for these (NOT blood pressure). Privacy policy v1 linked in App Store Connect + Play Console; start the ~1-2 week Google Play Health declaration review early.

### Phase 2 — Readiness + Analytics surfaces (M)
Readiness compute (Tier A1/A2 objective with explicit HRV-absent path; diet term left neutral) reading base workout tables; write `readiness_score` to `daily_metrics` (current-day only, frozen on rollover); Analytics TrendCards for each Tier-1 metric; the ONE dashboard readiness directive in Drona voice.

### Phase 3 — Subjective check-in + bodyweight reconcile (M)
Recovery/mood check-in (cloned write queue, 5-char error codes) feeding readiness Tier B; bodyweight canonical path: `daily_metrics` is the time series, `user_profiles.weight_kg` becomes a derived latest-value cache (updated to the most-recent `metric_date` value on each bodyweight write, a pure function so it is safe to re-run), one-time importer from `bodyStats.ts` (`overload_weight_log` / `overload_bodyfat_log`) with a per-user guard, then retire those as weight sources. Reconcile with the `profile-keyboard-and-weight-autolog` branch (do not create a second writer to `weight_kg`).

### Phase 4 — Coach integration (M)
Extend `get_user_coach_context()` with the recovery block ONLY (additive over the captured live body; nutrition stays with diet, see Section 6); add sleep/recovery/readiness to `workoutCoach.ts` live channel.

### Phase 5 — Refinements (deferred, as-needed)
iOS background delivery (observer + entitlement + fast completion handler); Android WorkManager background; blood-pressure `metric_events` path + `daily_bp` view + BP HealthKit read auth (only when a cuff user appears); sleep-stage breakdown; Tier-2 aggregator (only on paid demand / web need).

XP note: integrated daily metrics do NOT grant XP (XP is workout-derived via the server `award_xp` RPC). Use streaks for daily-metric engagement instead.

---

## 8. Open decisions for the human

1. RESOLVED: both platforms together. iOS HealthKit + Android Health Connect ship in the same Phase 1 behind one interface. Start the Google Play Health declaration review early since it is the long pole.
2. **Tier-2 aggregator: yes/no and which?** Default is skip until paid demand or a web need. If yes, Vital/Junction (~$0.50/user, ~$300/mo floor) vs Sahha (cheapest, behavioral scores). Decide the trigger condition (e.g. "first paying user asks for Whoop Recovery", or "web launch").
3. **Blood-pressure event table now or later?** Default defers `metric_events` + `daily_bp` view + BP read auth to Phase 6 (cuff users are rare, and requesting unused HealthKit types risks App Review rejection). Build now only if a current user has an Omron/Withings cuff.
4. **Readiness baseline window, thresholds, and HRV-absent reweighting.** Trailing 14 vs 21 vs 28 days; how many SD below baseline trips "low"; how to weight HRV vs RHR vs sleep vs acute load vs diet in Tier A1; how to reweight when HRV is absent (Tier A2); minimum days of history before readiness is shown at all. These set how the score feels and how honest it is across device types.
5. **Manual-fallback scope.** Beyond the recovery/mood check-in (locked as manual), do we allow manual entry of bodyweight only, or also sleep/RHR for users with no wearable? More manual fields = more write-queue surface and a blurrier integration-first story. Recommend bodyweight + check-in only.
6. RESOLVED: bodyweight canonical = `daily_metrics` time series. `user_profiles.weight_kg` becomes a derived latest-value cache (set on each bodyweight write to the most-recent `metric_date` value, so set-types math reads it unchanged). One-time import from `bodyStats.ts` with a per-user guard, then retire those keys as weight sources (measurements stay in `bodyStats.ts`). Reconcile with the profile-keyboard-and-weight-autolog branch so there is exactly one writer to `weight_kg`.
7. RESOLVED: do NOT touch nutrition. The coach RPC gets the recovery block only; nutrition (in both the coach context and readiness) is owned by the diet workstream. Capture the live function body and extend additively so the diet agent's later edit composes.
8. **Background delivery priority.** Default treats it as post-v1 polish (Phase 5 refinement). If users expect fresh readiness without opening the app, promote iOS background delivery earlier (entitlement + observer at launch + the must-call completion handler discipline).
