# Coding Conventions

**Analysis Date:** 2026-04-25

## Naming Patterns

**Files:**
- Screen files: `kebab-case` or flat name matching the route — `analytics.tsx`, `[id].tsx`
- Component files: `PascalCase` — `BottomNav.tsx`, `ThemedAlert.tsx`, `MiniAreaChart.tsx`
- Hook files: `camelCase` prefixed with `use` — `useWorkout.tsx`, `useTheme.tsx`
- Library files: `camelCase` — `bodyStats.ts`, `mockData.ts`, `supabase.ts`, `xp.ts`
- Constant files: `camelCase` — `theme.ts`

**Functions and Components:**
- React components: `PascalCase` — `StatCard`, `WeeklyCalendar`, `NavButton`, `PulsingDot`
- Hooks: `camelCase` prefixed with `use` — `useWorkout`, `useTheme`
- Plain utility functions: `camelCase` — `getLevelInfo`, `getXpForWorkout`, `formatDuration`, `formatDate`
- Event handlers: `camelCase` verb phrases — `startWorkout`, `finishWorkout`, `togglePause`, `startRoutine`, `startBlank`
- Async data loaders: `camelCase` verb+noun — `loadWeightLog`, `saveWeightLog`, `loadBodyFatLog`

**Variables:**
- State variables: `camelCase` noun/noun phrase — `isActive`, `isPaused`, `routineName`, `elapsed`
- Refs: `camelCase` suffixed with `Ref` — `timerRef`, `startTimeRef`, `pausedElapsedRef`, `exerciseTimerRef`
- Constants (file-level): `SCREAMING_SNAKE_CASE` — `ROUTINE_COLORS`, `AMBER`, `WEIGHT_KEY`, `EXERCISE_LIBRARY`
- Destructured theme colors: single letter `C` convention — `const { C } = useTheme()`

**Types and Interfaces:**
- Interfaces: `PascalCase` prefixed with descriptive noun — `WorkoutContextType`, `AlertButton`, `AlertStat`, `ThemedAlertProps`
- Type aliases: `PascalCase` — `ThemeMode`, `Mode`, `Gender`, `WeightUnit`
- Exported interfaces in `lib/types.ts`: plain `PascalCase` without suffix — `Workout`, `Exercise`, `Routine`, `ActiveSet`

## Code Style

**Formatting:**
- No Prettier or ESLint config files present — formatting is enforced by TypeScript strict mode only
- Consistent use of 2-space indentation throughout
- Single quotes for strings
- Trailing commas in multi-line objects and arrays
- Semicolons used throughout

**TypeScript:**
- Strict mode enabled via `tsconfig.json` (`"strict": true`, extends `expo/tsconfig.base`)
- Explicit return type annotations on exported utility functions — `getLevelInfo`, `getXpForWorkout`
- `as const` used for readonly literal types — `FontWeight.regular: '400' as const`
- Typed generics on state — `useState<Routine[]>`, `useState<string | null>`
- `type` imports for type-only usage — `import type { ActiveWorkoutExercise } from '@/lib/types'`
- `any` used in a few places as escape hatch, particularly with Supabase responses — `data as any[]`

**Linting:**
- No ESLint config detected — no enforced rule set beyond TypeScript compiler checks

## Import Organization

**Order (observed pattern):**
1. React and React Native built-ins — `import { useState, useEffect } from 'react'`
2. React Native core components — `import { View, Text, ... } from 'react-native'`
3. Expo and navigation packages — `import { LinearGradient } from 'expo-linear-gradient'`, `import { useRouter } from 'expo-router'`
4. Third-party UI/animation — `import Animated, { FadeInDown } from 'react-native-reanimated'`, `import { Feather } from '@expo/vector-icons'`
5. Internal constants — `import { Colors, Spacing, ... } from '@/constants/theme'`
6. Internal hooks — `import { useTheme } from '@/hooks/useTheme'`
7. Internal lib/services — `import { supabase } from '@/lib/supabase'`
8. Internal components — `import { MiniAreaChart } from '@/components/ui/MiniAreaChart'`
9. Type imports — `import type { Workout } from '@/lib/types'`

**Path Aliases:**
- `@/*` maps to the repo root — use `@/lib/...`, `@/constants/...`, `@/hooks/...`, `@/components/...`
- Never use relative paths for cross-directory imports

## Error Handling

