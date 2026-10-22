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
 * Clerk to load (offline, Clerk may never load) and TICKET_WAIT_MS for the
 * ticket. Giving up before the sign-out leaves the user with the session they
 * had. After the sign-out has begun the gate does NOT give up at that mark:
 * mounting the app then would let the guards and bridges see the signed-out
 * moment, the thing this gate exists to hide. It waits for the swap, up to
 * SWAP_MAX_MS, a cap only for a Clerk call that never returns. That cap is
 * the one exception: past it the app mounts while the user may be signed
 * out, and the guards and bridges see it. It is reported as swap_timed_out.
 *
 * The native splash stays up while the gate renders nothing: app/_layout.tsx
 * holds it, and this hides it once the gate is done.
 *
 * It runs once per cold start, on purpose. Doing it on return from the
 * background would mean unmounting a live app (an active workout included)
 * to hide the sign-out. So a user who keeps the app alive in memory from
 * before their last 3 days until past day 7 still meets the sign-in screen.
 * Phones end background apps far sooner than that in practice.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SplashScreen } from 'expo-router';
import {
  type GateOutcome,
  REFRESH_WITHIN_MS,
  runSessionRefresh,
  shouldRefreshSession,
  SKIPPED_OUTCOMES,
} from '@/lib/sessionRefresh';
import { track } from '@/lib/analytics';

const CLERK_LOAD_WAIT_MS = 4000;
const TICKET_WAIT_MS = 9000;
const SWAP_MAX_MS = 30000;
const TICKET_FETCH_MS = 8000;

/** Null when the request never got an answer (offline, aborted): a skip.
 *  Throws when the server answered with an error, so a broken deploy (no
 *  CLERK_SECRET_KEY, a verifier bug) shows up as a failure, not a skip. */
async function fetchTicket(token: string): Promise<{ ticket: string; userId: string } | null> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TICKET_FETCH_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${url}/functions/v1/session-refresh`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anonKey,
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: controller.signal,
      });
    } catch {
      return null;
    }
    if (!res.ok) throw new Error(`session-refresh: HTTP ${res.status}`);
    let body: { ticket?: string | null; user_id?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // The connection dropped or the abort fired mid-body: no answer, a skip.
      return null;
    }
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
    // Exactly one of these wins: the ticket wait running out (before the
    // sign-out), or the sign-out starting. JS runs them one at a time.
    let settled = false;
    let committed = false;
    let createdSessionId: string | null = null;
    let ticketTimer: ReturnType<typeof setTimeout> | undefined;
    let swapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: GateOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(ticketTimer);
      clearTimeout(swapTimer);
      // Three buckets, so the failure count means something: a new session,
      // nothing changed (offline, server down, gave up waiting), or a real
      // failure (sign-out or ticket sign-in went wrong, or a swap hung).
      const event = outcome === 'refreshed'
        ? 'session_refreshed'
        : SKIPPED_OUTCOMES.includes(outcome) ? 'session_refresh_skipped' : 'session_refresh_failed';
      track(event, {
        outcome,
        days_left: daysLeft,
        window_days: REFRESH_WITHIN_MS / 86_400_000,
      });
      setDone(true);
    };
    ticketTimer = setTimeout(() => {
      if (!committed) finish('ticket_timed_out');
    }, TICKET_WAIT_MS);
    runSessionRefresh({
      currentUserId: userId,
      fetchTicket: async () => {
        // No token is a skip. A server error throws on to runSessionRefresh,
        // which reports it as ticket_error. Neither signs anyone out.
        let token: string | null = null;
        try {
          token = await getToken();
        } catch {
          return null;
        }
        return token ? fetchTicket(token) : null;
      },
      beforeSignOut: () => {
        if (settled) return false; // the gate already gave up and moved on
        committed = true;
        clearTimeout(ticketTimer);
        swapTimer = setTimeout(() => finish('swap_timed_out'), SWAP_MAX_MS);
        return true;
      },
      signOut: () => signOut(),
      signInWithTicket: async (ticket) => {
        // The ticket is one-time. Once it has made a session, a retry must
        // only try to activate that session again, never redeem the ticket.
        if (!createdSessionId) {
          // Read the client at call time: the sign-out above replaced it.
          const attempt = await clerk.client.signIn.create({ strategy: 'ticket', ticket });
          if (attempt.status !== 'complete' || !attempt.createdSessionId) {
            throw new Error(`ticket sign-in: ${attempt.status}`);
          }
          createdSessionId = attempt.createdSessionId as string;
        }
        await clerk.setActive({ session: createdSessionId });
      },
    }).then(finish, () => finish('error'));
  }, [done, isLoaded, isSignedIn, userId, session, getToken, signOut, clerk]);

  useEffect(() => {
    if (done) SplashScreen.hideAsync().catch(() => {});
  }, [done]);

  return done ? <>{children}</> : null;
}
