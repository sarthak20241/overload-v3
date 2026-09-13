// Run with: deno test supabase/functions/_shared/retried.test.ts
//
// The midnight run retries PostgREST calls that failed transiently (a 5xx, or
// no status at all) and fails fast on anything that would fail the same again.

import { assertEquals } from "jsr:@std/assert@1";
import { retried } from "./retried.ts";

type R = { error: { message: string } | null; status?: number; data?: string };
const noWait = () => Promise.resolve();
const script = (...answers: R[]) => {
  let calls = 0;
  return { call: () => Promise.resolve(answers[Math.min(calls++, answers.length - 1)]), count: () => calls };
};

Deno.test("a 504 is retried and the later success is returned", async () => {
  const s = script({ error: { message: "Gateway Timeout" }, status: 504 }, { error: null, status: 200, data: "ok" });
  const r = await retried(s.call, 3, noWait);
  assertEquals(r.data, "ok");
  assertEquals(s.count(), 2);
});

Deno.test("a request that never got a status is retried", async () => {
  const s = script({ error: { message: "fetch failed" } }, { error: null, status: 200 });
  await retried(s.call, 3, noWait);
  assertEquals(s.count(), 2);
});

Deno.test("a 4xx fails fast: it would fail the same way again", async () => {
  const s = script({ error: { message: "duplicate key" }, status: 409 });
  const r = await retried(s.call, 3, noWait);
  assertEquals(r.status, 409);
  assertEquals(s.count(), 1);
});

Deno.test("a persistent 5xx gives up after the attempts", async () => {
  const s = script({ error: { message: "Gateway Timeout" }, status: 504 });
  const r = await retried(s.call, 3, noWait);
  assertEquals(r.status, 504);
  assertEquals(s.count(), 3);
});

Deno.test("a success is not repeated", async () => {
  const s = script({ error: null, status: 200 });
  await retried(s.call, 3, noWait);
  assertEquals(s.count(), 1);
});
