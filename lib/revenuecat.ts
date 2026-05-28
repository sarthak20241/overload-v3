/**
 * Thin wrapper around `react-native-purchases` that gracefully degrades when
 * the native module isn't available (Expo Go, dev preview, etc.). Callers get
 * a uniform API — no try/catch sprinkled everywhere, no "is RC configured?"
 * checks at every call site.
 *
 * Mirrors the lazy-require pattern in components/RevenueCatBridge.tsx so the
 * module stays loadable on web / dev tooling that doesn't ship the native
 * binding.
 *
 * Mapping to RevenueCat dashboard:
 *   - `monthly`           — package identifier for the monthly subscription
 *   - `annual`            — package identifier for the annual subscription
 *   - `founding_lifetime` — package identifier for the one-time founding deal
 * These must match the package identifiers you set under
 * `Project → Products → Packages` in the RC dashboard. The default Expo
 * convention is `$rc_monthly`, `$rc_annual`, and a custom identifier for
 * the lifetime — we accept either via PACKAGE_ID_MAP below.
 *
 * The hook surface returns RC's raw shapes for now (CustomerInfo, Package,
 * Offering). The Paywall component knows how to render them. If we end up
 * with more callers we can normalize into our own shape.
 */

// Loosely-typed RC bindings. The real types live in react-native-purchases;
// duplicating them here would just rot. The Paywall consumes these via
// runtime property access; mistakes surface immediately in the UI.
type RCPackage = {
  identifier: string;
  packageType: string; // 'MONTHLY' | 'ANNUAL' | 'LIFETIME' | 'CUSTOM' | ...
  product: {
    identifier: string;
    title?: string;
    description?: string;
    priceString: string;
    price: number;
    currencyCode: string;
  };
};
export type { RCPackage as RevenueCatPackage };

export type RevenueCatOffering = {
  identifier: string;
  serverDescription?: string;
  availablePackages: RCPackage[];
};

export type RevenueCatCustomerInfo = {
  entitlements: {
    active: Record<string, { isActive: boolean; productIdentifier: string }>;
  };
};

// Our app's canonical product slugs. We map RC's package identifiers into
// these so the Paywall + downstream code don't have to know about RC's
// `$rc_*` convention.
export type PlanKey = 'monthly' | 'annual' | 'founding_lifetime';

// RC's package identifiers (left) → our slugs (right). Some are conventional
// ($rc_monthly etc.) and some are custom. Add both forms so we tolerate the
// dashboard being configured either way.
const PACKAGE_ID_MAP: Record<string, PlanKey> = {
  '$rc_monthly': 'monthly',
  '$rc_annual': 'annual',
  'monthly': 'monthly',
  'annual': 'annual',
  'founding_lifetime': 'founding_lifetime',
  'lifetime': 'founding_lifetime',
};

let cachedModule: any | null | undefined;

function loadPurchases(): any | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedModule = require('react-native-purchases').default;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/**
 * Quick "can we attempt a purchase?" check used by the UI to swap real
 * buttons for an Expo-Go-friendly message. Returns true only if the native
 * module loaded AND `Purchases.configure()` has been called (which the
 * RevenueCatBridge does at app boot).
 */
export function isPurchasesAvailable(): boolean {
  const P = loadPurchases();
  if (!P) return false;
  try {
    // RC returns a Promise<boolean>; we only care about the sync presence
    // of the function. The async check happens implicitly inside getOfferings.
    return typeof P.getOfferings === 'function';
  } catch {
    return false;
  }
}

/**
 * Returns the current offering's packages, normalized into our PlanKey
 * slugs. Returns `null` if the SDK isn't available (Expo Go) or if there's
 * no current offering (RC dashboard hasn't been configured yet).
 *
 * The Paywall component should render a graceful "Purchases unavailable"
 * card when this returns null.
 */
export async function getCoachOfferings(): Promise<{
  byPlan: Partial<Record<PlanKey, RCPackage>>;
  raw: RevenueCatOffering | null;
} | null> {
  const P = loadPurchases();
  if (!P) return null;
  try {
    const offerings = await P.getOfferings();
    const current: RevenueCatOffering | null = offerings?.current ?? null;
    if (!current) return { byPlan: {}, raw: null };
    const byPlan: Partial<Record<PlanKey, RCPackage>> = {};
    for (const pkg of current.availablePackages ?? []) {
      const slug = PACKAGE_ID_MAP[pkg.identifier];
      if (slug && !byPlan[slug]) byPlan[slug] = pkg;
    }
    return { byPlan, raw: current };
  } catch (e) {
    console.warn('[revenuecat] getOfferings failed:', e);
    return null;
  }
}

/**
 * Initiates the IAP flow for the given package. Resolves with CustomerInfo
 * on a successful purchase; throws on cancellation, payment failure, or
 * SDK unavailability. The caller is responsible for telling the user what
 * happened (toast for failure, polling get_coach_access_status for success).
 *
 * IMPORTANT: A successful resolve here does NOT mean the user's tier in
 * Supabase has flipped yet — that's the RC webhook's job. The caller must
 * poll get_coach_access_status until state changes (typically 2-5s).
 */
export async function purchaseCoachPackage(
  pkg: RCPackage,
): Promise<RevenueCatCustomerInfo> {
  const P = loadPurchases();
  if (!P) {
    throw new PurchasesUnavailableError(
      'In-app purchases require a development build. Sign up via TestFlight ' +
      'or wait for the App Store release.',
    );
  }
  try {
    const result = await P.purchasePackage(pkg);
    // RC v6+ returns { customerInfo, productIdentifier }
    // RC v5 returned CustomerInfo directly. Tolerate both.
    return result?.customerInfo ?? result;
  } catch (e: any) {
    if (e?.userCancelled || e?.code === 'PURCHASE_CANCELLED') {
      throw new PurchaseCancelledError();
    }
    throw e;
  }
}

/**
 * Restores a previous purchase — Apple HIG requires a "Restore Purchases"
 * affordance on any paywall. Returns the customer's entitlements so the UI
 * can show a confirmation.
 */
export async function restorePurchases(): Promise<RevenueCatCustomerInfo | null> {
  const P = loadPurchases();
  if (!P) return null;
  try {
    return await P.restorePurchases();
  } catch (e) {
    console.warn('[revenuecat] restore failed:', e);
    throw e;
  }
}

export class PurchasesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PurchasesUnavailableError';
  }
}

export class PurchaseCancelledError extends Error {
  constructor() {
    super('User cancelled');
    this.name = 'PurchaseCancelledError';
  }
}
