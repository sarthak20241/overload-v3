/**
 * Silent re-sign-in before Clerk's fixed 7-day session lifetime ends.
 *
 * On Clerk's Hobby plan every session ends 7 days after sign-in, and users were
 * sent to the sign-in screen every week. The session-refresh edge function
 * mints a one-time sign-in ticket for a user whose session is near its end;
 * this trades it for a fresh session. The instance is in single-session mode,
 * so the old session has to be signed out before the ticket can sign in. That
 * swap runs at app start, behind SessionRefreshGate, before any screen or
 * bridge is mounted, so nothing sees the moment in between.
 *
 * The order matters, and it is what the tests pin:
 *   1. get the ticket first. No ticket (offline, not due, server error):
 *      nothing changes and the user stays signed in.
 *   2. only then sign out. A failed sign-out also changes nothing.
 *   3. sign in with the ticket, retried, because a failure HERE is the one
 *      that leaves the user signed out.
 *
 * No imports, so Deno can test it directly (lib/sessionRefresh.test.ts).
 */

/** Ask for a ticket once the session ends within this window. Must match
 *  REFRESH_WITHIN_MS in supabase/functions/session-refresh/refresh.ts, which
 *  refuses earlier asks (the test checks the two agree). */
export const REFRESH_WITHIN_MS = 3 * 24 * 60 * 60 * 1000;

/** Is this session close enough to its end to replace it now? */
export function shouldRefreshSession(expireAt: Date | null | undefined, now: number): boolean {
  if (!expireAt) return false;
  const remaining = expireAt.getTime() - now;
  return remaining > 0 && remaining <= REFRESH_WITHIN_MS;
}

export interface RefreshSteps {
  /** The ticket for the signed-in user, or null when there is none to use. */
  fetchTicket: () => Promise<{ ticket: string; userId: string } | null>;
  /** The user signed in right now. A ticket for anyone else is not used. */
  currentUserId: string;
  signOut: () => Promise<void>;
  /** Sign in with the ticket and make that session active. Throws on failure. */
  signInWithTicket: (ticket: string) => Promise<void>;
  /** Waits between sign-in attempts. */
  sleep?: (ms: number) => Promise<void>;
}

export type RefreshOutcome =
  /** New session active. */
  | 'refreshed'
  /** Nothing changed; the old session is still active. */
  | 'no_ticket'
  | 'ticket_user_mismatch'
  | 'sign_out_failed'
  /** Signed out and the ticket never signed in: the user must sign in. */
  | 'sign_in_failed';

/** Waits before the 2nd and 3rd ticket sign-in attempts. */
const SIGN_IN_RETRY_MS = [500, 1500];

export async function runSessionRefresh(steps: RefreshSteps): Promise<RefreshOutcome> {
  const sleep = steps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let got: { ticket: string; userId: string } | null = null;
  try {
    got = await steps.fetchTicket();
  } catch {
    got = null;
  }
  if (!got) return 'no_ticket';
  if (got.userId !== steps.currentUserId) return 'ticket_user_mismatch';

  try {
    await steps.signOut();
  } catch {
    // A sign-out can throw after it has already cleared the session. One
    // ticket attempt covers that case; if the old session is in fact still
    // active, Clerk refuses the ticket and nothing has changed.
    try {
      await steps.signInWithTicket(got.ticket);
      return 'refreshed';
    } catch {
      return 'sign_out_failed';
    }
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await steps.signInWithTicket(got.ticket);
      return 'refreshed';
    } catch {
      if (attempt >= SIGN_IN_RETRY_MS.length) return 'sign_in_failed';
      await sleep(SIGN_IN_RETRY_MS[attempt]);
    }
  }
}
