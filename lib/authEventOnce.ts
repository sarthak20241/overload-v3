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
