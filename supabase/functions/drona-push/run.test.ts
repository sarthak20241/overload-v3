// deno test --allow-all supabase/functions/drona-push/
//
// One drona-push run against an in-memory database and a fake Expo.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Candidate, type PushApi, type PushDb, runPush, type Ticket } from "./run.ts";
import type { PushMessage } from "../_shared/expoPush.ts";

const NOW = new Date("2026-11-21T05:30:00Z"); // 11:00 in Kolkata

function back(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const daily = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => back("2026-11-21", from - i));

const person = (over: Partial<Candidate> = {}): Candidate => ({
  user_id: "u1", tz: "Asia/Kolkata", today: "2026-11-21", hour: 11,
  days: daily(30, 3), last_push_at: null, tokens: ["ExponentPushToken[a]"], ...over,
});

function fakeDb(people: Candidate[], pending: { id: number; tickets: Ticket[] }[] = []) {
  const sends = new Map<string, { title: string; body: string; tickets: Ticket[]; status: string }>();
  const deleted: string[] = [];
  const marked: number[] = [];
  const db: PushDb = {
    candidates: async () => people,
    claim: async (u, k, title, body) => {
      if (sends.has(`${u}|${k}`)) return false;
      sends.set(`${u}|${k}`, { title, body, tickets: [], status: "claimed" });
      return true;
    },
    record: async (u, k, tickets, status) => {
      Object.assign(sends.get(`${u}|${k}`)!, { tickets, status });
    },
    release: async (u, k) => { sends.delete(`${u}|${k}`); },
    releaseStaleClaims: async () => {
      let n = 0;
      for (const [k, v] of sends) if (v.status === "claimed") { sends.delete(k); n++; }
      return n;
    },
    deleteTokens: async (t) => { deleted.push(...t); },
    unreadReceipts: async () => pending,
    markReceiptsRead: async (ids) => { marked.push(...ids); },
  };
  return { db, sends, deleted, marked };
}

function fakeApi(dead: string[] = [], receipts: Record<string, { status: string; error?: string }> = {}) {
  const sent: PushMessage[] = [];
  const api: PushApi = {
    send: async (msgs) => {
      sent.push(...msgs);
      return msgs.map((m) =>
        dead.includes(m.to) ? { token: m.to, error: "DeviceNotRegistered" } : { token: m.to, ticketId: `tk-${m.to}` }
      );
    },
    receipts: async () => receipts,
  };
  return { api, sent };
}

Deno.test("a lapsed steady logger gets one push on every phone; the tap opens Nutrition", async () => {
  const { db, sends } = fakeDb([person({ tokens: ["ExponentPushToken[a]", "ExponentPushToken[b]"] })]);
  const { api, sent } = fakeApi();
  const r = await runPush(db, api, NOW);
  assertEquals(r.sent, 1);
  assertEquals(sent.length, 2);
  assertEquals(sent[0].data, { type: "food_lapse", screen: "nutrition" });
  assertEquals(sends.get("u1|2026-11-18")!.status, "sent");
});

Deno.test("the next run (or an overlapping one) sends nothing for the same lapse", async () => {
  const f = fakeDb([person()]);
  const { api, sent } = fakeApi();
  await runPush(f.db, api, NOW);
  const r2 = await runPush(f.db, api, new Date(NOW.getTime() + 3600_000));
  assertEquals(sent.length, 1);
  assertEquals(r2.skipped.already_sent, 1);
});

Deno.test("not lapsed, quiet hours, or no phone: nothing claimed, nothing sent", async () => {
  const { db, sends } = fakeDb([
    person({ user_id: "a", days: daily(30, 0) }),
    person({ user_id: "b", hour: 23 }),
    person({ user_id: "c", tokens: [] }),
  ]);
  const { api, sent } = fakeApi();
  const r = await runPush(db, api, NOW);
  assertEquals(sent.length, 0);
  assertEquals(sends.size, 0);
  assertEquals(r.skipped, { not_lapsed: 1, quiet_hours: 1, no_token: 1 });
});

Deno.test("DeviceNotRegistered on send: the token is deleted", async () => {
  const { db, deleted, sends } = fakeDb([person({ tokens: ["ExponentPushToken[a]", "ExponentPushToken[dead]"] })]);
  const { api } = fakeApi(["ExponentPushToken[dead]"]);
  const r = await runPush(db, api, NOW);
  assertEquals(deleted, ["ExponentPushToken[dead]"]);
  assertEquals(r.deadTokens, 1);
  assertEquals(sends.get("u1|2026-11-18")!.status, "sent");
});

Deno.test("every phone dead: the claim stays, marked failed (no retry spam)", async () => {
  const { db, sends } = fakeDb([person()]);
  const { api } = fakeApi(["ExponentPushToken[a]"]);
  const r = await runPush(db, api, NOW);
  assertEquals(r.sent, 0);
  assertEquals(sends.get("u1|2026-11-18")!.status, "failed");
});

Deno.test("receipts: a dead token is deleted before this run sends to it", async () => {
  const pending = [{ id: 7, tickets: [{ token: "ExponentPushToken[a]", ticket: "old-1", error: null }] }];
  const { db, deleted, marked } = fakeDb([person()], pending);
  const { api, sent } = fakeApi([], { "old-1": { status: "error", error: "DeviceNotRegistered" } });
  const r = await runPush(db, api, NOW);
  assertEquals(sent.length, 0);
  assertEquals(r.skipped.no_token, 1);
  assertEquals(deleted, ["ExponentPushToken[a]"]);
  assertEquals(marked, [7]);
});

