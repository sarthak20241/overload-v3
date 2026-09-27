// Run with: deno test --allow-all supabase/functions/ai-coach/ourSources.test.ts
//
// Precise, our sources first. Jev is faked at fetch; the gate and the flow are
// the real code. The two promises that matter most: "shadow" never changes what
// the user is served, and "on" never pays for the web when a row answers.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { matchOurSources, selectMatchRows } from "./ourSources.ts";
import type { MatchCandidate } from "./preciseMatch.ts";
import { type CandidateFood, type ParseMealDeps, superLookupOne } from "./parseMeal.ts";

type Row = { food: CandidateFood; meta: MatchCandidate };

const food = (id: string, name: string, kcal: number, protein: number, brand: string | null = null): CandidateFood => ({
  food_id: id, name, brand, base_unit: "g", kcal, protein_g: protein, carb_g: 0, fat_g: 0, fiber_g: null,
  servings: [], source: "catalog",
});
const row = (id: string, name: string, source: string, kcal: number, protein: number, brand: string | null = null): Row => ({
  food: food(id, name, kcal, protein, brand),
  meta: { id, name, brand, source, kcal, protein_g: protein },
});

const BANANA = row("b1", "Bananas, raw", "usda", 89, 1.1);
const BANANA_2 = row("b2", "Banana", "web_verified", 89, 1.1);
const CHIPS = row("b3", "Banana chips", "usda", 519, 2.3);
const SP_RIGHT = row("s1", "Sweet potato, boiled, no added fat", "usda", 82, 1.4);
const SP_FAT = row("s2", "Sweet potato, boiled, NS as to fat", "usda", 115, 1.4);

interface JevScript {
  kind?: { choice: string; confidence: number } | "fail";
  /** Score (chance of "exactly this food") per candidate, in order. */
  scores?: number[] | "fail";
  tie?: Record<string, number>;
}

function fakeJev(script: JevScript, seen: { calls: string[] }): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const keys = Object.keys(body.questions);
    const answers: Record<string, unknown> = {};
    if (keys.some((k) => k.endsWith("_kind"))) {
      seen.calls.push("kind");
      if (script.kind === "fail") return new Response("x", { status: 500 });
      const k = script.kind ?? { choice: "plain", confidence: 0.95 };
      answers.f1_kind = { type: "choice", choice: k.choice, confidence: k.confidence, probabilities: { [k.choice]: k.confidence } };
    } else if (keys.some((k) => k.endsWith("_tie"))) {
      seen.calls.push("tie");
      const probs = script.tie ?? { none: 1 };
      const [choice, confidence] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
      answers.f1_tie = { type: "choice", choice, confidence, probabilities: probs };
    } else {
      seen.calls.push("score");
      if (script.scores === "fail") return new Response("x", { status: 500 });
      keys.forEach((k, i) => {
        const p = Array.isArray(script.scores) ? (script.scores[i] ?? 0) : 0;
        answers[k] = { type: "score", score: 2 * p, confidence: 0.9, legend: {}, probabilities: { "0": 1 - p, "1": 0, "2": p } };
      });
    }
    return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;
}

const jevDeps = (script: JevScript, seen: { calls: string[] }) => ({
  apiKey: "jev-test", timeoutMs: 1000, fetchFn: fakeJev(script, seen),
});

// ── The flow ────────────────────────────────────────────────────────────────

Deno.test("a plain food with a lab row is answered from our sources", async () => {
  const seen = { calls: [] as string[] };
  const r = await matchOurSources(
    { jev: jevDeps({ scores: [0.95, 0.93, 0.02] }, seen), findCandidates: async () => [BANANA, BANANA_2, CHIPS] },
    { name: "banana", brand: null },
  );
  assertEquals(r.match?.meta.id, "b1");
  assertEquals(seen.calls, ["kind", "score"]);
});

Deno.test("rows that disagree on numbers get a side-by-side tie-break", async () => {
  const seen = { calls: [] as string[] };
  const r = await matchOurSources(
    { jev: jevDeps({ scores: [0.96, 0.99], tie: { c2: 0.8, c1: 0.15, none: 0.05 } }, seen), findCandidates: async () => [SP_RIGHT, SP_FAT] },
    { name: "boiled sweet potato", brand: null },
  );
  // The tie-break lists rows in score order: SP_FAT (0.99) is c1, SP_RIGHT is c2.
  assertEquals(r.match?.meta.id, "s1");
  assertEquals(seen.calls, ["kind", "score", "tie"]);
});

Deno.test("an unclear tie-break serves nothing", async () => {
  const seen = { calls: [] as string[] };
  const r = await matchOurSources(
    { jev: jevDeps({ scores: [0.96, 0.99], tie: { c1: 0.45, c2: 0.4, none: 0.15 } }, seen), findCandidates: async () => [SP_RIGHT, SP_FAT] },
    { name: "boiled sweet potato", brand: null },
  );
  assertEquals(r.match, null);
});

Deno.test("an unsure kind is judged strictly: a plain lab row is not served", async () => {
  const seen = { calls: [] as string[] };
  const r = await matchOurSources(
    { jev: jevDeps({ kind: { choice: "plain", confidence: 0.4 }, scores: [0.95] }, seen), findCandidates: async () => [BANANA] },
    { name: "banana", brand: null },
  );
  assertEquals(r.match, null);
  assertEquals(r.trace.kind, null);
});

