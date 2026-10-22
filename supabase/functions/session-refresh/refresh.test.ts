// Run with: deno test --allow-all supabase/functions/session-refresh/
//
// This function mints sign-ins. What matters is WHO can get a ticket: only the
// verified caller, only for their own active session, only near its end.

import { assertEquals } from "jsr:@std/assert@1";
import { type ClerkSession, handleRefresh, REFRESH_WITHIN_MS, type RefreshDeps } from "./refresh.ts";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function deps(over: {
  claims?: { sub: string; sid: string } | { error: string };
  session?: ClerkSession | null;
} = {}) {
  const minted: string[] = [];
  const d: RefreshDeps = {
    verify: () => Promise.resolve(over.claims ?? { sub: "user_a", sid: "sess_a" }),
    getSession: () =>
      Promise.resolve(
        over.session !== undefined
          ? over.session
          : { id: "sess_a", user_id: "user_a", status: "active", expire_at: NOW + 1 * DAY },
      ),
    mintTicket: (userId) => {
      minted.push(userId);
      return Promise.resolve(`ticket_for_${userId}`);
    },
    now: () => NOW,
  };
  return { d, minted };
}

Deno.test("a verified user near the end of an active session gets a ticket for themselves", async () => {
  const { d, minted } = deps();
  const res = await handleRefresh(d);
  assertEquals(res, { status: 200, body: { ticket: "ticket_for_user_a", user_id: "user_a" } });
  assertEquals(minted, ["user_a"]);
});

Deno.test("an unverified caller gets nothing", async () => {
  const { d, minted } = deps({ claims: { error: 'verify failed: "exp" claim timestamp check failed' } });
  const res = await handleRefresh(d);
  assertEquals(res.status, 401);
  assertEquals(minted, []);
});

Deno.test("a session that belongs to someone else gets nothing", async () => {
  const { d, minted } = deps({
    session: { id: "sess_a", user_id: "user_b", status: "active", expire_at: NOW + DAY },
  });
  const res = await handleRefresh(d);
  assertEquals(res.status, 403);
  assertEquals(minted, []);
});

Deno.test("an ended, revoked or missing session gets nothing", async () => {
  for (const session of [
    { id: "sess_a", user_id: "user_a", status: "revoked", expire_at: NOW + DAY },
    { id: "sess_a", user_id: "user_a", status: "ended", expire_at: NOW + DAY },
    { id: "sess_a", user_id: "user_a", status: "expired", expire_at: NOW - DAY },
    { id: "sess_other", user_id: "user_a", status: "active", expire_at: NOW + DAY },
    null,
  ]) {
    const { d, minted } = deps({ session });
    const res = await handleRefresh(d);
    assertEquals(res.status, 403);
    assertEquals(minted, []);
  }
});

Deno.test("a session with more than the window left gets no ticket", async () => {
  const { d, minted } = deps({
    session: { id: "sess_a", user_id: "user_a", status: "active", expire_at: NOW + REFRESH_WITHIN_MS + 60_000 },
  });
  const res = await handleRefresh(d);
  assertEquals(res, { status: 200, body: { ticket: null, reason: "not_due" } });
  assertEquals(minted, []);
});

Deno.test("the window edge is inside: exactly the window left still gets a ticket", async () => {
  const { d, minted } = deps({
    session: { id: "sess_a", user_id: "user_a", status: "active", expire_at: NOW + REFRESH_WITHIN_MS },
  });
  const res = await handleRefresh(d);
  assertEquals(res.status, 200);
  assertEquals(minted, ["user_a"]);
});
