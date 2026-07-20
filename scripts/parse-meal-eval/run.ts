// parse_meal eval harness (P0 quality gate).
//
// Drives the EXACT production pipeline (supabase/functions/ai-coach/
// parseMeal.ts) from Node against the real catalog: tier-1 search hits live
// Supabase (anon key, global rows only), tier-2 hits the live Open Food
// Facts API in DRY-RUN mode (no backfill writes), tier-3 web search is OFF
// unless EVAL_WEB_SEARCH=1, tier-4 estimates run as in prod.
//
// Run from the repo root:
//   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/parse-meal-eval/run.ts
//   # optional: EVAL_WEB_SEARCH=1  ONLY=roti-dal,whey-scoop  MODEL=claude-haiku-4-5
//
// Supabase URL/key come from env (EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY) or
// a .env.local in the cwd. Costs: ~40 Haiku calls per full run (well under
// $0.10); web search adds ~$0.01 per search when enabled.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  type CandidateFood,
  type ParseMealDeps,
  type ParseMealResult,
  runParseMeal,
} from "../../supabase/functions/ai-coach/parseMeal";
import { CASES, type EvalCase } from "./cases";
import { makeClaudeCliFetch } from "./claude-cli-fetch";

// ── Env ─────────────────────────────────────────────────────────────────────

