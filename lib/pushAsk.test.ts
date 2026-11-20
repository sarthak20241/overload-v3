// deno test --allow-all lib/pushAsk.test.ts
//
// When the app asks for push permission (not on first open: after a food log
// on a second day), and where a tapped push lands.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { ASK_COPY, askDecision, noteFoodDay, pushRoute, REASK_AFTER_DAYS } from "./pushAsk.ts";

const NOW = "2026-11-20T10:00:00Z";

Deno.test("food days: distinct, newest kept, at most 14", () => {
  let d: string[] = [];
  d = noteFoodDay(d, "2026-11-01");
  d = noteFoodDay(d, "2026-11-01");
  assertEquals(d, ["2026-11-01"]);
  for (let i = 2; i <= 20; i++) d = noteFoodDay(d, `2026-11-${String(i).padStart(2, "0")}`);
  assertEquals(d.length, 14);
  assertEquals(d[d.length - 1], "2026-11-20");
  assert(!d.includes("2026-11-01"));
});

Deno.test("first day of logging: wait (never on first open, never on day one)", () => {
  assertEquals(askDecision({ days: ["2026-11-20"], askedAt: null, perm: "undetermined", now: NOW }), "wait");
  assertEquals(askDecision({ days: [], askedAt: null, perm: "undetermined", now: NOW }), "wait");
});

Deno.test("a log on a second day: ask", () => {
  assertEquals(askDecision({ days: ["2026-11-19", "2026-11-20"], askedAt: null, perm: "undetermined", now: NOW }), "ask");
});

Deno.test("already granted (trial reminder, Drona build): just save the token", () => {
  assertEquals(askDecision({ days: [], askedAt: null, perm: "granted", now: NOW }), "sync");
});

Deno.test("denied, blocked, or no native module: never ask", () => {
  for (const perm of ["denied", "missing"] as const) {
    assertEquals(askDecision({ days: ["2026-11-19", "2026-11-20"], askedAt: null, perm, now: NOW }), "never");
  }
});

Deno.test("said Not now: ask again only after the wait", () => {
  const days = ["2026-11-19", "2026-11-20"];
  assertEquals(askDecision({ days, askedAt: "2026-11-10T10:00:00Z", perm: "undetermined", now: NOW }), "wait");
  const longAgo = new Date(Date.parse(NOW) - (REASK_AFTER_DAYS + 1) * 86_400_000).toISOString();
  assertEquals(askDecision({ days, askedAt: longAgo, perm: "undetermined", now: NOW }), "ask");
});

Deno.test("tap: a food lapse push opens Nutrition; anything else is not ours", () => {
  assertEquals(pushRoute({ type: "food_lapse", screen: "nutrition" }), "/nutrition");
  assertEquals(pushRoute({ type: "ready", target: "x" }), null);
  // Our own message (drona-push send): the screen it names, home when unknown.
  assertEquals(pushRoute({ type: "drona", screen: "nutrition" }), "/nutrition");
  assertEquals(pushRoute({ type: "drona", screen: "home" }), "/");
  assertEquals(pushRoute({ type: "drona", screen: "somewhere-else" }), "/");
  assertEquals(pushRoute({ type: "drona" }), "/");
  assertEquals(pushRoute({}), null);
});

Deno.test("ask copy: coach voice, short, no dashes, no numbers", () => {
  for (const s of [ASK_COPY.title, ASK_COPY.body, ASK_COPY.yes, ASK_COPY.no]) {
    assert(!s.includes("—") && !s.includes("–"), s);
    assert(!/\d/.test(s), s);
  }
  assert(ASK_COPY.body.length <= 140);
});
