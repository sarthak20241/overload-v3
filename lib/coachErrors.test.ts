// Run with: deno test --allow-all lib/coachErrors.test.ts
//
// lib/coachErrors.ts has no imports, so Deno can test it directly even though
// the rest of the app is Metro-only — same reason lib/xp.test.ts works.
//
// What matters here is not the wording, it is WHICH BUCKET a failure lands in.
// The buckets answer one question for the user: is this on them (network, a
// dead session) or on us. Getting that backwards is what this file guards:
// a meal parse that never left the device, because Clerk could not produce a
// token in time, was reported as "Something broke on my end" — our server
// taking the blame for a slow connection, with Retry the only thing on offer.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { coachErrorMessage, coachInvokeErrorMessage } from "./coachErrors.ts";

const OFFLINE = "Lost the connection. Check your network and come back at me.";
const SIGNED_OUT = "Your session timed out. Sign in again and we'll pick this up.";
const BUSY = "I'm handling a lot right now. Give it a few seconds and ask again.";
const GENERIC = "Something broke on my end. Try that again in a moment.";

/** The supabase-js error classes, reproduced. The real ones live in
 *  @supabase/functions-js, which is an npm import this suite deliberately does
 *  not reach for (see the no --node-modules-dir note in deploy-functions.yml).
 *  Only two things about them matter and both are asserted below: the message
 *  is a fixed generic string, and the real cause is on `context`. */
class FunctionsError extends Error {
  context: unknown;
  constructor(message: string, name: string, context?: unknown) {
    super(message);
    this.name = name;
    this.context = context;
  }
}
class FunctionsFetchError extends FunctionsError {
  constructor(context: unknown) {
    super("Failed to send a request to the Edge Function", "FunctionsFetchError", context);
  }
}
class FunctionsHttpError extends FunctionsError {
  constructor(context: unknown) {
    super("Edge Function returned a non-2xx status code", "FunctionsHttpError", context);
  }
}

/** Enough of a Response for the classifier: a status and a readable body. */
function fakeResponse(status: number, body: unknown) {
  return { status, json: () => Promise.resolve(body) };
}

// The two strings lib/supabase.ts's fetch wrapper can throw. They are copied
// rather than imported because that module pulls in Clerk and expo-secure-store.
// If you change the wording there, change it here — and keep a word the offline
// bucket matches, which is the whole point of this test.
const AUTH_THROWS = [
  "Auth token timed out after 10000ms (slow connection?)",
  "No auth token available (offline?)",
];

Deno.test("a request that never left the device reads as a network problem, not ours", async () => {
  for (const message of AUTH_THROWS) {
    const err = new FunctionsFetchError(new Error(message));
    assertEquals(
      await coachInvokeErrorMessage(err),
      OFFLINE,
      `"${message}" must reach the offline bucket, not blame the server`,
    );
  }
});

Deno.test("the outer FunctionsFetchError message alone is unclassifiable", () => {
  // Proof that the context read above is load-bearing rather than decorative:
  // this is exactly what the classifier saw before, and it has no bucket.
  assertEquals(coachErrorMessage("Failed to send a request to the Edge Function"), GENERIC);
});

Deno.test("a real HTTP failure still classifies off the Response", async () => {
  assertEquals(
    await coachInvokeErrorMessage(new FunctionsHttpError(fakeResponse(401, { error: "unauthorized" }))),
    SIGNED_OUT,
  );
  assertEquals(
    await coachInvokeErrorMessage(new FunctionsHttpError(fakeResponse(429, { error: "rate_limited" }))),
    BUSY,
  );
  // 402 drona_access_required is deliberately not a paywall (see the note on
  // coachInvokeCapSignal) and has no bucket of its own, so it stays generic.
  assertEquals(
    await coachInvokeErrorMessage(new FunctionsHttpError(fakeResponse(402, { error: "drona_access_required" }))),
    GENERIC,
  );
});

Deno.test("an unreadable context is left out rather than stringified", async () => {
  // detailOf would turn a bare object into "[object Object]", which tells the
  // classifier nothing and makes the console log worse than silence.
  const err = new FunctionsFetchError({ nothing: "useful" });
  assertEquals(await coachInvokeErrorMessage(err), GENERIC);
});

Deno.test("the cause is kept in the detail, not swapped for it", async () => {
  // The status and the cause both survive, so the console log still names the
  // call that failed instead of only why.
  let logged = "";
  const warn = console.warn;
  console.warn = (..._a: unknown[]) => { logged = String(_a[1] ?? ""); };
  try {
    await coachInvokeErrorMessage(new FunctionsFetchError(new Error("Network request failed")));
  } finally {
    console.warn = warn;
  }
  assertStringIncludes(logged, "Failed to send a request to the Edge Function");
  assertStringIncludes(logged, "Network request failed");
});