Deno.test("Jev down or no candidates: no match, never a throw", async () => {
  const seen = { calls: [] as string[] };
  const down = await matchOurSources(
    { jev: jevDeps({ scores: "fail" }, seen), findCandidates: async () => [BANANA] },
    { name: "banana", brand: null },
  );
  assertEquals(down.match, null);
  const empty = await matchOurSources(
    { jev: jevDeps({}, seen), findCandidates: async () => [] },
    { name: "banana", brand: null },
  );
  assertEquals(empty.match, null);
  const broken = await matchOurSources(
    { jev: jevDeps({}, seen), findCandidates: async () => { throw new Error("db down"); } },
    { name: "banana", brand: null },
  );
  assertEquals(broken.match, null);
});

Deno.test("selectMatchRows keeps production's top 8, then adds lab rows from further down", () => {
  const branded = Array.from({ length: 10 }, (_, i) => ({ id: `off${i}` }));
  const generic = { id: "usda-oats" };
  const picked = selectMatchRows([...branded, generic], [], (id) => (id.startsWith("off") ? "off" : "usda"));
  assertEquals(picked.length, 9);
  assertEquals(picked[8].id, "usda-oats");
  assertEquals(picked.slice(0, 8).map((r) => r.id), branded.slice(0, 8).map((r) => r.id));
});

// ── Wired into Precise (superLookupOne → resolveOneItem path via deps) ──────
// superLookupOne is the web step only; the our-sources hook lives in
// resolveOneItem. These drive the hook through runParseMeal is heavy, so the
// integration check below exercises the real resolve path with a stub web.

import { runParseMeal, SHADOW_GRACE_MS } from "./parseMeal.ts";

function parseDeps(mode: "shadow" | "on", webCalls: string[], seen: { calls: string[] }): ParseMealDeps {
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: true,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null,
    jev: jevDeps({ scores: [0.95, 0.93, 0.02] }, seen),
    preciseMatch: { mode, findCandidates: async () => [BANANA, BANANA_2, CHIPS] },
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const tools: string[] = (body.tools ?? []).map((t: { name: string }) => t.name);
      if (tools.includes("report_sources")) {
        webCalls.push("web");
        return Response.json({
          stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } },
          content: [{ type: "tool_use", name: "report_sources", input: { results: [{
            for_item: "banana", found: true,
            readings: [{ url: "https://a.com/x", per_100: { kcal: 95, protein_g: 1, carb_g: 23, fat_g: 0.3 } }],
          }] } }],
        });
      }
      // extract + decide: one banana, 100 g.
      const name = tools[0] ?? "";
      if (name === "extract_meal") {
        return Response.json({
          stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", name, input: { declined: false, meal_type_from_text: null, items: [
            { name: "banana", brand: null, quantity: 100, unit: "g", prep: null },
          ] } }],
        });
      }
      return Response.json({
        stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "tool_use", name, input: {
          meal_type: "snack", drona_line: "ok",
          items: [{ food_name: "banana", food_id: null, quantity: 100, unit: "g", grams: 100, kcal: 89, protein_g: 1.1, carb_g: 23, fat_g: 0.3, confidence: "high" }],
        } }],
      });
    }) as typeof fetch,
  };
}

const INPUT = { text: "100g banana", localHour: 13, mealHint: null, mode: "super" as const, recentFoods: [], todayTotals: null, targets: null };

Deno.test("shadow: the web still answers, and the trace records what our sources would have served", async () => {
  const web: string[] = [];
  const seen = { calls: [] as string[] };
  const r = await runParseMeal(parseDeps("shadow", web, seen), INPUT);
  assertEquals(web.length, 1);
  assert(r.tool_calls.includes("super_lookup"));
  assert(!r.tool_calls.includes("our_sources_match"));
  const step = r.steps.find((s) => s.tool === "our_sources");
  assertEquals((step?.input as { mode: string }).mode, "shadow");
  assertEquals(((step?.result as { decision: { match: string } }).decision).match, "Bananas, raw");
  assertEquals(((step?.result as { web: { kcal: number } }).web).kcal, 95);
});

Deno.test("shadow: a slow match never holds the answer past the grace period", async () => {
  const web: string[] = [];
  const seen = { calls: [] as string[] };
  const deps = parseDeps("shadow", web, seen);
  let release: () => void = () => {};
  const blocked = new Promise<void>((res) => { release = res; });
  deps.preciseMatch = {
    mode: "shadow",
    findCandidates: async () => { await blocked; return [BANANA]; },
  };
  const t0 = Date.now();
  const r = await runParseMeal(deps, INPUT);
  const ms = Date.now() - t0;
  release();
  assert(ms < SHADOW_GRACE_MS + 1500, `took ${ms} ms`);
  assert(r.tool_calls.includes("super_lookup"));
  const step = r.steps.find((s) => s.tool === "our_sources");
  assertEquals((step?.result as { unfinished?: boolean }).unfinished, true);
});

Deno.test("on: a row our sources accept answers, and the web is never paid for", async () => {
  const web: string[] = [];
  const seen = { calls: [] as string[] };
  const r = await runParseMeal(parseDeps("on", web, seen), INPUT);
  assertEquals(web.length, 0);
  assert(r.tool_calls.includes("our_sources_match"));
  assert(!r.tool_calls.includes("super_lookup"));
});

// superLookupOne is imported so a rename of the web step breaks this file loudly.
void superLookupOne;
