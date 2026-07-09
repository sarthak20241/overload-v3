# AI Food Logging (Drona Parse) - Plan

Status: PLANNED (2026-07-06). Builds directly on the shipped diet/macro tracker (foods catalog,
meals + meal_entries, nutrition screen). Inspiration: Journalable's free-text logging flow
(screen recording reviewed 2026-07-06, 25s clip: type "oats yogabar 50g and milk 500 ml",
send, in-place "Analysing..." card ~3s, auto-logged with per-item macros + totals, edit after).

Design principle, same as the diet plan: friction is the enemy of food logging, and Drona is the
narrator. Journalable's insight is that ONE text box beats every picker. Our edge over them is
trust and coaching: they let the LLM invent macros (their "Milk 500 ml = 310 kcal / 16g protein"
is silent whole-milk math); we resolve against our real catalog (USDA + OFF India + curated, with
food_servings gram mappings), so the AI only matches foods and parses quantities, it never invents
nutrition. And where their card is a data diff, ours ends in Drona's voice.

## Locked decisions (2026-07-06)

- **v1 input = text only.** The typed free-text flow ships first; photo (Claude vision) and voice
  (needs a native STT dep = dev-client rebuild, same constraint that deferred the rest-timer
  sound) are fast-follow phases. No new native dependencies in v1.
