# Diet & Macro Tracking — Plan

Status: PLANNED (2026-06-23). Timing under discussion: schema/sync/catalog can likely run in
parallel with design-polish; the dashboard card + Nutrition tab touch surfaces design-polish owns,
so those gate on polish landing. Build on a fresh branch off `main`.

A full macro tracker for the Overload niche: progressive-overload lifters who need to hit **protein**
and stay in a **calorie band** for their goal (bulk / cut / maintain). Design principle, borrowed from
the set-types plan and our build-in-public wedge: **friction is the enemy of food logging, and Drona is
the narrator.** A generic food diary loses. Lead with the two levers a lifter cares about (protein,
calories vs target), make repeat-logging near-instant (recents/favorites first), and let Coach Drona
speak the numbers in his voice. The architecture is a near 1:1 clone of the existing
exercises/workouts domain, so this is mostly proven-pattern reuse, not greenfield invention.

## Locked decisions (2026-06-23)

- **Scope:** full macro tracker in v1 (searchable food catalog with per-serving macros, custom foods,
  daily calorie + macro targets, a daily nutrition rollup). Not a calories-only MVP.
- **Architecture:** mirror the catalog-vs-log split exactly. `foods` catalog = analog of `exercises`;
  `meals` + `meal_entries` = analog of `workouts` + `workout_sets`; `user_nutrition_stats` daily
  rollup = analog of `user_lift_stats`/`user_volume_stats`.
- **Persistence:** server-synced, offline-first, **like workouts** (`syncQueue`/`guestStore`), **NOT
  like `bodyStats.ts`** (AsyncStorage-only, never synced). Body-stats is the trap to avoid.
- **Nav placement (UX decision):** ship a dashboard **"Today's Fuel" card** (protein + calories-vs-target
  rings) plus a hidden Nutrition sub-screen FIRST (zero nav-slot cost, no collision with design-polish).
  Promote to a dedicated **Nutrition bottom-nav tab** AFTER design-polish lands, demoting Analytics off
  the tab bar to free a slot (Analytics is the lowest-frequency lean-back surface). Never touch the
  workout-owned center FAB; never grow the nav to 6 crowded slots.
- **Logging friction:** the food picker opens to **Recents + Favorites**, search is secondary, with a
  "same as yesterday" / repeat-meal shortcut. This is the retention lever for the meal-prep audience.
- **Catalog seed (sourcing decided, see "Data sourcing" below):** a layered catalog. Legally-clean
  bundle = USDA FoodData Central (CC0) for gym staples + raw ingredients, plus an Open Food Facts (ODbL,
  segregated) India subset for branded/barcode. **For Indian cooked dishes, compute our own macros from
  recipe definitions against the clean ingredient base, do not copy IFCT/INDB verbatim.** This is both
  the legal-safety move and the differentiator. External barcode ingest is a later phase.
- **Targets:** daily calorie/macro goals stored as nullable columns on `user_profiles` (analog of
  `goal`/`experience_level`), not a separate table, unless multi-target history is needed later.
- **Coach (Drona) awareness:** ship logging + schema first; wire structured nutrition into the coach in
  a follow-up phase (mirrors set-types "Coach awareness deferred"). Diet facts already have a home: the
  coach-enhancement plan added a `coach_memory` "diet" category + `remember_fact` tool, and
  `get_user_coach_context()` is the injection point.
- **Units / preferences:** reuse the **already-shipped** set-types Phase 0 `usePreferences` store + the
  settings-sheet pattern for unit toggles (g vs oz, kcal vs kJ) and target editing. Do not rebuild it.
- **Guest mode:** supported. Signed-out users log to a `guest_meals` store, same as guest workouts.
- **No em dashes** in any plan prose or UI copy. All user-facing strings in Coach Drona's voice.

---

## Feature spec

### A. Food catalog (property store, set once per food)

A hybrid catalog identical in shape to exercises: a bundled static `FOOD_LIBRARY` (always offline) plus
per-user custom rows in Supabase `foods`, unioned at read time and deduped by lowercased name.

