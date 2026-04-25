# Architecture

**Analysis Date:** 2026-04-25

## Pattern Overview

**Overall:** File-based routing SPA with shared React Context for cross-screen state

**Key Characteristics:**
- Expo Router drives all navigation — routes are files, not registered components
- A single `WorkoutContext` (`hooks/useWorkout.tsx`) owns active workout state across the entire app, including the floating mini-bar and the full-screen workout screen
- A second `ThemeContext` (`hooks/useTheme.tsx`) owns dark/light mode toggling and exposes a `C` color-map to every component
- Supabase (PostgreSQL) is the production data store; a built-in mock-data fallback (`lib/mockData.ts`) is activated whenever `isSupabaseConfigured === false`, enabling guest mode
- No Redux or Zustand — all shared state is React Context

## Layers

**Navigation / Shell:**
- Purpose: Wraps all screens in providers and defines the route tree
- Location: `app/_layout.tsx`, `app/index.tsx`, `app/(app)/_layout.tsx`, `app/(auth)/_layout.tsx`
- Contains: ClerkProvider, ThemeProvider, WorkoutProvider, Expo Router `<Stack>` / `<Tabs>`
- Depends on: `hooks/useWorkout.tsx`, `hooks/useTheme.tsx`, `lib/supabase.ts`
- Used by: Every screen in the app

**Screen Layer:**
- Purpose: Full-page views mounted by the router
- Location: `app/(app)/index.tsx`, `app/(app)/routines.tsx`, `app/(app)/history.tsx`, `app/(app)/analytics.tsx`, `app/(app)/profile.tsx`, `app/(auth)/index.tsx`, `app/workout/[id].tsx`
- Contains: Data fetching (Supabase or mock), local UI state, business logic, layout composition
- Depends on: `lib/supabase.ts`, `lib/mockData.ts`, `lib/types.ts`, `hooks/useWorkout.tsx`, `hooks/useTheme.tsx`, `constants/theme.ts`, `components/**`
- Used by: Expo Router

**Shared State (Context) Layer:**
- Purpose: Cross-screen state that must survive navigation
- Location: `hooks/useWorkout.tsx` (active workout timer + exercises), `hooks/useTheme.tsx` (dark/light mode)
- Contains: React Context + Provider components, exported `use*` hooks
- Depends on: `lib/types.ts`, `constants/theme.ts`
- Used by: Screens, `app/_layout.tsx`, `components/ui/BottomNav.tsx`

**Data / Library Layer:**
- Purpose: Supabase client, shared types, business logic, static data
- Location: `lib/`
- Contains:
  - `lib/supabase.ts` — Supabase client with SecureStore adapter; exports `isSupabaseConfigured` flag
  - `lib/types.ts` — All TypeScript interfaces (`UserProfile`, `Routine`, `Workout`, `WorkoutSet`, `ActiveWorkoutExercise`, etc.)
  - `lib/mockData.ts` — Guest-mode fixtures; mirrors the Supabase schema shape
  - `lib/exercises.ts` — Canonical `EXERCISE_LIBRARY` array and `MUSCLE_GROUPS` / `CATEGORIES` constants
  - `lib/xp.ts` — XP / level calculation (`getXpForWorkout`, `getLevelInfo`)
  - `lib/bodyStats.ts` — AsyncStorage helpers for local body measurement tracking
- Depends on: `@supabase/supabase-js`, `expo-secure-store`, `@react-native-async-storage/async-storage`
- Used by: Screens, `app/(app)/_layout.tsx`

**Design System Layer:**
- Purpose: All visual tokens in one place; no per-file theme constants
- Location: `constants/theme.ts`
- Contains: `Colors` (dark + light palettes, accent, stat, routine), `Spacing`, `Radius`, `FontSize`, `FontWeight`, `Shadow`
- Depends on: Nothing
- Used by: Every screen and component via `import { Colors, Spacing, ... } from '@/constants/theme'`

**Component Layer:**
- Purpose: Reusable UI primitives and domain-specific widgets
- Location: `components/`
- Contains:
  - `components/ui/BottomNav.tsx` — Persistent tab bar + floating mini workout bar
  - `components/ui/ThemedAlert.tsx` — Themed replacement for `Alert.alert`
  - `components/ui/MiniAreaChart.tsx` — Inline sparkline chart
  - `components/ui/MiniDonutChart.tsx` — Inline donut chart
  - `components/ai/AICoachModal.tsx` — Full-screen AI coach modal
  - `components/routines/ExercisePickerSheet.tsx` — Bottom-sheet exercise picker
- Depends on: `hooks/useTheme.tsx`, `hooks/useWorkout.tsx`, `constants/theme.ts`
- Used by: Screens

**Backend (Edge Function) Layer:**
- Purpose: Serverless AI endpoint deployed to Supabase Edge Functions
- Location: `supabase/functions/ai-coach/index.ts`
- Contains: Deno server that proxies chat messages to the Anthropic Claude API; returns plain text or structured JSON workout definitions
- Depends on: Anthropic API (`ANTHROPIC_API_KEY` env var)
- Used by: `components/ai/AICoachModal.tsx` via HTTP fetch

## Data Flow

**Standard Screen Data Load:**

