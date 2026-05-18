/**
 * Server-side admin check. Calls the `is_admin()` Postgres RPC, which checks
 * whether the calling Clerk user is in the `admin_users` table. Used by every
 * (admin) route layout to gate access.
 *
 * Returns false for unauthenticated requests, non-admins, or transient RPC
 * errors. The page-level handler is responsible for redirecting to
 * /no-access when this returns false.
 */
import { getSupabaseServerClient } from './supabase';

export async function isAdmin(): Promise<boolean> {
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.rpc('is_admin');
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}
