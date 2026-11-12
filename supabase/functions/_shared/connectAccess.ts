// Overload Connect has no in-app AI (no Drona chat, no AI food log, no plan
// build, no form check). get_coach_access_status() says so with `ai_blocked`
// (migration 20261112150000): a Connect account made under the hard paywall
// that is not Pro. Older accounts keep the free meter they signed up with.
//
// One helper, so every edge function refuses the same way and the app shows
// the same thing: `pro_required` opens the paywall on the Drona side
// (lib/coachErrors.ts treats pro_required as a paywall, not an error).

/** True when this access answer says: no in-app AI for this user. */
export function aiBlocked(access: unknown): boolean {
  return (access as { ai_blocked?: unknown } | null)?.ai_blocked === true;
}

/** The 402 body for a blocked request. `feature` names what was asked for. */
export function connectRefusal(feature: string): { error: "pro_required"; state: "free"; feature: string; plan: "connect" } {
  return { error: "pro_required", state: "free", feature, plan: "connect" };
}
