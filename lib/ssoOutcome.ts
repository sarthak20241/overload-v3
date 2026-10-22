// What a Clerk useSSO() startSSOFlow() call ended in, and what the sign-in
// screen says about it.
//
// startSSOFlow resolves without throwing in several states that are not a
// signed-in user, and createdSessionId is null in all of them:
//   - Clerk had not loaded yet: it returns at once, authSessionResult null,
//     and the browser never opens.
//   - The browser closed without a redirect: cancel / dismiss / other type.
//   - The browser came back, signIn.reload() ran, and the attempt still is not
//     complete: needs_second_factor, a sign-up missing fields, a provider
//     error on the first factor, or no reason Clerk states.
// The screen used to collapse every "browser came back" case into one setup
// instruction ("Add the redirect URL to your Clerk allowlist") shown to users.
// classifySSO names each case so the screen can take the right next step, and
// ssoErrorCopy holds the words a user sees. The technical detail goes to
// analytics via ssoDetail, never to the screen.
//
// No imports, so Deno can test it directly (lib/ssoOutcome.test.ts).

type VerificationLike = {
  status?: string | null;
  error?: { code?: string; message?: string; longMessage?: string } | null;
} | null;

export type SSOResultLike = {
  createdSessionId?: string | null;
  authSessionResult?: { type?: string } | null;
  signIn?: {
    status?: string | null;
    createdSessionId?: string | null;
    firstFactorVerification?: VerificationLike;
  } | null;
  signUp?: {
    status?: string | null;
    createdSessionId?: string | null;
    missingFields?: string[];
  } | null;
};

export type SSOOutcome =
  | { kind: 'session'; sessionId: string }
  | { kind: 'cancelled' }
  | { kind: 'not_ready' }
  | { kind: 'second_factor' }
  | { kind: 'missing_fields'; fields: string[] }
  | { kind: 'browser_failed'; browserResult: string }
  | { kind: 'provider_error'; code: string }
  | { kind: 'no_session' };

export function classifySSO(r: SSOResultLike): SSOOutcome {
  // Same precedence as useSSO: a transfer sign-up's session wins.
  const sessionId = r.createdSessionId || r.signUp?.createdSessionId || r.signIn?.createdSessionId;
  if (sessionId) return { kind: 'session', sessionId };

  const browser = r.authSessionResult;
  if (!browser) return { kind: 'not_ready' };
  if (browser.type === 'cancel' || browser.type === 'dismiss') return { kind: 'cancelled' };
  if (browser.type !== 'success') return { kind: 'browser_failed', browserResult: String(browser.type) };

  if (r.signIn?.status === 'needs_second_factor') return { kind: 'second_factor' };
  if (r.signUp?.status === 'missing_requirements') {
    return { kind: 'missing_fields', fields: r.signUp.missingFields ?? [] };
  }
  const code = r.signIn?.firstFactorVerification?.error?.code;
  if (code) return { kind: 'provider_error', code };
  return { kind: 'no_session' };
}

// Only a bare no_session is worth one quiet signIn.reload(): every other kind
// is either done, the user's choice, or a state a reload will not change.
export function shouldReloadSSO(o: SSOOutcome): boolean {
  return o.kind === 'no_session';
}

// What we send to analytics and the console. Never shown to the user.
export function ssoDetail(r: SSOResultLike): string {
  const v = r.signIn?.firstFactorVerification;
  return [
    `browser=${r.authSessionResult?.type ?? 'none'}`,
    `signIn=${r.signIn?.status ?? 'none'}`,
    `firstFactor=${v?.status ?? 'none'}`,
    `firstFactorError=${v?.error?.code ?? 'none'}`,
    `signUp=${r.signUp?.status ?? 'none'}`,
  ].join(' ');
}

// What the user reads. null means show nothing (signed in, backed out, or a
// next step that has its own screen).
export function ssoErrorCopy(o: SSOOutcome, provider: 'Google' | 'Apple'): string | null {
  switch (o.kind) {
    case 'session':
    case 'cancelled':
    case 'second_factor':
      return null;
    case 'not_ready':
      return 'Give me a second to get ready, then tap that again.';
    case 'missing_fields':
      return `${provider} didn't share everything I need to set you up. Try signing up with your email instead.`;
    case 'browser_failed':
    case 'provider_error':
    case 'no_session':
      return `That ${provider} sign-in didn't go through. Tap Continue with ${provider} to try again.`;
  }
}

// Password sign-in that came back unfinished for a reason we have no screen
// for. Same voice as above; the status goes to analytics, not here.
export const SIGN_IN_INCOMPLETE_COPY = "That sign-in didn't go through. Try again in a moment.";
