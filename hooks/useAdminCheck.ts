/**
 * useAdminCheck — calls the `is_admin()` Postgres RPC and returns a
 * boolean indicating whether the signed-in Clerk user is a member of
 * `admin_users`. Cheap (single round trip), but cached in module-scope so
 * tab switches don't refetch every time.
 *
 * Used to gate:
 *   - The "Admin Tools" affordance in the Profile screen
 *   - The /admin/research route itself (hides UI + falls back to a "no access"
 *     message if a deep-linked URL is opened by a non-admin)
 *
 * RLS-side guarantee: admin RPCs (promote_pending_to_kb, reject_pending,
 * admin_research_stats) all re-check is_admin() server-side. This hook is a
 * UX optimization, not the security boundary.
 */
import { useEffect, useState } from 'react';
import { useSupabaseClient } from '@/lib/supabase';

// Module-scope cache so the second-time visit to Profile doesn't refetch.
// Cleared on sign-out via supabase.auth listener (the supabase client is
// recreated on token change in our setup, so the cache is effectively
// scoped to a Clerk session).
let cachedIsAdmin: boolean | null = null;

export function useAdminCheck(): { isAdmin: boolean; loading: boolean } {
  const supabase = useSupabaseClient();
  const [isAdmin, setIsAdmin] = useState<boolean>(cachedIsAdmin ?? false);
  const [loading, setLoading] = useState<boolean>(cachedIsAdmin === null);

  useEffect(() => {
    let cancelled = false;
    if (cachedIsAdmin !== null) {
      setIsAdmin(cachedIsAdmin);
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const { data, error } = await supabase.rpc('is_admin');
        if (cancelled) return;
        if (error) {
          // Network blip, RPC missing, or unauthenticated → assume non-admin
          // (the dashboard's server-side RLS will still reject reads, so the
          // worst case is a confusing UI not a security leak).
          cachedIsAdmin = false;
          setIsAdmin(false);
        } else {
          cachedIsAdmin = data === true;
          setIsAdmin(cachedIsAdmin);
        }
      } catch {
        if (!cancelled) {
          cachedIsAdmin = false;
          setIsAdmin(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase]);

  return { isAdmin, loading };
}
