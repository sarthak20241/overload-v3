# Codebase Concerns

**Analysis Date:** 2026-04-25

## Tech Debt

**Pervasive `as any` type casting:**
- Issue: Over 20 instances of `as any` and `as any[]` casting throughout screens, masking real data-shape mismatches between Supabase responses and typed interfaces.
- Files: `app/(app)/_layout.tsx` (lines 33, 42, 133), `app/(app)/index.tsx` (lines 180, 199, 200), `app/workout/[id].tsx` (line 484), `components/ai/AICoachModal.tsx` (lines 765, 766)
- Impact: TypeScript cannot catch data-structure bugs; Supabase join responses differ structurally from the typed models in `lib/types.ts` and the gap is papered over with casts rather than proper discriminated types.
- Fix approach: Define proper Supabase row types (or use generated types via `supabase gen types`) for query results that include joins, then remove casts.

**`Routine` type shape mismatch:**
- Issue: `lib/types.ts` defines `Routine.exercises: RoutineExercise[]` but Supabase queries select `routine_exercises(*, exercises(*))`, producing a different nested shape. Screens access `.routine_exercises` via `as any` casts to compensate.
- Files: `lib/types.ts` (lines 36–43), `app/(app)/_layout.tsx` (line 133), `app/(app)/routines.tsx` (local `RoutineRaw` interface duplicates the real shape)
- Impact: Two conflicting representations of the same entity; the canonical type (`Routine`) is effectively unused for Supabase data paths.
- Fix approach: Either update `Routine` in `lib/types.ts` to match the Supabase response shape (with `routine_exercises`) or introduce a separate `RoutineWithExercises` query type.

**Routine exercise insertion is sequential (N+1 pattern):**
- Issue: `RoutineEditorSheet.handleSave` inserts each exercise into `routine_exercises` in a `for` loop with individual `await supabase.from(...).insert(...)` calls, one per exercise.
- Files: `app/(app)/routines.tsx` (lines 652–665, 675–688)
- Impact: Saving a 5-exercise routine makes 10+ sequential Supabase round-trips. High latency on save, especially on mobile networks.
- Fix approach: Collect all exercise IDs (resolving with `findOrCreateExercise` in parallel via `Promise.all`), then batch-insert all `routine_exercises` rows in a single `.insert([...])` call.

**Stale `exercises` dependency in workout `useEffect`:**
- Issue: The dependency array for the routine-load `useEffect` in `app/workout/[id].tsx` is `[id]` only (line 189). The effect references `workout.exercises`, `workout.startWorkout`, etc. from the outer scope, creating potential stale-closure issues if those change between mounts.
- Files: `app/workout/[id].tsx` (lines 93–189)
- Impact: Low risk currently because the effect is not expected to re-fire, but it will produce ESLint exhaustive-deps warnings and can silently break if refactored.
- Fix approach: Add stable references to `workout` to the dependency array or extract the load logic to a `useCallback` with proper deps.

**AI Plan/Workout generation ignores real API response:**
- Issue: In `GeneratePlanScreen.handleGenerate` and `GenerateWorkoutScreen.handleGenerate`, the AI edge function is called (`callAICoach`) but the returned string is discarded. Hard-coded mock plans are shown instead.
- Files: `components/ai/AICoachModal.tsx` (lines 343, 546)
- Impact: The AI integration is a UI facade — the real model's output is never parsed or rendered, defeating the purpose. Users on a configured environment see mock data, not personalized AI output.
- Fix approach: Parse the returned JSON from `callAICoach` (the edge function already returns structured JSON when asked to generate), map it to `GeneratedWorkout[]`, and display the real result.

**Body stats stored only in AsyncStorage (not Supabase):**
- Issue: Weight log, body fat log, and measurements are persisted exclusively to device AsyncStorage in `lib/bodyStats.ts`. There is no cloud sync for this data.
- Files: `lib/bodyStats.ts`, `app/(app)/analytics.tsx`
- Impact: Data is silently lost on app reinstall, device migration, or clearing app storage. No multi-device access.
- Fix approach: Mirror body stat writes to a `body_stats` or similar Supabase table; AsyncStorage can serve as cache.

**Hardcoded exercise library in workout screen:**
- Issue: `app/workout/[id].tsx` defines a local `EXERCISE_LIBRARY` constant (19 exercises, lines 26–46) separate from the comprehensive library in `lib/exercises.ts` (50+ exercises). The routines editor uses `lib/exercises.ts` but the active workout's "Add Exercise" picker uses only the 19-item local constant.
- Files: `app/workout/[id].tsx` (lines 26–46), `lib/exercises.ts`
- Impact: Users cannot add most exercises during an active workout that they can add to a routine. Inconsistent exercise availability is confusing.
- Fix approach: Replace the local constant with an import from `lib/exercises.ts`.

