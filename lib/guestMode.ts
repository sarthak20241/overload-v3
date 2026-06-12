import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { useClerkUser } from '@/hooks/useClerkUser';
import { isSupabaseConfigured } from '@/lib/supabase';

const GUEST_MODE_KEY = 'guest_mode_v1';

// Tracks "the user tapped Continue as guest." Persists across restarts so a
// guest doesn't get bounced to the auth screen on every cold start.
// Cleared on sign-in / sign-out so subsequent starts decide cleanly.

export async function getGuestMode(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(GUEST_MODE_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function setGuestMode(active: boolean): Promise<void> {
  try {
    if (active) await AsyncStorage.setItem(GUEST_MODE_KEY, '1');
    else await AsyncStorage.removeItem(GUEST_MODE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Session-level guest check for data routing, distinct from useGuestMode (the
 * explicit "Continue as guest" flag, which only drives navigation).
 *
 * This answers: "is there an authenticated Supabase session to read/write?"
 * Without a Clerk user there is no JWT, the Supabase client runs as the anon
 * role, and RLS rejects every write - so all data paths must use the local
 * guest store (lib/guestStore.ts) instead. True when Supabase is unconfigured
 * (dev builds without env vars) or when no Clerk user is signed in.
 *
 * CAVEAT: this also reads true while Clerk is still hydrating on cold launch,
 * before a signed-in user's session is restored. Never branch a data fetch on
 * it without first gating on Clerk readiness, or signed-in users get routed
 * to the (likely empty) guest store:
 *
 *   const { isLoaded: clerkLoaded } = useClerkUser();
 *   useEffect(() => {
 *     if (!clerkLoaded) return; // spinner covers this window
 *     ...fetch using isGuestSession...
 *   }, [clerkLoaded, ...]);
 */
export function useIsGuestSession(): boolean {
  const { user } = useClerkUser();
  return !isSupabaseConfigured || !user?.id;
}

export function useGuestMode(): { isGuest: boolean; isLoaded: boolean } {
  const [state, setState] = useState({ isGuest: false, isLoaded: false });
  useEffect(() => {
    let cancelled = false;
    getGuestMode().then((isGuest) => {
      if (!cancelled) setState({ isGuest, isLoaded: true });
    });
    return () => { cancelled = true; };
  }, []);
  return state;
}
