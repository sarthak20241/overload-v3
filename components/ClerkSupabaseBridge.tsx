/**
 * Bridges Clerk auth into the supabase-js client so every Postgres request
 * carries a JWT whose `sub` claim is the Clerk user ID.
 *
 * Renders nothing. Mount once inside <ClerkProvider> at the root layout.
 *
 * Required Clerk dashboard setup:
 *   JWT Templates -> New template -> name: "supabase"
 *   Signing key: same Supabase JWT secret (Project Settings -> API -> JWT Secret)
 *   Claims: { "sub": "{{user.id}}" }
 *
 * Without that template, getToken({template:'supabase'}) returns null and the
 * client falls back to the anon key — RLS will then block all per-user reads.
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
        return (await getToken({ template: 'supabase' })) ?? null;
      } catch {
        return null;
      }
    });
    return () => setSupabaseTokenGetter(null);
  }, [isSignedIn, getToken]);

  return null;
}
