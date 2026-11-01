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
deno test --allow-all --no-check --unstable-sloppy-imports --import-map=lib/directFetchRetry.test-import-map.json lib/directFetchRetry.test.ts  # Today pick + weekly card retry an expired token once
deno test --allow-all lib/authRetry.test.ts    # expired Clerk token: one retry with a fresh one
deno test --allow-all lib/purchaseErrors.test.ts # a pending store payment is not a failure; failures keep the store's reason
deno test --allow-all lib/coachBlocks.test.ts  # tables/charts/stats/progress in Drona's replies
deno test --allow-all lib/servingSize.test.ts # food editor portion <-> stored serving
deno test --allow-all lib/logDay.test.ts      # "2 eggs for tomorrow" -> which day a food log lands on
deno test --allow-all --unstable-sloppy-imports lib/phaseMetricHeadline.test.ts # one number per phase metric on every screen
deno test --allow-all lib/screenCache.test.ts  # Goal & Plan screens paint from cache; a pre-write read is never stored
deno test --allow-all lib/chartScale.test.ts   # Goal screen chart: readings width, goal ring at the program end
deno test --allow-all lib/phasePick.test.ts    # the active phase by seq, never by list index
deno test --allow-all lib/fitnessGoals.test.ts
deno test --allow-all lib/coachTopic.test.ts   # chats opened from the app: Drona's hidden topic turn + what is sent
deno test --allow-all --no-check --unstable-sloppy-imports --import-map=lib/coachConversations.test-import-map.json lib/coachConversations.test.ts  # saved chats: topic title, hidden turn kept
deno test --allow-all lib/missingColumn.test.ts # app-before-migration column fallbacks
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
deno test --allow-all lib/reviewPrompt.test.ts # store rating ask: a PR kept in the saved workout, 3+ workouts over 3+ days, every 90 days at most
deno test --no-check --unstable-sloppy-imports lib/loggedEntryEdit.test.ts  # editing a logged food; empty meal cleanup on a move
deno test --allow-all lib/orbTheme.test.ts     # loading orb: which way a tinted orb fades
deno test --allow-all lib/coachSessions.test.ts # coach sheets kept while Drona works: when kept, brought back, dropped
deno test --allow-all --unstable-sloppy-imports --import-map=lib/coachConversations.test-import-map.json lib/readyInbox.test.ts # what waits behind the dashboard bell
deno test --allow-all lib/backgroundHolds.test.ts # iOS background time: shared task, a hung hold lets go by itself
deno test --allow-all lib/homeLogHint.test.ts  # home log button: the pill's words, and when it stops
deno test --allow-all lib/startGuide.test.ts   # Home's first-week path: what ticks a step, the hello, the all-done moment once
deno test --allow-all --unstable-sloppy-imports lib/startLessons.test.ts # first-week lessons: every step has one, copy fits its card, no em dashes
deno test --allow-all --no-check --unstable-sloppy-imports --import-map=lib/coachConversations.test-import-map.json lib/parseSpeed.test.ts # food log mode: Quick / Precise, a stored Thorough reads as Quick
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

All design tokens live in `constants/theme.ts`: colors (lime green `#c8ff00` primary accent), spacing scale, font sizes, border radii, and shadow presets. The app uses light theme only (`Colors.light`) — `Colors.dark` is defined but unused. Use Feather icons (`@expo/vector-icons`). The app's icon scale is deliberately compact: inline/row icons match the surrounding text size (10–16px, e.g. 11px glyphs inside the 24x24 `rowIcon` tiles); reserve 24px+ for standalone icons such as tab bar items or empty states.

### XP/Leveling

`lib/xp.ts` implements a 50-level progression system (extended from 11 so every `TITLE_TIERS` title, up to Legend at level 50, is reachable). Levels 1-11 are frozen: the thresholds apply to a stored `user_profiles.xp`, so editing an early one re-levels every existing account. XP formula: `(sets × 2) + (volume / 100)`. Covered by `lib/xp.test.ts` (`deno test lib/xp.test.ts`).

### Path Aliases

`@/*` maps to the repo root (configured in `tsconfig.json`). Use `@/lib/...`, `@/constants/...`, etc. for imports.

### Key Conventions

- Animations use Reanimated 3 (`withSpring`, `withTiming`, `FadeIn`, `SlideInDown`). The Reanimated babel plugin is required and configured in `babel.config.js`.
- Typed routes are enabled (`experiments.typedRoutes: true` in `app.json`), so route strings are type-checked.
- `components/ui/` is intentionally empty — the UI kit has not been built out yet.
