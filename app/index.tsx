import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useGuestMode } from '@/lib/guestMode';
import { hasCompletedGuestOnboarding } from '@/lib/onboarding';
import { hasPendingOnboarding } from '@/lib/pendingOnboarding';

function AuthRedirect() {
  const { isSignedIn, isLoaded } = useClerkUser();
  const { isGuest, isLoaded: guestLoaded } = useGuestMode();

  // For a visitor who is neither signed-in nor an explicit guest, decide
  // between the two first-run destinations:
  //  - truly fresh install            → /onboarding (the front door now)
  //  - mid-conversion (pending plan)  → /(auth) to finish signing in and save
  //  - returning, already onboarded   → /(auth)
  // 'decide' stays null until that async read settles, so we render nothing
  // rather than flashing the wrong screen.
  const [decide, setDecide] = useState<null | 'onboarding' | 'auth'>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [pending, doneAsGuest] = await Promise.all([
        hasPendingOnboarding(),
        hasCompletedGuestOnboarding(),
      ]);
      if (!cancelled) setDecide(pending || doneAsGuest ? 'auth' : 'onboarding');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isLoaded || !guestLoaded) return null;
  // Signed-in users and explicit guests go straight to the app; the (app)
  // layout handles first-run onboarding and draining any pending plan.
  if (isSignedIn || isGuest) return <Redirect href="/(app)" />;
  if (decide === null) return null; // resolving fresh-vs-return
  return <Redirect href={decide === 'onboarding' ? '/onboarding' : '/(auth)'} />;
}

export default function Index() {
  // Always route through AuthRedirect. A misconfigured build (no Clerk key)
  // used to short-circuit to /(app) with no real session; now everyone
  // resolves a real destination, and onboarding is the front door for fresh
  // installs.
  return <AuthRedirect />;
}
