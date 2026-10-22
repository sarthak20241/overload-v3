/**
 * One retry with a fresh Clerk token when the server says the token expired.
 *
 * Clerk's session token lives 60 seconds and getToken() serves it from a cache.
 * After the app has sat in the background, that cache can hand back a token
 * that is already past `exp`: the server rejects it with a 401 before doing
 * anything, and the user is told to sign in again while their session is
 * perfectly alive. In production this cut a program build short ("exp" claim
 * timestamp check failed), and the user's next tap a minute later worked.
 *
 * The fix is the retry the user would have done, done for them: on a 401 that
 * names an expired token, ask Clerk for a fresh token with the cache skipped,
 * and send the same request once more. Once, so a genuinely dead session
 * still fails and still reaches the sign-in copy.
 *
 * No imports, so Deno can test it directly (lib/authRetry.test.ts).
 */

/**
 * Does this 401 body say the token expired? Both servers we talk to say so in
 * their own words:
 *   - our edge functions (jose): `"exp" claim timestamp check failed`
 *   - PostgREST:                 `JWT expired`
 * Any other 401 (no token, bad signature) is not something a fresh token from
 * the same session fixes, so it is not retried.
 */
export function isExpiredTokenReply(status: number, body: string): boolean {
  if (status !== 401) return false;
  // `exp\\?"` because the edge function's reason arrives inside a JSON string,
  // where its quotes are escaped: `\"exp\" claim`.
  return /exp\\?" claim|jwt expired/i.test(body);
}

/**
 * The token to retry with, or null when this reply is not one to retry.
 *
 * Null for anything but an expired-token 401, when Clerk cannot produce a
 * token, and when it hands back the same token (resending it would only fail
 * again). Callers retry at most once, so a dead session fails on the second
 * 401 and reaches the sign-in copy. Both retry paths decide here: the fetch
 * wrapper through `sendWithFreshTokenRetry`, the coach stream directly.
 */
export async function freshTokenAfterExpiry(
  status: number,
  body: string,
  token: string,
  freshToken: () => Promise<string | null>,
): Promise<string | null> {
  if (!isExpiredTokenReply(status, body)) return null;
  let next: string | null = null;
  try {
    next = await freshToken();
  } catch {
    next = null;
  }
  return next && next !== token ? next : null;
}

/**
 * Send with `token`; on an expired-token 401, send once more with a fresh one.
 *
 * `send` must build the whole request from the token it is given, so the retry
 * is the same request with only the header changed. The first response's body
 * is read from a clone, so when there is no retry the caller still gets a
 * response it can read.
 */
export async function sendWithFreshTokenRetry(
  send: (token: string) => Promise<Response>,
  token: string,
  freshToken: () => Promise<string | null>,
): Promise<Response> {
  const first = await send(token);
  if (first.status !== 401) return first;
  let body = '';
  try {
    body = await first.clone().text();
  } catch {
    return first;
  }
  const next = await freshTokenAfterExpiry(first.status, body, token, freshToken);
  if (!next) return first;
  // Only the clone was read. Release the first reply before replacing it, so
  // it holds no connection or buffer open.
  try {
    await first.body?.cancel();
  } catch { /* already closed, or no stream body: nothing to release */ }
  return send(next);
}

/**
 * Wrap `fn` so calls made while one is still running share its promise.
 *
 * After the app comes back from the background, a screen fires many requests
 * at once with the same stale token, and every one of them 401s. Without this,
 * each would ask Clerk for its own fresh token: a burst of identical fetches.
 * Once the shared call settles, the next call starts a new one.
 */
export function sharedInFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = fn().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

/** How long a fresh-token fetch may take before the retry is given up. Sized
 *  like lib/supabase.ts's TOKEN_BUDGET_MS: a cold refresh on mobile. */
export const FRESH_TOKEN_BUDGET_MS = 10000;

/**
 * `getToken`, but null after `ms` or on a throw instead of hanging or failing.
 * Clerk blocks on a refresh it cannot finish offline; without a bound the
 * request that is waiting to retry would wait with it.
 */
export async function tokenWithin(
  getToken: () => Promise<string | null>,
  ms: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getToken(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
