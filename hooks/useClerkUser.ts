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
  const { isSignedIn, signOut, getToken } = useAuth();
  return {
    user: user ?? null,
    isLoaded: !!userLoaded,
    isSignedIn: !!isSignedIn,
    signOut: async () => {
      if (signOut) await signOut();
    },
    getToken: isSignedIn && getToken ? getToken : null,
  };
}
