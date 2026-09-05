// THE CANONICAL CASE for Phase 7 (from the plan). Kept as a tool, not an eval
// case, because it WRITES to precise_cache and hits the live web - the eval
// corpus must stay side-effect free and repeatable.
//
//   npx tsx tools/super-canonical-case.ts          # cold: clears the row first
//   KEEP=1 npx tsx tools/super-canonical-case.ts   # warm: must serve with 0 searches
//
// Recorded result 2026-09-03: cold run web_searches=2, wrote 190 kcal / 25 g
// protein with 2 readings (one web, one FatSecret, so verified=false because
// FatSecret can never be an independent source). Warm run: 0 searches,
// precise_cache_hit, 4.4s against the cold 15.3s.
//
// THE CANONICAL CASE for Phase 7 (from the plan):
//   "milky mist low fat paneer" must ground from the web with the right macros,
//   and the SECOND identical parse must serve without a web call.
//
// Runs the real pipeline against the real DB and real web search. Asserts on
// the trace, not on vibes: a cache hit is proven by web_search_requests == 0.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { type ParseMealDeps, runParseMeal } from "../supabase/functions/ai-coach/parseMeal";
import { cacheKey } from "../supabase/functions/ai-coach/preciseCache";

const dotenv: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const env = (k: string) => process.env[k] ?? dotenv[k] ?? "";
const admin = createClient(env("EXPO_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const deps: ParseMealDeps = {
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  model: "claude-haiku-4-5",
  maxTokens: 1600,
  timeoutMs: 40000,
  webSearchEnabled: true,
  fastGrammarMode: "off",
  // Catalog deliberately empty: Super's job is the foods the catalog misses,
  // and a real row would mask whether the web path ran at all.
  searchFoods: async () => [],
  backfillOffFood: async () => null,
  getFoodPer100: async () => null,
  getFoodServings: async () => [],
  preciseCacheGet: async (key) => {
    const { data, error } = await admin.rpc("precise_cache_get", { p_key: key }).maybeSingle();
    if (error) { console.log("  cache read error:", error.message); return null; }
    return (data as any) ?? null;
  },
  preciseCachePut: async (row) => {
    const { error } = await admin.from("precise_cache")
      .upsert({ ...row, last_verified_at: new Date().toISOString() }, { onConflict: "cache_key" });
    if (error) console.log("  cache write error:", error.message);
  },
  log: (m) => console.log("  " + m),
};

const TEXT = "50g milky mist low fat paneer";

async function run(label: string) {
  const t0 = Date.now();
  const r = await runParseMeal(deps, {
    text: TEXT, localHour: 13, mealHint: null, mode: "super",
    recentFoods: [], todayTotals: null, targets: null,
  });
  const tools = r.tool_calls.join(",");
  const items = (r.parsed?.items ?? [])
    .map((i) => `${i.food_name} ${i.grams}g ${i.kcal}kcal/${i.protein_g}p [${i.source}] ${i.confidence}`)
    .join(" | ");
  console.log(`\n${label}  ${Date.now() - t0}ms  web_searches=${r.usage.web_search_requests}`);
  console.log(`  tools: ${tools}`);
  console.log(`  ${items}`);
  return r;
}

(async () => {
  const key = cacheKey("low fat paneer", "Milky Mist");
  console.log("cache key:", JSON.stringify(key));
  if (process.env.KEEP !== "1") {
    await admin.from("precise_cache").delete().eq("cache_key", key);
    console.log("(cleared any prior row for a clean first run)");
  } else {
    console.log("(KEEP=1: leaving the existing row in place)");
  }

  const first = await run("RUN 1 (cold)");
  const { data: row } = await admin.from("precise_cache").select("*").eq("cache_key", key).maybeSingle();
  console.log("\nstored row:", row
    ? `${(row as any).display_name} | ${(row as any).kcal}kcal | verified=${(row as any).verified} | sources=${((row as any).evidence ?? []).length}`
    : "NOTHING WRITTEN");
  if (row) {
    console.log("evidence:", JSON.stringify(((row as any).evidence ?? []).map((e: any) => ({ ref: e.ref, kcal: e.per_100?.kcal }))));
  }

  const second = await run("RUN 2 (warm)");

  console.log("\n──── VERDICT ────");
  console.log(`run 1 searched the web:      ${first.usage.web_search_requests > 0 ? "YES" : "NO"}`);
  console.log(`row was written:             ${row ? "YES" : "NO"}`);
  console.log(`run 2 served WITHOUT web:    ${second.usage.web_search_requests === 0 ? "YES" : "NO"}`);
  console.log(`run 2 hit the cache:         ${second.tool_calls.includes("precise_cache_hit") ? "YES" : "NO"}`);
})();
