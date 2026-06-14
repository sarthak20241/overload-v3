import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { useMemo, useRef } from 'react';
import * as SecureStore from 'expo-secure-store';
import { hasClerkKey } from '@/hooks/useClerkUser';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'placeholder';

export const isSupabaseConfigured = supabaseUrl !== 'https://placeholder.supabase.co';

const ExpoSecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

// Clerk -> Supabase JWT bridge.
//
// The supabase-js v2 client checks the `accessToken` callback on every request
// and uses its return value as the Bearer token. ClerkSupabaseBridge registers
// a Clerk-issued JWT (template "supabase") at app boot via
// `setSupabaseTokenGetter` so that Postgres RLS can read
// `auth.jwt() ->> 'sub'` as the Clerk user ID.
//
// Without a registered getter (guest mode, sign-out, pre-Clerk boot) the
// callback returns null and the client falls back to the anon key.
let clerkTokenGetter: (() => Promise<string | null>) | null = null;

export function setSupabaseTokenGetter(fn: (() => Promise<string | null>) | null): void {
  clerkTokenGetter = fn;
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: ExpoSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  accessToken: async () => {
    if (!clerkTokenGetter) return null;
    try {
      return await clerkTokenGetter();
    } catch {
      return null;
    }
  },
});

// Hook that returns a Supabase client which forwards the current Clerk session
// JWT on every request. Use this everywhere user data is touched.
//
// Implementation note: we attach the JWT via a custom `fetch` rather than via
// `supabase.auth.setSession`, because we don't want supabase-js to try to
// refresh the token itself — Clerk owns the refresh lifecycle. `getToken()`
// returns the cached short-lived access token (and silently refreshes from the
// long-lived client JWT in SecureStore when needed).
export function useSupabaseClient(): SupabaseClient {
  if (!hasClerkKey) {
    return supabase;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useAuth } = require('@clerk/clerk-expo');
  const { getToken } = useAuth();

  // Keep the latest getToken in a ref so each request reads a fresh token
  // WITHOUT recreating the client when getToken's identity changes. Clerk's
  // useAuth returns a new getToken on many renders; the previous
  // `useMemo(..., [getToken])` therefore handed back a brand-new Supabase client
  // almost every render. Any effect depending on the client identity then
  // re-ran every render (SyncProvider's flush, the exercise picker's fetch),
  // which could spiral into "Maximum update depth exceeded." The client is now
  // created once and reads the live token via the ref.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  return useMemo(() => {
    return createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        fetch: async (input: RequestInfo | URL, init: RequestInit = {}) => {
          // Bound getToken so an expired token + no network can't hang the
          // request forever — Clerk otherwise blocks on a token refresh it
          // can't complete offline. On timeout we treat it as no token and FAIL
          // the request (see below) rather than hanging the UI.
          let token: string | null = null;
          try {
            token = await Promise.race([
              getTokenRef.current(),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
            ]);
          } catch {
            token = null;
          }
          // No token (offline + expired token, or getToken timed out): FAIL the
          // request rather than send it unauthenticated. An anon request passes
          // RLS as "no rows" and returns empty data with NO error — which screens
          // would then write over their caches, wiping the user's data view (and
          // resetting XP / workout counts to 0). Throwing makes supabase-js
          // surface an error so callers keep their cached data instead.
          if (!token) throw new Error('No auth token available (offline?)');
          const headers = new Headers(init.headers);
          headers.set('Authorization', `Bearer ${token}`);
          return fetch(input as any, { ...init, headers });
        },
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }, []);
}
