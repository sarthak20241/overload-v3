import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { useMemo } from 'react';
import { hasClerkKey } from '@/hooks/useClerkUser';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'placeholder';

export const isSupabaseConfigured = supabaseUrl !== 'https://placeholder.supabase.co';

// Anonymous fallback client. Kept ONLY so guest-mode/no-Clerk paths don't crash
// on import. Never use it for user-scoped reads or writes — it carries no JWT
// and RLS will reject everything once the strict policies land.
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
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

  return useMemo(() => {
    return createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        fetch: async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const token = await getToken();
          const headers = new Headers(init.headers);
          if (token) headers.set('Authorization', `Bearer ${token}`);
          return fetch(input as any, { ...init, headers });
        },
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }, [getToken]);
}
