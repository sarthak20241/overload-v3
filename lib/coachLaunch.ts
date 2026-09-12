/**
 * One-shot "open Coach Drona when the dashboard shows up" hand-off.
 *
 * The coach sheet lives in local state on the dashboard, so a screen that is
 * about to navigate there (the /upgrade success screen: "Ask Drona to plan my
 * week") cannot open it directly. It leaves a request here; the dashboard
 * consumes it the next time it gains focus.
 *
 * Requests expire after a short window so a request that never found the
 * dashboard (the user landed somewhere else and wandered back minutes later)
 * doesn't pop the coach open out of nowhere.
 */
// Mirrors AICoachModal's `initialScreen` union (not exported from there).
export type CoachScreen = 'menu' | 'chat' | 'plan' | 'workout';

export interface CoachLaunchRequest {
  screen: CoachScreen;
  /** Auto-sent as the first message when provided. */
  prompt?: string;
}

const TTL_MS = 15_000;

let pending: (CoachLaunchRequest & { at: number }) | null = null;

export function requestCoachOpen(req: CoachLaunchRequest): void {
  pending = { ...req, at: Date.now() };
}

/** Returns the pending request (and clears it), or null if none / expired. */
export function consumeCoachOpen(): CoachLaunchRequest | null {
  const req = pending;
  pending = null;
  if (!req) return null;
  if (Date.now() - req.at > TTL_MS) return null;
  const { at: _at, ...rest } = req;
  return rest;
}