| field          | notes                                                                 |
|----------------|-----------------------------------------------------------------------|
| `name`         | identity key (lowercased), like exercises                             |
| `food_category`| CHECK enum (e.g. protein, grain, dairy, veg, fruit, fat, prepared, supplement) |
| `serving_unit` | CHECK enum (g, ml, piece, cup, scoop, roti, etc.), drives the qty input |
| `serving_size` | numeric, the reference serving the macros are stated for              |
| `kcal`, `protein_g`, `carb_g`, `fat_g` | per-serving macros                            |
| `created_by`   | NULL = global seed, non-null = user custom (RLS-scoped)               |
| `brand`, `barcode`, `image_url` | enrichment, populated by a later ingest phase        |

- Canonical enums + a `foodCategoryOf`/`servingUnitOf` normalizer live in a new `lib/foods.ts`,
  mirroring `lib/exercises.ts` `MetricType`/`metricTypeOf`. The DB CHECK list stays byte-for-byte in
  sync with the TS union.
- A descriptor table `SERVING_UNITS` (one object per unit: value/label/step/keyboardType) drives both
  the unit picker UI and the entry-row input, the way `METRIC_TYPES` does for sets.

### B. Meal logging (the log)

- A **meal** is a logged eating occasion: `meal_type` (breakfast/lunch/dinner/snack), `logged_at`,
  optional note. Owned by `user_id`, carries `client_id` for offline idempotency.
- A **meal_entry** is one food in a meal: `food_id` FK, `quantity`, `serving_unit`, and computed
  kcal/protein/carb/fat = per-serving * (quantity / serving_size). No own `user_id`; RLS via parent.
- **Log flow:** Nutrition screen "Today" view, tap a meal section (or "+ Log"), the **FoodPickerSheet**
  opens to Recents + Favorites, pick a food, set quantity, add. Two taps for a repeat food.
- **Offline + custom foods:** a meal entry references a food by name and resolves to a real `foods.id`
  lazily at sync time (`resolveFoodRow`), exactly like a set resolves its exercise. An offline-created
  custom food has no server id until sync, so the meal flush must throw a parkable error (EXRES analog),
  never drop entries.

### C. Daily targets + the lifter framing

- `user_profiles` gains nullable `daily_calorie_target`, `protein_target_g`, `carb_target_g`,
  `fat_target_g`. Optional: derive sensible defaults from existing `goal` + body weight.
- The hero framing everywhere is **protein ring + calories-vs-target ring**, carbs/fat secondary. This
  is the niche-differentiating UI: a lifter's mental model, not a neutral diary.
- `Colors.macro` palette (protein / carbs / fat) added to `constants/theme.ts`, following the existing
  `Colors.muscle` categorical-palette pattern, for rings/bars/chips.

### D. Dashboard "Today's Fuel" card (first prominent surface)

- A card on the dashboard (alongside the coach hero + stat cards) showing today's protein ring +
  calories-vs-target ring at a glance, tapping through to the Nutrition screen. Drona-voiced one-liner
  when off-track ("Protein's lagging today. Lock it in before bed.").
- Built behind the existing dashboard card pattern. Note: design-polish is reworking the dashboard, so
  coordinate placement (this is the polish-gated part).

### E. Nutrition surface + nav (end-state, post-polish)

- A **Nutrition tab** as the detailed log + day navigator + meal-history surface. Reached today via a
  hidden sub-screen (dashboard card tap + a Profile "Nutrition" row, `href:null` pattern); promoted to a
  real tab after design-polish, by relocating Analytics off the tab bar.
- A meal-history view mirrors `app/(app)/history.tsx` (cache + pending-queue merge + `useSync`).

### F. Coach (Drona) awareness (DEFERRED to its own phase)

- Add a nutrition CTE to `get_user_coach_context()` (today's intake vs targets, 7-day protein adherence)
  reading the `user_nutrition_stats` rollup, scoped by `current_clerk_user_id()`.
- Relax/extend the persona in `supabase/functions/ai-coach/prompt.ts` so Drona can coach macros (he
  currently refuses meal plans by persona), and surface diet facts via the existing `coach_memory`
  "diet" category. Ship logging first; this lands after.

### G. Quick-log / friction killers (niche retention)

- Recents (last N foods), Favorites (star a food), "repeat yesterday's <meal>", and a quantity stepper
  defaulting to the user's last-used quantity for that food. Cap quantity inputs (clamp like
  `MAX_CUSTOM_SETS`) so a bad paste can't freeze a render.

