/**
 * On Android a Google/Apple sign-in can be reported by two paths: the
 * sso-callback route (the deep link lands there first and activates the
 * session) and runSSO in app/(auth)/index.tsx (startSSOFlow resolves
 * afterwards). Both hold the same Clerk session id, so the first to claim it
 * sends signed_up / signed_in and the other stays quiet.
 *
 * No imports, so Deno tests it directly (lib/authEventOnce.test.ts).
 */
const claimed = new Set<string>();

export function claimAuthEvent(sessionId: string | null | undefined): boolean {
  if (!sessionId) return true;
  if (claimed.has(sessionId)) return false;
  claimed.add(sessionId);
  return true;
}

/**
 * The provider of the sign-in in progress. runSSO notes it before the browser
 * opens; when sso-callback wins the claim it takes it, so the event still says
 * google or apple. Taking clears it, and a note older than 10 minutes is
 * ignored, so a later cold-start deep link never reports an old provider.
 * runSSO clears it when it reports the sign-in itself or the user cancels;
 * after a no-session end it leaves it, since on Android the callback can
 * still finish the sign-in after runSSO has returned.
 */
const NOTE_TTL_MS = 10 * 60 * 1000;
let pending: { method: string; at: number } | null = null;

export function noteSSOMethod(method: string, now = Date.now()): void {
  pending = { method, at: now };
}

export function clearSSOMethod(): void {
  pending = null;
}

export function takeSSOMethod(now = Date.now()): string {
  const p = pending;
  pending = null;
  return p && now - p.at < NOTE_TTL_MS ? p.method : 'oauth_callback';
}
