// Silent re-sign-in before Clerk's fixed session lifetime runs out.
//
// The Hobby plan ends every Clerk session 7 days after sign-in, and the
// lifetime cannot be changed on it. Users were signed out every week, almost to
// the hour (PostHog, Sep-Oct 2026). Clerk's sign-in tokens ARE on Hobby: a
// one-time ticket the app can trade for a brand new session. So while a user
// is still signed in and their session is close to its end, the app asks here
// for a ticket and starts a fresh 7-day session with it.
//
// This mints a credential that signs someone in, so every rule below is about
// who it may be minted for:
//   - only for the user in a VERIFIED Clerk session JWT (`sub`), never for an
//     id the request names
//   - only when that JWT's own session (`sid`) is still active at Clerk and
//     belongs to that same user
//   - only inside the last REFRESH_WITHIN_MS of that session, so a stolen
//     60-second session token cannot be turned into a fresh 7-day session
//     at will, and a client calling in a loop gets nothing
// No dependencies, so the rules are tested directly (refresh.test.ts).

/** Mint only when the session ends within this window. The app uses the same
 *  number to decide when to ask (lib/sessionRefresh.ts). */
export const REFRESH_WITHIN_MS = 3 * 24 * 60 * 60 * 1000;

/** How long the ticket is valid. The app redeems it within seconds. */
export const TICKET_TTL_SECONDS = 120;

/** The parts of a Clerk Backend API session this needs. */
export interface ClerkSession {
  id: string;
  user_id: string;
  status: string;
  /** Unix ms. */
  expire_at: number;
}

export interface RefreshDeps {
  /** Verified claims of the caller's Clerk session JWT, or null with a reason. */
  verify: () => Promise<{ sub: string; sid: string } | { error: string }>;
  /** Clerk Backend API: GET /v1/sessions/{sid}. Null when it is not found. */
  getSession: (sid: string) => Promise<ClerkSession | null>;
  /** Clerk Backend API: POST /v1/sign_in_tokens. Returns the ticket. */
  mintTicket: (userId: string, ttlSeconds: number) => Promise<string>;
  now: () => number;
}

export type RefreshResult =
  | { status: 200; body: { ticket: string; user_id: string } }
  | { status: 200; body: { ticket: null; reason: string } }
  | { status: 401 | 403; body: { error: string; debug?: string } };

export async function handleRefresh(deps: RefreshDeps): Promise<RefreshResult> {
  const claims = await deps.verify();
  if ("error" in claims) {
    return { status: 401, body: { error: "Unauthorized", debug: claims.error } };
  }

  const session = await deps.getSession(claims.sid);
  if (!session || session.id !== claims.sid) {
    return { status: 403, body: { error: "session_not_found" } };
  }
  if (session.user_id !== claims.sub) {
    return { status: 403, body: { error: "session_user_mismatch" } };
  }
  if (session.status !== "active") {
    return { status: 403, body: { error: "session_not_active", debug: session.status } };
  }

  const remaining = session.expire_at - deps.now();
  if (remaining > REFRESH_WITHIN_MS) {
    // Not an error: the app asked early (its clock, or a session Clerk
    // already extended). Nothing to do, and the app carries on as it is.
    return { status: 200, body: { ticket: null, reason: "not_due" } };
  }

  const ticket = await deps.mintTicket(claims.sub, TICKET_TTL_SECONDS);
  return { status: 200, body: { ticket, user_id: claims.sub } };
}
