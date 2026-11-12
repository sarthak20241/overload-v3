# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start development server
npx expo start

# Run on specific platform
npx expo start --ios
npx expo start --android

# Install new dependency
npx expo install <package>

# parse_meal eval — ALWAYS route model calls through the Claude CLI, so the
# run bills the subscription instead of API credit.
EVAL_VIA_CLI=1 npx tsx scripts/parse-meal-eval/run.ts
# Composable: ONLY=case-a,case-b  FAST_MODE=on  EVAL_WEB_SEARCH=1  DEBUG_STEPS=1
# Wrong-catalog-row set (Thorough): CASE_SET=thorough-match, and
# THOROUGH_MATCH_MODE=on (or shadow) to run Jev's row check (needs JEV_API_KEY).
# Brand not in our catalog (generic or other-brand rows): CASE_SET=branded-oats.

# Saved-food match (Jev only, no model calls): is a food she logged before served?
# ONLY=too-yum,doctors-banana-caramel REPEAT=3 to see how steady a score is.
# ASK=prod CAND_BRAND=brackets runs the app's own matchMemory end to end (score,
# 0.6-0.7 to decide, then the choice question); other knobs are listed at the
# top of the script (FLOOR, MAYBE_FLOOR, RESPELL=0, DROP_RULE, ASK=choice|pipeline).
deno run -A scripts/memory-identity-eval/run.ts

# Use the API key ONLY when the question is latency or token cost. The harness
# warns that CLI timings are not comparable — they measure the CLI, not the
# pipeline. Correctness and per-case pass/fail are identical either way.
ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/parse-meal-eval/run.ts

# Program coach fuel days: does Drona plan fuel days when the user names hard
# weekdays, and only then? Same CLI rule as above.
EVAL_VIA_CLI=1 npx tsx scripts/program-fuel-eval/run.mts

# Program goal label: a generated cut must carry goal = fat_loss (Drona's
# goals_disagree signal reads coach_programs.goal). Same CLI rule.
EVAL_VIA_CLI=1 npx tsx scripts/program-goal-eval/run.mts

# Program activity goals: a cut gets a step goal, an asked-for run gets a cardio
# goal, a gain or strength hold with no ask gets neither. Same CLI rule.
EVAL_VIA_CLI=1 npx tsx scripts/program-activity-eval/run.mts

# Lean chat context: does Drona fetch a held-back section (routines, volume,
# plan changes, tape) when a question needs it, and skip it when the summary
# answers? Same CLI rule.
EVAL_VIA_CLI=1 npx tsx scripts/lean-context-eval/run.mts

# Region rules (FOOD_REGION_RULES=on, Precise): EVAL_REGION=india|us|uk sets the
# time zone for both evals; EVAL_PRECISE=1 runs parse-meal-eval in Precise.
# Both print a kcal error line (against each kcal range's middle).
# Food box (Precise): 58 cases (44 recorded conversations, 14 with no recording) graded on the outcome
# (card kept, lines not lost, saves with macros, no false claims). ADAPTER=recorded grades
# what the live box served; no model call. Plan: .planning/precise-food-logger-plan.md
# `recorded` replays stored answers, so it says nothing about today's code and
# always exits 0. ADAPTER=live (below) is the run that measures today's code.
npx tsx scripts/food-box-eval/run.mts            # TAG=correction  ONLY=id  WRITE_BASELINE=1
# Thread usage per user, last 7 days (copy_lines, restore_card, index size): scripts/food-box-eval/thread-usage.sql
# Today's food box code on each case, with the case's saved meals, memory and
# diary. Reads the live catalog, writes nothing. Same CLI rule as above.
EVAL_VIA_CLI=1 ADAPTER=live npx tsx scripts/food-box-eval/run.mts   # EVAL_CONCURRENCY=6  DEBUG_STEPS=1
# FOOD_THREADS=on: the case's earlier cards go in an in-memory thread store, the
# agent gets restore_card. Its own BASELINE.md section (live_threads).
FOOD_THREADS=on EVAL_VIA_CLI=1 ADAPTER=live npx tsx scripts/food-box-eval/run.mts
# FOOD_FIRST_GATE=on (step 3): the first message asks Jev "fully plain log?"; plain -> parse,
# else the agent. Measured with FOOD_THREADS=on FOOD_AGENT_LATER=on (section live_first).
FOOD_THREADS=on FOOD_AGENT_LATER=on FOOD_FIRST_GATE=on EVAL_VIA_CLI=1 ADAPTER=live npx tsx scripts/food-box-eval/run.mts
# The gate's floor (PLAIN_LOG_FLOOR) alone, Jev only: every first-message case, then HELD_OUT=1.
npx tsx scripts/food-box-eval/gate-probe.mts
# FOOD_AGENT_LATER=on (step 2): every later message of a thread goes to the food
# agent, with one-line card edits. Its own BASELINE.md section (live_later), and
# the run prints cost and agent turns per message (CLI token counts).
FOOD_THREADS=on FOOD_AGENT_LATER=on EVAL_VIA_CLI=1 ADAPTER=live npx tsx scripts/food-box-eval/run.mts
# FOOD_BUILD_RECIPE=on (step 5): the agent gets build_recipe. Home-dish cases: TAG=recipe-build.
FOOD_BUILD_RECIPE=on FOOD_THREADS=on FOOD_AGENT_LATER=on FOOD_FIRST_GATE=on EVAL_VIA_CLI=1 ADAPTER=live npx tsx scripts/food-box-eval/run.mts
deno test --allow-all scripts/food-box-eval/grade.test.ts

