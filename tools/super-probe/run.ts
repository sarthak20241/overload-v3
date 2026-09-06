// Super mode accuracy probe. Runs every case in cases.ts through the REAL
// pipeline against the REAL web, scores it against pack labels, and prints an
// error distribution rather than a bare pass rate.
//
//   npx tsx tools/super-probe/run.ts
//   ONLY=amul-lassi,cadbury-gems  npx tsx tools/super-probe/run.ts
//   CONCURRENCY=4                 npx tsx tools/super-probe/run.ts
//   KEEP=1                        npx tsx tools/super-probe/run.ts   # warm run
//   RESTORE=<path>                npx tsx tools/super-probe/run.ts   # crash recovery
//
// COSTS REAL MONEY and this one cannot go through the Claude CLI. Super's
// lookup uses Anthropic's SERVER-SIDE web_search tool, which only exists on the
// API; EVAL_VIA_CLI has nothing to route. Budget roughly 2 searches per case at
// $0.01 each plus Haiku tokens - about $0.40 for a full cold run of 16.
//
// SIDE EFFECTS, and they land in PRODUCTION. precise_cache is shared and the
// cache read is live for EVERY tier, not just Super - so a row this probe writes
// is served to real users for the full 90-day TTL. Some of what Super finds is
// wrong (a run of this probe banked Cadbury 5 Star at 533 kcal against a 447
// label), so the probe deletes every row IT wrote when it finishes.
//
// It deletes NOTHING ELSE. Rows that already existed are borrowed and put back
// (see "borrowing production rows" below) - the earlier cleanup deleted by
// pattern, which would have destroyed a real user's row for any food sharing a
// token once Super went live. KEEP=1 skips the borrow entirely and leaves the
// probe's own rows in production; use it only for a deliberate warm-path test,
// and clear up after.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { type ParseMealDeps, runParseMeal } from "../../supabase/functions/ai-coach/parseMeal";
import { PROBE_CASES, type ProbeCase, type Range } from "./cases";

const dotenv: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const env = (k: string) => process.env[k] ?? dotenv[k] ?? "";

