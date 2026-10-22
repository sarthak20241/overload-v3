// Run with: deno test --allow-all lib/authRetry.test.ts
//
// A Clerk token served stale from its cache must not read as a dead session.
// On 2026-10-21 a program build died on `"exp" claim timestamp check failed`
// and the user was told to sign in again; their next tap a minute later
// worked. These cases pin the one retry that stands in for that tap, and the
// limits that keep a really signed-out user from looping.

import { assertEquals } from "jsr:@std/assert@1";
import { isExpiredTokenReply, sendWithFreshTokenRetry } from "./authRetry.ts";

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
