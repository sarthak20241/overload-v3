// Run with: deno test --allow-all supabase/functions/ai-coach/foodFollowup.test.ts
//
// The reply and create calls in the food bar used to leave no record: the user
// saw what Drona wrote, and the trace kept only the parse's own decline, which
// they never saw. These pin that the record holds what was actually shown.

import { assertEquals } from "jsr:@std/assert@1";
import { readDraftResult, readReplyResult, skippedFollowup } from "./foodIntent.ts";

const ok = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  ok: true as const,
  data: { content, stop_reason: "end_turn", usage: { input_tokens: 210, output_tokens: 34 }, ...extra },
});

Deno.test("reply: the trace keeps the exact sentence the user saw", () => {
  const { reply, followup } = readReplyResult(
    ok([{ type: "text", text: "  Yes — I can log food and save meals right here. " }]),
    812,
  );
  assertEquals(reply, "Yes, I can log food and save meals right here.");
  assertEquals(followup.shown_text, reply);
  assertEquals(followup.raw_text, "  Yes — I can log food and save meals right here. ");
  assertEquals(followup.ok, true);
  assertEquals(followup.ms, 812);
  assertEquals(followup.input_tokens, 210);
  assertEquals(followup.output_tokens, 34);
  assertEquals(followup.stop_reason, "end_turn");
});

Deno.test("reply: an empty answer shows nothing and says why", () => {
  const { reply, followup } = readReplyResult(ok([{ type: "text", text: "   " }]), 500);
  assertEquals(reply, null);
  assertEquals(followup.shown_text, null);
  assertEquals(followup.ok, false);
  assertEquals(followup.error, "empty_reply");
});

Deno.test("reply: a failed call keeps the status and the error body", () => {
  const { reply, followup } = readReplyResult(
    { ok: false, status: 504, body: "Anthropic call exceeded 6000ms timeout" },
    6001,
  );
  assertEquals(reply, null);
  assertEquals(followup.http_status, 504);
  assertEquals(followup.error, "Anthropic call exceeded 6000ms timeout");
  assertEquals(followup.shown_text, null);
});

Deno.test("create: the trace keeps the card the model drafted", () => {
  const input = { name: "Gym bowl", items: [{ food_name: "chicken", kcal: 240 }], log_now: false, summary: "Gym bowl, 485 cal. Want it in My Meals?" };
  const { create, followup } = readDraftResult(ok([{ type: "tool_use", name: "create_custom_meal", input }]), 2400);
  assertEquals(create, { tool: "create_custom_meal", input });
  assertEquals(followup.ok, true);
  assertEquals(followup.tool, "create_custom_meal");
  assertEquals(followup.draft, input);
});

Deno.test("create: a wrong tool is refused but still recorded", () => {
  const { create, followup } = readDraftResult(ok([{ type: "tool_use", name: "log_meal", input: { x: 1 } }]), 900);
  assertEquals(create, null);
  assertEquals(followup.error, "wrong_tool");
  assertEquals(followup.tool, "log_meal");
  assertEquals(followup.draft, { x: 1 });
});

Deno.test("create: no tool call at all", () => {
  const { create, followup } = readDraftResult(ok([{ type: "text", text: "sure" }]), 900);
  assertEquals(create, null);
  assertEquals(followup.error, "no_tool_call");
});

Deno.test("a follow-up that never ran says so", () => {
  const f = skippedFollowup("reply");
  assertEquals(f.ok, false);
  assertEquals(f.error, "no_api_key");
  assertEquals(f.http_status, null);
});
