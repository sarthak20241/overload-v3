// deno test --allow-all --no-check --unstable-sloppy-imports --import-map=lib/directFetchRetry.test-import-map.json lib/directFetchRetry.test.ts
//
// The Today pick and the weekly Drona card each build their own request with
// a token from Clerk's cache, outside the Supabase client and its retry. A
// token that went stale while the app sat in the background must get one
// retry with a fresh token here too, and a dead session must still fail.

import { assertEquals } from "jsr:@std/assert@1";
import { tokens } from "./test-shims/supabase.ts";
import { requestSuggestion } from "./dailySuggestion.ts";
import { requestWeeklyCard } from "./dronaCard.ts";

const EXPIRED = JSON.stringify({ error: "Unauthorized", debug: 'verify failed: "exp" claim timestamp check failed' });

const SUGGESTION = { day: "2026-10-22", kind: "planned", routine_id: "r1", resumes_on: null, scheduled: true, basis: "b" };
const CARD = {
  id: "c1", kind: "notice", slot: "weekly", week_start: "2026-10-19", title: "t", body: "b",
  payload: {}, status: "pending", created_at: "2026-10-22T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
};

/** A server that accepts only `good`, and records the token on every request. */
function serve(good: string, reply: unknown) {
  const seen: string[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("Authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    seen.push(token);
    return Promise.resolve(
      token === good
        ? new Response(JSON.stringify(reply), { status: 200 })
        : new Response(EXPIRED, { status: 401 }),
    );
  }) as typeof fetch;
  return seen;
}

function setTokens(cached: string | null, fresh: string | null) {
  tokens.cached = cached;
  tokens.fresh = fresh;
  tokens.freshAsked = 0;
}

const realFetch = globalThis.fetch;
const cases = [
  { name: "Today pick", call: () => requestSuggestion("Asia/Kolkata"), reply: { suggestion: SUGGESTION } },
  { name: "weekly card", call: () => requestWeeklyCard("Asia/Kolkata"), reply: { card: CARD } },
];

for (const c of cases) {
  Deno.test(`${c.name}: an expired cached token is retried once with a fresh one`, async () => {
    try {
      setTokens("stale", "fresh");
      const seen = serve("fresh", c.reply);
      const got = await c.call();
      assertEquals(seen, ["stale", "fresh"]);
      assertEquals(got !== null, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  Deno.test(`${c.name}: a dead session fails after one retry, and no retry without a new token`, async () => {
    try {
      setTokens("stale", "also-stale");
      let seen = serve("never", c.reply);
      assertEquals(await c.call(), null);
      assertEquals(seen, ["stale", "also-stale"]);

      for (const fresh of [null, "stale"]) {
        setTokens("stale", fresh);
        seen = serve("never", c.reply);
        assertEquals(await c.call(), null);
        assertEquals(seen, ["stale"]);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  Deno.test(`${c.name}: a good token goes once and never asks for a fresh one`, async () => {
    try {
      setTokens("good", "fresh");
      const seen = serve("good", c.reply);
      assertEquals((await c.call()) !== null, true);
      assertEquals(seen, ["good"]);
      assertEquals(tokens.freshAsked, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}
