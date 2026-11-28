/**
 * Phase 1's workouts built BEFORE sign-up, then handed to the new account.
 *
 * The PostHog flag `phase1-build-timing` picks when sign-up's phase 1 build
 * starts:
 *   at_signup      (default, as before) the Goal screen builds it after the
 *                  account exists, under the film tour
 *   before_signup  onboarding asks for it the moment the program comes back
 *                  (ai-coach mode onboarding_phase1, no account needed), so it
 *                  is usually ready by the time the person has signed up
 * The server can turn the early route off on its own (ANON_PHASE_BUILD=off);
 * the build then fails fast and the Goal screen builds as before.
 *
 * Hand-off rules (tested): one build per app run, a newer onboarding replaces
 * it, the Goal screen takes it once, waits for it while it runs (never starts
 * a second build beside it), and gives up after a wait so the normal build
 * can run. Held in memory only: an app restart between onboarding and
 * sign-up loses it, and the Goal screen builds as before.
 *
 * Pure on purpose (no imports), so `deno test lib/phasePrebuild.test.ts`
 * reaches it. The request itself is passed in (lib/onboardingDrona.ts).
 */

export type Phase1BuildTiming = 'at_signup' | 'before_signup';

export const PHASE1_BUILD_TIMING_FLAG = 'phase1-build-timing';
export const DEFAULT_PHASE1_BUILD_TIMING: Phase1BuildTiming = 'at_signup';

export function phase1TimingFromFlag(variant: string | null | undefined): Phase1BuildTiming {
  return variant === 'before_signup' || variant === 'at_signup' ? variant : DEFAULT_PHASE1_BUILD_TIMING;
}

/** Phase 1's block as the early route reads it (anonOnboarding.sanitizeAnonPhase). */
export interface PrebuildPhase {
  name: string;
  split_type: string | null;
  days_per_week: number | null;
  emphasis: string | null;
  week_pattern: string[] | null;
  training_directive: string | null;
}

export function phaseBlockForPrebuild(ph: {
  name?: string | null;
  training_directive?: string | null;
  training_block?: {
    split_type?: string | null;
    days_per_week?: number | null;
    emphasis?: string | null;
    week_pattern?: string[] | null;
  } | null;
}): PrebuildPhase | null {
  const name = ph.name?.trim();
  if (!name) return null;
  const b = ph.training_block ?? null;
  return {
    name,
    split_type: b?.split_type ?? null,
    days_per_week: b?.days_per_week ?? null,
    emphasis: b?.emphasis ?? null,
    week_pattern: b?.week_pattern ?? null,
    training_directive: ph.training_directive ?? null,
  };
}

// One build at a time. `run` is bumped by every start, so a build that a newer
// one replaced (or that was given up on) can never land.
let run = 0;
let pending: Promise<unknown | null> | null = null;
let ready: unknown | null = null;
// The phase it was built for: only that phase may take it, so another account
// signing up in the same app run, or a redone onboarding, never gets it.
let builtFor = '';

const phaseKey = (name: string) => name.trim().toLowerCase();

/** Starts the early build for phase 1 called `phaseName`. A newer call replaces an older one. */
export function startPhasePrebuild<P>(request: () => Promise<P | null>, phaseName: string): void {
  const mine = ++run;
  ready = null;
  builtFor = phaseKey(phaseName);
  // The plan itself (null on any failure); the state update rides beside it.
  const plan = request().then((p) => p ?? null, () => null);
  pending = plan;
  void plan.then((p) => {
    if (mine !== run) return;
    ready = p;
    pending = null;
  });
}

/** True while there is a build to hand over (running or done). */
export function hasPhasePrebuild(): boolean {
  return pending !== null || ready !== null;
}

/**
 * The early build's plan, once: waits up to `waitMs` while it runs. Null when
 * there is none, it failed, or the wait ran out (then it is dropped, so it can
 * never land beside the build that runs instead).
 */
export async function takePhasePrebuild<P>(waitMs: number, phaseName: string): Promise<P | null> {
  const mine = run;
  // Built for another phase: drop it, so it can never land on this account.
  if (phaseKey(phaseName) !== builtFor) {
    clearPhasePrebuild();
    return null;
  }
  if (ready !== null) {
    const plan = ready as P;
    ready = null;
    run++;
    return plan;
  }
  // Held here: the build's own state update clears `pending` when it lands.
  const running = pending;
  if (!running) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), waitMs); });
  const plan = (await Promise.race([running, timeout])) as P | null;
  clearTimeout(timer);
  // Another caller took it while this one waited: handed over once only.
  if (mine !== run) return null;
  // Taken or given up on: either way it is used up.
  run++;
  pending = null;
  ready = null;
  return plan;
}

/** Drops any build: a new onboarding starts clean, even before it has its own. */
export function clearPhasePrebuild(): void {
  run++;
  pending = null;
  ready = null;
  builtFor = '';
}

export function resetPhasePrebuildForTest(): void {
  clearPhasePrebuild();
}
