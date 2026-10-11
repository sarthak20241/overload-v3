// Live probe for the Precise search rewrite: real Tavily, real Jev, model via
// `claude -p` (EVAL_VIA_CLI=1, the default here) or the API (EVAL_VIA_CLI=0).
// Accuracy only; CLI timings measure the CLI, not the pipeline.
//
//   npx tsx tools/search-rewrite-probe/run.mts "Oreo protein bar" "Muscle Blaze"
//
// Reads TAVILY_API_KEY / JEV_API_KEY from .env.local (falls back to the main
// checkout's, which is where they live). Costs ~4 Tavily credits per run.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseSuggestion,
  runTavilyLookup,
  suggestSearchPayload,
} from "../../supabase/functions/ai-coach/tavilyLookup.ts";
import { makeClaudeCliFetch } from "../../scripts/parse-meal-eval/claude-cli-fetch.ts";

const dotenv: Record<string, string> = {};
for (const p of [".env.local", resolve(process.cwd(), "../../../.env.local")]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !dotenv[m[1]]) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = (k: string) => process.env[k] ?? dotenv[k] ?? "";

const MODEL = "claude-haiku-5-5";
const viaCli = env("EVAL_VIA_CLI") !== "0";
const fetchFn = viaCli ? makeClaudeCliFetch(MODEL) : fetch;

async function callModel(payload: Record<string, unknown>) {
  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.ok ? res.json() : null;
}

const [name = "Oreo protein bar", brand = "Muscle Blaze"] = process.argv.slice(2);
const out = await runTavilyLookup({
  tavily: { apiKey: env("TAVILY_API_KEY"), timeoutMs: 20000 },
  jev: { apiKey: env("JEV_API_KEY"), timeoutMs: 8000 },
  country: "india",
  model: MODEL,
  callModel,
  suggestSearch: async (item, seen) => parseSuggestion(await callModel(suggestSearchPayload(MODEL, item, seen))),
}, { name, brand: brand || null });

console.log(`mode: ${viaCli ? "CLI (accuracy only)" : "API"}`);
for (const s of out.steps) console.log(s.tool, JSON.stringify(s.input), JSON.stringify(s.result).slice(0, 600));
console.log("\nrenamed:", out.renamed ?? null, " credits:", out.credits, " unavailable:", out.unavailable);
console.log("finding:", out.finding
  ? JSON.stringify({ searched_as: out.finding.searched_as, serving: [out.finding.serving_label, out.finding.serving_grams], readings: out.finding.readings.map((r) => ({ ref: r.ref, per_100: r.per_100 })) }, null, 1)
  : null);

// --full "<message>": the whole Precise parse on that message, catalog off
// (no DB), so the web path and decide are what answer.
const fullAt = process.argv.indexOf("--full");
if (fullAt > 0) {
  const { runParseMeal } = await import("../../supabase/functions/ai-coach/parseMeal.ts");
  const text = process.argv[fullAt + 1];
  const r = await runParseMeal({
    anthropicApiKey: env("ANTHROPIC_API_KEY"), model: MODEL, maxTokens: 1600, timeoutMs: 120000, webSearchEnabled: true,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null, getFoodServings: async () => [],
    fetchFn, webLookup: "tavily",
    tavily: { apiKey: env("TAVILY_API_KEY"), timeoutMs: 20000 },
    jev: { apiKey: env("JEV_API_KEY"), timeoutMs: 8000 },
    searchCountry: "india",
  }, { text, localHour: 10, mealHint: null, mode: "super", recentFoods: [], todayTotals: null, targets: null });
  console.log("\n=== full parse ===");
  for (const s of r.steps) if (["search_rewrite", "brand_check", "super_lookup"].includes(s.tool)) console.log(s.tool, JSON.stringify(s.result).slice(0, 300));
  for (const it of r.parsed?.items ?? []) {
    console.log(JSON.stringify({ name: it.food_name, said: it.said_name, grams: it.grams, serving: it.serving_label, kcal: it.kcal, protein: it.protein_g, source: it.source, conf: it.confidence, note: it.assumption }));
  }
}