**Patterns:**
- Async Supabase calls use either `.then().catch()` chaining or `try/catch` with empty catch bodies — `} catch {}`
- Empty catch blocks used frequently for silent failure on async storage reads — `lib/bodyStats.ts` lines 45, 58, 86
- Network errors in screens fall back to mock data via `isSupabaseConfigured` flag — `import { isSupabaseConfigured } from '@/lib/supabase'`
- Loading states managed with boolean `loading` state variable, reset in `.catch(() => setLoading(false))`
- User-visible errors shown via `ThemedAlert` component, not `Alert.alert` — `components/ui/ThemedAlert.tsx`
- Error messages stored in state strings — `const [showErrorAlert, setShowErrorAlert] = useState('')`
- Auth errors typed with `catch (err: any)` then accessed via `err.message`

**Guest/Offline Mode:**
- `isSupabaseConfigured` boolean exported from `lib/supabase.ts` gates all live data calls
- When false, functions from `lib/mockData.ts` are called as fallback — `getAllRoutines()`, `getMockWorkouts()`, `findMockRoutine()`

## Logging

**Framework:** None — no logging library used
**Console usage:** No `console.log`, `console.error`, or `console.warn` calls detected in the app source
**Errors:** Silently swallowed in most catch blocks or surfaced via UI alerts

## Comments

**When to Comment:**
- File-level JSDoc blocks for modules with non-obvious purpose — `lib/mockData.ts`, `lib/exercises.ts`, `components/ui/ThemedAlert.tsx`
- Inline comments used to mark design system provenance — `// Exact colors from Figma Make design system`
- Section dividers used in large files — `// ─── Progress bar ─────────────────────────────────`
- Commented-out imports left in place — `// import { useUser, useAuth } from '@clerk/clerk-expo';` in `app/(app)/profile.tsx`

**JSDoc/TSDoc:**
- JSDoc used sparingly — only on exported public-facing utility functions and component interfaces
- `ThemedAlert.tsx` has detailed usage example in the file-level JSDoc block

## Function Design

**Size:** Screen-level files are large (200–600+ lines). Sub-components are extracted inline within the same file rather than split into separate files.

**Parameters:**
- Functional components accept typed props inline — `{ visible, onClose }: { visible: boolean; onClose: () => void }`
- Hooks expose an object of values — `useWorkout()` returns `WorkoutContextType`
- Named parameters preferred over positional for components with 3+ props

**Return Values:**
- Components always return JSX — no `null` returns observed in components
- Utility functions return typed values — `{ level: number; xpInLevel: number; xpNeeded: number }`
- Async storage functions return the data or a safe default (`[]` or `{}`) on failure

## Module Design

**Exports:**
- Screens use `export default` — all files under `app/` use default exports (Expo Router requirement)
- Context providers use named exports — `export function WorkoutProvider`, `export function useWorkout`
- Library utilities use named exports — `export function getLevelInfo`, `export const supabase`
- Design tokens use named exports — `export const Colors`, `export const Spacing`

**Barrel Files:**
- Not used — no `index.ts` barrel files detected; imports always reference the exact file path

## Animation Conventions

- All animations use Reanimated 3 — `withSpring`, `withTiming`, `withRepeat`, `withSequence`, `withDelay`
- Entry/exit animations use layout animation presets — `FadeInDown`, `SlideInDown`, `SlideOutDown`, `FadeIn`, `FadeOut`
- Easing always specified explicitly on modal animations — `Easing.out(Easing.cubic)`
- `useSharedValue` + `useAnimatedStyle` pattern for imperative progress bar animations
- Animated views always wrapped in `Animated.View` with entering/exiting props

## Theme Convention

- Theme colors always accessed via `const { C } = useTheme()` in component body
- Global accent color `Colors.primary` (`#c8ff00`) accessed directly when not theme-dependent
- All spacing, radius, and font size values must come from theme tokens — `Spacing.xl`, `Radius.md`, `FontSize.base`, `FontWeight.semibold`
- Inline style overrides always use `{ color: C.foreground }` spread pattern — never hardcoded hex in component JSX except for semantic colors (`Colors.danger`, `Colors.success`)
- `StyleSheet.create` used for all static styles; dynamic theme overrides passed as array — `style={[styles.card, { backgroundColor: C.card }]}`

---

*Convention analysis: 2026-04-25*
