// Which server path builds the onboarding program for a signed-in user.
//
// A signed-in user who onboards (re-onboarding, or signed in before the
// intake) used to get only the authenticated coach path, which forces the
// generate_program tool. Since the free tier (migration 0088) that tool is
// Pro-only, so every free user on this path got 402 pro_required and quietly
// fell back to the deterministic program: 3 of 3 such new users, 2026-11-02
// to 11-04. The guest path (mode 'onboarding_plan', device rate-limited)
// builds the same program for anyone, so a 402 now goes there instead.
//
// No imports on purpose: lib/onboardingPlanRoute.test.ts runs it under Deno.

/** Thrown by the authenticated request so a caller can read the status. */
export class OnboardingHttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
    this.name = 'OnboardingHttpError';
  }
}

export type OnboardingPlanVia = 'authed' | 'guest_after_402';

/**
 * Runs `authed`; on a 402 (the Pro gate) runs `guest` instead. Any other
 * failure is thrown as before, so the caller still falls back to the
 * deterministic program.
 */
export async function requestOnboardingProgramSignedIn<T>(
  authed: () => Promise<T>,
  guest: () => Promise<T>,
): Promise<{ program: T; via: OnboardingPlanVia }> {
  try {
    return { program: await authed(), via: 'authed' };
  } catch (e) {
    if (e instanceof OnboardingHttpError && e.status === 402) {
      return { program: await guest(), via: 'guest_after_402' };
    }
    throw e;
  }
}