**`useClerkUser` uses runtime `require()` to conditionally call hooks:**
- Issue: `hooks/useClerkUser.ts` gates a `require('@clerk/clerk-expo')` call inside the function body based on `hasClerkKey`. This pattern violates React's rules-of-hooks at the framework level (a hook that conditionally calls other hooks) and can behave unexpectedly across hot reloads or fast-refresh cycles.
- Files: `hooks/useClerkUser.ts` (lines 25–40)
- Impact: Fragile in development; not recommended by Clerk or React docs.
- Fix approach: Use two separate components — one that wraps `useUser`/`useAuth` behind a `ClerkProvider` check at the tree level — or always render `ClerkProvider` and use an empty `publishableKey` guard at the provider itself.

---

## Security Considerations

**AI Coach edge function has no authentication:**
- Risk: `supabase/functions/ai-coach/index.ts` accepts any `POST` request and calls the Anthropic API without validating a Supabase JWT or any auth header. Anyone who discovers the function URL can consume the `ANTHROPIC_API_KEY` quota arbitrarily.
- Files: `supabase/functions/ai-coach/index.ts` (line 30)
- Current mitigation: Supabase edge functions are rate-limited at the infrastructure level, but there is no per-user or per-session auth check in the function body.
- Recommendations: Verify `Authorization: Bearer <supabase-jwt>` header inside the function using the Supabase client and validate the user session before proxying to Anthropic.

**Supabase queries lack user-scoping guard when `clerkId` is undefined:**
- Risk: Workout queries on the dashboard use `.eq('user_id', clerkId)` only when `clerkId` is defined. If `clerkId` is `undefined` (user not yet loaded), the query fetches all workouts without a user filter.
- Files: `app/(app)/index.tsx` (lines 186–202)
- Current mitigation: Supabase RLS policies (if enabled) would block this at the database level. Whether RLS is enabled is not confirmed from the app code alone.
- Recommendations: Guard all user-scoped queries with `if (!clerkId) return;` before dispatching. Confirm RLS policies are enforced on all user-data tables.

**Supabase anon key relies entirely on RLS for data isolation:**
- Risk: `EXPO_PUBLIC_SUPABASE_ANON_KEY` is embedded in the JS bundle. Without confirmed RLS configuration, the anon key grants broad read/write access to all data.
- Files: `lib/supabase.ts` (line 4)
- Current mitigation: Anon key is the standard Supabase pattern; security depends entirely on RLS being configured.
- Recommendations: Audit all Supabase tables for RLS enablement; document this assumption explicitly.

---

## Performance Bottlenecks

**Dashboard fetches full workout set data (potentially thousands of rows):**
- Problem: The dashboard query selects `workouts.*, workout_sets(*, exercises(*))` filtered to 90 days. A user with frequent workouts and many sets per session could receive thousands of rows on every dashboard load.
- Files: `app/(app)/index.tsx` (lines 187–202)
- Cause: All statistics (streak, volume, muscle breakdown) are computed client-side from raw rows.
- Improvement path: Push stat aggregation to Supabase via materialized views or RPC functions; fetch only pre-computed stat rows on the dashboard.

**Routine exercises are inserted with N+1 sequential round-trips:**
- Problem: Each exercise triggers a sequential Supabase round-trip during routine save, awaited inside a `for` loop.
- Files: `app/(app)/routines.tsx` (lines 652–688)
- Cause: Awaiting each insert individually.
- Improvement path: Resolve all exercise IDs in parallel via `Promise.all`, then batch-insert all `routine_exercises` rows.

**Multiple concurrent `setInterval` timers in the workout screen:**
- Problem: Up to 3 simultaneous `setInterval` calls run during an active workout (global workout timer from `useWorkout`, exercise timer, rest timer), each ticking every 1000ms and calling `setState`.
- Files: `app/workout/[id].tsx` (lines 82–233), `hooks/useWorkout.tsx` (lines 86–95)
- Cause: Separate timer abstractions with no shared tick source.
- Improvement path: Consolidate all timers under a single 1-second tick emitted from `useWorkout`, deriving exercise and rest durations from timestamps rather than maintaining their own intervals.

---

## Fragile Areas

