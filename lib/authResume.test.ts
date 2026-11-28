// Run with: deno test --allow-all lib/authResume.test.ts
//
// lib/authResume.ts has no imports, so Deno can test it directly. The shapes
// below mirror Clerk's SignUpResource (@clerk/clerk-expo 2.x useSignUp()).
//
// The bug (2026-11-27, Android): the code was sent, the user left the app to
// read the email, the app came back from a cold start, and the sign-in screen
// opened empty in 'login' mode. Clerk still held the unfinished sign-up, but
// nothing brought the code step back, so the user gave up.

import { assertEquals } from "jsr:@std/assert@1";
import { authFailProps, pendingEmailSignUp } from "./authResume.ts";

const NOW = 1_800_000_000_000;

function waitingForCode(over: Record<string, unknown> = {}) {
  return {
    status: "missing_requirements",
    unverifiedFields: ["email_address"],
    emailAddress: "sam@example.com",
    firstName: "Sam",
    lastName: null,
    abandonAt: NOW + 60_000,
    verifications: { emailAddress: { status: "unverified", strategy: "email_code" } },
    ...over,
  };
}

Deno.test("a sign-up whose email code was sent comes back as the code step", () => {
  assertEquals(pendingEmailSignUp(waitingForCode(), NOW), { email: "sam@example.com", firstName: "Sam" });
});

Deno.test("an expired code still comes back, so Resend can send a new one", () => {
  const su = waitingForCode({ verifications: { emailAddress: { status: "expired", strategy: "email_code" } } });
  assertEquals(pendingEmailSignUp(su, NOW), { email: "sam@example.com", firstName: "Sam" });
});

Deno.test("nothing to resume: no sign-up, a finished one, or an abandoned one", () => {
  assertEquals(pendingEmailSignUp(null, NOW), null);
  assertEquals(pendingEmailSignUp(undefined, NOW), null);
  assertEquals(pendingEmailSignUp({ status: null }, NOW), null);
  assertEquals(pendingEmailSignUp(waitingForCode({ status: "complete" }), NOW), null);
  assertEquals(pendingEmailSignUp(waitingForCode({ status: "abandoned" }), NOW), null);
  // Clerk drops an unfinished sign-up at abandonAt.
  assertEquals(pendingEmailSignUp(waitingForCode({ abandonAt: NOW - 1 }), NOW), null);
});

Deno.test("only an email-code step resumes; a code was never sent, or the email is verified", () => {
  // signUp.create ran but prepareEmailAddressVerification never did.
  assertEquals(
    pendingEmailSignUp(waitingForCode({ verifications: { emailAddress: { status: null, strategy: null } } }), NOW),
    null,
  );
  // A Google/Apple sign-up in progress has no email code to type.
  assertEquals(
    pendingEmailSignUp(waitingForCode({ verifications: { emailAddress: { status: "unverified", strategy: "email_link" } } }), NOW),
    null,
  );
  assertEquals(pendingEmailSignUp(waitingForCode({ unverifiedFields: [] }), NOW), null);
  assertEquals(pendingEmailSignUp(waitingForCode({ emailAddress: null }), NOW), null);
});

Deno.test("Clerk errors keep their code as the reason", () => {
  const err = { errors: [{ code: "form_code_incorrect", longMessage: "Incorrect code" }], message: "Incorrect code" };
  assertEquals(authFailProps("verify", err), { method: "verify", reason: "form_code_incorrect" });
});

Deno.test("the app's own checks say which one failed instead of 'unknown' alone", () => {
  assertEquals(authFailProps("register", new Error("Please enter your name")), {
    method: "register",
    reason: "unknown",
    detail: "Please enter your name",
  });
  assertEquals(authFailProps("verify", new Error("Enter the 6-digit code from your email")).detail, "Enter the 6-digit code from your email");
  // Long or odd errors are cut short; a missing message stays out.
  assertEquals(authFailProps("login", new Error("x".repeat(300))).detail?.length, 120);
  assertEquals(authFailProps("login", {}), { method: "login", reason: "unknown" });
  assertEquals(authFailProps("login", null), { method: "login", reason: "unknown" });
});