---

## Data sourcing (researched 2026-06-23)

A full macro tracker lives or dies on its food data, and the licensing is the part that is easy to get
catastrophically wrong. Researched across open government tables, Open Food Facts, India-specific
sources, and commercial APIs, with the actual license clauses read. Bottom line below.

### The core strategic call: for Indian dishes, compute, do not copy

The authoritative Indian data (IFCT 2017, INDB) is copyright-restricted and cannot be bundled; the
legally-clean data (USDA) has almost no Indian dishes. So we do NOT pick one source. We build a
**layered catalog** where each layer uses the legally-correct source for its job, and we **generate our
own Indian cooked-dish table** by computing macros from recipe compositions against a clean ingredient
base. Nutrient numbers are facts (not copyrightable); a curated table is. Computing our own dishes
sidesteps the entire IFCT/INDB copyright chain and produces a proprietary, defensible dataset.

### Source decisions

| Layer | Source | License | Decision |
|---|---|---|---|
| Gym staples + raw generic ingredients | USDA FoodData Central (SR Legacy + Foundation Foods) | CC0 / public domain | **BUNDLE.** Zero restrictions, offline OK, attribution only requested not required. The safe backbone. |
| Indian branded + barcode products | Open Food Facts, filtered to `countries:india` + global gym brands | ODbL (DB) + DbCL (facts) | **BUNDLE, segregated + attributed.** Share-alike binds the derived database, not the app code. |
| Indian raw ingredients | IFCT 2017 (ICMR-NIN) | Copyrighted govt publication | **REFERENCE ONLY** until written permission. Copyright page forbids "electronic storage for creating a product" without NIN permission. |
| Indian cooked dishes (dal, dosa, biryani, idli, paneer dishes) | We compute them: INDB (methodology/recipe comps) + Kaggle "Indian Food 101" (dish names + ingredient lists) against the USDA/own ingredient base | Our own work product | **BUNDLE.** This is the differentiator and the legal-safety move. |
| Dish-name list + regional tagging + autocomplete | Kaggle "Indian Food 101" (255 dishes, metadata, no macros) | low IP risk (verify page license) | **REFERENCE/seed strings.** Drives dish names + Drona's regional theming. |
| Barcode scanning (later phase) | expo-camera (CameraView) + bundled OFF India barcode subset (offline) + live OFF API (online enrichment) | MIT scanner / ODbL data | **DEFER.** Ship v1 without barcode. |

### Disqualified outright (do not design around these)

Every commercial nutrition API fails our offline-first constraint by ToS: **Nutritionix** (~$1,850/mo,
US-centric, no offline rights), **Edamam** (caches only 4 macros behind a password, no derived catalog),
**FatSecret** (IDs only, 24h cache cap), **Spoonacular** (1h cache, no derived storage, no resale),
**API Ninjas** (storage only on $99/mo tier, thin Indian quality). They cannot be the catalog. At most a
future ONLINE-ONLY add-on. Also avoid: **Australian AFCD** (CC BY-SA share-alike trap), **EuroFIR**
(membership-gated), **GS1 India DataKart** (best Indian barcode coverage but a gated paid registry, no
bundle license, possible future paid partnership only), and the **nodef/ifct2017** npm package (AGPL-3.0
code AND IFCT-copyright-tainted data).

### What needs permission, and what does not (we can start now)

The permission emails are an UPGRADE path, not a blocker. Verified 2026-06-24:

- **USDA FoodData Central — no permission, use now.** CC0 1.0 / public domain
  (confirmed on fdc.nal.usda.gov). Download, store, bundle, ship commercially, no
  permission, attribution only requested. Already downloaded + ingested by the
  pipeline (31 authoritative rows landing today).
- **Open Food Facts — no permission, use now.** ODbL is an open license; commercial
  use + persistent storage are explicitly allowed. The only obligations are the
  segregation + attribution guardrails below, not anyone's sign-off.
