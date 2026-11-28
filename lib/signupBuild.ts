// Sign-up's phase 1 build: one way forward.
//
// Sign-up ends with Drona building phase 1 in the coach sheet. People used to
// tap Back on the built plan and land in the coach menu with nothing saved
// (seen in onboarding recordings, 2026-11-28). On the sign-up visit the sheet
// has no way into the menu:
//   - the built plan has one button forward, Continue, which saves it and
//     goes on to the paywall (there is no separate Save to skip)
//   - Back on the built plan opens Drona to change it; Back from that chat,
//     or from an exercise's swap list, returns to the plan
//   - while Drona builds, Back does nothing (the plan is on its way)
//   - with no plan (the build failed), Back closes the sheet and the user goes
//     on; the dashboard asks to build phase 1 again

export type SignupPlanBack = 'open_refine' | 'close_refine' | 'close_swap' | 'close_sheet' | 'stay';

export function signupPlanBack(s: { hasPlan: boolean; refineOpen: boolean; building: boolean; swapOpen?: boolean }): SignupPlanBack {
  if (s.building) return 'stay';
  // An exercise's swap list (lib/planSwap.ts): Back returns to the plan.
  if (s.swapOpen) return 'close_swap';
  if (s.hasPlan) return s.refineOpen ? 'close_refine' : 'open_refine';
  return 'close_sheet';
}

/** The Goal screen visit at the end of sign-up (its params, read once on arrival). */
export function isSignupBuildVisit(p: { then?: string; tour?: string }): boolean {
  return p.then === 'upgrade' || p.tour === '1';
}

// The build's state, for the film tour that plays on top of it (the tour says
// "Building your Phase 1 workouts", then that they are ready). The plan screen
// reports; the Goal screen listens and hands it to the tour. One build at a
// time, so one value.
export type SignupBuildState = 'building' | 'ready' | 'failed' | null;

let buildState: SignupBuildState = null;
const buildListeners = new Set<(s: SignupBuildState) => void>();

/** What the plan screen's flags mean for the tour. A plan on screen wins over an old error. */
export function signupBuildStateOf(s: { building: boolean; hasPlan: boolean; failed: boolean }): SignupBuildState {
  if (s.hasPlan) return 'ready';
  if (s.building) return 'building';
  return s.failed ? 'failed' : null;
}

export function reportSignupBuild(next: SignupBuildState): void {
  if (next === buildState) return;
  buildState = next;
  for (const l of [...buildListeners]) l(next);
}

/** Calls back with the state now (when there is one) and on every change. */
export function onSignupBuild(listener: (s: SignupBuildState) => void): () => void {
  buildListeners.add(listener);
  if (buildState !== null) listener(buildState);
  return () => { buildListeners.delete(listener); };
}
