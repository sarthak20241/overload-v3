// Run with: deno test supabase/functions/ai-coach/jev.test.ts
//
// Jev was the one paid model that never reached token_usage_log: every intent
// check, memory gate, brand check and page judgment went unpriced. onUsage is
// how a caller learns what one call used.

import { assertEquals } from "jsr:@std/assert@1";
import { askJev, type JevUsage } from "./jev.ts";

const question = { food: { type: "noul" as const, instructions: "Is this food?" } };

const replying = (status: number, body: unknown): typeof fetch =>
  (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch;

Deno.test("a successful call reports its usage once", async () => {
  const seen: JevUsage[] = [];
  const r = await askJev("two eggs", question, {
    apiKey: "k", timeoutMs: 1000,
    fetchFn: replying(200, { model: "jev-1.13.0", answers: { food: { value: 0.9 } }, usage: { input_tokens: 812, output_tokens: 3 } }),
    onUsage: (u) => seen.push(u),
  });
  assertEquals(r.ok, true);
  assertEquals(seen.length, 1);
  assertEquals({ ...seen[0], latency_ms: 0 }, { model: "jev-1.13.0", input_tokens: 812, output_tokens: 3, questions: 1, latency_ms: 0 });
});

Deno.test("a failed call reports nothing", async () => {
  const seen: JevUsage[] = [];
  const r = await askJev("two eggs", question, {
    apiKey: "k", timeoutMs: 1000, fetchFn: replying(401, { error: "no" }), onUsage: (u) => seen.push(u),
  });
  assertEquals(r.ok, false);
  assertEquals(seen.length, 0);
});

Deno.test("a usage hook that throws never costs the answer", async () => {
  const r = await askJev("two eggs", question, {
    apiKey: "k", timeoutMs: 1000,
    fetchFn: replying(200, { model: "jev-1.13.0", answers: { food: { value: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } }),
    onUsage: () => { throw new Error("logger down"); },
  });
  assertEquals(r.ok, true);
});

Deno.test("a body without usage still answers, and reports zero tokens", async () => {
  const seen: JevUsage[] = [];
  await askJev("two eggs", question, {
    apiKey: "k", timeoutMs: 1000, model: "jev-x",
    fetchFn: replying(200, { answers: { food: { value: 0.9 } } }),
    onUsage: (u) => seen.push(u),
  });
  assertEquals([seen[0].model, seen[0].input_tokens, seen[0].output_tokens], ["jev-x", 0, 0]);
});
