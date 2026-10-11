// Run with: deno test --allow-all supabase/functions/ai-coach/thoroughMatch.test.ts
//
// Thorough asks Jev whether a catalog row IS the food named. Jev is faked at
// fetch; the gate, the flow and the parse pipeline are the real code. What must
// hold: "on" hands decide only Jev's row, or no row when Jev says none is the
// food; a Jev failure changes nothing; "shadow" changes nothing; Quick and
// Precise never ask.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type CandidateFood, type ParseMealDeps, type ResolvedItem, runParseMeal } from "./parseMeal.ts";
import { applyJudgement, judgeThorough, matchName } from "./thoroughMatch.ts";

const food = (id: string | null, name: string, kcal: number, protein: number, source: CandidateFood["source"] = "catalog"): CandidateFood => ({
  food_id: id, name, brand: null, base_unit: "g", kcal, protein_g: protein, carb_g: 0, fat_g: 0, fiber_g: null,
  servings: [], source,
});
const TOAST = food("t1", "Bread, white, toasted", 293, 9);
const MELBA = food("t2", "Melba toast, plain", 390, 12);
const sources = new Map([["t1", "usda"], ["t2", "usda"]]);
const item = (candidates: CandidateFood[]): ResolvedItem => ({
  name: "toast", brand: null, quantity: 2, unit: "slice", prep: null, candidates,
} as unknown as ResolvedItem);

interface Script {
  kind?: string;
  /** Chance of "exactly this food", per row in order; "fail" = HTTP 500. */
  scores?: number[] | "fail" | "empty";
}

function fakeJev(script: Script, calls: string[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const keys = Object.keys(body.questions);
    const answers: Record<string, unknown> = {};
    if (keys.some((k) => k.endsWith("_kind"))) {
      calls.push("kind");
      const choice = script.kind ?? "plain";
      answers.f1_kind = { type: "choice", choice, confidence: 0.95, probabilities: { [choice]: 0.95 } };
    } else {
      calls.push("score");
      if (script.scores === "fail") return new Response("x", { status: 500 });
      if (script.scores !== "empty") {
        keys.forEach((k, i) => {
          const p = Array.isArray(script.scores) ? (script.scores[i] ?? 0) : 0;
          answers[k] = { type: "score", score: 2 * p, confidence: 0.9, legend: {}, probabilities: { "0": 1 - p, "1": 0, "2": p } };
        });
      }
    }
    return Response.json({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;
}
const jev = (script: Script, calls: string[] = []) => ({ apiKey: "jev-test", timeoutMs: 1000, fetchFn: fakeJev(script, calls) });

// ── The judgement ───────────────────────────────────────────────────────────

Deno.test("Jev's row is the only row decide sees", async () => {
  const j = await judgeThorough(jev({ scores: [0.95, 0.05] }), item([TOAST, MELBA]), sources);
  assertEquals(j.action, "serve");
  assertEquals(applyJudgement(item([TOAST, MELBA]), j).candidates.map((c) => c.food_id), ["t1"]);
});

Deno.test("no row is the food: decide gets no rows, so it estimates", async () => {
  const j = await judgeThorough(jev({ scores: [0.1] }), item([MELBA]), sources);
  assertEquals(j.action, "estimate");
  assertEquals(applyJudgement(item([MELBA]), j).candidates, []);
});

Deno.test("a Jev failure keeps the rows Thorough had", async () => {
  for (const scores of ["fail", "empty"] as const) {
    const j = await judgeThorough(jev({ scores }), item([TOAST, MELBA]), sources);
    assertEquals(j.action, "keep", scores);
    assertEquals(applyJudgement(item([TOAST, MELBA]), j).candidates.length, 2);
  }
});

Deno.test("the gate reads the row's real origin, not 'catalog'", async () => {
  // A plain food takes only a reference row. Without the foods.source lookup
  // every catalog row reads as "catalog" and even the right one is refused.
  const j = await judgeThorough(jev({ scores: [0.95] }), item([TOAST]), new Map());
  assertEquals(j.action, "estimate");
  assertEquals((j.trace.decision as { reason: string }).reason, "kind");
});

Deno.test("prep is part of the food Jev judges", () => {
  assertEquals(matchName({ name: "sweet potato", prep: "boiled" }), "boiled sweet potato");
  assertEquals(matchName({ name: "boiled eggs", prep: "boiled" }), "boiled eggs");
  assertEquals(matchName({ name: "rice", prep: null }), "rice");
});

// ── Through the pipeline ────────────────────────────────────────────────────

function harness(mode: "off" | "shadow" | "on", script: Script) {
  const calls: string[] = [];
  const decideRows: string[][] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("typesafe.ai")) return fakeJev(script, calls)(url, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const tool = body.tool_choice.name;
    calls.push(tool);
    let input: Record<string, unknown>;
    if (tool === "extract_meal" || tool === "estimate_meal") {
      input = { declined: false, items: [{ name: "toast", brand: null, quantity: 2, unit: "slice", prep: null }] };
    } else {
      const payload = JSON.parse(body.messages[0].content);
      decideRows.push(payload.items[0].candidates.map((c: { name: string }) => c.name));
      input = { meal_type: "lunch", drona_line: "Logged.", items: [] };
    }
    return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name: tool, input }] });
  }) as typeof fetch;
  const deps: ParseMealDeps = {
    anthropicApiKey: "test", model: "test", maxTokens: 1000, timeoutMs: 1000, webSearchEnabled: false, fetchFn,
    searchFoods: async () => [TOAST, MELBA],
    backfillOffFood: async () => null,
    getFoodPer100: async () => null,
    jev: { apiKey: "jev-test", timeoutMs: 1000, fetchFn },
    thoroughMatch: { mode, sourcesOf: async () => sources },
  };
  return { deps, calls, decideRows };
}
const input = { text: "2 slices of toast", localHour: 13, mealHint: null, recentFoods: [], todayTotals: null, targets: null };

