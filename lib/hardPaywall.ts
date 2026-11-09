/**
 * Hard paywall (2026-11-08): accounts made on or after HARD_PAYWALL_FROM must
 * start a trial or subscribe to use the app. Older accounts keep the metered
 * free plan they signed up for.
 *
 * Pure, so the rule is unit-tested (lib/hardPaywall.test.ts) and the app
 * layout, the paywall and anything else ask the same question.
 */

/**
 * The first day of the hard paywall, in UTC. Accounts created before it keep
 * the free plan. Set it to the day the update reaches phones, so nobody who
 * signed up under the free plan is locked out by it.
 */
export const HARD_PAYWALL_FROM = Date.parse('2026-11-09T00:00:00Z');

/** Access states that mean "no Pro, no trial". The two legacy ones still
 *  come from an old cached blob for one render. */
const NOT_PAYING = new Set(['free', 'trial_ended', 'eligible_for_trial']);

function toMs(createdAt: Date | number | string | null | undefined): number | null {
  if (createdAt == null) return null;
  const ms = createdAt instanceof Date ? createdAt.getTime() : typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Was this account made under the hard paywall? Unknown date = no. */
export function isHardPaywallAccount(createdAt: Date | number | string | null | undefined): boolean {
  const ms = toMs(createdAt);
  return ms !== null && ms >= HARD_PAYWALL_FROM;
}

/**
 * Must this person pay before they see the app?
 *
 * Only when all hold: the account is new, the store can sell here (not Expo
 * Go or web, where nobody could pay), and access says not paying. 'unknown'
 * (still loading, or the server is down) never locks: a network blip must not
 * shut a paying user out.
 */
export function mustPay(opts: {
  createdAt: Date | number | string | null | undefined;
  accessState: string;
  purchasesAvailable: boolean;
}): boolean {
  return (
    opts.purchasesAvailable &&
    isHardPaywallAccount(opts.createdAt) &&
    NOT_PAYING.has(opts.accessState)
  );
}
