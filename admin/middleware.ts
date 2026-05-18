/**
 * Clerk middleware.
 *
 * Auth model: same Clerk app instance as the Expo app, configured as a
 * Supabase third-party auth provider (Clerk Dashboard → Integrations →
 * Supabase). Clerk JWTs verify against Supabase's JWKS, so the admin app
 * + the Expo app + the ai-coach edge function all trust the same tokens.
 *
 * Protected routes:
 *   - Everything under /(admin)/*  → requires signed-in Clerk user
 *   - / and /sign-in and /sign-up → public
 *
 * The RLS-level admin check (is_admin() Postgres function) happens later
 * inside the actual route handlers. Middleware only verifies "signed in".
 */
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/no-access',
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals + static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
