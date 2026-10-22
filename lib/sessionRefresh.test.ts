// Run with: deno test --allow-all lib/sessionRefresh.test.ts
//
// The silent re-sign-in signs the user OUT before it signs them back in, so
// the order of the steps is the whole safety story: nothing may sign anyone
// out until a ticket for that same user is in hand.

import { assertEquals } from "jsr:@std/assert@1";
import {
  REFRESH_WITHIN_MS,
  type RefreshSteps,
  runSessionRefresh,
  shouldRefreshSession,
} from "./sessionRefresh.ts";
import { REFRESH_WITHIN_MS as SERVER_WINDOW } from "../supabase/functions/session-refresh/refresh.ts";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

Deno.test("the app asks inside the same window the server mints in", () => {
  assertEquals(REFRESH_WITHIN_MS, SERVER_WINDOW);
});

Deno.test("shouldRefreshSession: only in the last days of a live session", () => {
  assertEquals(shouldRefreshSession(new Date(NOW + 6 * DAY), NOW), false);
  assertEquals(shouldRefreshSession(new Date(NOW + REFRESH_WITHIN_MS + 1), NOW), false);
  assertEquals(shouldRefreshSession(new Date(NOW + REFRESH_WITHIN_MS), NOW), true);
  assertEquals(shouldRefreshSession(new Date(NOW + 1 * DAY), NOW), true);
  assertEquals(shouldRefreshSession(new Date(NOW - 1), NOW), false);
  assertEquals(shouldRefreshSession(null, NOW), false);
  assertEquals(shouldRefreshSession(undefined, NOW), false);
});

/** Records the steps in the order they ran. */
function steps(over: Partial<RefreshSteps> & { signInFailures?: number } = {}) {
  const log: string[] = [];
  let failuresLeft = over.signInFailures ?? 0;
  const s: RefreshSteps = {
    currentUserId: "user_a",
    fetchTicket: async () => {
      log.push("fetchTicket");
      return { ticket: "t1", userId: "user_a" };
    },
    signOut: async () => {
      log.push("signOut");
    },
    signInWithTicket: async (ticket) => {
      log.push(`signIn:${ticket}`);
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error("network");
      }
    },
    sleep: async () => {},
    ...over,
  };
  return { s, log };
}

Deno.test("the ticket comes first, then sign-out, then the ticket sign-in", async () => {
  const { s, log } = steps();
  assertEquals(await runSessionRefresh(s), "refreshed");
  assertEquals(log, ["fetchTicket", "signOut", "signIn:t1"]);
});

Deno.test("no ticket, or a failed fetch: nobody is signed out", async () => {
  for (const fetchTicket of [async () => null, async () => { throw new Error("offline"); }]) {
    const { s, log } = steps({ fetchTicket: fetchTicket as RefreshSteps["fetchTicket"] });
    assertEquals(await runSessionRefresh(s), "no_ticket");
    assertEquals(log.includes("signOut"), false);
  }
});

Deno.test("a ticket for another user is never used", async () => {
  const { s, log } = steps({ fetchTicket: async () => ({ ticket: "t1", userId: "user_b" }) });
  assertEquals(await runSessionRefresh(s), "ticket_user_mismatch");
  assertEquals(log.includes("signOut"), false);
  assertEquals(log.some((l) => l.startsWith("signIn")), false);
});

Deno.test("a failing ticket sign-in is retried", async () => {
  const { s, log } = steps({ signInFailures: 2 });
  assertEquals(await runSessionRefresh(s), "refreshed");
  assertEquals(log, ["fetchTicket", "signOut", "signIn:t1", "signIn:t1", "signIn:t1"]);
});

Deno.test("three failed ticket sign-ins give up and say the user is signed out", async () => {
  const { s, log } = steps({ signInFailures: 3 });
  assertEquals(await runSessionRefresh(s), "sign_in_failed");
  assertEquals(log.filter((l) => l === "signIn:t1").length, 3);
});

Deno.test("a sign-out that throws gets one ticket attempt", async () => {
  const thrower = async () => { throw new Error("sign-out failed"); };
  const ok = steps({ signOut: thrower });
  assertEquals(await runSessionRefresh(ok.s), "refreshed");
  const refused = steps({ signOut: thrower, signInFailures: 1 });
  assertEquals(await runSessionRefresh(refused.s), "sign_out_failed");
  assertEquals(refused.log.filter((l) => l === "signIn:t1").length, 1);
});
