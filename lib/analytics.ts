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
        // Despite the name, `true` masks ALL text on React Native, not just
        // inputs, which turned every replay into grey boxes. A fitness log is
        // not sensitive, so text stays legible; the places that show an email,
        // a name or a sign-in code wrap themselves in <PostHogMaskView>
        // (the sign-in card, the profile email).
        maskAllTextInputs: false,
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
  | 'onboarding_skipped'
  | 'onboarding_plan_generated'
  | 'onboarding_plan_failed'
  | 'onboarding_completed'
  | 'onboarding_pending_drained'
  // ── Auth ─────────────────────────────────────────────────────────────────
  | 'signup_started'
  | 'signed_up'
  | 'signed_in'
  | 'signed_out'
  | 'auth_failed'
  | 'account_deleted'
  | 'guest_mode_entered'
  | 'guest_converted'
  // ── Activation: the core loop ────────────────────────────────────────────
  | 'start_workout_modal_opened'
  | 'workout_start_selected'
  | 'workout_started'
  | 'workout_restored'
  | 'workout_resume_prompted'
  | 'exercise_started'
  | 'set_logged'
  | 'set_deleted'
  | 'set_type_changed'
  | 'rest_started'
  | 'rest_skipped'
  | 'exercise_finished'
  | 'exercise_added'
  | 'exercise_removed'
  | 'exercise_selected'
  | 'custom_exercise_created'
  | 'exercise_note_saved'
  | 'superset_created'
  | 'superset_broken'
  | 'workout_paused'
  | 'workout_resumed'
  | 'workout_minimized'
  | 'workout_reopened'
  | 'workout_finish_opened'
  | 'workout_completed'
  | 'workout_discarded'
  | 'workout_share_opened'
  | 'workout_edited'
  | 'workout_edit_failed'
  | 'workout_preference_changed'
  | 'music_app_opened'
  | 'routine_created'
  | 'routine_save_failed'
  | 'routine_deleted'
  | 'routine_sync_answered'
  | 'today_suggestion_tapped'
  | 'history_workout_edit_opened'
  | 'history_workout_deleted'
  | 'share_started'
  | 'share_completed'
  | 'share_failed'
  | 'import_file_picked'
  | 'import_file_rejected'
  | 'import_started'
  | 'import_completed'
  | 'import_failed'
  // ── Body, health, readiness ──────────────────────────────────────────────
  | 'weight_logged'
  | 'body_fat_logged'
  | 'measurements_logged'
  | 'sleep_logged'
  | 'health_connect_result'
  | 'health_sync_run'
  | 'health_sync_failed'
  | 'readiness_card_tapped'
  // ── Nutrition ────────────────────────────────────────────────────────────
  | 'meal_logged'
  | 'meal_undone'
  | 'meal_parse_started'
  | 'meal_parse_failed'
  | 'meal_auto_log_skipped'
  | 'parse_proposal_accepted'
  | 'parse_proposal_edited'
  | 'parse_proposal_rejected'
  | 'parse_tier_changed'
  | 'auto_log_toggled'
  | 'food_searched'
  | 'food_picked'
  | 'ask_drona_tapped'
  | 'ask_drona_result'
  | 'saved_meal_saved'
  | 'saved_meal_deleted'
  | 'meal_entry_updated'
  | 'meal_entry_deleted'
  | 'nutrition_targets_edited'
  | 'nutrition_day_changed'
  // ── Coach Drona ──────────────────────────────────────────────────────────
  | 'coach_opened'
  | 'coach_closed'
  | 'coach_gate_viewed'
  | 'coach_menu_option_selected'
  | 'coach_message_sent'
  | 'coach_response_received'
  | 'coach_failed'
  | 'coach_new_chat_started'
  | 'coach_citation_tapped'
  | 'coach_workout_edit_proposed'
  | 'coach_workout_edit_applied'
  | 'coach_targets_applied'
  | 'coach_targets_dismissed'
  | 'coach_routines_saved'
  | 'coach_program_applied'
  | 'insight_tapped'
  | 'insight_dismissed'
  // ── Programs (Drona-managed goal plans) ──────────────────────────────────
  | 'program_viewed'
  | 'program_phase_expanded'
  | 'program_split_build_started'
  | 'program_phase_advanced'
  | 'program_completed'
  | 'program_ended'
  // ── Profile & settings ───────────────────────────────────────────────────
  | 'theme_changed'
  | 'units_changed'
  | 'profile_field_changed'
  | 'notification_permission_result'
  | 'offline_banner_shown'
  // ── Money ────────────────────────────────────────────────────────────────
  | 'limit_reached'
  | 'upgrade_prompt_tapped'
  | 'milestone_upsell_shown'
  | 'milestone_upsell_snoozed'
  | 'paywall_viewed'
  | 'paywall_dismissed'
  | 'paywall_step_advanced'
  | 'paywall_plan_selected'
  | 'paywall_plans_expanded'
  | 'paywall_skipped'
  | 'paywall_success_cta'
  | 'purchase_started'
  | 'purchase_completed'
  | 'purchase_failed'
  | 'purchase_restore_started'
  | 'purchase_restored'
  | 'purchase_restore_failed'
  | 'trial_started'
  | 'trial_reminder_scheduled'
  | 'subscription_changed'
  | 'plan_detail_viewed'
  | 'plan_detail_bounced'
  | 'manage_subscription_opened';

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

/**
 * Push buffered events now. Await it before a sign-out or account delete:
 * the bridge resets the person the moment the session drops, so anything
 * still in the queue after that would land on a stranger. Best effort;
 * resolves either way.
 */
export async function flushAnalytics(): Promise<void> {
  try {
    await posthog?.flush();
  } catch {}
}

/**
 * Report a caught error to PostHog error tracking. For the catch blocks that
 * already emit a `*_failed` product event: the event says it broke, this says
 * why, with a stack. Never throws.
 */
export function trackError(error: unknown, context?: AnalyticsProps): void {
  try {
    posthog?.captureException(error instanceof Error ? error : new Error(String(error)), clean(context));
  } catch {}
}

/**
 * Super properties ride on EVERY event from now on (until unregistered).
 * Used for the one or two facts every question gets sliced by that are not
 * person properties: is this a guest session.
 */
export function registerSuperProps(props: AnalyticsProps): void {
  try {
    const cleaned = clean(props);
    if (cleaned) void posthog?.register(cleaned);
  } catch {}
}

/**
 * `workout_started` fires inside the WorkoutProvider, which cannot see which
 * surface pushed the workout route. The surface stamps its name here right
 * before `router.push('/workout/...')`, and the provider consumes it once.
 * A stale stamp (push that never mounted) is dropped after 30s.
 */
let pendingWorkoutSource: { source: string; at: number } | null = null;

export function markWorkoutSource(source: string): void {
  pendingWorkoutSource = { source, at: Date.now() };
}

export function consumeWorkoutSource(): string {
  const p = pendingWorkoutSource;
  pendingWorkoutSource = null;
  if (!p || Date.now() - p.at > 30_000) return 'unknown';
  return p.source;
}

/** True when a real key is configured. Used by the provider to skip mounting. */
export const analyticsEnabled = !!posthog;
