// WHY DOES SUPER WOBBLE? (plan item 7e, third bullet)
//
// Cadbury 5 Star has come back at 447 kcal (exact) twice and 533 (+19%) once
// from identical code. This asks whether the same food, asked repeatedly,
// lands in the same place - and if not, how far apart.
//
//   npx tsx tools/super-probe/wobble.ts
//
// BUDGET, enforced rather than hoped for: 4 foods x 3 runs x at most 2 searches
// = 24 searches at $0.01, about $0.24. MAX_SEARCHES is 26 rather than 24 because
// the check runs BEFORE each lookup, not during one: at 24 exactly, a planned
// run would be cancelled by rounding rather than by overspend. The real ceiling
// is 26 plus at most one run in flight, so ~$0.28 worst case, never open-ended.
//
// Deliberately NOT the 16-food corpus in cases.ts: the other twelve were steady,
// and re-measuring a steady food teaches nothing about wobble. Same reason each
// food repeats - one run of many foods cannot show variance at all. Cost of the
// full corpus for this question would have been ~$1 for the same answer.
//
// Touches NOTHING in production: preciseCacheGet always misses so every run is
// cold, and preciseCachePut is a no-op so no probe row is ever written. The
// cache read path is live on every tier, so a probe row would otherwise be
// served to real users for 90 days.
import { readFileSync } from "node:fs";
import { type ParseMealDeps, runParseMeal } from "../../supabase/functions/ai-coach/parseMeal";

// .env.local is a convenience, not a requirement: CI and anyone running this
// with ANTHROPIC_API_KEY already exported should not be stopped by a missing
// file. A real env var still wins over the file.
const dotenv: Record<string, string> = {};
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env.local; fall through to process.env */ }
// No Supabase client on purpose. This probe reads and writes nothing, so it must
// not require a service-role key to run - a script that asks for prod credentials
// it never uses is one nobody can be sure is safe.
const env = (k: string) => process.env[k] ?? dotenv[k] ?? "";
if (!env("ANTHROPIC_API_KEY")) {
  console.error("ANTHROPIC_API_KEY is required (export it, or put it in .env.local).");
  process.exit(1);
}

const MAX_SEARCHES = 26;
const RUNS = 3;

/** The four with the widest measured spread on 2026-09-04, with the pack label
 *  from Open Food Facts so drift has something to drift FROM. */
const CASES = [
  { id: "cadbury-5-star",   text: "100g Cadbury 5 Star",                            truth: 447 },
  { id: "amul-malai-paneer", text: "100g Amul Malai Paneer",                        truth: 312 },
  { id: "nutrichoice",      text: "100g Britannia NutriChoice Digestive biscuits",  truth: 497 },
  { id: "bingo-mad-angles", text: "100g Bingo Mad Angles Mmmmm Masala",             truth: 538 },
];

let spent = 0;

const deps: ParseMealDeps = {
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  model: "claude-haiku-4-5",
  maxTokens: 1600,
  timeoutMs: 60000,
  webSearchEnabled: true,
  fastGrammarMode: "off",
  searchFoods: async () => [],
  backfillOffFood: async () => null,
  getFoodPer100: async () => null,
  getFoodServings: async () => [],
  preciseCacheGet: async () => null,
  preciseCachePut: async () => {},
  log: () => {},
};

async function once(text: string) {
  const t0 = Date.now();
  const r = await runParseMeal(deps, {
    text, localHour: 13, mealHint: null, mode: "super",
    recentFoods: [], todayTotals: null, targets: null,
  });
  spent += r.usage.web_search_requests ?? 0;
  const item = r.parsed?.items?.[0];
  const g = Number(item?.grams) || 0;
  const k = g > 0 ? 100 / g : 0;
  const step = ((r as any).steps ?? []).find((s: any) => s.tool === "super_lookup");
  return {
    ms: Date.now() - t0,
    searches: r.usage.web_search_requests ?? 0,
    name: String(item?.food_name ?? "-"),
    source: String(item?.source ?? "-"),
    kcal: item ? Number(item.kcal) * k : NaN,
    protein: item ? Number(item.protein_g) * k : NaN,
    found: !!step,
  };
}

(async () => {
  console.log(`budget ${MAX_SEARCHES} searches (~$${(MAX_SEARCHES * 0.01).toFixed(2)}); stops if exceeded\n`);
  const summary: { id: string; spread: number; usedWeb: number; runs: number }[] = [];
  for (const c of CASES) {
    const rows: Awaited<ReturnType<typeof once>>[] = [];
    for (let i = 0; i < RUNS; i++) {
      if (spent >= MAX_SEARCHES) { console.log("BUDGET REACHED - stopping"); break; }
      rows.push(await once(c.text));
    }
    const kcals = rows.map((r) => r.kcal).filter(Number.isFinite);
    const spread = kcals.length ? ((Math.max(...kcals) - Math.min(...kcals)) / c.truth) * 100 : NaN;
    console.log(`${c.id}   label ${c.truth} kcal`);
    for (const r of rows) {
      const err = ((r.kcal - c.truth) / c.truth) * 100;
      console.log(
        `   ${r.kcal.toFixed(0).padStart(4)} kcal ${(err >= 0 ? "+" : "")}${err.toFixed(0).padStart(3)}%   ` +
        `${r.protein.toFixed(1).padStart(5)}g P   ${(r.ms / 1000).toFixed(1)}s  srch=${r.searches}  ` +
        `web=${r.found ? "yes" : "NO "}  [${r.source}]  "${r.name}"`,
      );
    }
    console.log(`   spread across runs: ${spread.toFixed(1)}% of label\n`);
    summary.push({ id: c.id, spread, usedWeb: rows.filter((r) => r.found).length, runs: rows.length });
  }
  console.log("──── SUMMARY ────");
  for (const s of summary) {
    console.log(`${s.id.padEnd(20)} spread ${s.spread.toFixed(1).padStart(5)}%   web lookup ran ${s.usedWeb}/${s.runs}`);
  }
  console.log(`\nsearches used: ${spent}  (~$${(spent * 0.01).toFixed(2)})`);
})();
