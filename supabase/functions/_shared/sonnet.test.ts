// Run with: deno test --allow-all supabase/functions/_shared/sonnet.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { requireTool, SONNET_MODEL, sonnetSettings } from "./sonnet.ts";

Deno.test("between_tools goes only to Sonnet 5.5: any other model would return a 400", () => {
  assertEquals(sonnetSettings(SONNET_MODEL).thinking, { type: "between_tools" });
  for (const m of ["claude-haiku-4-5", "claude-haiku-5-5", "claude-sonnet-4-6", "sonnet"]) {
    assertEquals(sonnetSettings(m), {});
  }
});

Deno.test("requireTool is a system message naming the tool", () => {
  const m = requireTool("generate_program");
  assertEquals(m.role, "system");
  assertEquals(m.content.includes("generate_program"), true);
});
