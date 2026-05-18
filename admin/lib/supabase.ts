/**
 * Server-side Supabase client factory.
 *
 * The admin app runs entirely server-rendered (no client-side data fetches),
 * so every call to Supabase needs the Clerk JWT in the Authorization header
 * for RLS to recognize the user. We make one client per request via this
 * factory — passing the Clerk session token captured from `auth()`.
 *
 * Why not a long-lived module-scope client: each request has its own user
 * token. Sharing a client across requests would leak one user's auth to
 * another (rare in this admin app, but still wrong).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { auth } from '@clerk/nextjs/server';

export async function getSupabaseServerClient(): Promise<SupabaseClient> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const { getToken } = await auth();
  // Default template — Supabase third-party auth integration accepts the
  // raw Clerk session JWT (signed RS256, verified via Clerk's JWKS).
  const token = await getToken();

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
