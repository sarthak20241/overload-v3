// The paywall after sign-up's phase 1 build.
//
// Sign-up ends on the Goal screen, which builds phase 1's workouts. The
// paywall follows, and the PostHog flag `post-build-paywall` picks when:
//   after_save  the moment the build sheet closes (the old behaviour)
//   first_tap   the user sees their Goal screen; the first tap on it (back,
//               a pillar, the phase card, Adjust with Drona, the menu) opens
//               the paywall instead of what it would have opened
// A missing or unknown flag value is first_tap. Both sign-up doors (onboarding
// first, or sign in first) build the Goal screen params here, so neither can
// drop the paywall again (2026-11-20: the sign-in-first door had no then=upgrade).

export type PostBuildPaywallTiming = 'after_save' | 'first_tap';

export const POST_BUILD_PAYWALL_FLAG = 'post-build-paywall';
export const DEFAULT_POST_BUILD_PAYWALL: PostBuildPaywallTiming = 'first_tap';

export function timingFromFlag(variant: string | null | undefined): PostBuildPaywallTiming {
  return variant === 'after_save' || variant === 'first_tap' ? variant : DEFAULT_POST_BUILD_PAYWALL;
}

/** The Goal screen params at the end of sign-up. Only the phone apps sell. */
export function signupGoalPlanParams(os: string): Record<string, string> {
  return {
    build: 'phase',
    auto: '1',
    // The film tour plays on top while phase 1 builds.
    tour: '1',
    ...(os === 'ios' || os === 'android' ? { then: 'upgrade' } : {}),
  };
}

export type PostBuildPaywallStep = 'open' | 'arm' | 'allow';

/**
 * What the Goal screen does on sign-up's visit. `build_closed` is the build
 * sheet closing; `tap` is any tap that leaves or changes the screen. `armed`
 * means the build closed under first_tap; `deciding` means the build closed
 * and the flag is still loading (either timing ends in a paywall, so a tap
 * then opens it); `fired` means the paywall already opened once.
 */
export function postBuildPaywallStep(s: {
  timing: PostBuildPaywallTiming;
  event: 'build_closed' | 'tap';
  armed: boolean;
  fired: boolean;
  deciding?: boolean;
}): PostBuildPaywallStep {
  if (s.fired) return 'allow';
  if (s.event === 'build_closed') return s.timing === 'after_save' ? 'open' : 'arm';
  return s.armed || s.deciding ? 'open' : 'allow';
}