function loadDotEnvLocal(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const dotenv = loadDotEnvLocal();
const env = (k: string) => process.env[k] ?? dotenv[k] ?? "";

const SUPABASE_URL = env("EXPO_PUBLIC_SUPABASE_URL");
const SUPABASE_ANON_KEY = env("EXPO_PUBLIC_SUPABASE_ANON_KEY");
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const MODEL = env("MODEL") || "claude-haiku-4-5";
const WEB_SEARCH = env("EVAL_WEB_SEARCH") === "1";
// Route model calls through the `claude -p` CLI (subscription) instead of the
// API. Correctness only - see claude-cli-fetch.ts for what it does not model.
const VIA_CLI = env("EVAL_VIA_CLI") === "1";
const ONLY = env("ONLY") ? new Set(env("ONLY").split(",").map((s: string) => s.trim())) : null;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY (env or .env.local in cwd).");
  process.exit(1);
}
if (!ANTHROPIC_API_KEY && !VIA_CLI) {
  console.error("Missing ANTHROPIC_API_KEY. (Or set EVAL_VIA_CLI=1 to run the model through `claude -p`.)");
  process.exit(1);
}
if (VIA_CLI) {
  console.log("[eval] model calls routed through `claude -p` - latency and token counts are NOT comparable to an API run.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Deps: mirrors handleParseMealRequest's wiring, minus writes ─────────────

// Semantic fallback mirror (0080): same behavior as index.ts — embed the
// query and hit search_foods_semantic only when trigram returns nothing.
// Needs VOYAGE_API_KEY in env/.env.local; silently skipped without it.
const VOYAGE_API_KEY = env("VOYAGE_API_KEY");
async function embedQueryForEval(text: string): Promise<number[] | null> {
  if (!VOYAGE_API_KEY) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${VOYAGE_API_KEY}` },
      body: JSON.stringify({ input: [text], model: "voyage-3", input_type: "query" }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

async function searchCatalogWithServings(query: string): Promise<CandidateFood[]> {
  // Mirrors prod (0083): one round trip, servings joined server-side.
  const { data, error } = await supabase.rpc("search_foods_ranked_with_servings", { q: query, lim: 8 });
  if (error) console.error(`  search_foods_ranked_with_servings error: ${error.message}`);
  let rows = (Array.isArray(data) ? data.slice(0, 6) : []) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    const vec = await embedQueryForEval(query);
    if (vec) {
      const { data: sem } = await supabase.rpc("search_foods_semantic_with_servings", {
        p_query_embedding: JSON.stringify(vec),
        lim: 6,
      });
      rows = (Array.isArray(sem) ? sem : []) as Array<Record<string, unknown>>;
    }
  }
  if (rows.length === 0) return [];
  const parseServings = (raw: unknown): { label: string; grams: number; is_default: boolean }[] => {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((s) => {
      const o = s as Record<string, unknown>;
      const label = typeof o?.label === "string" ? o.label : "";
      const grams = Number(o?.grams);
      if (!label || !Number.isFinite(grams)) return [];
      return [{ label, grams, is_default: !!o.is_default }];
    });
  };
  return rows.map((r) => ({
    food_id: String(r.id),
    name: String(r.name),
    brand: r.brand ? String(r.brand) : null,
    base_unit: r.base_unit === "ml" ? ("ml" as const) : ("g" as const),
    kcal: Number(r.kcal ?? 0),
    protein_g: Number(r.protein_g ?? 0),
    carb_g: Number(r.carb_g ?? 0),
    fat_g: Number(r.fat_g ?? 0),
    fiber_g: r.fiber_g === null || r.fiber_g === undefined ? null : Number(r.fiber_g),
    servings: parseServings(r.servings),
    source: "catalog" as const,
  }));
}

let offLookups = 0;
const deps: ParseMealDeps = {
  anthropicApiKey: ANTHROPIC_API_KEY,
  model: MODEL,
  ...(VIA_CLI ? { fetchFn: makeClaudeCliFetch(MODEL) } : {}),
  maxTokens: 1600,
  timeoutMs: 30000,
  webSearchEnabled: WEB_SEARCH,
  searchFoods: searchCatalogWithServings,
  backfillOffFood: async () => {
    // DRY RUN: never write to prod from the eval. The model still receives
    // the OFF macros; the candidate just carries no food_id.
    offLookups++;
    return null;
  },
  getFoodPer100: async (foodId) => {
    const { data } = await supabase
      .from("foods")
      .select("base_unit, kcal, protein_g, carb_g, fat_g, fiber_g")
      .eq("id", foodId)
      .maybeSingle();
    if (!data) return null;
    const row = data as Record<string, unknown>;
    return {
      base_unit: String(row.base_unit ?? "g"),
      kcal: Number(row.kcal ?? 0),
      protein_g: Number(row.protein_g ?? 0),
      carb_g: Number(row.carb_g ?? 0),
      fat_g: Number(row.fat_g ?? 0),
      fiber_g: row.fiber_g === null || row.fiber_g === undefined ? null : Number(row.fiber_g),
    };
  },
  getFoodServings: async (foodId) => {
    const { data } = await supabase
      .from("food_servings")
      .select("label, grams, is_default")
      .eq("food_id", foodId)
      .order("seq", { ascending: true });
    return ((data ?? []) as Array<Record<string, unknown>>).map((s) => ({
      label: String(s.label),
      grams: Number(s.grams),
      is_default: !!s.is_default,
    }));
  },
  log: () => {},
};

// ── Scoring ─────────────────────────────────────────────────────────────────

interface CaseOutcome {
  id: string;
  pass: boolean;
  failures: string[];
  tiers: string[];
  ms: number;
  tokens: number;
  summary: string;
}

function scoreCase(c: EvalCase, result: ParseMealResult): string[] {
  const failures: string[] = [];
  const exp = c.expect;

  if (exp.declined) {
    if (!result.declined) failures.push("expected decline, but it logged");
    return failures;
  }
  if (result.declined) {
    failures.push(`expected a log, got decline: "${result.declined.message}"`);
    return failures;
  }
  if (c.expectCorrection !== undefined) {
    const got = result.parsed?.corrects_previous === true;
    if (got !== c.expectCorrection) {
      failures.push(`corrects_previous ${got} != ${c.expectCorrection}`);
    }
  }
  const items = result.parsed!.items;
  if (exp.minItems !== undefined && items.length < exp.minItems) {
    failures.push(`items ${items.length} < min ${exp.minItems}`);
  }
  if (exp.maxItems !== undefined && items.length > exp.maxItems) {
    failures.push(`items ${items.length} > max ${exp.maxItems}`);
  }
  if (exp.mealType && result.parsed!.meal_type !== exp.mealType) {
    failures.push(`meal_type ${result.parsed!.meal_type} != ${exp.mealType}`);
  }
  for (const ie of exp.items ?? []) {
    // nameIncludes plus optional nameIncludesAny alternates: a "roasted
    // edamame" line is equally correct as "Edamame..." or "Soybeans, mature
    // seeds, roasted..." — same food under two names.
    const needles = [ie.nameIncludes, ...(ie.nameIncludesAny ?? [])].map((n) => n.toLowerCase());
    const match = items.find((i) => needles.some((n) => i.food_name.toLowerCase().includes(n)));
    if (!match) {
      failures.push(`no item matching "${needles.join('|')}" (got: ${items.map((i) => i.food_name).join(" | ")})`);
      continue;
    }
    for (const bad of ie.nameExcludes ?? []) {
      if (match.food_name.toLowerCase().includes(bad.toLowerCase())) {
        failures.push(`"${ie.nameIncludes}" resolved to "${match.food_name}" which must not contain "${bad}"`);
      }
    }
    if (ie.tiers && !ie.tiers.includes(match.source)) {
      failures.push(`"${ie.nameIncludes}" tier ${match.source} not in [${ie.tiers.join(",")}]`);
    }
    if (ie.gramsBetween) {
      const [lo, hi] = ie.gramsBetween;
      if (match.grams < lo || match.grams > hi) {
        failures.push(`"${ie.nameIncludes}" grams ${match.grams} outside [${lo}, ${hi}]`);
      }
    }
    if (ie.proteinBetween) {
      const [lo, hi] = ie.proteinBetween;
      if (match.protein_g < lo || match.protein_g > hi) {
        failures.push(`"${ie.nameIncludes}" protein ${match.protein_g} outside [${lo}, ${hi}]`);
      }
    }
    if (ie.kcalBetween) {
      const [lo, hi] = ie.kcalBetween;
      if (match.kcal < lo || match.kcal > hi) {
        failures.push(`"${ie.nameIncludes}" kcal ${match.kcal} outside [${lo}, ${hi}]`);
      }
    }
  }
  return failures;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const cases = CASES.filter((c) => !ONLY || ONLY.has(c.id))
    .filter((c) => !c.expect.needsWebSearch || WEB_SEARCH);
  console.log(
    `parse_meal eval: ${cases.length} cases | model=${MODEL} | web_search=${WEB_SEARCH ? "on" : "off"} | OFF backfill=DRY RUN\n`,
  );

  const outcomes: CaseOutcome[] = [];
  let totalTokens = 0;

  for (const c of cases) {
    const started = Date.now();
    try {
      const baseInput = {
        localHour: c.hour ?? null,
        mealHint: null,
        recentFoods: [],
        todayTotals: null,
        targets: { daily_calorie_target: 2400, protein_target_g: 140 },
      };
      let result = await runParseMeal(deps, { ...baseInput, text: c.text });
      // Follow-up cases: replay the first parse as the meal on screen, then
      // score the follow-up — exactly what the client sends.
      if (c.followUp) {
        const prev = (result.parsed?.items ?? []).map((i) => ({
          food_id: i.food_id,
          food_name: i.food_name,
          quantity: i.quantity,
          serving_label: i.serving_label,
          grams: i.grams,
        }));
        result = await runParseMeal(deps, {
          ...baseInput,
          text: c.followUp,
          previousText: c.text,
          previousItems: prev,
        });
      }
      const failures = scoreCase(c, result);
      const tokens = result.usage.input_tokens + result.usage.output_tokens;
      totalTokens += tokens;
      const tiers = result.parsed ? [...new Set(result.parsed.items.map((i) => i.source))] : [];
      outcomes.push({
        id: c.id,
        pass: failures.length === 0,
        failures,
        tiers,
        ms: Date.now() - started,
        tokens,
        summary: result.parsed
          ? result.parsed.items
            .map((i) => `${i.food_name} ${i.grams}g ${i.kcal}kcal/${i.protein_g}p [${i.source}]`)
            .join("; ") + ` :: "${result.parsed.drona_line}"`
          : `DECLINED: ${result.declined?.message ?? ""}`,
      });
    } catch (e) {
      outcomes.push({
        id: c.id, pass: false, failures: [`threw: ${String(e).slice(0, 160)}`],
        tiers: [], ms: Date.now() - started, tokens: 0, summary: "",
      });
    }
    const last = outcomes[outcomes.length - 1];
    console.log(`${last.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(24)} ${last.ms}ms  [${last.tiers.join(",")}]`);
    if (!last.pass) for (const f of last.failures) console.log(`      - ${f}`);
    if (last.summary) console.log(`      ${last.summary}`);
    // Be gentle with the API and OFF.
    await new Promise((r) => setTimeout(r, 400));
  }

  const passed = outcomes.filter((o) => o.pass).length;
  const declineCases = cases.filter((c) => c.expect.declined).length;
  const tierCounts: Record<string, number> = {};
  for (const o of outcomes) for (const t of o.tiers) tierCounts[t] = (tierCounts[t] ?? 0) + 1;
  const avgMs = Math.round(outcomes.reduce((a, o) => a + o.ms, 0) / Math.max(outcomes.length, 1));

  console.log("\n──────── summary ────────");
  console.log(`passed:        ${passed}/${outcomes.length}  (${declineCases} decline cases)`);
  console.log(`tier mix:      ${JSON.stringify(tierCounts)}`);
  console.log(`avg latency:   ${avgMs}ms`);
  console.log(`total tokens:  ${totalTokens}`);
  console.log(`OFF lookups:   ${offLookups} (dry run, nothing written)`);
  const hardFails = outcomes.filter((o) => !o.pass);
  if (hardFails.length > 0) {
    console.log(`\nfailed cases: ${hardFails.map((o) => o.id).join(", ")}`);
  }
  process.exit(passed === outcomes.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
