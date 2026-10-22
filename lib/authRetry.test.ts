// Run with: deno test --allow-all lib/authRetry.test.ts
//
// A Clerk token served stale from its cache must not read as a dead session.
// On 2026-10-21 a program build died on `"exp" claim timestamp check failed`
// and the user was told to sign in again; their next tap a minute later
// worked. These cases pin the one retry that stands in for that tap, and the
// limits that keep a really signed-out user from looping.

import { assertEquals } from "jsr:@std/assert@1";
import { freshTokenAfterExpiry, isExpiredTokenReply, sendWithFreshTokenRetry, sharedInFlight, tokenWithin, tokenWithinTimed } from "./authRetry.ts";

// The exact bodies the two servers send for an expired token.
const EDGE_EXPIRED = JSON.stringify({
  error: "Unauthorized",
  debug: 'verify failed: "exp" claim timestamp check failed',
});
const POSTGREST_EXPIRED = JSON.stringify({
  code: "PGRST303",
  details: null,
  hint: null,
  message: "JWT expired",
});

Deno.test("both servers' expired-token 401s are recognised", () => {
  assertEquals(isExpiredTokenReply(401, EDGE_EXPIRED), true);
  assertEquals(isExpiredTokenReply(401, POSTGREST_EXPIRED), true);
});

Deno.test("other 401s and non-401s are not", () => {
  assertEquals(isExpiredTokenReply(401, JSON.stringify({ error: "Unauthorized", debug: "no auth header" })), false);
  assertEquals(isExpiredTokenReply(401, JSON.stringify({ debug: "verify failed: signature verification failed" })), false);
  assertEquals(isExpiredTokenReply(403, POSTGREST_EXPIRED), false);
  assertEquals(isExpiredTokenReply(500, EDGE_EXPIRED), false);
});

/** A server that accepts only `good`, and records every token it was sent. */
function server(good: string, expiredBody = EDGE_EXPIRED) {
  const seen: string[] = [];
  const send = (token: string) => {
    seen.push(token);
    return Promise.resolve(
      token === good ? new Response("ok", { status: 200 }) : new Response(expiredBody, { status: 401 }),
    );
  };
  return { seen, send };
}

Deno.test("an expired token is replaced and the request sent again", async () => {
  const { seen, send } = server("fresh");
  const res = await sendWithFreshTokenRetry(send, "stale", () => Promise.resolve("fresh"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
  assertEquals(seen, ["stale", "fresh"]);
});

Deno.test("PostgREST's expired reply gets the same retry", async () => {
  const { seen, send } = server("fresh", POSTGREST_EXPIRED);
  const res = await sendWithFreshTokenRetry(send, "stale", () => Promise.resolve("fresh"));
  assertEquals(res.status, 200);
  assertEquals(seen, ["stale", "fresh"]);
});

Deno.test("it retries once only: a second expired reply is returned as is", async () => {
  const { seen, send } = server("never");
  const res = await sendWithFreshTokenRetry(send, "stale", () => Promise.resolve("also-stale"));
  assertEquals(res.status, 401);
  assertEquals(seen, ["stale", "also-stale"]);
});

Deno.test("no fresh token, or the same token again: no retry, body still readable", async () => {
  for (const fresh of [null, "stale"]) {
    const { seen, send } = server("never");
    const res = await sendWithFreshTokenRetry(send, "stale", () => Promise.resolve(fresh));
    assertEquals(res.status, 401);
    assertEquals(seen, ["stale"]);
    assertEquals(await res.text(), EDGE_EXPIRED);
  }
});

Deno.test("a 401 for another reason is not retried", async () => {
  const { seen, send } = server("fresh", JSON.stringify({ error: "Unauthorized", debug: "no auth header" }));
  let asked = 0;
  const res = await sendWithFreshTokenRetry(send, "stale", () => {
    asked++;
    return Promise.resolve("fresh");
  });
  assertEquals(res.status, 401);
  assertEquals(seen, ["stale"]);
  assertEquals(asked, 0);
});

Deno.test("a fresh-token fetch that throws leaves the first reply", async () => {
  const { seen, send } = server("fresh");
  const res = await sendWithFreshTokenRetry(send, "stale", () => Promise.reject(new Error("offline")));
  assertEquals(res.status, 401);
  assertEquals(seen, ["stale"]);
});

// The coach stream calls this directly instead of sendWithFreshTokenRetry.
Deno.test("freshTokenAfterExpiry: a fresh token only for an expired 401", async () => {
  const fresh = () => Promise.resolve("fresh");
  assertEquals(await freshTokenAfterExpiry(401, EDGE_EXPIRED, "stale", fresh), "fresh");
  assertEquals(await freshTokenAfterExpiry(401, POSTGREST_EXPIRED, "stale", fresh), "fresh");
  assertEquals(await freshTokenAfterExpiry(401, JSON.stringify({ debug: "no auth header" }), "stale", fresh), null);
  assertEquals(await freshTokenAfterExpiry(402, EDGE_EXPIRED, "stale", fresh), null);
  assertEquals(await freshTokenAfterExpiry(401, EDGE_EXPIRED, "stale", () => Promise.resolve("stale")), null);
  assertEquals(await freshTokenAfterExpiry(401, EDGE_EXPIRED, "stale", () => Promise.resolve(null)), null);
  assertEquals(await freshTokenAfterExpiry(401, EDGE_EXPIRED, "stale", () => Promise.reject(new Error("offline"))), null);
});

Deno.test("sharedInFlight: parallel 401s share one fresh-token fetch", async () => {
  let calls = 0;
  let release: (v: string) => void = () => {};
  const fresh = sharedInFlight(() => {
    calls++;
    return new Promise<string>((resolve) => (release = resolve));
  });
  const both = Promise.all([fresh(), fresh(), fresh()]);
  release("fresh");
  assertEquals(await both, ["fresh", "fresh", "fresh"]);
  assertEquals(calls, 1);
  // Settled: the next call asks again.
  const later = fresh();
  release("fresher");
  assertEquals(await later, "fresher");
  assertEquals(calls, 2);
});

Deno.test("tokenWithin: a hung or throwing token fetch gives null, a quick one passes", async () => {
  assertEquals(await tokenWithin(() => Promise.resolve("t"), 50), "t");
  assertEquals(await tokenWithin(() => new Promise<string | null>(() => {}), 20), null);
  assertEquals(await tokenWithin(() => Promise.reject(new Error("offline")), 50), null);
});

Deno.test("the first reply's body is released before the retry", async () => {
  let cancelled = false;
  const first = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(EDGE_EXPIRED));
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 401 },
  );
  const sends = [first, new Response("ok", { status: 200 })];
  const res = await sendWithFreshTokenRetry(() => Promise.resolve(sends.shift()!), "stale", () => Promise.resolve("fresh"));
  assertEquals(res.status, 200);
  assertEquals(first.bodyUsed || cancelled, true);
});

Deno.test("tokenWithinTimed: says whether the null came from the timeout", async () => {
  assertEquals(await tokenWithinTimed(() => Promise.resolve("t"), 50), { token: "t", timedOut: false });
  assertEquals(await tokenWithinTimed(() => new Promise<string | null>(() => {}), 20), { token: null, timedOut: true });
  assertEquals(await tokenWithinTimed(() => Promise.resolve(null), 50), { token: null, timedOut: false });
});