const admin = createClient(env("EXPO_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Tolerance around the label band. Wide on purpose: see the header of
 *  cases.ts. Errors worth catching are 2x-10x, not 15%. */
const TOL = 0.15;
/** Below this many grams of a macro, a percentage is meaningless - 0.7 g vs
 *  1.5 g of fat is a 114% "error" that says nothing about the lookup. Use an
 *  absolute allowance instead. */
const MACRO_ABS_FLOOR_G = 3;

function bandMiss(actual: number | null | undefined, r: Range, absFloor = 0): number | null {
  // Returns signed % error against the NEAREST edge of the truth band, or null
  // when there is nothing to compare. Inside the band scores 0 - being between
  // two legitimately printed panels is not an error.
  if (actual === null || actual === undefined || Number.isNaN(actual)) return null;
  if (actual >= r.lo && actual <= r.hi) return 0;
  const edge = actual < r.lo ? r.lo : r.hi;
  if (edge <= absFloor && Math.abs(actual - edge) <= absFloor) return 0;
  return (actual - edge) / edge;
}

function within(err: number | null, tol = TOL): boolean {
  return err !== null && Math.abs(err) <= tol;
}

const deps: ParseMealDeps = {
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  model: "claude-haiku-4-5",
  maxTokens: 1600,
  timeoutMs: 60000,
  webSearchEnabled: true,
  fastGrammarMode: "off",
  // Catalog OFF. The ground truth in cases.ts IS the catalog's OFF rows, so
  // leaving search on would let Super read the answer key and the probe would
  // measure nothing at all.
  searchFoods: async () => [],
  backfillOffFood: async () => null,
  getFoodPer100: async () => null,
  getFoodServings: async () => [],
  preciseCacheGet: async (key) => {
    const { data } = await admin.rpc("precise_cache_get", { p_key: key }).maybeSingle();
    return (data as any) ?? null;
  },
  preciseCachePut: async (row) => {
    await admin.from("precise_cache")
      .upsert({ ...row, last_verified_at: new Date().toISOString() }, { onConflict: "cache_key" });
  },
  log: () => {},
};

interface Result {
  c: ProbeCase;
  ok: boolean;
  reason: string;
  name: string;
  per100: { kcal: number; p: number; c: number; f: number } | null;
  errKcal: number | null;
  errP: number | null;
  searches: number;
  ms: number;
  sources: number;
  verified: boolean | null;
  cached: boolean;
}

/** Find this case's cache row by token match on the key. Returns null rather
 *  than throwing: a missing row means the lookup wrote nothing, which is a
 *  finding to report, not a crash. */
async function findRow(c: ProbeCase): Promise<any | null> {
  let q = admin.from("precise_cache").select("cache_key, display_name, verified, evidence");
  for (const t of c.keyTokens) q = q.ilike("cache_key", `%${t}%`);
  const { data } = await q.limit(2);
  if (!data || data.length === 0) return null;
  // Two matches means the tokens are too loose to identify the row. Flag it
  // rather than silently scoring against whichever came back first.
  if (data.length > 1) return { ...data[0], _ambiguous: true };
  return data[0];
}

async function runOne(c: ProbeCase): Promise<Result> {
  const t0 = Date.now();
  const base: Omit<Result, "ok" | "reason"> = {
    c, name: "", per100: null, errKcal: null, errP: null,
    searches: 0, ms: 0, sources: 0, verified: null, cached: false,
  };
  try {
    const r = await runParseMeal(deps, {
      text: c.text, localHour: 13, mealHint: null, mode: "super",
      recentFoods: [], todayTotals: null, targets: null,
    });
    const ms = Date.now() - t0;
    const item = r.parsed?.items?.[0];
    if (!item) {
      return { ...base, ms, searches: r.usage.web_search_requests ?? 0,
               ok: false, reason: "no item returned" };
    }
    // The case asks for 100 g, so the item totals ARE per-100g - but only if
    // the pipeline actually resolved 100 g. If it decided the portion was
    // something else, normalise rather than silently comparing wrong bases.
    const g = Number(item.grams) || 0;
    if (g <= 0) return { ...base, ms, ok: false, reason: "zero grams" };
    const k = 100 / g;
    const per100 = {
      kcal: Number(item.kcal) * k,
      p: Number(item.protein_g) * k,
      c: Number(item.carb_g) * k,
      f: Number(item.fat_g) * k,
    };
    const name = String(item.food_name ?? "");
    const lname = name.toLowerCase();

    // The cache key is built from the EXTRACTED name and brand inside the
    // pipeline, so it cannot be recomputed out here. Match on tokens instead.
    const row = { data: await findRow(c) };

    const errKcal = bandMiss(per100.kcal, c.kcal);
    const errP = bandMiss(per100.p, c.protein_g, MACRO_ABS_FLOOR_G);
    const nameOk = c.nameIncludes.some((n) => lname.includes(n.toLowerCase()));

    const out = {
      ...base, ms, name, per100, errKcal, errP,
      searches: r.usage.web_search_requests ?? 0,
      sources: ((row.data as any)?.evidence ?? []).length,
      verified: (row.data as any)?.verified ?? null,
      cached: r.tool_calls.includes("precise_cache_hit"),
    };
    // Name first: a wrong product with plausible numbers is the failure that a
    // calorie check alone waves through.
    if (!nameOk) return { ...out, ok: false, reason: `wrong product: "${name}"` };
    if (!within(errKcal)) return { ...out, ok: false, reason: `kcal off ${pct(errKcal)}` };
    if (!within(errP, 0.30)) return { ...out, ok: false, reason: `protein off ${pct(errP)}` };
    return { ...out, ok: true, reason: "" };
  } catch (e) {
    return { ...base, ms: Date.now() - t0, ok: false, reason: `threw: ${String(e).slice(0, 90)}` };
  }
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100 >= 0 ? "+" : "")}${(x * 100).toFixed(0)}%`);

// ─────────────────────── borrowing production rows ───────────────────────
//
// precise_cache is GLOBAL and has no owner column - by design, because a
// product's macros are a fact about the product, not about whoever asked. That
// makes "delete the rows for this case" a dangerous instruction: the original
// cleanup deleted by `ilike cache_key %token%` for each of the case's tokens,
// which was harmless while the table held one row and stops being harmless the
// moment Super is on and real users create rows. A case with the token "paneer"
// would delete a user's researched paneer row, and a KEEP=1 run would leave a
// wrong one in its place for the full 90-day TTL.
//
// So the probe no longer deletes anything it did not create. It BORROWS:
//   1. read the rows its loose tokens match, whole,
//   2. write them to disk BEFORE touching the table (the crash net),
//   3. delete them BY EXACT cache_key - never a pattern,
//   4. run,
//   5. delete only keys that were NOT borrowed (those are the probe's own),
//   6. put the borrowed rows back, then drop the file.
//
// A run that dies between 3 and 6 leaves the file behind on purpose. Restore it
// with RESTORE=<path> npx tsx tools/super-probe/run.ts - that is why the path is
// printed loudly rather than logged quietly.
const RESTORE_DIR = "tools/super-probe";

type CacheRow = Record<string, unknown> & { cache_key: string };

/** Rows a case's tokens match. Read-only; the loose match stays loose here
 *  because over-matching a row we are about to preserve costs nothing, while
 *  under-matching one would leave it to be deleted as "ours" in step 5. */
async function matchingRows(c: ProbeCase): Promise<CacheRow[]> {
  let q = admin.from("precise_cache").select("*");
  for (const t of c.keyTokens) q = q.ilike("cache_key", `%${t}%`);
  const { data, error } = await q;
  if (error) throw new Error(`precise_cache read failed: ${error.message}`);
  return (data ?? []) as CacheRow[];
}

let restorePath: string | null = null;
let borrowedKeys = new Set<string>();

async function borrowRows(cases: ProbeCase[]): Promise<CacheRow[]> {
  const rows: CacheRow[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    for (const r of await matchingRows(c)) {
      if (!seen.has(r.cache_key)) { seen.add(r.cache_key); rows.push(r); }
    }
  }
  borrowedKeys = seen;
  if (rows.length === 0) return rows;

  // Disk before delete. If this write fails we have not touched the table yet,
  // so failing here is safe and failing after would not be.
  restorePath = `${RESTORE_DIR}/.borrowed-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(restorePath, JSON.stringify(rows, null, 2));
  console.log(`borrowed ${rows.length} existing row(s) -> ${restorePath}`);

  const { error } = await admin.from("precise_cache").delete().in("cache_key", [...seen]);
  if (error) throw new Error(`could not clear borrowed rows: ${error.message}`);
  return rows;
}

