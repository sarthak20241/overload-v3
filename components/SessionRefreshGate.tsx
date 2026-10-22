/**
 * Replaces a Clerk session that is about to hit its fixed 7-day end, at app
 * start, before anything else mounts. See lib/sessionRefresh.ts for why and
 * for the order of the steps.
 *
 * Everything that reacts to auth (the Supabase and RevenueCat bridges, the
 * analytics bridge, the route guards) is a child of this gate. The swap signs
 * the old session out for a moment, and none of them may see that moment: the
 * RevenueCat bridge would log the user out of purchases, the route guard would
 * send them to the sign-in screen. So children render only once the gate is
 * done. Mount it inside <ClerkProvider> only.
 *
 * It never holds the app up for long: it waits at most CLERK_LOAD_WAIT_MS for
 * Clerk to load (offline, Clerk may never load), and the swap itself is cut
 * off at REFRESH_MAX_MS. On any failure before the sign-out, the user simply
 * keeps the session they had.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { REFRESH_WITHIN_MS, runSessionRefresh, shouldRefreshSession } from '@/lib/sessionRefresh';
import { track } from '@/lib/analytics';

const CLERK_LOAD_WAIT_MS = 4000;
const REFRESH_MAX_MS = 15000;
const TICKET_FETCH_MS = 8000;

async function fetchTicket(token: string): Promise<{ ticket: string; userId: string } | null> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TICKET_FETCH_MS);
  try {
    const res = await fetch(`${url}/functions/v1/session-refresh`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ticket?: string | null; user_id?: string };
    return body.ticket && body.user_id ? { ticket: body.ticket, userId: body.user_id } : null;
  } finally {
    clearTimeout(timer);
  }
}

export function SessionRefreshGate({ children }: { children: ReactNode }) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useAuth, useClerk, useSession } = require('@clerk/clerk-expo');
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth();
  const { session } = useSession();
  const clerk = useClerk();
  const [done, setDone] = useState(false);
  const started = useRef(false);

  // Clerk may never load (offline cold start). Don't hold the app for it.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!started.current) setDone(true);
    }, CLERK_LOAD_WAIT_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (done || started.current || !isLoaded) return;
    started.current = true;
    const expireAt: Date | null = session?.expireAt ?? null;
    if (!isSignedIn || !userId || !shouldRefreshSession(expireAt, Date.now())) {
      setDone(true);
      return;
    }
    const daysLeft = expireAt ? Math.round(((expireAt.getTime() - Date.now()) / 86_400_000) * 10) / 10 : null;
    const run = runSessionRefresh({
      currentUserId: userId,
      fetchTicket: async () => {
        const token = await getToken();
        return token ? fetchTicket(token) : null;
      },
      signOut: () => signOut(),
      signInWithTicket: async (ticket) => {
        // Read the client at call time: the sign-out above replaced it.
        const attempt = await clerk.client.signIn.create({ strategy: 'ticket', ticket });
        if (attempt.status !== 'complete' || !attempt.createdSessionId) {
          throw new Error(`ticket sign-in: ${attempt.status}`);
        }
        await clerk.setActive({ session: attempt.createdSessionId });
      },
    });
    const cutoff = new Promise<'timed_out'>((r) => setTimeout(() => r('timed_out'), REFRESH_MAX_MS));
    Promise.race([run, cutoff]).then((outcome) => {
      track(outcome === 'refreshed' ? 'session_refreshed' : 'session_refresh_failed', {
        outcome,
        days_left: daysLeft,
        window_days: REFRESH_WITHIN_MS / 86_400_000,
      });
      setDone(true);
    });
  }, [done, isLoaded, isSignedIn, userId, session, getToken, signOut, clerk]);

  return done ? <>{children}</> : null;
}
