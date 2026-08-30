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

/** Best-effort readable text out of anything throwable. Plain objects with a
 *  `message` field count too — not everything that reaches here is an Error. */
function detailOf(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof (raw as any).message === 'string') {
    return (raw as any).message;
  }
  return String(raw ?? '');
}

/**
 * Pull the real failure out of a supabase-js `functions.invoke` error.
 *
 * `FunctionsHttpError.message` is always the same generic "Edge Function
 * returned a non-2xx status code" — the status and the server's error body
 * live on `error.context`, which is the raw Response. Without this the
 * classifier can never see a 401 or a 429, and the console log is useless.
 * Both invoke call sites go through here so they cannot drift apart again.
 */
export async function coachInvokeErrorMessage(error: unknown): Promise<string> {
  let detail = detailOf(error);
  const ctx = (error as any)?.context;
  if (ctx) {
    if (typeof ctx.status === 'number') detail = `HTTP ${ctx.status}: ${detail}`;
    try {
      if (typeof ctx.json === 'function') {
        const body = await ctx.json();
        const inner = body?.error
          ? `${body.error}${body.debug ? ` (${body.debug})` : ''}`
          : JSON.stringify(body);
        if (inner) detail = `${detail} ${inner}`;
      }
    } catch { /* body already consumed or not JSON — status alone still helps */ }
  }
  return coachErrorMessage(detail);
}

/** A 402 the client should answer with the paywall rather than an error. */
export interface CoachCapSignal {
  kind: 'cap' | 'pro';
  /** Which allowance ran out, when the server names one ('parse', 'chat'). */
  feature?: string;
  used?: number;
  limit?: number;
}

/**
 * Read a 402 off a `functions.invoke` error, if that is what it is.
 *
 * A 402 is NOT a failure: it is the free tier's allowance running out, and it
 * must open the upgrade screen rather than a "something broke" line that
 * blames the app for the user's own plan. Returns null for anything else, so
 * callers fall through to `coachInvokeErrorMessage` unchanged.
 *
 * The body is read off a CLONE. `error.context` is the raw Response and its
 * body can only be consumed once, so reading it here directly would leave
 * coachInvokeErrorMessage with nothing to classify for every other status.
 */
export async function coachInvokeCapSignal(error: unknown): Promise<CoachCapSignal | null> {
  const ctx = (error as any)?.context;
  if (!ctx || ctx.status !== 402) return null;
  try {
    const res = typeof ctx.clone === 'function' ? ctx.clone() : ctx;
    const body = await res.json();
    if (body?.error === 'free_cap_hit') {
      return {
        kind: 'cap',
        feature: typeof body.feature === 'string' ? body.feature : undefined,
        used: Number.isFinite(body.parses_today) ? Number(body.parses_today) : undefined,
        limit: Number.isFinite(body.parse_daily_limit) ? Number(body.parse_daily_limit) : undefined,
      };
    }
    if (body?.error === 'pro_required') {
      return { kind: 'pro', feature: typeof body.feature === 'string' ? body.feature : undefined };
    }
    // drona_access_required is deliberately NOT treated as a paywall: it also
    // covers a broken or unauthenticated session, and showing someone a
    // purchase screen because their token expired is worse than a retry line.
  } catch { /* body already consumed or not JSON — fall through to the message */ }
  return null;
}

/**
 * Map any raw failure (string, Error, or unknown) to user-safe coach copy.
 * The raw detail is logged, never returned.
 */
export function coachErrorMessage(raw: unknown): string {
  const detail = detailOf(raw);

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
