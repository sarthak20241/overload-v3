/**
 * Server-side admin check. Calls the `is_admin()` Postgres RPC, which checks
 * whether the calling Clerk user is in the `admin_users` table. Used by every
 * (admin) route layout to gate access.
 *
 * Returns false for unauthenticated requests, non-admins, or transient RPC
 * errors. The page-level handler is responsible for redirecting to
 * /no-access when this returns false.
 *
 * Wrapped in React's `cache()` so a single request — even one that touches
 * the layout, the page, and nested server components — only calls is_admin()
 * ONCE. Cache scope is the React request, not cross-request: subsequent
 * navigations re-check (good, in case admin status changed mid-session).
 * Saves ~100-300ms per tab click that we used to spend on a Supabase
 * roundtrip the layout was triggering on every render.
 */
import { cache } from 'react';
import { getSupabaseServerClient } from './supabase';

export const isAdmin = cache(async (): Promise<boolean> => {
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.rpc('is_admin');
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
});
