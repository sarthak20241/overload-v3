# External Integrations

**Analysis Date:** 2026-04-25

## APIs & External Services

**AI / LLM:**
- Anthropic Claude API - AI fitness coach feature
  - SDK/Client: Direct `fetch` to `https://api.anthropic.com/v1/messages` (no SDK)
  - Model: `claude-sonnet-4-20250514`
  - Auth: `ANTHROPIC_API_KEY` (Supabase Edge Function secret — server-side only, never exposed to client)
  - Integration point: `supabase/functions/ai-coach/index.ts` (Deno Edge Function)
  - Client invocation: `supabase.functions.invoke('ai-coach', ...)` in `components/ai/AICoachModal.tsx`

**Authentication:**
- Clerk - User authentication and identity management
  - SDK: `@clerk/clerk-expo` 2.7.2
  - Auth: `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (public key, safe for client)
  - Integration points: `app/_layout.tsx` (ClerkProvider), `app/index.tsx` (redirect guard), `app/(auth)/index.tsx` (sign-in screen)
  - Token storage: Custom `tokenCache` adapter using `expo-secure-store` (native Keychain/Keystore)
  - JWT tokens from Clerk are passed to Supabase via the auth adapter in `lib/supabase.ts`

## Data Storage

**Databases:**
- Supabase (PostgreSQL) - Primary data store
  - Connection: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`
  - Client: `@supabase/supabase-js` 2.48.1, initialized in `lib/supabase.ts`
  - Auth storage adapter: `ExpoSecureStoreAdapter` (wraps `expo-secure-store`) — sessions persisted to device Keychain/Keystore
  - Auth settings: `autoRefreshToken: true`, `persistSession: true`, `detectSessionInUrl: false`
  - Configuration check: `isSupabaseConfigured` boolean exported from `lib/supabase.ts` — used throughout app to gracefully degrade when unconfigured

**Schema (6 tables in `supabase/schema.sql`):**
- `user_profiles` — user data linked via `clerk_user_id` (text FK, not UUID)
- `exercises` — exercise library (50+ seeded entries)
- `routines` — user-created workout routines
- `routine_exercises` — join table (routine ↔ exercise with sets/reps/rest config)
- `workouts` — completed workout sessions
- `workout_sets` — individual sets logged within a workout

**File Storage:**
- Not used — no Supabase Storage, S3, or local file storage integration detected

**Caching:**
- No dedicated cache layer (Redis, Memcached, etc.)
- Expo SecureStore used for auth session persistence only

## Authentication & Identity

**Auth Provider:**
- Clerk (primary auth)
  - Implementation: `ClerkProvider` at root (`app/_layout.tsx`); conditional render — if no publishable key is set, app runs without auth (guest/demo mode)
  - User identity linked to Supabase records via `clerk_user_id` text field on `user_profiles`

**Guest Mode:**
- App partially functional without Clerk configured — `hasClerkKey` checks gate auth-dependent UI
- Mock data layer: `lib/mockData.ts` provides offline/guest data; `addGuestRoutine` used in AI coach

## Monitoring & Observability

**Error Tracking:**
- Not detected — no Sentry, Datadog, Bugsnag, or similar SDK present

**Logs:**
- Console logging only (`console.error`, `console.log` in catch blocks)
- Edge Function errors returned as structured JSON responses

**Analytics:**
- Not detected — no Amplitude, Mixpanel, PostHog, or similar

## CI/CD & Deployment

**Hosting:**
- Mobile app: Expo managed workflow; production builds via EAS Build (not yet configured — no `eas.json`)
- Edge Functions: Supabase-hosted Deno runtime (deploy via Supabase CLI)

**CI Pipeline:**
- Not configured — no GitHub Actions, CircleCI, or similar detected

## Environment Configuration

**Required env vars (client — `.env.local`):**
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk auth publishable key
- `EXPO_PUBLIC_SUPABASE_URL` — Supabase project REST URL
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — Supabase anonymous API key

**Required env vars (server — Supabase dashboard secrets):**
- `ANTHROPIC_API_KEY` — Used by `supabase/functions/ai-coach/index.ts`

**Secrets location:**
- Client secrets: `.env.local` (not committed; template at `.env.local.example`)
- Server secrets: Supabase project dashboard → Edge Function secrets

## Webhooks & Callbacks

**Incoming:**
- None detected — no webhook endpoints in app code

**Outgoing:**
- Supabase Edge Function (`ai-coach`) makes outbound HTTP POST to `https://api.anthropic.com/v1/messages`

**Deep Links / OAuth Callbacks:**
- App scheme `overload` registered in `app.json`
- `expo-auth-session` and `expo-web-browser` handle OAuth redirect flows for Clerk social login
- `detectSessionInUrl: false` set on Supabase client (Clerk manages session, not URL-based OAuth)

---

*Integration audit: 2026-04-25*
