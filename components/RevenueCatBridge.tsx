/**
 * Bridges Clerk auth into the RevenueCat SDK so every purchase event
 * webhook'd back to Supabase carries the Clerk user ID as `app_user_id`.
 *
 * Renders nothing. Mount once at the root layout (next to ClerkSupabaseBridge).
 *
 * Required env (in .env.local):
 *   EXPO_PUBLIC_REVENUECAT_IOS_KEY      (from RC dashboard → API keys)
 *   EXPO_PUBLIC_REVENUECAT_ANDROID_KEY  (when shipping Android)
 *
 * Behavior:
 *   - On first mount: Purchases.configure(apiKey). Idempotent across renders.
 *   - When the Clerk user signs in: Purchases.logIn(clerkUserId). All
 *     subsequent purchases tag the user; the RC webhook → Supabase pipeline
 *     uses this id to flip user_profiles.tier.
 *   - When the user signs out: Purchases.logOut(). RC reverts to its own
 *     anonymous id for the next anonymous session.
 *
 * Defensive shape:
 *   - react-native-purchases is a native module — unavailable in Expo Go.
 *     We require it lazily through try/catch so the dev experience in Go
 *     stays functional (purchases simply won't work; everything else does).
 *   - Missing API key → SDK stays uninitialized. Drona chat still works.
 *     Only purchase / paywall UI is affected.
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { hasClerkKey } from '@/hooks/useClerkUser';

const RC_IOS_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ?? '';
const RC_ANDROID_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY ?? '';

// Module-scoped so a re-mount of <RevenueCatBridge /> never re-configures.
// RC's configure() is idempotent but logs a warning; we'd rather avoid it.
let purchasesConfigured = false;

/**
 * Lazy-load react-native-purchases. The module isn't in Expo Go (no native
 * binding) and shouldn't crash dev mode. Returns null if unavailable.
 */
function loadPurchases(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native-purchases').default;
  } catch {
    return null;
  }
}

function getApiKey(): string {
  if (Platform.OS === 'ios') return RC_IOS_KEY;
  if (Platform.OS === 'android') return RC_ANDROID_KEY;
  return '';
}

export function RevenueCatBridge() {
  const Purchases = loadPurchases();

  // Configure on first mount when we have a key + the module is present.
  useEffect(() => {
    if (!Purchases || purchasesConfigured) return;
    const apiKey = getApiKey();
    if (!apiKey) return;
    try {
      Purchases.configure({ apiKey });
      purchasesConfigured = true;
    } catch (e) {
      console.warn('[RevenueCat] configure failed:', e);
    }
  }, [Purchases]);

  // Identity sync only when Clerk is configured. In guest mode, RC stays
  // anonymous — there's no Clerk id to tie purchases to.
  return hasClerkKey ? <ClerkIdentitySync Purchases={Purchases} /> : null;
}

/**
 * Inner component — split out so we can use Clerk hooks behind the
 * conditional. Same pattern ClerkSupabaseBridge uses.
 */
function ClerkIdentitySync({ Purchases }: { Purchases: any | null }) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useAuth } = require('@clerk/clerk-expo');
  const { userId, isLoaded, isSignedIn } = useAuth();

  // Track the last id we logged in with so we don't re-call logIn on every
  // render. RC's logIn is idempotent but it does network work; cheaper to
  // skip when nothing changed.
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!Purchases || !isLoaded) return;
    (async () => {
      try {
        if (isSignedIn && userId) {
          if (lastIdRef.current === userId) return;
          await Purchases.logIn(userId);
          lastIdRef.current = userId;
        } else {
          if (lastIdRef.current === null) return;
          await Purchases.logOut();
          lastIdRef.current = null;
        }
      } catch (e) {
        console.warn('[RevenueCat] identity sync failed:', e);
      }
    })();
  }, [Purchases, isLoaded, isSignedIn, userId]);

  return null;
}
