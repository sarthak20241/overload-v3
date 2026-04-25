# Testing Patterns

**Analysis Date:** 2026-04-25

## Test Framework

**Runner:** None — no test framework is installed or configured

**Assertion Library:** None

**Test Config:** Not present — no `jest.config.*`, `vitest.config.*`, or equivalent detected

**Run Commands:**
```bash
# No test scripts configured in package.json
# The "scripts" section contains only: start, android, ios, web
```

## Test File Organization

**Location:** No test files detected anywhere in the codebase

**Naming:** No `.test.ts`, `.test.tsx`, `.spec.ts`, or `.spec.tsx` files found

**Structure:** Not applicable

## Test Coverage

**Requirements:** None enforced — no coverage thresholds configured

**Coverage tooling:** Not present

## Test Types

**Unit Tests:** Not implemented

**Integration Tests:** Not implemented

**E2E Tests:** Not implemented

## What Exists Instead of Tests

The codebase substitutes automated testing with several manual-verification mechanisms:

**Guest/Mock Mode (`lib/mockData.ts`):**
- Comprehensive mock data layer used when Supabase is not configured
- `getMockWorkouts()`, `getAllRoutines()`, `getMockWeightLog()`, `mockProfile` provide realistic data
- Controlled via `isSupabaseConfigured` flag from `lib/supabase.ts`
- Allows the full UI to be exercised without any backend connection

**Pure Utility Functions (`lib/xp.ts`, `lib/exercises.ts`):**
- `getLevelInfo(totalXp)` and `getXpForWorkout(sets, volume)` in `lib/xp.ts` are pure functions with no side effects — high-value candidates for unit tests if testing is added
- `EXERCISE_LIBRARY` constant in `lib/exercises.ts` is static data — testable by snapshot

**Type Safety as Correctness Verification:**
- TypeScript strict mode (`"strict": true` in `tsconfig.json`) catches type-level errors at compile time
- All interfaces defined in `lib/types.ts` — `Workout`, `ActiveSet`, `Routine`, etc.
- `as const` used on literal types in `constants/theme.ts`

## Adding Tests — Recommended Approach

If tests are introduced, the following setup aligns with the Expo ecosystem:

**Recommended framework:**
```bash
npx expo install jest-expo @types/jest
npx expo install --dev @testing-library/react-native @testing-library/jest-native
```

**Recommended `jest.config.js`:**
```js
module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg)',
  ],
};
```

**Highest-value test targets (pure, no mocks needed):**
- `lib/xp.ts` — `getLevelInfo` and `getXpForWorkout` are pure functions
- `lib/bodyStats.ts` — AsyncStorage load/save functions (mock AsyncStorage)
- `constants/theme.ts` — token presence and value sanity checks

**Test file placement convention (if added):**
- Co-locate with source: `lib/xp.test.ts` beside `lib/xp.ts`
- Or in a top-level `__tests__/` directory matching the source tree

## Mocking

**Framework:** None currently installed

**What would need mocking if tests are added:**
- `expo-secure-store` — used in `lib/supabase.ts` and `app/_layout.tsx`
- `@react-native-async-storage/async-storage` — used in `lib/bodyStats.ts`
- `@supabase/supabase-js` — Supabase client in `lib/supabase.ts`
- `@clerk/clerk-expo` — auth hooks used throughout `(app)/` screens
- `expo-router` — `useRouter`, `useLocalSearchParams`, `usePathname`

**What does NOT need mocking:**
- `lib/xp.ts` — pure math functions, no I/O
- `lib/exercises.ts` — static data constants
- `lib/mockData.ts` — already the mock data source itself

## Fixtures and Test Data

**Current state:** `lib/mockData.ts` serves as the de facto fixture source

**Existing mock data includes:**
- 15 exercises across all muscle groups
- ~3 weeks of realistic workout history via `buildWorkouts()`
- Full `mockProfile` object matching the `UserProfile` interface
- Weight/body fat/measurement log mocks via `getMockWeightLog()`, `getMockBodyFatLog()`, `getMockMeasurements()`
- Previous performance data via `getPreviousPerformance(exerciseId)`

**Location:** `lib/mockData.ts`

---

*Testing analysis: 2026-04-25*
