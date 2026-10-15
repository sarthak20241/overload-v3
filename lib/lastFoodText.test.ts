// deno test --allow-all lib/lastFoodText.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { isRecallable, RECALL_MS, type LastFoodText } from "./lastFoodText.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const sent = (over: Partial<LastFoodText> = {}): LastFoodText => ({
  text: "2 eggs, 1 banana", at: NOW - 60_000, userId: "user_a", ...over,
});

Deno.test("a recent send by the same user is offered back", () => {
  assertEquals(isRecallable(sent(), NOW, "user_a"), true);
});

Deno.test("another account on the same phone never sees it", () => {
  assertEquals(isRecallable(sent(), NOW, "user_b"), false);
  assertEquals(isRecallable(sent(), NOW, null), false);
  assertEquals(isRecallable(sent({ userId: null }), NOW, "user_a"), false);
});

Deno.test("it stops being offered after 12 hours", () => {
  assertEquals(isRecallable(sent({ at: NOW - RECALL_MS + 1 }), NOW, "user_a"), true);
  assertEquals(isRecallable(sent({ at: NOW - RECALL_MS }), NOW, "user_a"), false);
});

Deno.test("a send dated in the future (clock moved back) is not trusted", () => {
  assertEquals(isRecallable(sent({ at: NOW + 60_000 }), NOW, "user_a"), false);
});

Deno.test("nothing, or only spaces, is never offered", () => {
  assertEquals(isRecallable(null, NOW, "user_a"), false);
  assertEquals(isRecallable(sent({ text: "   " }), NOW, "user_a"), false);
});
