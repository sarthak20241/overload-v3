import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { askCoachLine, linePrompt, type LinePack } from "./phaseMetricsLine.ts";

const pack: LinePack = {
  program_title: "Summer Cut",
  phase_name: "Volume Cut",
  job_text: "Bring weight 71.0 to 69.6 kg",
  week_in_phase: 2,
  weeks_total: 3,
  metrics: [
    { kind: "bodyweight", is_hero: true, unit: "kg", direction: "down", start_value: 71.0, target_value: 69.6, current_value: 70.4, status: "on_track" },
    { kind: "protein_days", is_hero: false, unit: "days", direction: "up", start_value: null, target_value: 5, current_value: 3, status: "slipping" },
    { kind: "steps", is_hero: false, unit: "steps", direction: "up", start_value: null, target_value: 8000, current_value: null, status: "due" },
  ],
};

Deno.test("the prompt carries every number and status word the line may name", () => {
  const p = linePrompt(pack);
  assertStringIncludes(p, "Volume Cut, week 2 of 3");
  assertStringIncludes(p, "This phase's job: Bring weight 71.0 to 69.6 kg");
  assertStringIncludes(p, "Bodyweight (hero): now 70.4 kg, target 69.6 kg, started 71.0, down, status On track");
  assertStringIncludes(p, "Protein days: now 3 days, target 5 days, up, status Slipping");
  assertStringIncludes(p, "Steps a day: now no reading, target 8,000 steps, up, status Due");
});

const reply = (body: unknown, status = 200): typeof fetch =>
  // deno-lint-ignore require-await
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

Deno.test("a clean tool call is the line", async () => {
  const fetchFn = reply({ content: [{ type: "tool_use", name: "phase_line", input: { line: "On pace. Protein is the one slipping; hit 150g on the rest days." } }] });
  assertEquals(await askCoachLine(pack, "k", fetchFn), { line: "On pace. Protein is the one slipping; hit 150g on the rest days." });
});

Deno.test("no line on a failure, a refusal, a cut-off call, or a line that does not read as one", async () => {
  assertEquals((await askCoachLine(pack, "k", reply({ error: "x" }, 500))).line, null);
  assertEquals((await askCoachLine(pack, "k", reply({ stop_reason: "refusal", content: [] }))).error, "refusal");
  assertEquals((await askCoachLine(pack, "k", reply({ stop_reason: "max_tokens", content: [] }))).error, "max_tokens");
  assertEquals((await askCoachLine(pack, "k", reply({ content: [{ type: "text", text: "On pace." }] }))).error, "no tool call");
  assertEquals((await askCoachLine(pack, "k", reply({ content: [{ type: "tool_use", name: "phase_line", input: { line: "On pace — keep going" } }] }))).line, null);
});