**`WorkoutContext` state lives only in memory:**
- Files: `hooks/useWorkout.tsx`
- Why fragile: Active workout state (exercises, elapsed time, set log) is held in React state with no persistence. If the app is force-quit mid-workout, all logged progress is lost permanently.
- Safe modification: Any change to the context state shape requires updating the default context value, all consumers, and verifying that `finishWorkout` properly clears all fields.
- Test coverage: None.

**Guest mode data is in-memory only:**
- Files: `lib/mockData.ts` (lines 261–316)
- Why fragile: `_guestRoutines` and `_guestWorkouts` are plain module-level arrays. They reset on app restart. Any module boundary change (e.g., tree-shaking) can reset them mid-session.
- Safe modification: Treat guest storage as ephemeral; do not add persistence logic to these arrays without migrating to AsyncStorage.
- Test coverage: None.

**Workout save silently drops sets with `temp-` IDs:**
- Files: `app/workout/[id].tsx` (lines 457–469)
- Why fragile: When `resolveExerciseRow` fails (network error), exercises receive a `temp-{timestamp}` ID. During `confirmFinish`, sets whose exercise ID starts with `temp-` are silently filtered out and not saved. The user sees a success state but those sets are permanently lost with no indication.
- Safe modification: Surface a warning to the user listing which exercises were not saved, rather than silently dropping them.
- Test coverage: None.

**`Redesign Gym Workout Tracker UI (3)/` directory is a committed prototype:**
- Files: `/Users/sarthakkumar/Coding/overload-v3/Redesign Gym Workout Tracker UI (3)/`
- Why fragile: This is a Figma design export / prototype (full React/Vite app with its own `supabase/functions/`, `node_modules`, and source code). It sits at the repo root and is not part of the Expo app. Its presence inflates repo size, can confuse tools that scan the codebase, and its `supabase/functions/server/` directory may conflict with the actual edge function definitions.
- Safe modification: Remove from the repository or add to `.gitignore`. Extract any useful design references to a `docs/` or `design/` directory without source code.

**`dist/` build artifacts are tracked in the repo:**
- Files: `/Users/sarthakkumar/Coding/overload-v3/dist/`
- Why fragile: Compiled Expo web build outputs live in the repo, bloating it and creating merge conflicts.
- Safe modification: Add `dist/` and `.expo/` to `.gitignore` and remove existing tracked artifacts via `git rm -r --cached dist/ .expo/`.

---

## Missing Critical Features

**No offline support for in-progress workouts:**
- Problem: If the app is force-quit during a workout, all logged sets vanish. There is no mechanism to persist in-progress workout state to AsyncStorage or elsewhere.
- Blocks: Reliable workout tracking for users with unreliable connectivity or who multitask during workouts.

**No pagination on history and analytics data:**
- Problem: `app/(app)/analytics.tsx` and `app/(app)/history.tsx` load all workout data at once. As a user's history grows, initial load time increases unboundedly.
- Blocks: Long-term usability for users with more than a few months of data.

**Routine editing does not restore existing exercises (guest mode):**
- Problem: `RoutineEditorSheet.loadExistingExercises` has an early return when `!isSupabaseConfigured` (line 562). In guest mode, editing a routine always presents an empty exercise list rather than the exercises from the in-memory `_guestRoutines` store.
- Files: `app/(app)/routines.tsx` (lines 561–585)
- Blocks: Users cannot edit routines they created in guest mode.

**Dark mode is defined but not user-toggleable:**
- Problem: `constants/theme.ts` defines `Colors.dark` and `useTheme` supports a `mode` prop, but the profile screen has no dark/light toggle. Currently light theme only is used.
- Blocks: Dark mode feature cannot be surfaced to users without adding a profile control and persisting the preference.

---

## Test Coverage Gaps

**No tests exist anywhere in the project:**
- What's not tested: All business logic — XP calculation (`lib/xp.ts`), workout save flow (`app/workout/[id].tsx`), routine creation (`app/(app)/routines.tsx`), context state management (`hooks/useWorkout.tsx`), mock data construction (`lib/mockData.ts`), body stats persistence (`lib/bodyStats.ts`).
- Files: Entire `app/`, `hooks/`, `lib/`, `components/` directories.
- Risk: Any regression in set logging, XP calculation, or Supabase write logic is invisible until a user encounters it. The silent set-drop bug (temp IDs) is a direct consequence of zero test coverage.
- Priority: High — the workout save flow and XP accumulation are core features with no safety net.

---

*Concerns audit: 2026-04-25*
