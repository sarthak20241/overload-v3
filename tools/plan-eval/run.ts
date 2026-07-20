/**
 * generate_plan eval harness: accuracy gate + latency profile, across pipelines.
 *
 *   npx tsx tools/plan-eval/run.ts
 *   npx tsx tools/plan-eval/run.ts --pipelines baseline,compact,fanout --variant onboarding
 *   npx tsx tools/plan-eval/run.ts --pipelines fanout --fill-model claude-haiku-4-5
 *   npx tsx tools/plan-eval/run.ts --pipelines compact --catalog full --repeat 5
 *
 * Flags:
 *   --pipelines a,b,c  which pipelines to run (default baseline)
 *   --repeat N         runs per case per pipeline (default 3). Latency needs a
 *                      distribution; n=1 says nothing about p95.
 *   --only a,b         case ids
 *   --variant v        'onboarding' or 'coach'
 *   --model m          main model (default claude-sonnet-4-6)
 *   --fill-model m     model for fanout's parallel day-fills (default: --model)
 *   --catalog w        'library' (46 names) or 'full' (787). Default library,
 *                      so a pipeline comparison changes one thing at a time.
 *   --concurrency N    parallel in-flight runs (default 3)
 *   --latency-gate     exit nonzero if p95 exceeds the legacy 30s abort
 *   --json             also write raw per-run records
 *
 * Exit code is nonzero when any accuracy check fails.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, type EvalCase } from './cases';
import {
  LEGACY_NONSTREAM_TIMEOUT_MS, VARIANTS, globalCatalog,
  type CatalogWidth, type PipelineName, type Provider, type RunResult,
} from './pipeline';
import { buildCatalogIndex, LIBRARY_INDEX, scorePlan, type ScoreResult } from './score';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

function loadEnvLocal(): void {
  const p = join(ROOT, '.env.local');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvLocal();

const API_KEY = process.env.ANTHROPIC_API_KEY;

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
const has = (n: string) => argv.includes(`--${n}`);

const REPEAT = Math.max(1, parseInt(flag('repeat') ?? '3', 10));
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency') ?? '3', 10));
const MODEL = flag('model');
const FILL_MODEL = flag('fill-model');
const CATALOG = (flag('catalog') ?? 'library') as CatalogWidth;
const ONLY = flag('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const VARIANT_FILTER = flag('variant');
const LATENCY_GATE = has('latency-gate');
const WRITE_JSON = has('json');
const PIPELINES = (flag('pipelines') ?? 'baseline').split(',').map((s) => s.trim()).filter(Boolean) as PipelineName[];
const PROVIDER = (flag('provider') ?? 'api') as Provider;

for (const p of PIPELINES) {
  if (!VARIANTS[p]) { console.error(`unknown pipeline "${p}". known: ${Object.keys(VARIANTS).join(', ')}`); process.exit(1); }
}
if (PROVIDER !== 'api' && PROVIDER !== 'cli') { console.error(`unknown provider "${PROVIDER}" (api|cli)`); process.exit(1); }
// Only the api transport needs a key; the cli transport uses the login.
if (PROVIDER === 'api' && !API_KEY) { console.error('Missing ANTHROPIC_API_KEY (set it in .env.local, or pass --provider cli)'); process.exit(1); }
// baseline forces tool_choice; `claude -p` exposes no such flag, so a cli run
// would silently measure a different pipeline than the one named.
if (PROVIDER === 'cli' && PIPELINES.includes('baseline')) {
  console.error('provider=cli cannot run the baseline pipeline: it requires forced tool_choice, which `claude -p` does not expose.');
  process.exit(1);
}

let cases: EvalCase[] = CASES;
if (VARIANT_FILTER) cases = cases.filter((c) => c.variant === VARIANT_FILTER);
if (ONLY) cases = cases.filter((c) => ONLY.includes(c.id));
if (cases.length === 0) { console.error('No cases matched the filters.'); process.exit(1); }

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmtMs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

interface Rec { run: RunResult; score: ScoreResult; attempt: number; pipeline: PipelineName }

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function main() {
  // Coach output is resolved against the 787-row global catalog on save
  // (AICoachModal ilike), NOT against the 46-name EXERCISE_LIBRARY. Scoring it
  // against the 46 overstates failures, which an earlier revision did.
  const fullCatalog = buildCatalogIndex(await globalCatalog());
  const catalogFor = (c: EvalCase) => (c.variant === 'coach' ? fullCatalog : LIBRARY_INDEX);

  const jobs: { c: EvalCase; attempt: number; pipeline: PipelineName }[] = [];
  for (const pipeline of PIPELINES) for (const c of cases) for (let a = 0; a < REPEAT; a++) jobs.push({ c, attempt: a, pipeline });

  console.log(`plan-eval: ${PIPELINES.join(' + ')} x ${cases.length} cases x ${REPEAT} runs = ${jobs.length} runs`);
  console.log(`model=${MODEL ?? 'claude-sonnet-4-6'}${FILL_MODEL ? ` fill=${FILL_MODEL}` : ''} provider=${PROVIDER} catalog=${CATALOG} (coach scored vs ${fullCatalog.size} global rows) concurrency=${CONCURRENCY}`);
  if (PROVIDER === 'cli') {
    console.log('NOTE provider=cli: ACCURACY IS VALID, LATENCY AND TOKEN COUNTS ARE NOT.');
    console.log('     The CLI wraps each request in its own agent loop: measured ~6x slower than the API');
    console.log('     (skeleton 5.3s -> 31.4s) with no prompt caching, and output_tokens aggregates its');
    console.log('     internal turns. Ignore every latency column below; use the API for timing.\n');
  } else { console.log(''); }

  const startedAll = Date.now();
  const records = await mapLimit(jobs, CONCURRENCY, async ({ c, attempt, pipeline }) => {
    let run: RunResult;
    try {
      run = await VARIANTS[pipeline](c, { apiKey: API_KEY!, model: MODEL, fillModel: FILL_MODEL, catalog: CATALOG, provider: PROVIDER });
    } catch (err) {
      run = {
        caseId: c.id, variant: c.variant, pipeline, ok: false, error: `threw: ${String(err).slice(0, 200)}`,
        spans: { ttft_ms: 0, decode_ms: 0, total_ms: 0, workout_complete_ms: [], intent_text_ms: null, stages: [] },
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        calls: 0, output_tps: 0, stopReason: null, intentText: '', plan: null,
      };
    }
    const score = scorePlan(c, run.plan, { catalog: catalogFor(c) });
    const bad = !run.ok || score.failures.length > 0;
    const d1 = run.spans.workout_complete_ms[0];
    console.log(
      `${bad ? 'FAIL' : 'ok  '}  ${pipeline.padEnd(8)} ${c.id.padEnd(32)} #${attempt + 1}  ` +
      `total=${fmtMs(run.spans.total_ms)} ttft=${run.spans.ttft_ms}ms day1=${d1 ? fmtMs(d1) : '-'} ` +
      `out=${run.usage.output_tokens}tok calls=${run.calls}`,
    );
    if (run.error) console.log(`        ! ${run.error}`);
    for (const f of score.failures) console.log(`        x ${f}`);
    return { run, score, attempt, pipeline } as Rec;
  });

  // ── Pipeline comparison ───────────────────────────────────────────────────
  console.log(`\n${'='.repeat(104)}\nPIPELINE COMPARISON\n`);
  console.log(`${'pipeline'.padEnd(10)} ${'runs'.padStart(5)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'day1 p50'.padStart(9)} ${'outTok'.padStart(7)} ${'calls'.padStart(6)} ${'pass'.padStart(7)} ${'distinct'.padStart(9)} ${'>30s'.padStart(6)}`);
  console.log('-'.repeat(104));
  for (const p of PIPELINES) {
    const rs = records.filter((r) => r.pipeline === p);
    const totals = rs.map((r) => r.run.spans.total_ms);
    const d1 = rs.map((r) => r.run.spans.workout_complete_ms[0]).filter((n): n is number => typeof n === 'number');
    const pass = rs.filter((r) => r.run.ok && r.score.failures.length === 0).length;
    const dist = rs.map((r) => r.score.metrics.distinctRatio).filter((n) => n > 0);
    console.log(
      `${p.padEnd(10)} ${String(rs.length).padStart(5)} ${fmtMs(pct(totals, 50)).padStart(7)} ${fmtMs(pct(totals, 95)).padStart(7)} ` +
      `${(d1.length ? fmtMs(pct(d1, 50)) : '-').padStart(9)} ${String(Math.round(mean(rs.map((r) => r.run.usage.output_tokens)))).padStart(7)} ` +
      `${mean(rs.map((r) => r.run.calls)).toFixed(1).padStart(6)} ${`${pass}/${rs.length}`.padStart(7)} ` +
      `${mean(dist).toFixed(2).padStart(9)} ${String(totals.filter((t) => t > LEGACY_NONSTREAM_TIMEOUT_MS).length).padStart(6)}`,
    );
  }

  // ── Per case per pipeline ─────────────────────────────────────────────────
  console.log(`\n${'='.repeat(104)}\nPER CASE\n`);
  console.log(`${'case'.padEnd(34)} ${'pipeline'.padEnd(9)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'outTok'.padStart(7)} ${'distinct'.padStart(9)}  fails`);
  console.log('-'.repeat(104));
  for (const c of cases) {
    for (const p of PIPELINES) {
      const rs = records.filter((r) => r.pipeline === p && r.run.caseId === c.id);
      if (!rs.length) continue;
      const totals = rs.map((r) => r.run.spans.total_ms);
      const fails = rs.filter((r) => !r.run.ok || r.score.failures.length > 0).length;
      const dist = rs.map((r) => r.score.metrics.distinctRatio).filter((n) => n > 0);
      console.log(
        `${c.id.padEnd(34)} ${p.padEnd(9)} ${fmtMs(pct(totals, 50)).padStart(7)} ${fmtMs(pct(totals, 95)).padStart(7)} ` +
        `${String(Math.round(mean(rs.map((r) => r.run.usage.output_tokens)))).padStart(7)} ${mean(dist).toFixed(2).padStart(9)}  ${fails || ''}`,
      );
    }
  }

  // ── Stage breakdown ───────────────────────────────────────────────────────
  // For multi-call pipelines, where the wall clock actually goes, plus what
  // the same calls would have cost run back to back. That difference is the
  // entire value of the fan-out, so it should be visible in every report.
  const multiStage = records.filter((r) => r.run.spans.stages.length > 1);
  if (multiStage.length) {
    console.log(`\n${'='.repeat(104)}\nSTAGE BREAKDOWN\n`);
    for (const p of PIPELINES) {
      const rs = records.filter((r) => r.pipeline === p && r.run.spans.stages.length > 1);
      if (!rs.length) continue;
      const labels = new Map<string, number[]>();
      for (const r of rs) {
        for (const s of r.run.spans.stages) {
          const key = s.label.startsWith('fill:') ? 'fill (each)' : s.label;
          if (!labels.has(key)) labels.set(key, []);
          labels.get(key)!.push(s.ms);
        }
      }
      console.log(`  ${p}:`);
      for (const [label, ms] of labels) {
        console.log(`    ${label.padEnd(16)} p50=${fmtMs(pct(ms, 50))}  p95=${fmtMs(pct(ms, 95))}  (n=${ms.length})`);
      }
      const serial = rs.map((r) => r.run.spans.stages.reduce((a, s) => a + s.ms, 0));
      const actual = rs.map((r) => r.run.spans.total_ms);
      console.log(`    ${'ACTUAL total'.padEnd(16)} p50=${fmtMs(pct(actual, 50))}  p95=${fmtMs(pct(actual, 95))}`);
      console.log(`    ${'if serial'.padEnd(16)} p50=${fmtMs(pct(serial, 50))}   <- saved by running in parallel: ${fmtMs(pct(serial, 50) - pct(actual, 50))}`);
    }
  }

  // ── Cross-day collisions ──────────────────────────────────────────────────
  console.log(`\n${'='.repeat(104)}\nCROSS-DAY REPEATS (the fan-out failure mode)\n`);
  for (const p of PIPELINES) {
    const rs = records.filter((r) => r.pipeline === p);
    const withRepeats = rs.filter((r) => r.score.metrics.crossDayRepeats.length > 0);
    const totalRepeats = rs.reduce((a, r) => a + r.score.metrics.crossDayRepeats.length, 0);
    console.log(`  ${p.padEnd(9)} ${withRepeats.length}/${rs.length} runs had a repeat · ${totalRepeats} repeated exercises · mean distinct ratio ${mean(rs.map((r) => r.score.metrics.distinctRatio)).toFixed(2)}`);
    const top = new Map<string, number>();
    for (const r of rs) for (const cd of r.score.metrics.crossDayRepeats) top.set(cd.name, (top.get(cd.name) ?? 0) + 1);
    const worst = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (worst.length) console.log(`            most repeated: ${worst.map(([n, k]) => `${n} (${k})`).join(', ')}`);
  }

  const failed = records.filter((r) => !r.run.ok || r.score.failures.length > 0);
  console.log(`\n${'='.repeat(104)}\nACCURACY\n\n  passed ${records.length - failed.length}/${records.length}`);
  if (failed.length) {
    console.log('\n  failures:');
    for (const r of failed) {
      for (const f of [...(r.run.error ? [r.run.error] : []), ...r.score.failures]) {
        console.log(`    [${r.pipeline}] ${r.run.caseId} #${r.attempt + 1}: ${f}`);
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const outDir = join(HERE, 'reports');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const md = [
    `# generate_plan eval — ${new Date().toISOString()}`,
    ``,
    `pipelines: ${PIPELINES.join(', ')} · model: \`${MODEL ?? 'claude-sonnet-4-6'}\`${FILL_MODEL ? ` · fill: \`${FILL_MODEL}\`` : ''} · catalog: ${CATALOG}`,
    `cases: ${cases.length} · runs/case: ${REPEAT} · total runs: ${records.length} · wall clock: ${fmtMs(Date.now() - startedAll)}`,
    ``,
    `## Pipeline comparison`,
    ``,
    `| pipeline | runs | p50 | p95 | day1 p50 | out tok | calls | pass | distinct ratio | >30s |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
    ...PIPELINES.map((p) => {
      const rs = records.filter((r) => r.pipeline === p);
      const totals = rs.map((r) => r.run.spans.total_ms);
      const d1 = rs.map((r) => r.run.spans.workout_complete_ms[0]).filter((n): n is number => typeof n === 'number');
      const pass = rs.filter((r) => r.run.ok && r.score.failures.length === 0).length;
      return `| ${p} | ${rs.length} | ${fmtMs(pct(totals, 50))} | ${fmtMs(pct(totals, 95))} | ${d1.length ? fmtMs(pct(d1, 50)) : '-'} | ${Math.round(mean(rs.map((r) => r.run.usage.output_tokens)))} | ${mean(rs.map((r) => r.run.calls)).toFixed(1)} | ${pass}/${rs.length} | ${mean(rs.map((r) => r.score.metrics.distinctRatio)).toFixed(2)} | ${totals.filter((t) => t > LEGACY_NONSTREAM_TIMEOUT_MS).length} |`;
    }),
    ``,
    `## Per case`,
    ``,
    `| case | pipeline | p50 | p95 | out tok | distinct | fails |`,
    `|---|---|---|---|---|---|---|`,
    ...cases.flatMap((c) => PIPELINES.map((p) => {
      const rs = records.filter((r) => r.pipeline === p && r.run.caseId === c.id);
      if (!rs.length) return '';
      const totals = rs.map((r) => r.run.spans.total_ms);
      const fails = rs.filter((r) => !r.run.ok || r.score.failures.length > 0).length;
      return `| ${c.id} | ${p} | ${fmtMs(pct(totals, 50))} | ${fmtMs(pct(totals, 95))} | ${Math.round(mean(rs.map((r) => r.run.usage.output_tokens)))} | ${mean(rs.map((r) => r.score.metrics.distinctRatio)).toFixed(2)} | ${fails || ''} |`;
    }).filter(Boolean)),
    ``,
    `## Accuracy`,
    ``,
    `passed ${records.length - failed.length}/${records.length}`,
    ``,
    ...(failed.length
      ? ['### Failures', '', ...failed.flatMap((r) => [...(r.run.error ? [r.run.error] : []), ...r.score.failures].map((f) => `- \`${r.pipeline}\` \`${r.run.caseId}\` #${r.attempt + 1}: ${f}`)), '']
      : []),
  ].join('\n');

  const mdPath = join(outDir, `plan-eval-${stamp}.md`);
  writeFileSync(mdPath, md);
  console.log(`\nreport: ${mdPath}`);

  if (WRITE_JSON) {
    const jsonPath = join(outDir, `plan-eval-${stamp}.json`);
    writeFileSync(jsonPath, JSON.stringify(records.map((r) => ({
      pipeline: r.pipeline, caseId: r.run.caseId, attempt: r.attempt, ok: r.run.ok, error: r.run.error,
      spans: r.run.spans, usage: r.run.usage, calls: r.run.calls, output_tps: r.run.output_tps,
      failures: r.score.failures, warnings: r.score.warnings, metrics: r.score.metrics,
      plan: r.run.plan,
    })), null, 2));
    console.log(`raw:    ${jsonPath}`);
  }

  const allTotals = records.map((r) => r.run.spans.total_ms);
  const latencyBad = LATENCY_GATE && pct(allTotals, 95) > LEGACY_NONSTREAM_TIMEOUT_MS;
  process.exit(failed.length > 0 || latencyBad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
