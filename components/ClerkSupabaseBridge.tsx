/**
 * Bridges Clerk auth into the supabase-js client so every Postgres request
 * carries a JWT whose `sub` claim is the Clerk user ID.
 *
 * Renders nothing. Mount once inside <ClerkProvider> at the root layout.
 *
 * Required setup:
 *   Supabase Dashboard -> Authentication -> Third-Party Auth -> Add Clerk
 *
 * That integration teaches PostgREST and the edge functions' JWKS verifier
 * to trust Clerk's RS256 session tokens directly. We pass Clerk's NATIVE
 * session JWT (no template) — NOT the legacy `template: 'supabase'` HS256
 * token, which wouldn't verify against Clerk's JWKS.
 */
import { useEffect } from 'react';
import { setSupabaseTokenGetter } from '@/lib/supabase';
import { hasClerkKey } from '@/hooks/useClerkUser';

export function ClerkSupabaseBridge() {
  if (!hasClerkKey) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useAuth } = require('@clerk/clerk-expo');
  const { getToken, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isSignedIn) {
      setSupabaseTokenGetter(null);
      return;
    }
    setSupabaseTokenGetter(async () => {
      try {
        return (await getToken()) ?? null;
      } catch {
        return null;
      }
    });
    return () => setSupabaseTokenGetter(null);
  }, [isSignedIn, getToken]);

  return null;
}