- **IFCT 2017 / INDB — permission needed for VERBATIM use; reference is fine now.**
  The IFCT copyright (confirmed verbatim on nin.res.in) forbids storing/reproducing
  the publication "in any electronic format for creating a product" without written
  NIN permission. So we do NOT bundle their tables. BUT individual nutrient *values*
  are facts (not copyrightable), so we may consult IFCT/INDB to author and sanity-check
  our own rows. That is what "compute, don't copy" does, and it ships without waiting.
  The email unlocks cleaner, direct verbatim use if granted. (Engineering guidance,
  not formal legal advice.)

Net: we can build the full catalog NOW from USDA + OFF + our own computed Indian
dishes, and the NIN/Anuvaad replies only ever make Indian coverage better.

### Legal guardrails (LOCKED)

- **USDA (CC0):** bundle freely. Courtesy credit "FoodData Central, U.S. Department of Agriculture."
- **Open Food Facts (ODbL):** (1) keep OFF-sourced rows in a separately-identifiable partition (e.g. a
  `source` column tagged `off`), never irreversibly merged into proprietary rows, so share-alike applies
  only to that subset; (2) ship attribution: "Includes data from Open Food Facts, licensed under ODbL";
  (3) be willing to offer the OFF-derived subset under ODbL on request (a downloadable dump); (4) send a
  custom User-Agent identifying the app on any live API call; (5) do not bundle OFF product images
  (CC BY-SA, separate copyleft), macros/text only.
- **IFCT 2017 / INDB / their Kaggle re-uploads / nodef package:** do NOT bundle any of these verbatim.
  Use as reference/methodology only. A third party cannot license data they do not own.
- **Compute-don't-copy for dishes:** our cooked-dish rows are authored/computed by us; document the
  ingredient breakdown + source ingredient ids per dish so the derivation is defensible and re-runnable.
- This is engineering guidance, not formal legal advice. The clean upgrade is written permission.

### Action with lead time (start now, parallel to everything)

Email **ICMR-NIN** (IFCT 2017) and **Anuvaad / Dr. Lindsay Jaacks** (INDB) requesting written permission
to use their data in a commercial app. If granted, we use the authoritative Indian tables directly and
the catalog quality jumps. If not, the compute-don't-copy path still ships. This has the longest lead
time of anything in the plan, so kick it off independent of the build.

### Catalog build pipeline (offline, repo tooling, not shipped code)

A `scripts/diet-catalog/` pipeline (run once + on refresh, output committed):
1. Ingest USDA SR Legacy + Foundation Foods CSVs, filter to a curated allow-list of gym staples + common
   ingredients, normalize to our per-serving schema.
2. Ingest the OFF bulk dump, filter to `countries:india` + global gym brands with complete macro panels,
   tag `source='off'`, keep segregated.
3. Compute Indian cooked dishes: for each dish in the "Indian Food 101" list, define an ingredient
   breakdown (INDB recipe comps as the reference), compute per-serving macros from the ingredient base,
   emit our own rows with documented derivation.
4. Emit two artifacts: the static `FOOD_LIBRARY` seed (bundled in `lib/foods.ts`, the offline base) and
   a `foods` table seed SQL (global rows, `created_by` null, applied as service role).
This pipeline IS the bulk of the "full macro tracker" effort. The app-side plumbing is the easy part.

## Data model

All migrations purely additive, nullable/defaulted, applied to live via Supabase MCP `apply_migration`
(project rule: **never `db push`**, ref `rjmmslierxhvwdjgjilb`). Each mirrored into `schema.sql`
(both RLS passes: the per-op `auth.jwt()->>'sub'` policies AND the `current_clerk_user_id()` helper
`for all` pass). TS interfaces (`Food`, `Meal`, `MealEntry`) added to `lib/types.ts` with forward-safe
optional fields.

### `0046_foods_catalog.sql`
- `create table foods` with `id uuid pk`, `name text not null`,
  `created_by text default (auth.jwt()->>'sub')` (NULL = global), `food_category text` + CHECK,
  `serving_unit text` + CHECK, `serving_size numeric`, `kcal/protein_g/carb_g/fat_g numeric`,
  `brand text`, `barcode text`, `image_url text`, `source text` + CHECK
  (`usda`/`off`/`curated`/`user`, for ODbL segregation + provenance, see Data sourcing), timestamps.
