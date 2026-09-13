/**
 * Product analytics (PostHog).
 *
 * One client, created once at import. Everything else in the app goes through
 * `track()` / `screen()` / `identifyUser()` so event names live in ONE place
 * and can't drift between screens.
 *
 * Why a module singleton and not just the React context: half the interesting
 * moments happen in plain functions (lib/dietData.ts, lib/workouts.ts, the
 * sync queue), not in components. `usePostHog()` can't reach those. The
 * provider in app/_layout.tsx is handed THIS client, so the hook and the
 * singleton are the same instance.
 *
 * No key configured (EXPO_PUBLIC_POSTHOG_KEY absent) = every call is a silent
 * no-op. Dev builds, CI and eval scripts therefore cost nothing and never
 * pollute the production project.
 *
 * Screen views are captured MANUALLY (components/AnalyticsBridge.tsx) because
 * expo-router does not expose a NavigationContainer for PostHog's autocapture
 * to hook into. `captureScreens` stays false in the provider.
 */
import PostHog from 'posthog-react-native';

const KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY ?? '';
const HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

/**
 * Session replay is ON here but the real switch is server-side: PostHog only
 * records when "Record user sessions" is enabled in project settings. That
 * means replay can be killed from the dashboard without shipping a build —
 * the reason it is safe to turn on for launch.
 */
export const posthog = KEY
  ? new PostHog(KEY, {
      host: HOST,
      // Application Installed / Updated / Opened / Became Active / Backgrounded.
      // These give us installs and opens for free, without an attribution SDK.
      captureAppLifecycleEvents: true,
      enableSessionReplay: true,
      sessionReplayConfig: {
        // A fitness log is not sensitive, but a sign-in field is. Mask inputs,
        // keep everything else legible so a replay is actually worth watching.
        maskAllTextInputs: true,
        maskAllImages: false,
        maskAllSandboxedViews: true,
        captureLog: true,
        captureNetworkTelemetry: true,
      },
      errorTracking: {
        autocapture: {
          uncaughtExceptions: true,
          unhandledRejections: true,
          nativeCrashes: true,
          console: ['error'],
        },
      },
      // A workout can run for an hour with the phone on airplane mode in a
      // gym basement. Keep the session id stable across a cold start so the
      // funnel doesn't split a single visit into two.
      enablePersistSessionIdAcrossRestart: true,
    })
  : null;

/**
 * Every event the app can send. Adding a name here is the only way to send it,
 * which keeps the PostHog project free of `workout_finished` vs
 * `workout_completed` duplicates.
 */
export type AnalyticsEvent =
  // ── Onboarding: the first funnel we care about ────────────────────────────
  | 'onboarding_started'
  | 'onboarding_step_viewed'
  | 'onboarding_step_completed'
  | 'onboarding_back'
  | 'onboarding_plan_generated'
  | 'onboarding_plan_failed'
  | 'onboarding_completed'
  // ── Auth ─────────────────────────────────────────────────────────────────
  | 'signup_started'
  | 'signed_up'
  | 'signed_in'
  | 'signed_out'
  | 'auth_failed'
  // ── Activation: the core loop ────────────────────────────────────────────
  | 'workout_started'
  | 'set_logged'
  | 'workout_completed'
  | 'workout_discarded'
  | 'routine_created'
  // ── Nutrition ────────────────────────────────────────────────────────────
  | 'meal_logged'
  | 'meal_parse_started'
  | 'meal_parse_failed'
  // ── Coach Drona ──────────────────────────────────────────────────────────
  | 'coach_opened'
  | 'coach_message_sent'
  | 'coach_response_received'
  | 'coach_failed'
  // ── Money ────────────────────────────────────────────────────────────────
  | 'limit_reached'
  | 'paywall_viewed'
  | 'paywall_dismissed'
  | 'purchase_started'
  | 'purchase_completed'
  | 'purchase_failed'
  | 'purchase_restored';

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

/** Drop undefined keys so PostHog property definitions stay clean. */
type CleanProps = Record<string, string | number | boolean | null>;

function clean(props?: AnalyticsProps): CleanProps | undefined {
  if (!props) return undefined;
  const out: CleanProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Send one product event. Safe to call anywhere, including before login. */
export function track(event: AnalyticsEvent, props?: AnalyticsProps): void {
  try {
    posthog?.capture(event, clean(props));
  } catch {
    // Analytics must never break a workout.
  }
}

/** Send a screen view. Called by AnalyticsBridge on every route change. */
export function screen(name: string, props?: AnalyticsProps): void {
  try {
    posthog?.screen(name, clean(props));
  } catch {}
}

/**
 * Tie the anonymous device to a real account. PostHog merges the pre-signup
 * events into the same person, so the onboarding funnel survives signup.
 */
export function identifyUser(userId: string, props?: AnalyticsProps): void {
  try {
    posthog?.identify(userId, clean(props));
  } catch {}
}

/** Update person properties without re-identifying (tier changes, level ups). */
export function setUserProps(props: AnalyticsProps): void {
  try {
    const cleaned = clean(props);
    if (cleaned) posthog?.capture('$set', { $set: cleaned });
  } catch {}
}

/** Sign-out: forget the person so the next user on this phone is separate. */
export function resetAnalytics(): void {
  try {
    posthog?.reset();
  } catch {}
}

/** Push buffered events now (before a screen that may kill the app). */
export function flushAnalytics(): void {
  try {
    void posthog?.flush();
  } catch {}
}

/** True when a real key is configured. Used by the provider to skip mounting. */
export const analyticsEnabled = !!posthog;