Deno.test("on: decide sees only the row Jev accepted", async () => {
  const h = harness("on", { scores: [0.95, 0.05] });
  const r = await runParseMeal(h.deps, { ...input, mode: null });
  assertEquals(h.decideRows, [["Bread, white, toasted"]]);
  assert(r.steps.some((s) => s.tool === "thorough_match"));
});

Deno.test("on: no accepted row means decide gets none and estimates", async () => {
  const h = harness("on", { scores: [0.1, 0.1] });
  await runParseMeal(h.deps, { ...input, mode: null });
  assertEquals(h.decideRows, [[]]);
});

Deno.test("shadow: Jev is asked and recorded, decide is untouched", async () => {
  const h = harness("shadow", { scores: [0.1, 0.1] });
  const r = await runParseMeal(h.deps, { ...input, mode: null });
  assertEquals(h.decideRows[0].length, 2);
  const step = r.steps.find((s) => s.tool === "thorough_match")!;
  assertEquals((step.input as { action: string }).action, "estimate");
});

Deno.test("off and Quick never ask Jev about Thorough rows", async () => {
  for (const [mode, tier] of [["off", null], ["on", "fast"]] as const) {
    const h = harness(mode, { scores: [0.95, 0.05] });
    const r = await runParseMeal(h.deps, { ...input, mode: tier });
    assert(!h.calls.includes("score"), `${mode}/${tier}`);
    assert(!r.steps.some((s) => s.tool === "thorough_match"), `${mode}/${tier}`);
  }
});

Deno.test("no row origins: nothing is judged and decide keeps every row", async () => {
  for (const sourcesOf of [async () => new Map<string, string>(), async () => { throw new Error("down"); }]) {
    const h = harness("on", { scores: [0.95, 0.05] });
    h.deps.thoroughMatch = { mode: "on", sourcesOf };
    const r = await runParseMeal(h.deps, { ...input, mode: null });
    assertEquals(h.decideRows[0].length, 2);
    assert(!h.calls.includes("score"));
    assertEquals((r.steps.find((s) => s.tool === "thorough_match")!.result as { reason: string }).reason, "no_sources");
  }
});

Deno.test("only catalog ids are looked up: a FatSecret id would fail the whole lookup", async () => {
  const h = harness("on", { scores: [0.95, 0.05, 0.05] });
  const asked: string[][] = [];
  h.deps.searchFoods = async () => [TOAST, MELBA];
  h.deps.searchFatSecret = async () => [food("fs:123", "Toasted Bread", 290, 9, "fatsecret")];
  h.deps.thoroughMatch = { mode: "on", sourcesOf: async (ids) => { asked.push(ids); return sources; } };
  await runParseMeal(h.deps, { ...input, mode: null });
  assertEquals(asked.length, 1);
  assert(asked[0].every((id) => !id.startsWith("fs:")), JSON.stringify(asked));
});
