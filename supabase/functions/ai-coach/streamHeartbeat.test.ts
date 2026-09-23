// Run with: deno test --allow-all supabase/functions/ai-coach/streamHeartbeat.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { HEARTBEAT_FRAME, startHeartbeat } from "./streamHeartbeat.ts";

Deno.test("pings at once, then every 2 seconds, and stops when told", () => {
  using time = new FakeTime();
  const frames: string[] = [];
  const stop = startHeartbeat((f) => frames.push(f));
  assertEquals(frames.length, 1);
  time.tick(1999);
  assertEquals(frames.length, 1);
  time.tick(1);
  assertEquals(frames.length, 2);
  time.tick(6000);
  assertEquals(frames.length, 5);
  stop();
  time.tick(10_000);
  assertEquals(frames.length, 5);
});

Deno.test("a client that hung up does not break the heartbeat or the parse", () => {
  using time = new FakeTime();
  let calls = 0;
  const stop = startHeartbeat(() => { calls++; throw new Error("stream closed"); });
  time.tick(4000);
  assertEquals(calls, 3);
  stop();
});

Deno.test("the ping is an SSE comment the app's parser skips", () => {
  // The app splits on a blank line and needs BOTH an `event:` and a `data:`
  // line before it acts on a frame (lib/dietData.ts parseMealStreaming).
  const frame = HEARTBEAT_FRAME.slice(0, HEARTBEAT_FRAME.indexOf("\n\n"));
  assertEquals(frame.startsWith(":"), true);
  assertEquals(frame.split("\n").some((l) => l.startsWith("event:") || l.startsWith("data:")), false);
});
