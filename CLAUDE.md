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
```

There are no configured lint, test, or build scripts.

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

All design tokens live in `constants/theme.ts`: colors (lime green `#c8ff00` primary accent), spacing scale, font sizes, border radii, and shadow presets. The app uses light theme only (`Colors.light`) — `Colors.dark` is defined but unused. Use Feather icons (`@expo/vector-icons`) at 24px standard size.

### XP/Leveling

`lib/xp.ts` implements an 11-level progression system. XP formula: `(sets × 2) + (volume / 100)`. Used in the dashboard to render a level progress bar.

### Path Aliases

`@/*` maps to the repo root (configured in `tsconfig.json`). Use `@/lib/...`, `@/constants/...`, etc. for imports.

### Key Conventions

- Animations use Reanimated 3 (`withSpring`, `withTiming`, `FadeIn`, `SlideInDown`). The Reanimated babel plugin is required and configured in `babel.config.js`.
- Typed routes are enabled (`experiments.typedRoutes: true` in `app.json`), so route strings are type-checked.
- `components/ui/` is intentionally empty — the UI kit has not been built out yet.
