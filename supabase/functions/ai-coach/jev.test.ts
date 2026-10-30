// Run with: deno test supabase/functions/ai-coach/jev.test.ts
//
// Jev was the one paid model that never reached token_usage_log: every intent
// check, memory gate, brand check and page judgment went unpriced. onUsage is
// how a caller learns what one call used.

import { assertEquals } from "jsr:@std/assert@1";
import { askJev, JEV_MODEL, type JevUsage } from "./jev.ts";

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
  assertEquals({ ...seen[0], latency_ms: 0 }, { model: "jev-1.13.0", served_model: "jev-1.13.0", input_tokens: 812, output_tokens: 3, questions: 1, latency_ms: 0 });
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

Deno.test("a retried call reports once, for the attempt that answered", async () => {
  const seen: JevUsage[] = [];
  let calls = 0;
  const flaky = (() => {
    calls += 1;
    return Promise.resolve(calls === 1
      ? new Response("busy", { status: 429, headers: { "retry-after": "0" } })
      : new Response(JSON.stringify({ model: "jev-1.13.0", answers: { food: { value: 0.9 } }, usage: { input_tokens: 40, output_tokens: 1 } }), { status: 200 }));
  }) as typeof fetch;
  const r = await askJev("two eggs", question, { apiKey: "k", timeoutMs: 1000, fetchFn: flaky, onUsage: (u) => seen.push(u) });
  assertEquals([r.ok, calls, seen.length, seen[0].input_tokens], [true, 2, 1, 40]);
  // timed from the answering attempt, not from before the 250 ms backoff
  assertEquals(seen[0].latency_ms < 200, true);
});

// A model bump without a price row logs every call at $0 (compute_token_cost
// returns 0 for an unknown model). Pin that the pinned model has one.
Deno.test("the pinned Jev model has a model_pricing row", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  let priced = false;
  for await (const f of Deno.readDir(dir)) {
    if (!f.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(new URL(f.name, dir));
    if (sql.includes("model_pricing") && sql.includes(`'${JEV_MODEL}'`)) priced = true;
  }
  assertEquals(priced, true, `add a model_pricing row for ${JEV_MODEL}`);
});

// Priced by the model we asked for: an echoed id with no model_pricing row
// would read as free. The id that answered is kept apart for the logs.
Deno.test("usage is priced under the pinned model, with the served id kept apart", async () => {
  const seen: JevUsage[] = [];
  await askJev("two eggs", question, {
    apiKey: "k", timeoutMs: 1000,
    fetchFn: replying(200, { model: "jev-1.13.0-20261101", answers: { food: { value: 0.9 } }, usage: { input_tokens: 9, output_tokens: 1 } }),
    onUsage: (u) => seen.push(u),
  });
  assertEquals([seen[0].model, seen[0].served_model], [JEV_MODEL, "jev-1.13.0-20261101"]);
});