# Edge function unit tests (the one real test suite).
deno test --allow-all supabase/functions/ai-coach/
deno test --allow-all supabase/functions/revenuecat-webhook/
deno test --allow-all supabase/functions/session-refresh/   # who may get a sign-in ticket
deno test --allow-all lib/sessionRefresh.test.ts             # silent re-sign-in: ticket, then sign-out, then sign-in
deno test --allow-all supabase/functions/_shared/   # TODAY pick rules, shared by app + daily-suggestion
deno test --allow-all supabase/functions/drona-cards/ # weekly phase metrics check, against a fake database
deno test --allow-all lib/xp.test.ts
deno test --allow-all lib/tiers.test.ts
deno test --unstable-sloppy-imports --import-map=lib/test-import-map.json lib/readiness.test.ts
deno test --allow-all lib/coachErrors.test.ts  # which bucket a failure lands in
deno test --allow-all lib/ssoOutcome.test.ts   # Google/Apple sign-in with no session: next step + user copy
deno test --allow-all --no-check --unstable-sloppy-imports --import-map=lib/directFetchRetry.test-import-map.json lib/directFetchRetry.test.ts  # Today pick + weekly card retry an expired token once
deno test --allow-all lib/authRetry.test.ts    # expired Clerk token: one retry with a fresh one
deno test --allow-all lib/purchaseErrors.test.ts # a pending store payment is not a failure; failures keep the store's reason
deno test --allow-all lib/coachBlocks.test.ts  # tables/charts/stats/progress in Drona's replies
deno test --allow-all lib/servingSize.test.ts # food editor portion <-> stored serving
deno test --allow-all lib/logDay.test.ts      # "2 eggs for tomorrow" -> which day a food log lands on
deno test --allow-all --unstable-sloppy-imports lib/phaseMetricHeadline.test.ts # one number per phase metric on every screen
deno test --allow-all lib/screenCache.test.ts  # Goal & Plan screens paint from cache; a pre-write read is never stored
deno test --allow-all lib/syncTick.test.ts     # screens re-read only when a sync flush lands; a local save merges with no read
deno test --allow-all lib/workoutWindows.test.ts # Analytics: the shared 90-day workouts read plus the older half
deno test --allow-all --unstable-sloppy-imports --import-map=lib/test-import-map.json lib/dashboardProgram.test.ts # dashboard TODAY pick + activity goals from the shared program read
deno test --allow-all lib/foodReads.test.ts     # meals with entries, saved meals with items: one read each; the day read fills its week
deno test --allow-all --unstable-sloppy-imports lib/profileReads.test.ts # one shared user_profiles / goal history / day-goal read; every write clears it
deno test --allow-all --unstable-sloppy-imports --import-map=lib/test-import-map.json lib/dashboardCards.test.ts # dashboard Drona cards + bell count from one read
deno test --allow-all lib/chartScale.test.ts   # Goal screen chart: readings width, goal ring at the program end
deno test --allow-all lib/phasePick.test.ts    # the active phase by seq, never by list index
deno test --allow-all lib/fitnessGoals.test.ts
deno test --allow-all --unstable-sloppy-imports lib/goalIntake.test.ts # new goal: the question screens, what Drona is sent, ask before build
deno test --allow-all lib/coachAffirm.test.ts  # a "yes, build it" turn forces the build; Build it shows only under a build question
deno test --allow-all lib/coachTopic.test.ts   # chats opened from the app: Drona's hidden topic turn + what is sent
deno test --allow-all --no-check --unstable-sloppy-imports --import-map=lib/coachConversations.test-import-map.json lib/coachConversations.test.ts  # saved chats: topic title, hidden turn kept
deno test --allow-all lib/missingColumn.test.ts # app-before-migration column fallbacks
deno test --allow-all --no-check --unstable-sloppy-imports lib/foodOrigin.test.ts # food line origins in the app; edit-sheet rule pinned to the SQL trigger
deno run --node-modules-dir=none --allow-read --allow-env --allow-net --allow-write --allow-sys supabase/tests/food_memory_local.ts # food memory triggers on PGlite (downloads it; not in CI)
deno test --allow-all --unstable-sloppy-imports lib/planExercise.test.ts # Drona plan exercise -> exercises + routine rows
deno test --allow-all --unstable-sloppy-imports lib/routineTargets.test.ts # "45s" / "5km" -> routine time + distance targets
deno test --allow-all lib/maintenance.test.ts   # the Nutrition screen's maintenance row and sheet
deno test --allow-all lib/foodPatterns.test.ts  # usual foods per meal, and when each meal is offered
deno test --allow-all --unstable-sloppy-imports lib/yourFoods.test.ts # manual search: foods you logged before come first
deno test --allow-all lib/mealCleanup.test.ts   # empty meal rows go in one safe database step
deno test --allow-all lib/mealCardSplit.test.ts # big food card: list vs note when the box is short
deno test --allow-all lib/mealReady.test.ts   # AI food log: open the result or toast when it lands; a waiting meal survives a restart; - / + amounts
deno test --allow-all lib/calorieBars.test.ts  # Analytics calorie bars: each day against its own goal ±10%
deno test --allow-all lib/pendingEntries.test.ts # an added suggestion or copy shows at once, swapped for the saved row
deno test --allow-all lib/pendingParse.test.ts  # food search "Log it with Drona": handed to Nutrition once, with its meal and day
deno test --allow-all lib/foodBarCard.test.ts   # food box: a save card sits beside the meal card, never replaces it
deno test --allow-all lib/foodCardBack.test.ts  # food card return arrow: back one message, the card before it, 10 steps kept
deno test --allow-all supabase/functions/ai-coach/foodFirstGate.test.ts # first message: plain -> parse, else the agent with the running parse
deno test --allow-all lib/foodThread.test.ts    # food box thread ids + card versions, counted the way the server counts
deno test --allow-all supabase/functions/ai-coach/foodThreads.test.ts # thread store: stable line ids, one conditional write, restore
deno test --allow-all supabase/functions/ai-coach/foodAgentLater.test.ts # step 2: later messages to the agent, one-line edits in a fixed order, no line lost
deno test --allow-all supabase/functions/ai-coach/recipe.test.ts # step 5: build_recipe, parts summed in code, an assumed oil asked about once (FOOD_BUILD_RECIPE)
deno test --allow-all --node-modules-dir=none supabase/migrations/checks/food_threads.check.ts # the food_threads migration on PGlite (real Postgres, downloads it; not in CI)
deno test --allow-all --node-modules-dir=none supabase/migrations/checks/food_card_lines_recipe.check.ts # food_card_lines.recipe: a dish keeps its parts in the thread store (PGlite; not in CI)
deno test --allow-all lib/reviewPrompt.test.ts # store rating ask: a PR kept in the saved workout, 3+ workouts over 3+ days, every 90 days at most
deno test --no-check --unstable-sloppy-imports lib/loggedEntryEdit.test.ts  # editing a logged food; empty meal cleanup on a move
deno test --allow-all lib/questionPin.test.ts  # Drona chat: a reply types in under its question at the top
deno test --allow-all lib/orbTheme.test.ts     # loading orb: which way a tinted orb fades
deno test --allow-all lib/coachSessions.test.ts # coach sheets kept while Drona works: when kept, brought back, dropped
deno test --allow-all --unstable-sloppy-imports --import-map=lib/coachConversations.test-import-map.json lib/readyInbox.test.ts # what waits behind the dashboard bell
deno test --allow-all lib/backgroundHolds.test.ts # iOS background time: shared task, a hung hold lets go by itself
deno test --allow-all lib/healthCardio.test.ts  # watch runs -> cardio workouts: cardio types only, long enough, never twice
deno test --allow-all --unstable-sloppy-imports lib/cardioLog.test.ts # dashboard cardio sheet: a logged session counts, queued ones count before sync
deno test --allow-all --no-check --unstable-sloppy-imports --import-map=lib/coachConversations.test-import-map.json lib/parseSpeed.test.ts # food log mode: Quick / Precise, a stored Thorough reads as Quick
deno test --allow-all lib/sheetText.test.ts     # text boxes in Portal sheets: late owner values never put old text back (Android letter drops)
deno test --allow-all lib/firstOpenUpdate.test.ts # fresh store install: newest update before onboarding, 5 s cap, never reloads an open app
deno test --allow-all lib/signupTour.test.ts    # the film tour after sign-up: its words, the tap rules, no promise the plan is done
deno test --allow-all lib/hardPaywall.test.ts   # hard paywall: accounts from HARD_PAYWALL_FROM on must pay; older ones keep free
deno test --allow-all --no-check lib/invite.test.ts   # referral link + share text, store discount code URLs, refusal words
deno test --allow-all --node-modules-dir=none supabase/migrations/checks/referral_codes.check.ts # referral + campaign codes on PGlite: both get a month, no cap, no own code, old-app rules kept (not in CI)
deno test --allow-all lib/weightWheel.test.ts    # onboarding weight wheels: whole + one decimal, the top of the scale, kg <-> lbs
deno test --allow-all supabase/functions/ai-coach/freeGoalBuild.test.ts # one free goal plan per account: 1 build, 8 edit turns, a guest build spends it
deno test --allow-all supabase/functions/ai-coach/regionRules.test.ts # FOOD_REGION_RULES: each region gets only its block, no rule lost, off = today
deno test --allow-all --node-modules-dir=none supabase/functions/mcp/ # ChatGPT/Claude connector: sign-in token, every query filtered to the user, read + food write tools
deno test --allow-all --node-modules-dir=none supabase/migrations/checks/mcp_food_writes.check.ts # connector food writes on PGlite: one meal per day, no double log, delete only connector lines (not in CI)
deno test --allow-all --node-modules-dir=none supabase/migrations/checks/connect_plan.check.ts # Connect plan on PGlite: Pro unchanged, Connect = free + connector, no in-app AI for new accounts (not in CI)
deno test --allow-all --node-modules-dir=none supabase/migrations/checks/mcp_workout_writes.check.ts # connector workout writes on PGlite: app volume, no XP for connector workouts, app-edit XP, delete only connector workouts (not in CI)
# App Store offer codes (key + pool in ~/.config/overload, never in the repo).
# FRIENDMONTH = 1 month free (monthly), the iPhone referral code. "Free year" =
# one-time codes; Apple makes 500+ per batch. The admin site Coupons page keeps
# them in the coupons table, gives one at a time, and makes 500 more per period.
npx tsx scripts/offer-codes/codes.mts list   # also: setup. Handing out codes: admin site -> Coupons (coupons table)
```

There are no configured lint or build scripts.

## Deploying Edge Functions

**Nothing deploys automatically. Merging is not consent to deploy.**

A PR touching `supabase/functions/**` deploys on merge only if it carries the
`deploy:yes` label. Labels are set on the PR page: right sidebar → Labels.

- `deploy:yes` → `deploy-functions.yml` deploys that PR's functions on merge
- `deploy:no` → explicitly recorded as "land it, deploy later"
- **no label → nothing deploys**, and the merge is not blocked

**If you are an agent, never add `deploy:yes` on your own.** It changes
production the moment the PR merges, so the choice is the user's — ask. Leaving
it off is always safe; the code lands and production is untouched, and it can be
deployed later with Actions → "Deploy Edge Functions" → Run workflow.

`.github/workflows/deploy-decision.yml` reports what a merge will do and fails
only on the two contradictions: both labels at once, and `deploy:yes` on a fork
PR (GitHub withholds secrets from fork runs, so that deploy could not run). Its
check is named **"Deploy decision"** — the job name, not the workflow name — if
you want it as a required status check.

A change under `_shared/` fans out to every function importing it, since nothing
rebuilds on its own. To deploy by hand at any time: Actions → "Deploy Edge
Functions" → Run workflow (name functions, or `all`). The deploy is gated on the
Deno suites above — they are the only test CI this repo has.

Deploying requires the `SUPABASE_ACCESS_TOKEN` repo secret; the project ref is
derived from the existing `SUPABASE_URL` secret.

`verify_jwt` lives in `supabase/config.toml`, not in the workflow, so it travels
with the code. **A new function needs a `[functions.<name>]` block there** — the
CLI default is `verify_jwt = true`, which makes the gateway reject Clerk JWTs
before the handler runs, so every call 401s.

Prefer this over deploying from a laptop. The deployed `ai-coach` silently drifted
two commits behind `main` that way, which meant an unrelated refactor shipped
alongside the next fix.

When reporting eval results, say which mode was used — a latency number must
never be quoted from a CLI run.

## Environment Setup

Copy `.env.local.example` to `.env.local` and fill in:
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk auth key
- `EXPO_PUBLIC_SUPABASE_URL` — Supabase project URL
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key

## Architecture

**Overload** is an Expo Router (file-based routing) fitness tracking app. Stack: React Native 0.79, Expo 53, Clerk auth, Supabase (PostgreSQL), Reanimated 3.

### Navigation Structure

```
app/
├── _layout.tsx          # Root: ClerkProvider + WorkoutProvider wrapping everything
├── index.tsx            # Redirect: signed-in → /(app), signed-out → /(auth)
├── (auth)/              # Sign-in screens, only accessible when signed out
├── (app)/               # Main tab group, protected by Clerk
│   ├── _layout.tsx      # Custom bottom tab bar + mini workout bar + start-workout modal
│   ├── index.tsx        # Dashboard
│   ├── routines.tsx     # Routine management
│   ├── history.tsx      # Workout history
│   ├── analytics.tsx    # Charts & stats
│   └── profile.tsx      # User profile
└── workout/[id].tsx     # Full-screen workout tracking modal
```

### State Management

Workout state is managed via a single React Context in `hooks/useWorkout.tsx`. It tracks the active workout (ID, routine name, exercises, elapsed time) and runs a `setInterval` timer while a workout is active. No Redux or Zustand — context only.

### Auth Flow

Clerk manages authentication. JWTs are cached in Expo SecureStore (native Keychain/Keystore) via a custom adapter in `lib/supabase.ts`. The root `_layout.tsx` uses `useAuth()` to redirect between `(auth)` and `(app)` groups.

### Database

Supabase (PostgreSQL) with 6 tables: `user_profiles`, `exercises`, `routines`, `routine_exercises`, `workouts`, `workout_sets`. Schema + 50+ seeded exercises in `supabase/schema.sql`. Users are linked via `clerk_user_id`.

### Design System

All design tokens live in `constants/theme.ts`: colors (lime green `#c8ff00` primary accent), spacing scale, font sizes, border radii, and shadow presets. The app has a dark and a light theme (`ThemeProvider` / `useTheme()` in `hooks/useTheme.tsx`), and it starts in dark. Read colors from the `C` object that `useTheme()` returns. Do not hard-code one theme's tokens: `Colors.light.muted`, for example, shows a light fill in the default dark UI. Use Feather icons (`@expo/vector-icons`). The app's icon scale is deliberately compact: inline/row icons match the surrounding text size (10–16px, e.g. 11px glyphs inside the 24x24 `rowIcon` tiles); reserve 24px+ for standalone icons such as tab bar items or empty states.

### XP/Leveling

`lib/xp.ts` implements a 50-level progression system (extended from 11 so every `TITLE_TIERS` title, up to Legend at level 50, is reachable). Levels 1-11 are frozen: the thresholds apply to a stored `user_profiles.xp`, so editing an early one re-levels every existing account. XP formula: `(sets × 2) + (volume / 100)`. Covered by `lib/xp.test.ts` (`deno test lib/xp.test.ts`).

### Path Aliases

`@/*` maps to the repo root (configured in `tsconfig.json`). Use `@/lib/...`, `@/constants/...`, etc. for imports.

### Key Conventions

- Animations use Reanimated 3 (`withSpring`, `withTiming`, `FadeIn`, `SlideInDown`). The Reanimated babel plugin is required and configured in `babel.config.js`.
- Typed routes are enabled (`experiments.typedRoutes: true` in `app.json`), so route strings are type-checked.
- `components/ui/` is intentionally empty — the UI kit has not been built out yet.
