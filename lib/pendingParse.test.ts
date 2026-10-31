// Run with: deno test lib/pendingParse.test.ts
//
// lib/pendingParse.ts has no imports, so Deno can test it directly.

import { assertEquals } from "jsr:@std/assert@1";
import {
  dronaLogText,
  PENDING_PARSE_MAX_AGE_MS,
  setPendingParse,
  takePendingParse,
} from "./pendingParse.ts";

const DAY = new Date(2026, 9, 30); // Fri 30 Oct 2026
const T0 = 1_000_000;

Deno.test("one letter is still a search; two is something to send", () => {
  assertEquals(dronaLogText(""), null);
  assertEquals(dronaLogText("  e "), null);
  assertEquals(dronaLogText("eg"), "eg");
  assertEquals(dronaLogText("  2  eggs and   toast "), "2 eggs and toast");
});

Deno.test("a hand-off is taken once, with its meal and day", () => {
  setPendingParse({ text: "2 eggs and toast", meal: "breakfast", day: DAY }, T0);
  const p = takePendingParse(T0 + 500);
  assertEquals(p?.text, "2 eggs and toast");
  assertEquals(p?.meal, "breakfast");
  assertEquals(p?.day.getTime(), DAY.getTime());
  // A re-focus, a second effect run: nothing left to run again.
  assertEquals(takePendingParse(T0 + 600), null);
});

Deno.test("the newer hand-off wins", () => {
  setPendingParse({ text: "oats", meal: "breakfast", day: DAY }, T0);
  setPendingParse({ text: "chicken salad", meal: "lunch", day: DAY }, T0 + 10);
  const p = takePendingParse(T0 + 20);
  assertEquals(p?.text, "chicken salad");
  assertEquals(p?.meal, "lunch");
  assertEquals(takePendingParse(T0 + 30), null);
});

Deno.test("a hand-off nobody took in time is dropped, not fired late", () => {
  setPendingParse({ text: "rice and dal", meal: "dinner", day: DAY }, T0);
  assertEquals(takePendingParse(T0 + PENDING_PARSE_MAX_AGE_MS + 1), null);
  // And it is gone, not waiting for a later take.
  assertEquals(takePendingParse(T0 + 1), null);
});

Deno.test("too little text leaves nothing waiting", () => {
  setPendingParse({ text: "x", meal: "snack", day: DAY }, T0);
  assertEquals(takePendingParse(T0), null);
});

Deno.test("the stored day is a copy, so a later change to the caller's date does not move it", () => {
  const d = new Date(DAY.getTime());
  setPendingParse({ text: "banana", meal: "snack", day: d }, T0);
  d.setDate(d.getDate() + 3);
  assertEquals(takePendingParse(T0)?.day.getTime(), DAY.getTime());
});
