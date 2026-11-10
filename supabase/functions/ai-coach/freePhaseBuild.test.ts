// Run with: deno test --allow-all supabase/functions/ai-coach/freePhaseBuild.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { freePhaseBuildCandidate, freePhaseRefineCandidate } from "./freePhaseBuild.ts";

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

Deno.test("a refine_plan turn naming a phase asks for a free refine turn", () => {
  assertEquals(freePhaseRefineCandidate({ mode: "refine_plan", phase_id: PHASE }), PHASE);
});

Deno.test("the refine turn that forces generate_plan asks too, so applying the change is not paywalled", () => {
  assertEquals(
    freePhaseRefineCandidate({ mode: "refine_plan", force_tool: "generate_plan", phase_id: PHASE }),
    PHASE,
  );
});

Deno.test("refine with another forced tool stays Pro", () => {
  for (const force_tool of ["generate_workout", "generate_program", "query_sql", 7]) {
    assertEquals(
      freePhaseRefineCandidate({ mode: "refine_plan", force_tool, phase_id: PHASE }),
      null,
      String(force_tool),
    );
  }
});

Deno.test("other modes, and no mode, do not ask for a free refine turn", () => {
  for (const mode of [undefined, "discuss_plan", "refine_workout", "refine_program", "discuss_program", "chat"]) {
    assertEquals(
      freePhaseRefineCandidate({ mode, force_tool: "generate_plan", phase_id: PHASE }),
      null,
      String(mode),
    );
  }
});

Deno.test("a refine turn with no phase_id, or a non-string one, does not ask", () => {
  assertEquals(freePhaseRefineCandidate({ mode: "refine_plan" }), null);
  assertEquals(freePhaseRefineCandidate({ mode: "refine_plan", phase_id: "" }), null);
  assertEquals(freePhaseRefineCandidate({ mode: "refine_plan", phase_id: 7 }), null);
  assertEquals(freePhaseRefineCandidate(null), null);
});

Deno.test("build and refine never both ask for one request", () => {
  const bodies = [
    { force_tool: "generate_plan", phase_id: PHASE },
    { mode: "refine_plan", phase_id: PHASE },
    { mode: "refine_plan", force_tool: "generate_plan", phase_id: PHASE },
  ];
  for (const b of bodies) {
    const both = freePhaseBuildCandidate(b) !== null && freePhaseRefineCandidate(b) !== null;
    assertEquals(both, false, JSON.stringify(b));
  }
});
