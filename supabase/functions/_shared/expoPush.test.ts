// deno test --allow-all supabase/functions/_shared/expoPush.test.ts
//
// The Expo push API client: chunks, tickets, and which tokens are dead.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { deadTokens, EXPO_CHUNK, isExpoPushToken, readReceipts, sendExpoPush } from "./expoPush.ts";

type Call = { url: string; body: unknown; headers: Record<string, string> };

function fakeFetch(answer: (url: string, body: any) => unknown, calls: Call[] = [], status = 200) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(answer(url, body)), { status });
  }) as typeof fetch;
}

const tok = (i: number) => `ExponentPushToken[t${i}]`;

Deno.test("token shape: Expo tokens only", () => {
  assert(isExpoPushToken("ExponentPushToken[abc123]"));
  assert(isExpoPushToken("ExpoPushToken[abc123]"));
  assert(!isExpoPushToken("abc"));
  assert(!isExpoPushToken("ExponentPushToken[]"));
});

Deno.test("send: one result per message, in order, with ticket ids and errors", async () => {
  const calls: Call[] = [];
  const f = fakeFetch((_u, body) => ({
    data: body.map((m: any) =>
      m.to === tok(2)
        ? { status: "error", message: "not registered", details: { error: "DeviceNotRegistered", expoPushToken: m.to } }
        : { status: "ok", id: `id-${m.to}` }
    ),
  }), calls);
  const res = await sendExpoPush([1, 2, 3].map((i) => ({ to: tok(i), title: "t", body: "b" })), { fetch: f, accessToken: "sek" });
  assertEquals(res.map((r) => r.ticketId ?? null), [`id-${tok(1)}`, null, `id-${tok(3)}`]);
  assertEquals(res[1].error, "DeviceNotRegistered");
  assertEquals(deadTokens(res), [tok(2)]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://exp.host/--/api/v2/push/send");
  assertEquals(calls[0].headers.Authorization, "Bearer sek");
});

Deno.test("send: chunks of 100", async () => {
  const calls: Call[] = [];
  const f = fakeFetch((_u, body) => ({ data: body.map(() => ({ status: "ok", id: "x" })) }), calls);
  const msgs = Array.from({ length: EXPO_CHUNK * 2 + 5 }, (_, i) => ({ to: tok(i), body: "b" }));
  const res = await sendExpoPush(msgs, { fetch: f });
  assertEquals(calls.map((c) => (c.body as unknown[]).length), [100, 100, 5]);
  assertEquals(res.length, msgs.length);
  assert(!("Authorization" in calls[0].headers));
});

Deno.test("send: a failed request marks its chunk failed, never dead", async () => {
  const f = fakeFetch(() => ({ errors: [{ message: "boom" }] }), [], 500);
  const res = await sendExpoPush([{ to: tok(1), body: "b" }], { fetch: f });
  assertEquals(res[0].ticketId, undefined);
  assertEquals(res[0].error, "request_failed");
  assertEquals(deadTokens(res), []);
});

Deno.test("send: a malformed token is not sent and not called dead", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(() => ({ data: [] }), calls);
  const res = await sendExpoPush([{ to: "nope", body: "b" }], { fetch: f });
  assertEquals(calls.length, 0);
  assertEquals(res[0].error, "bad_token");
  assertEquals(deadTokens(res), []);
});

Deno.test("receipts: DeviceNotRegistered comes back by ticket id", async () => {
  const f = fakeFetch((_u, body) => ({
    data: Object.fromEntries(body.ids.map((id: string) =>
      [id, id === "b" ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok" }]
    )),
  }));
  const r = await readReceipts(["a", "b"], { fetch: f });
  assertEquals(r.a, { status: "ok", error: undefined });
  assertEquals(r.b, { status: "error", error: "DeviceNotRegistered" });
});
