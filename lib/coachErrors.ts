/**
 * Coach Drona error copy.
 *
 * Raw failures from the edge function (and from the model provider behind it)
 * are developer text: HTTP statuses, JSON blobs, provider billing notices.
 * None of that belongs in a chat bubble. Every user-visible failure goes
 * through `coachErrorMessage`, which buckets the raw detail into one short
 * line in Drona's voice and keeps the original for the console only.
 *
 * Buckets are intentionally coarse. The user only needs to know two things:
 * is this on them (offline, signed out) or on us, and is it worth retrying.
 */

const OFFLINE = "Lost the connection. Check your network and come back at me.";
const SIGNED_OUT = "Your session timed out. Sign in again and we'll pick this up.";
const BUSY = "I'm handling a lot right now. Give it a few seconds and ask again.";
const GENERIC = "Something broke on my end. Try that again in a moment.";

/**
 * Map any raw failure (string, Error, or unknown) to user-safe coach copy.
 * The raw detail is logged, never returned.
 */
export function coachErrorMessage(raw: unknown): string {
  const detail =
    raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : String(raw ?? '');

  if (detail) console.warn('[coach] request failed:', detail);

  const t = detail.toLowerCase();

  // Transport: no network, DNS, TLS, aborted socket, timeouts.
  if (
    /network error|network request failed|failed to fetch|offline|timed? ?out|timeout|econnrefused|enotfound|socket|abort/.test(t)
  ) {
    return OFFLINE;
  }

  // Auth: expired Clerk token, missing JWT, RLS rejection.
  if (/http 401|http 403|\b401\b|\b403\b|unauthorized|not signed in|jwt|authentication/.test(t)) {
    return SIGNED_OUT;
  }

  // Capacity: provider rate limits and overload, or our own throttle.
  if (/http 429|\b429\b|\b529\b|rate.?limit|overloaded|too many requests|quota/.test(t)) {
    return BUSY;
  }

  // Everything else — 4xx/5xx, provider billing, malformed responses, missing
  // config. All of it is our problem, and none of it is the user's business.
  return GENERIC;
}
