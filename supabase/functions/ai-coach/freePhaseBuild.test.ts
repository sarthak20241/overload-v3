// Run with: deno test --allow-all supabase/functions/ai-coach/freePhaseBuild.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { freePhaseBuildCandidate } from "./freePhaseBuild.ts";

const PHASE = "6f1c2b9e-0000-4000-8000-000000000001";

Deno.test("a forced generate_plan naming a phase asks for the free build", () => {
  assertEquals(freePhaseBuildCandidate({ force_tool: "generate_plan", phase_id: PHASE }), PHASE);
});

Deno.test("refine and discuss stay Pro even with a phase_id", () => {
  for (const mode of ["refine_plan", "discuss_plan", "refine_program", "chat"]) {
    assertEquals(
      freePhaseBuildCandidate({ mode, force_tool: "generate_plan", phase_id: PHASE }),
      null,
      mode,
    );
  }
});

Deno.test("other forced tools stay Pro", () => {
  assertEquals(freePhaseBuildCandidate({ force_tool: "generate_workout", phase_id: PHASE }), null);
  assertEquals(freePhaseBuildCandidate({ force_tool: "generate_program", phase_id: PHASE }), null);
});

Deno.test("no phase_id, or a non-string one, does not ask", () => {
  assertEquals(freePhaseBuildCandidate({ force_tool: "generate_plan" }), null);
  assertEquals(freePhaseBuildCandidate({ force_tool: "generate_plan", phase_id: "" }), null);
  assertEquals(freePhaseBuildCandidate({ force_tool: "generate_plan", phase_id: 7 }), null);
  assertEquals(freePhaseBuildCandidate(null), null);
});
