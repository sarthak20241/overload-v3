/**
 * Safe Clerk user accessor.
 *
 * ClerkProvider is mounted conditionally at the root layout based on
 * EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY, so calling Clerk hooks directly in a
 * screen would crash when the key is absent (guest mode / pre-config).
 *
 * React's rules of hooks forbid conditional hook calls, so we use a runtime
 * `require()` gated by `hasClerkKey`. This is isolated here so the rest of the
 * app can import a typed hook with a stable shape.
 */

import type { UserResource } from '@clerk/types';

export const hasClerkKey = !!process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

export interface ClerkUserState {
  user: UserResource | null;
  isLoaded: boolean;
  isSignedIn: boolean;
  signOut: () => Promise<void>;
  /** Clerk JWT for authenticated edge-function calls. Null when signed out. */
  getToken: (() => Promise<string | null>) | null;
}

export function useClerkUser(): ClerkUserState {
  if (!hasClerkKey) {
    return { user: null, isLoaded: true, isSignedIn: false, signOut: async () => {}, getToken: null };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useUser, useAuth } = require('@clerk/clerk-expo');
  const { user, isLoaded: userLoaded } = useUser();
  const { isSignedIn, isLoaded: authLoaded, signOut, getToken } = useAuth();
  return {
    user: user ?? null,
    // BOTH hooks must have settled, not just useUser(). `isLoaded` and
    // `isSignedIn` are read from two different Clerk hooks, and callers combine
    // them — useCoachAccess derives "this is a guest" from
    // `isLoaded && !isSignedIn` to decide between the sign-in card and a
    // spinner. If useUser() reported loaded while useAuth() was still restoring
    // a persisted session from SecureStore, `isSignedIn` would still be
    // undefined and a genuinely signed-in user would be shown "Sign in to meet
    // Coach Drona" for that tick. Requiring both removes the dependency on the
    // two settling in lockstep; it can only ever delay `isLoaded`, never report
    // loaded too early, and every caller uses it as a "wait for Clerk" gate.
    isLoaded: !!userLoaded && !!authLoaded,
    isSignedIn: !!isSignedIn,
    signOut: async () => {
      if (signOut) await signOut();
    },
    getToken: isSignedIn && getToken ? getToken : null,
  };
}