/** Put back exactly what we took, and only then drop the file. */
async function giveBackRows(): Promise<void> {
  if (!restorePath) return;
  await restoreFrom(restorePath);
}

async function restoreFrom(path: string): Promise<void> {
  const rows = JSON.parse(readFileSync(path, "utf8")) as CacheRow[];
  if (rows.length === 0) { unlinkSync(path); return; }
  const { error } = await admin.from("precise_cache").upsert(rows, { onConflict: "cache_key" });
  if (error) {
    console.error(`\nRESTORE FAILED (${error.message}). Rows are still in ${path}.`);
    console.error(`Retry with: RESTORE=${path} npx tsx tools/super-probe/run.ts`);
    process.exitCode = 1;
    return;
  }
  console.log(`restored ${rows.length} borrowed row(s) from ${path}`);
  unlinkSync(path);
}

/** Rows the PROBE wrote: matched by the case's tokens, minus everything we
 *  borrowed. This is the only set the probe is allowed to delete. */
async function deleteOwnRows(cases: ProbeCase[]): Promise<number> {
  const mine = new Set<string>();
  for (const c of cases) {
    for (const r of await matchingRows(c)) {
      if (!borrowedKeys.has(r.cache_key)) mine.add(r.cache_key);
    }
  }
  if (mine.size === 0) return 0;
  const { count, error } = await admin
    .from("precise_cache").delete({ count: "exact" }).in("cache_key", [...mine]);
  if (error) throw new Error(`cleanup failed: ${error.message}`);
  return count ?? 0;
}