- RLS: 4 scoped policies. SELECT = `created_by is null or created_by = auth.jwt()->>'sub'`
  (the OR-leak gotcha: a naive `using (true)` exposes every user's private foods).
  INSERT/UPDATE/DELETE own-only. Clone `0036_exercise_ownership.sql`.
- Pair of partial unique indexes on `lower(name)`: one `where created_by is not null`, one
  `where created_by is null` (clone `0037_exercise_name_unique.sql`) so `resolveFoodRow` find-by-name is
  canonical and seed `on conflict do nothing` is idempotent.
- Seed the India-first + gym-staples global library as **service role** (so seed rows get NULL
  `created_by`, not the runner's sub, the exact bug 0036 fixed).

### `0047_meals_and_meal_entries.sql`
- `create table meals`: `id uuid pk`, `user_id text not null default (auth.jwt()->>'sub')`,
  `logged_at timestamptz`, `meal_type text` + CHECK (breakfast/lunch/dinner/snack), `note text`,
  `client_id uuid` + partial unique index `(user_id, client_id) where client_id is not null` (clone
  `0038_workouts_client_id.sql`). RLS = 4 own-scoped policies on `user_id` (clone workouts).
- `create table meal_entries`: `id uuid pk`, `meal_id uuid references meals(id) on delete cascade`,
  `food_id uuid references foods(id) on delete set null` (keep the entry, drop only the catalog link),
  denormalized `food_name text` + `quantity numeric` + `serving_unit text` + cached
  `kcal/protein_g/carb_g/fat_g numeric`, `position int`. The denormalization makes history immutable
  (deleting a catalog food does not change past totals), lets the log render without a join, and lets
  offline-created custom foods (no server id yet) display. **No own `user_id`**: RLS via EXISTS against
  parent `meals` (clone workout_sets). Adding a redundant user_id diverges from the codebase and the
  rollup trigger. (`position` not `order` — `order` is a reserved word.)

### `0048_nutrition_targets.sql`
- `alter table user_profiles add column if not exists daily_calorie_target numeric`, `protein_target_g`,
  `carb_target_g`, `fat_target_g`, nullable. Same additive pattern as `goal`/`experience_level`.

### `0049_user_nutrition_stats.sql`
- `create table user_nutrition_stats` PK `(user_id, day)` with summed kcal/macro columns, owner-read RLS.
- `recompute_user_nutrition_stat(user, day)` plpgsql helper (clone `recompute_user_lift_stat`), and an
  AFTER INSERT/UPDATE/DELETE per-row trigger on `meal_entries` that recomputes only the affected
  `(user, day)` (clone the workout_sets stats trigger, `0008_per_user_stats_tables.sql`).
- If meals ever award XP/streaks, use a SECURITY DEFINER atomic-upsert RPC (clone `award_xp`,
  `0039`), never a client read-modify-write, or concurrent offline flushes lose updates.

---

## Phases

Sizing in t-shirts. P1 to P3 do not touch the dashboard/nav and are candidates for running parallel to
design-polish. P4 (card) and P5 (tab) are the polish-gated surfaces.

- **P-data — Catalog data build (L, can start now, independent of app code).** The
  `scripts/diet-catalog/` pipeline (see Data sourcing): ingest USDA (CC0) + OFF India subset (ODbL,
  tagged `source='off'`), compute Indian cooked dishes against the ingredient base, emit the
  `FOOD_LIBRARY` seed + `foods` table seed SQL. This is the bulk of the work. Also: send the NIN +
  Anuvaad permission emails (longest lead time, fire immediately).
- **P0 — Data + types foundation (M).** Migrations 0046 to 0049 applied via MCP + mirrored into
  `schema.sql`. `lib/foods.ts` (enums, normalizers, `SERVING_UNITS`, the `FOOD_LIBRARY` seed emitted by
  P-data). `Food`/`Meal`/`MealEntry` in `lib/types.ts`. `Colors.macro` palette. Nutrition formatters in
  `lib/format.ts` (`formatKcal` reusing `abbreviateNumber`, `formatMacroGrams` like `formatWeight`,
  `roundMacros` like `roundVolume` for summed float noise).
- **P1 — Catalog read/resolve/cache (M).** `resolveFoodRow`/`saveLocalCustomFood`/`mergeLocalCustomFoods`
  (clone `lib/exerciseResolve.ts`). Add `foods` to `localCache.ts` `CacheEntity`/`ENTITIES`. Guest
  `GuestFood` CRUD in `lib/guestStore.ts`.
- **P2 — Food picker + foods library screen (L).** `FoodPickerSheet` (clone `ExercisePickerSheet.tsx`,
  Portal not Modal, Recents/Favorites-first, quantity entry). Foods library/manager screen (clone
  `app/(app)/exercises.tsx`: search + category pills + YOUR FOODS/LIBRARY sections + edit sheet with
  macro inputs + delete-with-usage-count counting `meal_entries`).
- **P3 — Meal logging + offline sync (L).** `lib/mealQueue.ts` (clone `syncQueue.ts`: `PendingMeal`,
  `client_id`, phase-gated idempotent flush, lazy food resolve, parkable EXRES). Wire into
  `SyncProvider.tsx` (import, `totalPending`, hydrate, `flushNow`) AND the `profile.tsx` pre-sign-out
  flush. Guest `guest_meals` store + `addGuestMeal`. Pending-merge read adapters (clone
  `pendingAdapters.ts`). Capture `logged_at` at enqueue, not flush.
- **P4 — Dashboard "Today's Fuel" card (M, polish-gated).** Protein + calories-vs-target rings, Drona
  one-liner, tap-through. Coordinate with design-polish dashboard reflow.
- **P5 — Nutrition screen + tab promotion (M, polish-gated).** Day view, meal sections, history. Promote
  to a bottom-nav tab (edit BOTH `(app)/_layout.tsx` and the hardcoded `BottomNav.tsx`), relocate
  Analytics off the tab bar.
- **P6 — Coach awareness (M, deferred).** Nutrition CTE in `get_user_coach_context()`, persona update in
  `ai-coach/prompt.ts`, `coach_memory` "diet" wiring.
- **P7 — Barcode scan + OFF enrichment (M, later).** `expo-camera` (CameraView, `onBarcodeScanned`,
  `ean13`/`ean8`/`upc_a`/`upc_e`, needs a dev/EAS build, camera permission). Resolve against the bundled
  OFF India barcode subset offline, fall back to the live OFF API (custom User-Agent) for cache-misses,
  backfilling `barcode`/`brand`. Degrades gracefully offline. Expect high scan-miss rates on Indian
  shelves initially (OFF India coverage is ~10k products). GS1 India DataKart is a possible future paid
  online partnership, not bundleable.

---

## Migration numbering

Next free number is **0046** (highest present is 0045; 0041 is missing, 0030 is duplicated, 0040 jumps
to 0042). This plan claims 0046 to 0049. Verify with `ls supabase/migrations/` before applying, and
apply via Supabase MCP only.

---

## Open refinements (decide during build, not blocking)

- Targets: nullable columns on `user_profiles` now; split to a `nutrition_targets` table only if/when
  target-change history is wanted.
- Whether meals contribute XP (and what formula) or stay XP-neutral. Leaning XP-neutral in v1 to avoid
  gamifying eating; revisit.
- Recents source: derive from `meal_entries` history vs a dedicated `food_favorites` table. Start
  derived, add favorites table if starring needs to persist independently.
- "Same as yesterday" granularity: whole-day copy vs per-meal copy.
- Guest carryover on sign-up: there is no guest-to-server migration today (workouts only offer a manual
  per-routine recreate). Decide if a guest's logged meals carry over or are abandoned in place like
  guest workouts. Net-new work if carryover is wanted.
- Sequencing vs paused set-types: diet reuses the shipped Phase 0 preferences foundation but should not
  hard-depend on unmerged set-types work (Phases A to E, including migrations 0043 to 0045 which exist as
  files on `feat/exercise-set-types` but are paused).
