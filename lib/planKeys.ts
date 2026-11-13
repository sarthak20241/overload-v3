/**
 * Overload's plan slugs, and which slug a RevenueCat package is. Pure (no
 * native module), so lib/revenuecatPlans.test.ts can run it. lib/revenuecat.ts
 * re-exports everything here.
 */

/** The fields of an RC package this file reads. */
export interface PackageLike {
  identifier: string;
  packageType?: string;
  product?: { identifier?: string } | null;
}

// Our app's canonical product slugs. We map RC's package identifiers into
// these so the Paywall + downstream code don't have to know about RC's
// `$rc_*` convention.
export type PlanKey =
  | 'monthly'
  | 'annual'
  | 'founding_lifetime'
  // Overload Connect (tracker + your own AI). Custom package identifiers in
  // the default offering; never matched by packageType, so a Connect package
  // can never be mistaken for a Pro one.
  | 'connect_monthly'
  | 'connect_annual'
  | 'connect_lifetime';

/** Connect plans (no Drona). Everything else in PlanKey is Pro. */
export const CONNECT_PLANS: readonly PlanKey[] = ['connect_monthly', 'connect_annual', 'connect_lifetime'];
export function isConnectPlan(plan: PlanKey): boolean {
  return CONNECT_PLANS.includes(plan);
}

// RC's package identifiers (left) → our slugs (right). Some are conventional
// ($rc_monthly etc.) and some are custom. Add both forms so we tolerate the
// dashboard being configured either way.
const PACKAGE_ID_MAP: Record<string, PlanKey> = {
  '$rc_monthly': 'monthly',
  '$rc_annual': 'annual',
  '$rc_lifetime': 'founding_lifetime',
  'monthly': 'monthly',
  'annual': 'annual',
  'founding_lifetime': 'founding_lifetime',
  'lifetime': 'founding_lifetime',
  'connect_monthly': 'connect_monthly',
  'connect_annual': 'connect_annual',
  'connect_lifetime': 'connect_lifetime',
};

// Fallback when the identifier isn't recognized: match on RC's packageType.
// RC's standard types are MONTHLY, ANNUAL, LIFETIME, plus weekly/two-month/etc.
// — the three we care about all map cleanly. CUSTOM packages have no
// standard type, so they must use a recognized identifier above.
function packageTypeToPlanKey(packageType: string | undefined): PlanKey | null {
  switch (packageType) {
    case 'MONTHLY': return 'monthly';
    case 'ANNUAL': return 'annual';
    case 'LIFETIME': return 'founding_lifetime';
    default: return null;
  }
}

/**
 * A Connect product, read from the store product id (overload_connect_*; on
 * Play "overload_connect_annual:annual"). Checked BEFORE the package id and
 * type: a Connect package set up as "$rc_annual" or type ANNUAL by mistake
 * must never be sold as Pro, because the buyer would get no Drona.
 */
function connectPlanFromProduct(productId: string | undefined): PlanKey | null {
  const id = String(productId ?? '').split(':')[0];
  if (id === 'overload_connect_monthly') return 'connect_monthly';
  if (id === 'overload_connect_annual') return 'connect_annual';
  if (id === 'overload_connect_lifetime') return 'connect_lifetime';
  return null;
}

export function packageToPlanKey(pkg: PackageLike): PlanKey | null {
  const connect = connectPlanFromProduct(pkg.product?.identifier);
  if (connect) return connect;
  const mapped = PACKAGE_ID_MAP[pkg.identifier] ?? packageTypeToPlanKey(pkg.packageType);
  // A Connect package id over a product that is not Connect: trust nothing.
  return mapped && isConnectPlan(mapped) ? null : mapped;
}

