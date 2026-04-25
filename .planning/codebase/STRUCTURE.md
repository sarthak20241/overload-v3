# Codebase Structure

**Analysis Date:** 2026-04-25

## Directory Layout

```
overload-v3/
├── app/                          # All screens — Expo Router file-based routes
│   ├── _layout.tsx               # Root layout: providers + Stack navigator
│   ├── index.tsx                 # Auth gate: redirects to (app) or (auth)
│   ├── (app)/                    # Protected tab group
│   │   ├── _layout.tsx           # Tab shell + BottomNav + StartWorkoutModal
│   │   ├── index.tsx             # Dashboard screen
│   │   ├── routines.tsx          # Routine list + create/edit
│   │   ├── history.tsx           # Workout history list
│   │   ├── analytics.tsx         # Charts & stats
│   │   └── profile.tsx           # User profile + body stats
│   ├── (auth)/
│   │   └── index.tsx             # Sign-in / register / forgot-password screen
│   └── workout/
│       └── [id].tsx              # Full-screen active workout (id = routine id or "new")
├── components/
│   ├── ai/
│   │   └── AICoachModal.tsx      # Full-screen AI coach chat/plan modal
│   ├── routines/
│   │   └── ExercisePickerSheet.tsx  # Bottom-sheet exercise picker for routine builder
│   └── ui/
│       ├── BottomNav.tsx         # Persistent tab bar + floating mini workout bar
│       ├── ThemedAlert.tsx       # Themed replacement for Alert.alert()
│       ├── MiniAreaChart.tsx     # Inline sparkline area chart
│       └── MiniDonutChart.tsx    # Inline donut chart for muscle breakdown
├── constants/
│   └── theme.ts                  # All design tokens: Colors, Spacing, Radius, FontSize, FontWeight, Shadow
├── hooks/
│   ├── useWorkout.tsx            # WorkoutContext: active workout state + timer
│   └── useTheme.tsx              # ThemeContext: dark/light mode + C color-map
├── lib/
│   ├── supabase.ts               # Supabase client + SecureStore adapter + isSupabaseConfigured
│   ├── types.ts                  # All shared TypeScript interfaces
│   ├── mockData.ts               # Guest-mode fixture data (mirrors Supabase schema)
│   ├── exercises.ts              # Canonical EXERCISE_LIBRARY, MUSCLE_GROUPS, CATEGORIES
│   ├── xp.ts                     # XP formula + level calculation
│   └── bodyStats.ts              # AsyncStorage helpers for local body measurements
├── supabase/
│   ├── schema.sql                # Full DB schema + 50+ seeded exercises
│   └── functions/
│       └── ai-coach/
│           └── index.ts          # Deno Edge Function: proxies to Anthropic Claude API
├── assets/                       # Static images and icons
├── dist/                         # Expo build output (generated, not committed manually)
├── app.json                      # Expo project config (typedRoutes enabled)
├── babel.config.js               # Babel config (Reanimated plugin required)
├── tsconfig.json                 # TypeScript config (@/* alias → repo root)
├── package.json                  # Dependencies
└── CLAUDE.md                     # Project instructions for AI agents
```

## Directory Purposes

**`app/`:**
- Purpose: Every file here is a route. Expo Router converts the file tree to navigation
- Contains: Screen components (`.tsx`), layout wrappers (`_layout.tsx`)
- Key files: `_layout.tsx` (root shell), `index.tsx` (auth gate), `(app)/_layout.tsx` (tab shell)

**`app/(app)/`:**
- Purpose: The main authenticated section of the app, rendered as a tab group
- Contains: Five tab screens (dashboard, routines, history, analytics, profile)
- Key files: `index.tsx` (dashboard), `routines.tsx`, `history.tsx`, `analytics.tsx`, `profile.tsx`

**`app/(auth)/`:**
- Purpose: Authentication screens only accessible before sign-in
- Contains: Single screen handling login, register, and forgot-password modes
- Key files: `index.tsx`

**`app/workout/`:**
- Purpose: Full-screen workout tracking, overlaid on top of the tab navigator
- Contains: Dynamic route `[id].tsx`; `id` is a routine UUID or the string `"new"`
- Key files: `[id].tsx`

**`components/ui/`:**
- Purpose: Presentational primitives shared across multiple screens
- Contains: `BottomNav`, `ThemedAlert`, `MiniAreaChart`, `MiniDonutChart`
- Note: This directory was marked "intentionally empty" in earlier plans; it now contains active components

**`components/ai/`:**
- Purpose: AI coach feature components
- Contains: `AICoachModal.tsx` — full-screen modal with chat, plan, and quick-workout tabs

**`components/routines/`:**
- Purpose: Components specific to the routines feature
- Contains: `ExercisePickerSheet.tsx` — bottom-sheet for picking exercises during routine creation

**`constants/`:**
- Purpose: Single source of truth for all visual design tokens
- Contains: `theme.ts` only
- Key exports: `Colors` (dark/light), `Spacing`, `Radius`, `FontSize`, `FontWeight`, `Shadow`

