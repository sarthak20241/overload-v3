// deno test --allow-all supabase/functions/drona-push/
//
// The manual send: our own push to chosen users or everyone with a phone.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type ManualDb, parseSendRequest, runManualSend, type Target } from "./manual.ts";
import type { PushApi } from "./run.ts";
import type { PushMessage } from "../_shared/expoPush.ts";

Deno.test("request: needs a campaign id, a title, a body, and users or 'all'", () => {
  const ok = parseSendRequest({ campaign: "nov-checkin", title: "Drona here", body: "Quick hello.", user_ids: ["u1"] });
  assert("req" in ok);
  for (const bad of [
    { title: "t", body: "b", user_ids: ["u1"] }, // no campaign
    { campaign: "camp", body: "b", user_ids: ["u1"] }, // no title
    { campaign: "camp", title: "t", user_ids: ["u1"] }, // no body
    { campaign: "camp", title: "t", body: "b" }, // nobody
    { campaign: "camp", title: "t", body: "b", user_ids: [] },
    { campaign: "camp", title: "t", body: "b", user_ids: ["u1"], all: true }, // both
    { campaign: "has space", title: "t", body: "b", all: true },
    { campaign: "camp", title: "x".repeat(61), body: "b", all: true },
    { campaign: "camp", title: "t", body: "x".repeat(201), all: true },
    { campaign: "camp", title: "t", body: "b", all: true, screen: "settings" },
    { campaign: "camp", title: "t", body: "b", user_ids: ["u1", 42] }, // not all text
    { campaign: "camp", title: "t", body: "b", user_ids: ["u1", ""] },
    { campaign: "camp", title: "t", body: "b", user_ids: Array.from({ length: 1001 }, (_, i) => `u${i}`) },
  ]) {
    assert("error" in parseSendRequest(bad), JSON.stringify(bad).slice(0, 80));
  }
});

Deno.test("request: screen defaults to home; quiet hours default on", () => {
  const r = parseSendRequest({ campaign: "camp", title: "t", body: "b", all: true });
  assert("req" in r);
  assertEquals(r.req.screen, "home");
  assertEquals(r.req.respectQuietHours, true);
});

const target = (over: Partial<Target> = {}): Target => ({
  user_id: "u1", hour: 11, tokens: ["ExponentPushToken[a]"], ...over,
});

function fakes(targets: Target[]) {
  const claimed = new Map<string, string>();
  const sent: PushMessage[] = [];
  const db: ManualDb = {
    targets: async (ids) => (ids ? targets.filter((t) => ids.includes(t.user_id)) : targets),
    claim: async (u, k) => {
      if (claimed.has(`${u}|${k}`)) return false;
      claimed.set(`${u}|${k}`, "claimed");
      return true;
    },
    record: async (u, k, _t, status) => { claimed.set(`${u}|${k}`, status); },
    release: async (u, k) => { claimed.delete(`${u}|${k}`); },
    deleteTokens: async () => {},
    alreadySent: async (k) => [...claimed.keys()].filter((x) => x.endsWith(`|${k}`)).map((x) => x.split("|")[0]),
  };
  const api: PushApi = {
    send: async (msgs) => { sent.push(...msgs); return msgs.map((m) => ({ token: m.to, ticketId: "t" })); },
    receipts: async () => ({}),
  };
  return { db, api, sent, claimed };
}

const REQ = { campaign: "nov-checkin", title: "Drona here", body: "Quick hello.", screen: "nutrition" as const, respectQuietHours: true, dryRun: false };

Deno.test("send: each user gets it once per campaign, on every phone, tap opens the screen", async () => {
  const f = fakes([target({ tokens: ["ExponentPushToken[a]", "ExponentPushToken[b]"] }), target({ user_id: "u2" })]);
  const r = await runManualSend(f.db, f.api, REQ);
  assertEquals(r.sent, 2);
  assertEquals(f.sent.length, 3);
  assertEquals(f.sent[0].data, { type: "drona", screen: "nutrition", campaign: "nov-checkin" });
  const again = await runManualSend(f.db, f.api, REQ);
  assertEquals(again.sent, 0);
  assertEquals(again.skipped.already_sent, 2);
  assertEquals(f.sent.length, 3);
});

Deno.test("send: quiet hours skip people at night unless turned off", async () => {
  const f = fakes([target({ hour: 23 }), target({ user_id: "u2", hour: 7 }), target({ user_id: "u3", hour: 12 })]);
  const r = await runManualSend(f.db, f.api, REQ);
  assertEquals(r.sent, 1);
  assertEquals(r.skipped.quiet_hours, 2);
  const g = fakes([target({ hour: 23 })]);
  assertEquals((await runManualSend(g.db, g.api, { ...REQ, respectQuietHours: false })).sent, 1);
});

Deno.test("send: dry run sends and claims nothing, and says who would get it", async () => {
  const f = fakes([target(), target({ user_id: "u2", tokens: [] })]);
  const r = await runManualSend(f.db, f.api, { ...REQ, dryRun: true });
  assertEquals(f.sent.length, 0);
  assertEquals(f.claimed.size, 0);
  assertEquals(r.wouldSend, 1);
  assertEquals(r.skipped.no_token, 1);
});

Deno.test("dry run names who would get it, and leaves out people this campaign already reached", async () => {
  const f = fakes([target(), target({ user_id: "u2" }), target({ user_id: "u3", hour: 23 })]);
  await runManualSend(f.db, f.api, { ...REQ, userIds: ["u1"] }); // u1 got it already
  const r = await runManualSend(f.db, f.api, { ...REQ, dryRun: true });
  assertEquals(r.recipients, ["u2"]);
  assertEquals(r.wouldSend, 1);
  assertEquals(r.skipped.already_sent, 1);
  assertEquals(r.skipped.quiet_hours, 1);
});

Deno.test("a claim that throws skips that person, the rest still get it", async () => {
  const f = fakes([target(), target({ user_id: "u2" })]);
  const orig = f.db.claim;
  f.db.claim = async (u, k, t, b, kind) => { if (u === "u1") throw new Error("db down"); return orig(u, k, t, b, kind); };
  const r = await runManualSend(f.db, f.api, REQ);
  assertEquals(r.sent, 1);
  assertEquals(r.skipped.claim_failed, 1);
});

Deno.test("out of time after the claim: the claim is let go and nothing is sent", async () => {
  const f = fakes([target()]);
  let t = 0;
  const orig = f.db.claim;
  f.db.claim = async (...a) => { t += 50_000; return orig(...a); }; // the claim itself was slow
  const r = await runManualSend(f.db, f.api, REQ, { clock: () => t, budgetMs: 40_000 });
  assertEquals(f.sent.length, 0);
  assertEquals(f.claimed.size, 0);
  assertEquals(r.skipped.out_of_time, 1);
});

Deno.test("no saved time zone: unknown hour, so quiet hours skip them (sent only when quiet hours are off)", async () => {
  const f = fakes([target({ hour: null })]);
  assertEquals((await runManualSend(f.db, f.api, REQ)).skipped.quiet_hours, 1);
  assertEquals((await runManualSend(f.db, f.api, { ...REQ, respectQuietHours: false })).sent, 1);
});
