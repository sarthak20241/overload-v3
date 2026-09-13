/**
 * Should the dashboard ask the user to build their Phase 1 split, and in which
 * words?
 *
 * Onboarding now hands out the PROGRAM (the phase-by-phase road) and stops
 * there. The week of concrete workouts is built afterwards, by Drona, from the
 * Goal screen, so it is written against a real user id. This module decides
 * when to say so.
 *
 * Two different asks, because two different things are missing:
 *   'build'  - signed in, program saved, phase 1 has no routines yet.
 *   'signin' - no account, so there is no program row at all. Their program is
 *              held in the pending blob and lands the moment they sign in.
 *
 * Pure on purpose: no imports, so `deno test` can reach it. Storage and
 * rendering live with the component.
 */

/** How long "Later" buys. Long enough not to nag, short enough to return. */
export const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

export type SplitPromptAction = 'build' | 'signin' | null;

export interface SplitPromptState {
  /** False while auth or the program query is still settling. */
  ready: boolean;
  /** They finished the intake. Nothing is asked of anyone who has not. */
  onboardingDone: boolean;
  /** A guest session, or signed out. Either way there is no account yet. */
  isGuest: boolean;
  /** An active program row exists for this account. */
  hasProgram: boolean;
  /**
   * Routines already linked to the current phase. NULL means not loaded yet,
   * which is not the same as zero: a prompt fired on "not loaded" would flash
   * on every cold start.
   */
  phaseRoutineCount: number | null;
  /** Epoch ms of the last "Later", or null. */
  dismissedAt: number | null;
  nowMs: number;
}

export function splitPromptFor(s: SplitPromptState): SplitPromptAction {
  if (!s.ready || !s.onboardingDone) return null;
  // A clock that went backwards (timezone edit, restored backup) would stamp
  // the snooze in the future and hold the prompt forever, so an elapsed time
  // below zero counts as expired rather than as "not yet".
  if (s.dismissedAt != null) {
    const elapsed = s.nowMs - s.dismissedAt;
    if (elapsed >= 0 && elapsed < SNOOZE_MS) return null;
  }
  if (s.isGuest) return 'signin';
  if (!s.hasProgram) return null;
  if (s.phaseRoutineCount == null) return null;
  return s.phaseRoutineCount === 0 ? 'build' : null;
}