1. Screen mounts; checks `isSupabaseConfigured`
2. If configured: calls `supabase.from('table').select(...)` (async, with `await` or `.then`)
3. If not configured: reads from `lib/mockData.ts` synchronously
4. Sets local `useState` with results; renders list or empty state

**Starting a Workout:**

1. User taps "Start Workout" in `BottomNav` → `(app)/_layout.tsx` opens `StartWorkoutModal`
2. Modal fetches routines (Supabase or mock); user picks one
3. `router.push('/workout/<id>')` navigates to `app/workout/[id].tsx`
4. `[id].tsx` loads the routine, builds `ActiveWorkoutExercise[]`, calls `workout.startWorkout(id, name, exercises)` on `WorkoutContext`
5. Timer starts in `WorkoutContext` via `setInterval`; `BottomNav` reads context and shows mini-bar

**Finishing a Workout:**

1. User taps "Finish" in `app/workout/[id].tsx`
2. Screen inserts row into `workouts` table, then batch-inserts into `workout_sets`
3. Calls `workout.finishWorkout()` which clears context state and stops timer
4. `router.replace('/(app)/history')` navigates away

**Auth Flow:**

1. `app/index.tsx` reads `useAuth()` from Clerk
2. `isSignedIn` → redirect to `/(app)`; else → redirect to `/(auth)`
3. `(auth)/index.tsx` handles email/password and Google OAuth via Clerk SDK
4. Clerk JWTs are persisted in native Keychain/Keystore via `expo-secure-store` adapter in `lib/supabase.ts`

**State Management:**

- Active workout: `WorkoutContext` (`hooks/useWorkout.tsx`) — persists across tab navigations
- Theme: `ThemeContext` (`hooks/useTheme.tsx`) — in-memory only (resets on app restart)
- Body stats / measurements: `AsyncStorage` via `lib/bodyStats.ts` — local device only
- All other data: fetched on mount from Supabase or mock; not globally cached

## Key Abstractions

**WorkoutContext:**
- Purpose: Tracks the live workout (exercises, elapsed time, pause state) across screens
- Examples: `hooks/useWorkout.tsx`
- Pattern: React Context + Provider wrapping the entire app in `app/_layout.tsx`; consumed via `useWorkout()` hook

**ThemeContext:**
- Purpose: Provides a `C` color-map object to every component so no screen hard-codes colors
- Examples: `hooks/useTheme.tsx`
- Pattern: Same Provider/hook pattern; `C` is `Colors.dark` or `Colors.light` based on `mode`

**isSupabaseConfigured flag:**
- Purpose: Enables guest mode without conditionals scattered across screens
- Examples: `lib/supabase.ts` (exported), used in every screen and in `app/(app)/_layout.tsx`
- Pattern: Boolean derived from env vars at module init; screens branch on it before every data call

**ActiveWorkoutExercise:**
- Purpose: Runtime exercise state during a workout (sets logged, previous performance, timers)
- Examples: `lib/types.ts`
- Pattern: Extends the static `RoutineExercise` DB type with `ActiveSet[]`, `previousSets`, and timer metadata; stored in `WorkoutContext`

## Entry Points

**App Bootstrap:**
- Location: `app/_layout.tsx`
- Triggers: Expo Router on first launch
- Responsibilities: Mounts `ClerkProvider` (if key present), `GestureHandlerRootView`, `SafeAreaProvider`, `ThemeProvider`, `WorkoutProvider`, then the root `<Stack>`

**Auth Gate:**
- Location: `app/index.tsx`
- Triggers: Expo Router on `"/"` route
- Responsibilities: Reads Clerk auth state; issues `<Redirect>` to `/(app)` or `/(auth)`

**Tab Shell:**
- Location: `app/(app)/_layout.tsx`
- Triggers: Navigation to any `/(app)/*` route
- Responsibilities: Renders `<Tabs>` (hidden native tab bar), persistent `<BottomNav>`, and `StartWorkoutModal`

**Workout Screen:**
- Location: `app/workout/[id].tsx`
- Triggers: `router.push('/workout/<id>')` or `router.push('/workout/new')`
- Responsibilities: Loads routine from Supabase or mock, initializes `WorkoutContext`, tracks per-exercise timers, saves completed workout to Supabase

## Error Handling

**Strategy:** Inline `try/catch` with local `useState` error strings shown as `ThemedAlert` dialogs. No global error boundary.

**Patterns:**
- Supabase errors are caught in `try/catch` blocks; a `showErrorAlert` state string triggers `<ThemedAlert>` with the message
- Mock data fallback is silent — `isSupabaseConfigured` prevents real calls rather than catching failures
- Auth errors from Clerk surface as `err.errors?.[0]?.longMessage || err.message` displayed in an inline error box
- Timer refs are cleaned up in `useEffect` return functions to prevent memory leaks

## Cross-Cutting Concerns

**Logging:** `console.error` / `console.warn` only; no structured logging library.

**Validation:** Ad-hoc inline checks (e.g., `if (!name.trim())`, `if (password.length < 6)`) inside submit handlers; no schema validation library.

**Authentication:** Clerk handles sessions; `useAuth()` hook gates the `/(app)` route group. Supabase client uses the Clerk JWT (via SecureStore adapter) for Row Level Security.

---

*Architecture analysis: 2026-04-25*