Deno.test("receipts: a send whose receipt has not come back waits for the next run", async () => {
  const pending = [{ id: 8, tickets: [{ token: "ExponentPushToken[z]", ticket: "not-yet", error: null }] }];
  const { db, marked } = fakeDb([], pending);
  const { api } = fakeApi([], {});
  await runPush(db, api, NOW);
  assertEquals(marked, []);
});

Deno.test("dry run decides but claims and sends nothing", async () => {
  const { db, sends } = fakeDb([person()]);
  const { api, sent } = fakeApi();
  const r = await runPush(db, api, NOW, { dryRun: true });
  assertEquals(sent.length, 0);
  assertEquals(sends.size, 0);
  assert(r.skipped.dry_run === 1);
});

Deno.test("Expo throws for one person: that one is let go, the rest still get theirs, dead tokens still go", async () => {
  const pending = [{ id: 9, tickets: [{ token: "ExponentPushToken[old]", ticket: "r-1", error: null }] }];
  const { db, sends, deleted } = fakeDb([
    person({ user_id: "boom", tokens: ["ExponentPushToken[boom]"] }),
    person({ user_id: "ok", tokens: ["ExponentPushToken[ok]"] }),
  ], pending);
  const sent: string[] = [];
  const api: PushApi = {
    send: async (msgs) => {
      if (msgs[0].to === "ExponentPushToken[boom]") throw new Error("expo 503");
      sent.push(...msgs.map((m) => m.to));
      return msgs.map((m) => ({ token: m.to, ticketId: "t" }));
    },
    receipts: async () => ({ "r-1": { status: "error", error: "DeviceNotRegistered" } }),
  };
  const r = await runPush(db, api, NOW);
  assertEquals(sent, ["ExponentPushToken[ok]"]);
  assert(!sends.has("boom|2026-11-18")); // let go: next hour retries
  assertEquals(sends.get("ok|2026-11-18")!.status, "sent");
  assertEquals(deleted, ["ExponentPushToken[old]"]);
  assertEquals(r.sent, 1);
});

Deno.test("dry run changes nothing: no receipts marked, no tokens deleted", async () => {
  const pending = [{ id: 3, tickets: [{ token: "ExponentPushToken[a]", ticket: "x", error: null }] }];
  const { db, deleted, marked } = fakeDb([person()], pending);
  const { api } = fakeApi([], { x: { status: "error", error: "DeviceNotRegistered" } });
  await runPush(db, api, NOW, { dryRun: true });
  assertEquals(deleted, []);
  assertEquals(marked, []);
});

Deno.test("time budget: no new send starts once the run is out of time; the rest wait for the next hour", async () => {
  const { db, sends } = fakeDb([person({ user_id: "a" }), person({ user_id: "b" }), person({ user_id: "c" })]);
  const { api, sent } = fakeApi();
  let t = 0;
  const clock = () => (t += 20_000); // each check is 20 s later
  const r = await runPush(db, api, NOW, { clock, budgetMs: 30_000 });
  assertEquals(sent.length, 1);
  assertEquals(sends.size, 1);
  assertEquals(r.skipped.out_of_time, 2);
});

Deno.test("Expo never took the push (request failed or threw): the claim is let go, so next hour retries", async () => {
  const f = fakeDb([person()]);
  const down: PushApi = { send: async () => { throw new Error("503"); }, receipts: async () => ({}) };
  await runPush(f.db, down, NOW);
  assertEquals(f.sends.size, 0);
  const { api, sent } = fakeApi();
  const r = await runPush(f.db, api, new Date(NOW.getTime() + 3600_000));
  assertEquals(sent.length, 1);
  assertEquals(r.sent, 1);
});

Deno.test("a claim left by a run that died mid-send is let go, so this run sends it", async () => {
  const f = fakeDb([person()]);
  await f.db.claim("u1", "2026-11-18", "t", "b"); // the dead run's row, status claimed
  const { api, sent } = fakeApi();
  const r = await runPush(f.db, api, NOW);
  assertEquals(sent.length, 1);
  assertEquals(r.staleClaims, 1);
  assertEquals(f.sends.get("u1|2026-11-18")!.status, "sent");
});

Deno.test("the time budget counts the receipts step too", async () => {
  const pending = [{ id: 1, tickets: [{ token: "ExponentPushToken[z]", ticket: "r", error: null }] }];
  const { db } = fakeDb([person()], pending);
  const { api, sent } = fakeApi([], { r: { status: "ok" } });
  let t = 0;
  const clock = () => t;
  const slowReceipts = { ...api, receipts: async (ids: string[]) => { t += 45_000; return api.receipts(ids); } };
  await runPush(db, slowReceipts, NOW, { clock, budgetMs: 40_000 });
  assertEquals(sent.length, 0);
});

Deno.test("one phone dead, the other failed for a moment: the dead one goes, the claim is let go for a retry", async () => {
  const f = fakeDb([person({ tokens: ["ExponentPushToken[dead]", "ExponentPushToken[live]"] })]);
  const api: PushApi = {
    send: async (msgs) => msgs.map((m) =>
      m.to === "ExponentPushToken[dead]" ? { token: m.to, error: "DeviceNotRegistered" } : { token: m.to, error: "request_failed" }
    ),
    receipts: async () => ({}),
  };
  const r = await runPush(f.db, api, NOW);
  assert(!f.sends.has("u1|2026-11-18"));
  assertEquals(f.deleted, ["ExponentPushToken[dead]"]);
  assertEquals(r.skipped.send_failed, 1);
});
