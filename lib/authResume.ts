// Sign-in screen helpers with no imports, so Deno can test them
// (lib/authResume.test.ts).
//
// Why: on Android the app can restart while the user is away reading the
// sign-up code email. The screen's own state (mode, email, name) lives only in
// memory, so it came back empty in 'login' mode and the code step was lost.
// Clerk keeps the unfinished sign-up on its client across the restart, so the
// screen can ask Clerk and reopen the code step.

/** The parts of Clerk's SignUpResource this file reads. */
export type SignUpLike = {
  status?: string | null;
  unverifiedFields?: readonly string[] | null;
  emailAddress?: string | null;
  firstName?: string | null;
  abandonAt?: number | null;
  verifications?: {
    emailAddress?: { status?: string | null; strategy?: string | null } | null;
  } | null;
} | null | undefined;

export type PendingEmailSignUp = { email: string; firstName: string | null };

/**
 * An email sign-up that is waiting for its 6-digit code, or null.
 * Only a sign-up whose email code was already sent counts: before that there
 * is no code to type, and an OAuth sign-up has no code at all. An expired code
 * still counts, because "Resend code" on that step sends a new one.
 */
export function pendingEmailSignUp(su: SignUpLike, now: number = Date.now()): PendingEmailSignUp | null {
  if (!su || su.status !== 'missing_requirements') return null;
  if (!su.emailAddress) return null;
  if (!(su.unverifiedFields ?? []).includes('email_address')) return null;
  if (su.abandonAt != null && su.abandonAt <= now) return null;
  const v = su.verifications?.emailAddress;
  if (v?.strategy !== 'email_code') return null;
  if (v.status !== 'unverified' && v.status !== 'expired') return null;
  return { email: su.emailAddress, firstName: su.firstName ?? null };
}

const DETAIL_MAX = 120;

/**
 * Properties for the auth_failed event. A Clerk error keeps its code as the
 * reason. Anything else (the screen's own checks such as an empty name, a short
 * password or an empty code, or a network error) stays reason 'unknown', as
 * before, and adds the message as `detail` so the failures can be told apart.
 * The screen's own messages hold no personal data.
 */
export function authFailProps(method: string, err: unknown): { method: string; reason: string; detail?: string } {
  const e = err as { errors?: { code?: string }[]; message?: unknown } | null | undefined;
  const code = e?.errors?.[0]?.code;
  if (code) return { method, reason: code };
  const message = typeof e?.message === 'string' ? e.message.trim() : '';
  return message ? { method, reason: 'unknown', detail: message.slice(0, DETAIL_MAX) } : { method, reason: 'unknown' };
}