**`hooks/`:**
- Purpose: React Context providers and hooks for global shared state
- Contains: `useWorkout.tsx`, `useTheme.tsx`
- Pattern: Each file exports both a `*Provider` component and a `use*` hook

**`lib/`:**
- Purpose: Non-UI shared logic — Supabase client, types, business rules, static data
- Contains: `supabase.ts`, `types.ts`, `mockData.ts`, `exercises.ts`, `xp.ts`, `bodyStats.ts`

**`supabase/`:**
- Purpose: Database schema and server-side functions
- Contains: `schema.sql` (DDL + seed data), `functions/ai-coach/index.ts` (Edge Function)

## Key File Locations

**Entry Points:**
- `app/_layout.tsx`: App bootstrap — mounts all providers and the root navigator
- `app/index.tsx`: Auth redirect gate
- `app/(app)/_layout.tsx`: Tab shell with persistent bottom nav and workout modal

**Configuration:**
- `app.json`: Expo project config; `experiments.typedRoutes: true` enables typed route strings
- `babel.config.js`: Must include Reanimated babel plugin (`react-native-reanimated/plugin`)
- `tsconfig.json`: Path alias `@/*` maps to repo root
- `.env.local`: Runtime secrets (copy from `.env.local.example`)

**Core Logic:**
- `lib/supabase.ts`: Database client; check `isSupabaseConfigured` before every Supabase call
- `lib/types.ts`: Source of truth for all data shapes — read this before writing any data-fetching code
- `lib/mockData.ts`: Guest-mode data; must stay structurally consistent with `lib/types.ts`
- `lib/exercises.ts`: Single source for the exercise library — do not duplicate inline exercise arrays
- `hooks/useWorkout.tsx`: Active workout context — call `startWorkout`, `updateExercises`, `finishWorkout` only from `app/workout/[id].tsx`
- `constants/theme.ts`: All colors and spacing — always import from here, never hardcode values

**Testing:**
- No test files present; no test framework configured

## Naming Conventions

**Files:**
- Screen files: `camelCase.tsx` matching the route segment (e.g., `routines.tsx`, `history.tsx`)
- Dynamic routes: `[paramName].tsx` (e.g., `[id].tsx`)
- Layout files: `_layout.tsx` (underscore prefix is Expo Router convention)
- Hooks: `use<Name>.tsx` in `hooks/` (e.g., `useWorkout.tsx`)
- Library files: `camelCase.ts` in `lib/` (e.g., `mockData.ts`, `bodyStats.ts`)
- Components: `PascalCase.tsx` (e.g., `BottomNav.tsx`, `ThemedAlert.tsx`)
- Constants: `camelCase.ts` (e.g., `theme.ts`)

**Directories:**
- Route groups use parentheses: `(app)`, `(auth)` — invisible in the URL path
- Component sub-directories use lowercase: `ui`, `ai`, `routines`

**Exports:**
- Default export for screens and layouts (required by Expo Router)
- Named exports for Context providers, hooks, types, and constants

## Where to Add New Code

**New Tab Screen:**
- Implementation: Create `app/(app)/<name>.tsx` with a default export
- Register: Add `<Tabs.Screen name="<name>" />` in `app/(app)/_layout.tsx`
- Nav button: Add entry in `components/ui/BottomNav.tsx`

**New Modal/Sheet:**
- Stateless sheet: Add to `components/ui/` if reusable, or inline in the calling screen
- Feature-specific: Add to `components/<feature>/`

**New Shared Business Logic:**
- Pure functions / constants: Add to the appropriate file in `lib/` or create `lib/<name>.ts`
- New type/interface: Add to `lib/types.ts`

**New Exercise Data:**
- Add to `EXERCISE_LIBRARY` array in `lib/exercises.ts` — this is the single authoritative list

**New Design Token:**
- Add to `constants/theme.ts` in both `dark` and `light` objects (keep them in sync)

**New Global State:**
- Add a new Context + Provider + hook to `hooks/` following the pattern in `useWorkout.tsx` or `useTheme.tsx`
- Mount the Provider in `app/_layout.tsx`

**New Supabase Table:**
- Add DDL to `supabase/schema.sql`
- Add corresponding TypeScript interface to `lib/types.ts`
- Add corresponding mock data shape to `lib/mockData.ts`

**New Edge Function:**
- Create `supabase/functions/<name>/index.ts` following the Deno pattern in `supabase/functions/ai-coach/index.ts`

## Special Directories

**`dist/`:**
- Purpose: Expo web/native build artifacts
- Generated: Yes (by `npx expo export`)
- Committed: No (listed in `.gitignore`)

**`.expo/`:**
- Purpose: Expo CLI cache and type generation
- Generated: Yes
- Committed: No

**`Redesign Gym Workout Tracker UI (3)/`:**
- Purpose: Figma-exported design reference files (static design assets and UI sketches)
- Generated: No (manually placed)
- Committed: Yes (serves as visual spec)

**`.planning/`:**
- Purpose: GSD planning documents (codebase maps, phases, milestones)
- Generated: Yes (by GSD tooling)
- Committed: Yes

---

*Structure analysis: 2026-04-25*