(async () => {
  const only = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cases = only.length ? PROBE_CASES.filter((c) => only.includes(c.id)) : PROBE_CASES;
  const conc = Number(process.env.CONCURRENCY ?? 4);

  if (process.env.RESTORE) {
    await restoreFrom(process.env.RESTORE);
    return;
  }

  // Take the borrowed rows out of the way, having first written them down.
  const borrowed = process.env.KEEP === "1" ? [] : await borrowRows(cases);
  console.log(
    process.env.KEEP === "1"
      ? "KEEP=1: warm run, cache rows left in place"
      : `cleared ${borrowed.length} cache rows for ${cases.length} cases (cold run)`,
  );
  console.log(`running ${cases.length} cases, concurrency ${conc}\n`);

  const results: Result[] = [];
  for (let i = 0; i < cases.length; i += conc) {
    const batch = await Promise.all(cases.slice(i, i + conc).map(runOne));
    for (const r of batch) {
      const mark = r.ok ? "PASS" : "FAIL";
      const nums = r.per100
        ? `${r.per100.kcal.toFixed(0)}kcal/${r.per100.p.toFixed(1)}p`
        : "-";
      const truth = `[want ${r.c.kcal.lo}-${r.c.kcal.hi}kcal/${r.c.protein_g.lo}-${r.c.protein_g.hi}p]`;
      console.log(
        `${mark}  ${r.c.id.padEnd(32)} ${nums.padEnd(18)} ${truth.padEnd(34)} ` +
        `${(r.ms / 1000).toFixed(1)}s srch=${r.searches} src=${r.sources} ` +
        `ver=${r.verified === null ? "-" : r.verified}` + (r.ok ? "" : `  <- ${r.reason}`)
      );
      results.push(r);
    }
  }

  const pass = results.filter((r) => r.ok).length;
  const kErrs = results.map((r) => r.errKcal).filter((e): e is number => e !== null).map(Math.abs);
  const median = (a: number[]) =>
    a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN;
  const signed = results.map((r) => r.errKcal).filter((e): e is number => e !== null);

  console.log("\n──── SUPER ACCURACY ────");
  console.log(`cases                  ${results.length}`);
  console.log(`passed                 ${pass}/${results.length}  (${((pass / results.length) * 100).toFixed(0)}%)`);
  console.log(`median |kcal error|    ${(median(kErrs) * 100).toFixed(1)}%`);
  console.log(`worst  |kcal error|    ${(Math.max(...kErrs, 0) * 100).toFixed(1)}%`);
  // A systematic lean is worth more than the pass rate: if the mean signed
  // error is strongly non-zero, Super is not noisy, it is biased.
  console.log(`mean signed kcal error ${((signed.reduce((a, b) => a + b, 0) / (signed.length || 1)) * 100).toFixed(1)}%  (bias: 0 = none)`);
  // PROTEIN IS REPORTED SEPARATELY AND ALWAYS, even for cases that passed.
  // The MACRO_ABS_FLOOR_G allowance deliberately lets a sub-3 g miss through -
  // 0.9 g of protein per 100 g of biscuit is not a tracking error worth failing
  // a case over. But a run where every such miss leans the SAME WAY is not
  // noise, it is a bias, and a pass/fail column would hide it completely.
  // Bourbon reading 1.8 g against a 2.7-5.0 g label passed on exactly that
  // allowance, three runs running. So print the distribution regardless.
  const pErrs = results.map((r) => r.errP).filter((e): e is number => e !== null);
  const pSignedRaw = results
    .filter((r) => r.per100)
    .map((r) => {
      // Recomputed WITHOUT the absolute floor: this line exists to see the lean
      // the floor is designed to forgive, so it must not use the same forgiveness.
      const t = r.c.protein_g;
      const a = r.per100!.p;
      if (a >= t.lo && a <= t.hi) return 0;
      const edge = a < t.lo ? t.lo : t.hi;
      return edge > 0 ? (a - edge) / edge : 0;
    });
  console.log(`median |protein err|   ${(median(pErrs.map(Math.abs)) * 100).toFixed(1)}%  (after the <${MACRO_ABS_FLOOR_G}g allowance)`);
  console.log(`mean signed protein    ${((pSignedRaw.reduce((a, b) => a + b, 0) / (pSignedRaw.length || 1)) * 100).toFixed(1)}%  (NO allowance - negative = reads low)`);
  console.log(`protein misses >20%    ${pSignedRaw.filter((e) => Math.abs(e) > 0.2).length}/${pSignedRaw.length}`);
  console.log(`total web searches     ${results.reduce((a, r) => a + r.searches, 0)}  (~$${(results.reduce((a, r) => a + r.searches, 0) * 0.01).toFixed(2)} in search fees)`);
  console.log(`rows marked verified   ${results.filter((r) => r.verified === true).length}/${results.length}`);
  console.log(`served from cache      ${results.filter((r) => r.cached).length}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("\nfailures:");
    for (const f of failed) console.log(`  ${f.c.id.padEnd(32)} ${f.reason}`);
  }

  // Put production back how we found it. A probe row is research done with the
  // catalog switched OFF and scored against an answer key - it is a measurement,
  // not a fact we want served to anyone. Runs even when cases failed, because a
  // failed case is exactly the one whose wrong row you least want left behind.
  if (process.env.KEEP !== "1") {
    const removed = await deleteOwnRows(cases);
    console.log(`\ncleaned up ${removed} probe rows from precise_cache`);
    await giveBackRows();
  } else {
    console.log("\nKEEP=1: probe rows LEFT IN PRODUCTION - delete them yourself.");
  }
})().catch(async (e) => {
  // A crash after the borrow is the case the disk file exists for. Try to hand
  // the rows back before dying; if that fails too, restoreFrom prints the exact
  // command to finish the job by hand. Never swallow the original error.
  console.error(`\nprobe failed: ${e instanceof Error ? e.message : String(e)}`);
  await giveBackRows().catch(() => {});
  process.exitCode = 1;
});
