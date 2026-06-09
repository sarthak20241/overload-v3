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
import { hasClerkKey } from '@/hooks/useClerkUser';
import { ensureConfigured, ensureIdentity, logOutRevenueCat } from '@/lib/revenuecat';

export function RevenueCatBridge() {
  // Configure as early as possible so getOfferings() (paywall) works even
  // before the user signs in. ensureConfigured is idempotent.
  useEffect(() => {
    ensureConfigured();
  }, []);

  // Identity sync only when Clerk is configured. In guest mode, RC stays
  // anonymous — there's no Clerk id to tie purchases to.
  return hasClerkKey ? <ClerkIdentitySync /> : null;
}

/**
 * Inner component — split out so we can use Clerk hooks behind the
 * conditional. Same pattern ClerkSupabaseBridge uses.
 *
 * Crucially, identity goes through ensureIdentity(), which configures the SDK
 * BEFORE calling logIn in the same code path. That removes the old race where
 * this child effect (React flushes child effects before parent effects) could
 * call logIn before the parent had configured the SDK — which left every
 * purchase tagged with an anonymous RC id.
 */
function ClerkIdentitySync() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useAuth } = require('@clerk/clerk-expo');
  const { userId, isLoaded, isSignedIn } = useAuth();

  // Track the last id we logged in with so we don't re-call logIn on every
  // render. RC's logIn is idempotent but it does network work; cheaper to
  // skip when nothing changed.
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    (async () => {
      if (isSignedIn && userId) {
        if (lastIdRef.current === userId) return;
        await ensureIdentity(userId);
        lastIdRef.current = userId;
      } else {
        if (lastIdRef.current === null) return;
        await logOutRevenueCat();
        lastIdRef.current = null;
      }
    })();
  }, [isLoaded, isSignedIn, userId]);

  return null;
}
