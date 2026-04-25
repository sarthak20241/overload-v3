# Technology Stack

**Analysis Date:** 2026-04-25

## Languages

**Primary:**
- TypeScript 5.3.3 - All application code (`app/`, `lib/`, `components/`, `hooks/`, `constants/`)

**Secondary:**
- TypeScript/Deno - Supabase Edge Functions (`supabase/functions/ai-coach/index.ts`)
- SQL - Database schema and seed data (`supabase/schema.sql`)

## Runtime

**Environment:**
- Node.js 24.4.0 (development tooling)
- Deno - Supabase Edge Function runtime (`supabase/functions/`)
- React Native 0.81.5 - iOS and Android native runtime

**Package Manager:**
- npm 11.4.2
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Expo 54.0.0 - React Native toolchain, build system, and native module management
- Expo Router 6.0.23 - File-based routing for React Native (maps `app/` directory to navigation)
- React 19.1.0 - UI rendering
- React Native 0.81.5 - Cross-platform mobile primitives

**Animation:**
- React Native Reanimated 4.1.1 - Declarative animations (`withSpring`, `withTiming`, `FadeIn`, `SlideInDown`)
- React Native Gesture Handler 2.28.0 - Native gesture recognition; `GestureHandlerRootView` wraps entire app in `app/_layout.tsx`
- React Native Worklets 0.5.1 - JS worklet support required by Reanimated 4

**Charts / Graphics:**
- React Native SVG 15.12.1 - Custom SVG chart rendering (used in `components/ui/MiniAreaChart.tsx`, `components/ui/MiniDonutChart.tsx`)
- Victory Native 41.16.0 - Declared as dependency but not actively imported in current app screens

**Navigation:**
- React Native Screens 4.16.2 - Native screen container optimization
- React Native Safe Area Context 5.6.2 - Safe area insets

**Build/Dev:**
- babel-preset-expo - Expo-tuned Babel preset (`babel.config.js`)
- `react-native-reanimated/plugin` - Required Babel plugin for Reanimated worklets (`babel.config.js`)
- TypeScript strict mode enabled (`tsconfig.json`)

## Key Dependencies

**Critical:**
- `@clerk/clerk-expo` 2.7.2 - Authentication provider; wraps entire app; token cached via SecureStore
- `@supabase/supabase-js` 2.48.1 - Database client (PostgreSQL via Supabase REST/realtime)
- `expo-secure-store` 15.0.8 - Native Keychain/Keystore used as Supabase auth storage adapter and Clerk token cache
- `expo-router` 6.0.23 - File-based navigation; typed routes enabled

**Infrastructure:**
- `@react-native-async-storage/async-storage` 2.2.0 - Local key-value storage (Expo-managed version)
- `expo-linear-gradient` 15.0.8 - Gradient UI elements
- `@expo/vector-icons` 15.0.2 - Icon set; Feather icons used exclusively at 24px standard size
- `expo-auth-session` 7.0.10 - OAuth session management for Clerk social login flows
- `expo-web-browser` 15.0.10 - In-app browser for OAuth redirects

## Configuration

**Environment:**
- Variables loaded via Expo's `EXPO_PUBLIC_` prefix convention (available at runtime in RN)
- Template: `.env.local.example` at project root
- Active config expected at `.env.local` (not committed)
- Required vars:
  - `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`
  - `EXPO_PUBLIC_SUPABASE_URL`
  - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- Supabase Edge Function requires `ANTHROPIC_API_KEY` set in Supabase dashboard (server-side only)

**Build:**
- `app.json` - Expo app configuration (name, bundle IDs, plugins, orientation, scheme)
- `babel.config.js` - Babel with expo preset and Reanimated plugin
- `tsconfig.json` - Extends `expo/tsconfig.base`; strict mode; `@/*` path alias maps to repo root
- `expo-env.d.ts` - Expo-generated environment type declarations

**App identifiers:**
- iOS bundle ID: `com.overload.tracker`
- Android package: `com.overload.tracker`
- Deep link scheme: `overload`
- Orientation: portrait only
- Interface style: light (forced)

## Platform Requirements

**Development:**
- Node.js 24+ (detected)
- npm 11+
- Expo CLI (`npx expo start`)
- iOS: Xcode + Simulator or physical device
- Android: Android Studio + Emulator or physical device
- Supabase project with schema applied from `supabase/schema.sql`

**Production:**
- Deployment target: iOS App Store and Google Play via EAS Build (Expo Application Services)
- No EAS config (`eas.json`) currently committed — standard Expo managed workflow
- Supabase Edge Functions deployed to Supabase project hosting (Deno runtime)

---

*Stack analysis: 2026-04-25*
