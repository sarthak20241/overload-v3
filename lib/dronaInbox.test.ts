import { assertEquals } from "jsr:@std/assert@1";
import { bucketOf, canUndo, waitingCount, UNDO_WINDOW_MS } from "./dronaInbox.ts";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const card = (over: Record<string, unknown>) => ({
  id: "c1", kind: "act", topic: "swap", status: "pending",
  payload: {}, deferred_at: null, expires_at: null, decided_at: null, created_at: "2026-09-14T00:00:00Z",
  ...over,
} as any);

Deno.test("a pending card with no expiry is waiting", () => {
  assertEquals(bucketOf(card({}), NOW), "waiting");
});

Deno.test("a deferred card still inside its week is waiting", () => {
  assertEquals(bucketOf(card({ deferred_at: "2026-09-16T10:00:00Z", expires_at: "2026-09-20T18:30:00Z" }), NOW), "waiting");
});

Deno.test("a pending card past its expiry is done, shown as expired", () => {
  assertEquals(bucketOf(card({ expires_at: "2026-09-17T18:30:00Z" }), NOW), "done");
});

Deno.test("an answered card is done whatever its expiry says", () => {
  assertEquals(bucketOf(card({ status: "applied" }), NOW), "done");
  assertEquals(bucketOf(card({ status: "dismissed", expires_at: "2027-01-01T00:00:00Z" }), NOW), "done");
});

Deno.test("an applied swap can be undone for seven days", () => {
  const applied = card({ status: "applied", decided_at: "2026-09-15T12:00:00Z", payload: { action: "apply_swap" } });
  assertEquals(canUndo(applied, NOW), true);
  assertEquals(canUndo(card({ ...applied, decided_at: "2026-09-10T11:59:59Z" }), NOW), false);
  assertEquals(NOW - Date.parse("2026-09-11T12:00:00Z") <= UNDO_WINDOW_MS, true);
});

Deno.test("a notice Drona applied itself can also be undone within the window", () => {
  // The worker leaves the notice pending; the swap already happened at created_at.
  const notice = card({ kind: "notice", payload: { action: "undo_swap" }, created_at: "2026-09-14T09:00:00Z" });
  assertEquals(canUndo(notice, NOW), true);
});

Deno.test("only swaps have an Undo; a request or a dismissed card does not", () => {
  assertEquals(canUndo(card({ kind: "request", status: "applied", decided_at: "2026-09-17T00:00:00Z", payload: { action: "log_food" } }), NOW), false);
  assertEquals(canUndo(card({ status: "dismissed", decided_at: "2026-09-17T00:00:00Z", payload: { action: "apply_swap" } }), NOW), false);
});

Deno.test("waiting count ignores done and expired cards", () => {
  const rows = [card({}), card({ status: "applied" }), card({ expires_at: "2026-09-01T00:00:00Z" }), card({ deferred_at: "x", expires_at: "2026-09-21T00:00:00Z" })];
  assertEquals(waitingCount(rows, NOW), 2);
});