- **Confirm card with section selector (REVISED 2026-07-07 after on-device test).** The original
  "auto-log + edit, no confirm" model was built and tested on the iOS sim, and the user rejected it:
  entries auto-landed in one section (usually snacks) with no way to place them elsewhere, and the
  card committing on an 8s timer felt out of control. Replaced with a REVIEW step: parse populates
  a card with the items + a Breakfast/Lunch/Dinner/Snacks selector (pre-seeded to Drona's guess) +
  an explicit "Add to <section>" button. NOTHING is logged until the user taps Add; Discard throws
  it away. Verified on-device: picking Lunch routed the meal to Lunch, not the parser's Dinner guess.
- **Catalog-grounded parsing with a no-match fallback LADDER (extended 2026-07-06).** Claude
  matches text to catalog rows + servings and parses quantities; macros come from the matched
  row. When the catalog misses, we do NOT jump straight to a model guess. Order:
  Tier 1 catalog -> Tier 2 live Open Food Facts lookup (branded items; free; the ODbL
  guardrails from the diet plan apply; fetched products are BACKFILLED into `foods` tagged
  source 'off' so the catalog grows itself and repeat hits are Tier 1) -> Tier 3 Anthropic
  web-search tool (label data from brand/restaurant sites; ~$10 per 1k searches; fires only on
  no-match, max 2 searches per parse, only for named/branded items) -> Tier 4 Drona estimate
  from model knowledge (food_id null, snapshots carry the numbers, history stays immutable).
  Every line shows provenance: no chip for catalog, "from label" for tiers 2-3, "Drona's
  estimate" for tier 4. Individual label facts are not copyrightable; we never bulk-copy a
  proprietary database.
- **Assumptions are visible and tappable.** "milk" resolving to toned milk shows as a chip on the
  result card; one tap swaps the variant and relogs the line. No silent guesses.
- **Any signed-in user (LOCKED 2026-07-07).** Requires a Clerk JWT but NOT paid Drona access:
  the parse_meal branch sits before the paid access gate, gated only by JWT + the 40/day bucket.
  AI logging is a free retention hook, not a paid-tier feature. Guests keep the manual picker.
- **OFF backfill scope: global catalog (LOCKED 2026-07-07).** Live-OFF hits write a shared
  foods row (created_by null, source 'off') so the catalog self-grows for everyone.
- **Food only in v1.** Journalable's box also takes exercise; our workouts have their own flow.
  The parser politely declines non-food input in Drona's voice.
- **Meals stay XP-neutral** (carried from the diet plan). No XP from AI-logged meals.
- **No em dashes** in plan prose or any UI copy. All user-facing strings in Drona's voice.

## The flow (v1)

1. Nutrition screen bottom bar ("Tell Drona what you ate", app/(app)/nutrition.tsx:164) becomes a
   real TextInput instead of a redirect to /food-search. A separate browse affordance (small
   search icon beside the bar) keeps the manual picker one tap away. Guests: bar keeps the
   current redirect behavior.
2. Send: an optimistic card appears in the day view with the raw text + a shimmer "Drona is
   reading that..." state. Client passes device-local hour; meal type defaults via the existing
   mealForNow() (nutrition.tsx), overridden if the text names a meal ("for lunch").
3. Edge function parses + matches (see Architecture). Target latency: under ~4s, on par with
   Journalable's ~3s.
4. Result: the card morphs into logged entry rows (name, serving, quantity, per-item macros),
   a totals row, assumption chips where relevant, and one Drona line ("21g protein before 8am.
   Keep stacking."). Entries are ALREADY saved via the existing logFood() path
   (lib/dietData.ts:282), so the MacroRing/bars, user_nutrition_stats rollup triggers, and
   dashboard FUEL card all update for free.
5. Undo snackbar (single action: delete the created entries, and the meal if this action created
   it and it is now empty). Tap an entry row later to fix quantity/serving or delete it.

## Architecture

### Edge function: parse_meal mode on ai-coach

Add a `parse_meal` mode to supabase/functions/ai-coach/index.ts rather than a sibling function:
it reuses Clerk JWT verification, the Anthropic client + timeout, the tool-execution loop,
token_usage_log, and coach_traces (mode column distinguishes traces). Own rate-limit bucket,
NOT the coach 30/24h window: meals happen several times a day (propose 40 parses/24h rolling).

Parsing pipeline (single invocation, tool-use loop like the existing coach tools):

- Input: { text, local_hour, meal_hint? } plus a compact context block: the user's ~20 recent
  foods (names + default serving + last-used quantity, from meal_entries) so "my usual milk"
  and personal customs match first, and today's totals + protein/calorie targets so the Drona
  line can react to the day, not just the meal.
- Tool `search_foods(q)`: wraps the search_foods_ranked RPC + food_servings lookup, returns
  top-N candidates per query with their serving labels + grams. Claude calls it per extracted
  item, picks the best row + serving, converts the user's stated amount to grams
  (resolveBaseAmount semantics; per-100 basis math stays server-side and deterministic).
- Tool `lookup_off(q)` (Tier 2): live Open Food Facts search, custom User-Agent, ~3s timeout,
  degrades silently to the next tier. On a hit with a complete macro panel, the edge function
  backfills a global `foods` row (source 'off', segregated per the ODbL guardrails, on conflict
  do nothing against the lower(name) unique index) plus its serving, then logs against the new
  row like any catalog food. The catalog compounds with usage.
- Tier 3: Anthropic server-side web-search tool enabled for the parse_meal request, prompt-gated
  to fire only for named/branded no-match items, hard cap 2 searches per parse. Whether tier-3
  results also persist as rows (per-user, source 'web', needs the foods_source_check CHECK
  extended) or stay entry-only snapshots: decide during P0 from eval behavior. Persisting
  per-user avoids polluting the global catalog with unreviewed rows.
- Latency comms: the analysing card narrates tier changes ("Checking the label for that
  one...") so lookup seconds read as diligence, not lag. Common case (catalog hit) stays fast.
- Output (forced structured final answer): items[] of
  { food_id | null, food_name, serving_label, quantity, grams, macros?, assumption?, confidence },
  meal_type, drona_line. food_id null => Claude-estimated macros, flagged estimated.
- Model: claude-haiku-4-5 for speed + cost (this runs on every meal). Coach chat stays on
  sonnet. Model-swap checklist applies: hardcoded MODEL constant, redeploy, model_pricing row
  for haiku if absent, dev tooling. Escalate parse model only if matching quality demands it.

### Client

- lib/dietData.ts gains `parseAndLogMeal(text)`: calls the edge function, then batch-logs each
  returned item through logFood() (catalog items) or a new `logEstimatedEntry()` (null food_id,
  snapshot macros only). Returns entry ids for undo.
- The analysing/result card is a new components/diet/ParsedMealCard.tsx following the entry-row
  card idiom (C.card background, Shadow.card, C.macro.* chips). Raw text renders as a dim
  caption on the result card (like the video) but is NOT persisted to the log; it lives only in
  the trace.
- Failure paths: offline or edge error keeps the raw text in the input with a Drona-voiced
  retry line and a one-tap fallback into food-search. No half-logged state: entries insert only
  after a successful parse (batch, sequential inserts; on partial failure delete the inserted
  ids and surface retry).
- Entry editing (P2): tapping a logged AI entry opens the serving/quantity editor. Reuse the
  food-detail screen in an edit mode for catalog-backed entries; estimated entries get a
  minimal quantity-scale sheet (macros scale linearly from the snapshot).

### Data

No new tables for v1. meal_entries already supports everything: nullable food_id, denormalized
name + macro snapshots, grams_logged. One additive migration:

- `0073_meal_entries_logged_via.sql`: `alter table meal_entries add column if not exists
  logged_via text` CHECK in ('manual','ai') default null (null = legacy/manual). Lets the
  result card re-render AI entries distinctly, powers undo grouping, and gives analytics on
  AI adoption. Verify next free number with `ls supabase/migrations/` before applying; apply
  via Supabase MCP only (project rule: never db push, ref rjmmslierxhvwdjgjilb).

## Where we beat Journalable (the differentiators to protect while building)

1. Numbers with receipts: catalog-grounded macros, estimates visibly flagged.
2. Assumption chips: silent guesses become one-tap fixes.
3. Meal-sectioned log: entries land in breakfast/lunch/dinner/snack, stats stay coherent.
4. Drona narrates: protein-first coach line on every card, aware of the whole day.
5. Staples learning (P3): repeat meals collapse to one tap; "usual breakfast" just works.
6. India-first matching: yogabar, katori, roti, dal resolve because the catalog was built for
   this niche.
7. Self-growing catalog: OFF-backfilled no-match hits mean every lookup makes the next one
   instant, for every user. Journalable re-guesses every time.

## Phases

- **P0 - Edge parse_meal (M/L). BUILT 2026-07-06 (branch-local, nothing deployed).**
  - `supabase/functions/ai-coach/parseMeal.ts`: runtime-agnostic (deps injected) so the eval
    harness replays the exact prod pipeline from Node. Tools: search_foods (tier 1),
    lookup_packaged_food (tier 2, live OFF), web_search server tool (tier 3, `web_search_20250305`
    basic variant since Haiku, `max_uses: 2`, env-gated), log_meal terminal tool. Two-round
    search budget + forced log_meal on the final iteration so composite dishes can't spin.
    Catalog/OFF items get macros RECOMPUTED server-side from the row (verifyItems) so grounded
    numbers are deterministic. Dashes scrubbed from user-facing strings.
  - `ai-coach/index.ts`: `mode: 'parse_meal'` branch after auth+access gate, BEFORE the coach
    rate insert (body now parsed once up top). Own bucket `parse_meal_rate_limit` (40/day).
    Deps: catalog search via search_foods_ranked + food_servings join; OFF backfill inserts a
    global `foods` row (service role, source 'off', food_category 'other' - NOT 'prepared_dish')
    + default serving; recents from meals/meal_entries (14d); targets + today's totals.
    token_usage_log pipeline 'parse_meal'; coach_traces reused.
  - Migrations `0073_ai_food_logging.sql` (parse_meal_rate_limit + meal_entries.logged_via check
    'manual'/'ai') and `0074_seed_curated_staples.sql`: **APPLIED TO LIVE 2026-07-07 via Supabase
    MCP** (ref rjmmslierxhvwdjgjilb). Verified: rate-limit table + logged_via column exist, 10
    staples + 20 servings seeded, Toned Milk reads 48kcal/3.2p per 100ml. **0074 is load-bearing
    and was a finding from the eval:** lib/foods.ts
    FOOD_LIBRARY's 10 staples (Toned Milk, Curd, Whey, Paneer, dals...) live ONLY in the app
    bundle; the picker unions them client-side but the edge fn searches the DB, so they were
    invisible to the parser and fell to whole-milk-style estimates. 0074 seeds the same rows
    server-side (created_by null, source 'curated') so they become tier-1 hits AND stay identical
    for the client (name-dedupe collapses them).
  - Haiku pricing row already present (migration 0024, `claude-haiku-4-5`), so no new pricing
    migration needed.
  - Eval harness `scripts/parse-meal-eval/` (run.ts + cases.ts), run with
    `ANTHROPIC_API_KEY=... npx tsx scripts/parse-meal-eval/run.ts`. 41 cases (30 Indian meals +
    ~10 branded/no-match + 3 decline). Live catalog (anon), OFF dry-run (no backfill writes),
    web search off unless EVAL_WEB_SEARCH=1. Baseline result 2026-07-06: decline path clean,
    branded items resolve via OFF/estimate with provenance, gram math correct on explicit
    amounts. Remaining eval reds are (a) the 3 bundled staples that only turn tier-1 once 0074
    is applied to live, and (b) an occasional wrong USDA row pick (chicken breast -> fat-free
    deli slice) - a ranking nicety, not a blocker. Re-run these post-0074-apply to confirm green.
  - OPEN before P1: decide tier-3 ships enabled vs waits (lean enabled, capped); wrong-row
    ranking nudge; whether estimated branded items offer "save as custom food."
- **P1 - Client flow. BUILT + VERIFIED ON iOS SIM 2026-07-07.** Ran on iPhone 17 Pro sim
  (dev build from this worktree, Metro :8082, against LIVE edge fn). Confirmed end to end:
  analysing shimmer -> result card with FROM LABEL provenance chip + Drona-voice assumption
  ("Took that as 100 g. Used Nutribit label data...") + per-item macros; entries logged to the
  right meal section; ring counted down + macro bars climbed; 8s auto-dismiss. Real parses that
  worked: "Moong Dal Halwa (Mai Karigar)" 340kcal, "Milky Mist Paneer" 275kcal (OFF/label tier).
  Test artifacts left in prod today's log for the sim's signed-in user: those 2 junk entries in
  SNACKS (no in-app delete until P2 -> remove via Supabase MCP or P2 delete UI). Note: computer-use
  typing into the iOS sim triggers the press-and-hold accent popup, so scripted input mangles;
  real device typing is unaffected.
  - lib/dietData.ts: `parseMeal()` (calls supabase.functions.invoke('ai-coach', {mode:'parse_meal',
    text, local_hour, local_date, meal_hint}); Clerk JWT rides the client fetch wrapper),
    `logParsedMeal()` (find-or-create meal, batch-insert entries with the parser's FINAL macros +
    logged_via='ai'; sugar/sat_fat/sodium null since parser returns only fiber), `undoParsedMeal()`.
  - components/diet/ParsedMealCard.tsx: 4 states (analysing shimmer / result rows w/ provenance
    chip + assumption + Drona line + Undo / declined / error+Retry). Reanimated pulse; reduced-motion safe.
  - app/(app)/nutrition.tsx: bottom bar is now a real TextInput + send for signed-in users (guests
    keep the picker Pressable). ParseFlow state machine drives the card; entries land in the meal
    sections underneath (reload()), ring/bars count-up for free from the existing animated
    components. 8s auto-dismiss on result (Undo lives in that window). Keyboard lift via
    useKeyboardAwareScroll's kbHeight (absolute bar, so bottom:kbHeight; the hook's listeners are
    cross-platform). camera/mic icons dropped (P4/P5).
  - ON-DEVICE WATCH ITEMS (can't verify from here, native): keyboard lift on both iOS + Android;
    tall multi-item card overlapping the last meal section (ScrollView paddingBottom is static 150);
    real parse latency feel (~6-8s) with the shimmer.
  - NOT DONE in P1: count-up is inherited, not custom; targets still hardcoded in the screen
    (TARGETS const) though the edge fn reads real targets for its Drona line.
- **P2 - Fix-it affordances. BUILT + PARTLY VERIFIED ON iOS SIM 2026-07-07.** Logged entries in the
  day view are now tappable -> EntryEditSheet (components/diet/EntryEditSheet.tsx, Portal sheet like
  SetTypeSheet): quantity stepper with live macro scaling (scales the stored snapshot linearly, so it
  works uniformly for catalog/off/estimate entries), a Breakfast/Lunch/Dinner/Snacks selector to MOVE
  the entry, and Delete. dietData: deleteMealEntry / updateEntryQuantity / moveEntry (find-or-create
  target meal + delete emptied source meal). LoggedEntry extended with meal_id + grams_logged.
  On-device: sheet opens + renders all controls; DELETE verified end to end (-265 kcal, ring/bars
  updated). Quantity-save + move-save are type-clean and share the same verified onSaved->reload
  pipeline but weren't cleanly completed on the sim (concurrent test-parse churn re-flowed the list).
  DEFERRED from P2: assumption-chip VARIANT SWAP on the review card (re-resolve "milk" -> toned/whole,
  needs a variant re-query); current chips are informational only. Sim lesson: a NEW component file
  needs a full bundle reload (Fast Refresh can't apply a new import) -> `xcrun simctl terminate +
  launch com.overload.tracker` forces a clean refetch (Cmd+R is unreliable, focus bounces off the sim).
- **Targets + goal editor. BUILT + VERIFIED ON iOS SIM 2026-07-08.** The hero ring/bars were drawing
  against a hardcoded TARGETS/FUEL_TARGETS const (2000/125/250/56) on both the nutrition screen and
  the dashboard FUEL card. Now: `useNutritionTargets()` in dietData reads the four user_profiles
  columns (daily_calorie_target, protein_target_g, carb_target_g, fat_target_g), falls back to
  DEFAULT_TARGETS per-field, and exposes isCustom + an optimistic `apply` + focus-refetch.
  `saveNutritionTargets()` upserts on clerk_user_id (like the profile screen). A "SET GOAL" pill on
  the hero (dimmed "GOAL" once set) opens NutritionGoalSheet (Portal sheet, 4 number-pad fields +
  Save). Wired into both screens. On-device: read + pill + sheet render verified; Save PERSISTS
  (confirmed the user_profiles row via MCP: 2000/125/250/56) and the pill flips SET GOAL->GOAL on
  refetch. The edge fn already reads these columns for Drona's day-aware line, so they now agree.
  Not separately verified: a DISTINCT custom value's instant ring update (sim typing is unreliable);
  optimistic apply is type-clean and covers it.
- **P3 - Saved meals + recipes (AI-native). BUILT + core VERIFIED ON iOS SIM 2026-07-08.**
  User chose "meals + recipes, AI-native" over MFP-style form builders. Migration 0075 (applied to
  live): saved_meals (name, kind meal|recipe, servings, serving_label, cached WHOLE-batch macros) +
  saved_meal_items (clone of meal_entries), RLS cloned from meals/meal_entries. dietData:
  createSavedMeal (from parsed items, sums totals), listSavedMeals (with items), logSavedMeal (MEAL
  expands its items into meal_entries scaled by qty; RECIPE inserts ONE per-serving entry named after
  the recipe = totals/servings x eaten), deleteSavedMeal. UI: SaveMealSheet (from the review card's
  bookmark: name + meal/recipe toggle + recipe yield/label; items come from the parse, no form) and
  SavedMealsSheet (header bookmark: list + one-tap Log into the current meal + delete). On-device
  VERIFIED: list renders with correct per-serving math (400 kcal/4 katori -> 100 kcal/katori row);
  one-tap Log inserted exactly 100kcal/6P/12C/2F into Breakfast; delete refreshed to empty state.
  NOT cleanly UI-verified (sim env got messy: two overlapping sim windows + RN element-inspector
  toggled on + flaky keyboard): the SaveMealSheet render + createSavedMeal-from-parse round trip.
  Both type-clean and pattern-identical to verified code (logParsedMeal insert; the 3 other Portal
  sheets render fine) - low risk, user to confirm with clean typing.
  DEFERRED from P3 (original stub): frequent-combo AUTO-detection, "usual breakfast"/"repeat
  yesterday" typed shortcuts, and writing staples to coach_memory. The explicit save/re-log covers
  the core repeat-tracking need; these auto-conveniences are follow-ons.
  TEST JUNK: seeded 'Toor Dal (batch)' recipe (deleted via UI) + its one logged serving on Jul 8
  Breakfast (100 kcal) remains; include in the logged_via junk purge.
- **P4 - Photo logging (M, later).** Camera/gallery icon on the bar, image straight to Claude
  vision as base64 (no storage bucket), same result card. Portion estimation from photos is
  genuinely hard; ship with conservative confidence + always-editable output.
- **P5 - Voice (S, later, rebuild-gated).** Mic icon, STT (expo-speech-recognition or similar
  native module), pipes into the same text flow. Bundle with the next dev-client rebuild
  alongside the rest-timer sound dep.

- **MFP-parity manual surfaces. BUILT + VERIFIED ON iOS SIM 2026-07-08.** User feedback after testing:
  (1) the save bookmark should fill after saving, (2) must be able to create a meal WITHOUT the coach,
  (3) My Meals/My Recipes should live in the search bar to browse + log manually (MFP model, reference
  video reviewed). Delivered:
  - Bookmark saved-state: after Save on the review card, the bookmark becomes a lime "check Saved"
    chip (ParsedMealCard `saved` prop; nutrition tracks savedReview, reset each parse).
  - food-search.tsx now has MFP tabs: All | My Meals | My Recipes. Meals/recipes tabs show a
    "Create a meal/recipe" button + listSavedMeals filtered by kind/query, each row +logs via
    logSavedMeal into the target meal (checkmark on logged). VERIFIED: tabs render, saved list +
    macros, one-tap log.
  - app/(app)/meal-builder.tsx: manual Create-a-Meal/Recipe (NO coach). Meal/Recipe toggle, name,
    recipe yield/label, a FOODS list built via an INLINE catalog search (searchCatalog, tap + to add),
    running totals, Save via createSavedMeal. Registered href:null + hidden workout chrome in
    (app)/_layout.tsx. VERIFIED END TO END: built "My Roti Plate" by searching + adding Roti / Chapati,
    named + saved -> DB row confirmed (120 kcal, 1 item), no AI involved.
  - KNOWN NIT: router.back() after saving in the builder lands on the Dashboard instead of returning
    to food-search's My Meals tab (Expo Router Tabs href:null back-history quirk). Feature works; the
    saved meal appears in My Meals on next visit. Minor nav polish TODO.
  - Also deferred: My Foods tab (custom foods), Copy Previous Meal, per-item quantity stepper in the
    builder (adds at 1 serving; user edits the logged entry after). Recipe logs 1 serving by default.

## Open refinements (decide during build, not blocking)

- Rate limit number (40/day proposed) and whether parse failures count against it (they should
  not).
- Tier-3 persistence: per-user source 'web' rows (needs foods_source_check extended, can bundle
  into 0073) vs entry-only snapshots. Decide from P0 eval.
- Reading OFF nutrition-label IMAGES via Claude vision when a product exists but its structured
  macros are incomplete: real but deferred to the enrichment phase; tiers 2-3 should cover most
  branded cases without a vision call.
- Whether "save this estimate as a custom food" is offered inline on estimated entries (leaning
  yes, it back-fills the catalog with the user's real foods).
- Multi-meal texts ("breakfast was X, lunch was Y"): v1 may split into two meals or ask; decide
  from eval-set behavior.
- Whether the browse icon opens food-search prefilled with the unparsed text on failure.
- Streaming the result per-item vs one shot (one shot first; haiku is fast enough).
