// Run with: deno test --allow-all lib/ssoOutcome.test.ts
//
// lib/ssoOutcome.ts has no imports, so Deno can test it directly. The shapes
// below mirror what @clerk/clerk-expo 2.x useSSO().startSSOFlow resolves with.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { classifySSO, shouldReloadSSO, SIGN_IN_INCOMPLETE_COPY, ssoDetail, ssoErrorCopy, type SSOOutcome } from "./ssoOutcome.ts";

const success = { type: "success" };

Deno.test("a created session signs in, from either signIn or a transfer signUp", () => {
  assertEquals(classifySSO({ createdSessionId: "sess_1", authSessionResult: success }), { kind: "session", sessionId: "sess_1" });
  assertEquals(
    classifySSO({ createdSessionId: null, authSessionResult: success, signUp: { status: "complete", createdSessionId: "sess_2" } }),
    { kind: "session", sessionId: "sess_2" },
  );
  // After our own signIn.reload() the result object carries the fresh signIn.
  assertEquals(
    classifySSO({ createdSessionId: null, authSessionResult: success, signIn: { status: "complete", createdSessionId: "sess_3" } }),
    { kind: "session", sessionId: "sess_3" },
  );
});

Deno.test("Clerk not loaded yet: no browser result, so not ready, not a setup problem", () => {
  // startSSOFlow returns { createdSessionId: null, authSessionResult: null }
  // straight away when useSignIn/useSignUp are not loaded.
  const o = classifySSO({ createdSessionId: null, authSessionResult: null, signIn: null, signUp: null });
  assertEquals(o, { kind: "not_ready" });
  assertEquals(shouldReloadSSO(o), false);
});

Deno.test("backing out of the browser is silent", () => {
  for (const type of ["cancel", "dismiss"]) {
    const o = classifySSO({ createdSessionId: null, authSessionResult: { type } });
    assertEquals(o, { kind: "cancelled" });
    assertEquals(ssoErrorCopy(o, "Google"), null);
  }
});

Deno.test("a browser that ends in another state is a failed browser step", () => {
  assertEquals(classifySSO({ createdSessionId: null, authSessionResult: { type: "locked" } }), { kind: "browser_failed", browserResult: "locked" });
});

Deno.test("an account with 2FA goes to the code step, with no error shown", () => {
  const o = classifySSO({ createdSessionId: null, authSessionResult: success, signIn: { status: "needs_second_factor" } });
  assertEquals(o, { kind: "second_factor" });
  assertEquals(ssoErrorCopy(o, "Google"), null);
  assertEquals(shouldReloadSSO(o), false);
});

Deno.test("a sign-up missing fields names them for analytics, not the user", () => {
  const o = classifySSO({
    createdSessionId: null,
    authSessionResult: success,
    signIn: { status: "needs_identifier", firstFactorVerification: { status: "transferable" } },
    signUp: { status: "missing_requirements", missingFields: ["username"] },
  });
  assertEquals(o, { kind: "missing_fields", fields: ["username"] });
  assert(!ssoErrorCopy(o, "Apple")!.includes("username"));
});

Deno.test("a provider error on the first factor is its own kind and is not retried", () => {
  const o = classifySSO({
    createdSessionId: null,
    authSessionResult: success,
    signIn: { status: "needs_first_factor", firstFactorVerification: { status: "failed", error: { code: "oauth_access_denied" } } },
  });
  assertEquals(o, { kind: "provider_error", code: "oauth_access_denied" });
  assertEquals(shouldReloadSSO(o), false);
});

Deno.test("2026-10-22: browser came back, reload left no session and no reason: retry once quietly", () => {
  // The owner's first Google try on the sim: Google sign-in page, redirect
  // back, the app's GET /v1/client/sign_ins/sia_..., then no session.
  const r = {
    createdSessionId: null,
    authSessionResult: success,
    signIn: { status: "needs_first_factor", createdSessionId: null, firstFactorVerification: { status: "unverified", error: null } },
    signUp: { status: null, createdSessionId: null },
  };
  const o = classifySSO(r);
  assertEquals(o, { kind: "no_session" });
  assertEquals(shouldReloadSSO(o), true);
  assertEquals(ssoDetail(r), "browser=success signIn=needs_first_factor firstFactor=unverified firstFactorError=none signUp=none");
});

Deno.test("no copy a user can see carries setup words, Clerk detail, or an em dash", () => {
  const outcomes: SSOOutcome[] = [
    { kind: "not_ready" },
    { kind: "missing_fields", fields: ["username", "phone_number"] },
    { kind: "browser_failed", browserResult: "locked" },
    { kind: "provider_error", code: "oauth_access_denied" },
    { kind: "no_session" },
  ];
  const banned = /clerk|allowlist|redirect|dashboard|url|status|locked|oauth|username|phone_number|—/i;
  for (const o of outcomes) {
    for (const p of ["Google", "Apple"] as const) {
      const copy = ssoErrorCopy(o, p);
      assert(copy, `${o.kind} should tell the user something`);
      assert(!banned.test(copy), `${o.kind}/${p}: "${copy}"`);
    }
  }
  assert(!banned.test(SIGN_IN_INCOMPLETE_COPY));
});
