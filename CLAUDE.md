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

# Use the API key ONLY when the question is latency or token cost. The harness
# warns that CLI timings are not comparable — they measure the CLI, not the
# pipeline. Correctness and per-case pass/fail are identical either way.
ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/parse-meal-eval/run.ts

# Program coach fuel days: does Drona plan fuel days when the user names hard
# weekdays, and only then? Same CLI rule as above.
EVAL_VIA_CLI=1 npx tsx scripts/program-fuel-eval/run.mts

# Edge function unit tests (the one real test suite).
deno test --allow-all supabase/functions/ai-coach/
deno test --allow-all supabase/functions/revenuecat-webhook/
deno test --allow-all supabase/functions/_shared/   # TODAY pick rules, shared by app + daily-suggestion
deno test --allow-all lib/xp.test.ts
deno test --allow-all lib/tiers.test.ts
deno test --allow-all lib/coachErrors.test.ts  # which bucket a failure lands in
deno test --allow-all lib/servingSize.test.ts # food editor portion <-> stored serving
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
