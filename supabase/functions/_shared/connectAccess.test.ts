// deno test --allow-all supabase/functions/_shared/connectAccess.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { aiBlocked, connectRefusal } from "./connectAccess.ts";

Deno.test("only an explicit ai_blocked true blocks", () => {
  assertEquals(aiBlocked({ state: "free", ai_blocked: true }), true);
  assertEquals(aiBlocked({ state: "free", ai_blocked: false }), false);
  // An answer from before the migration has no field: nothing changes.
  assertEquals(aiBlocked({ state: "free" }), false);
  assertEquals(aiBlocked(null), false);
  assertEquals(aiBlocked({ ai_blocked: "true" }), false);
});

Deno.test("the refusal is a pro_required the app already turns into the paywall", () => {
  assertEquals(connectRefusal("chat"), { error: "pro_required", state: "free", feature: "chat", plan: "connect" });
});
