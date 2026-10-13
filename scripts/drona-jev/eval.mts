/**
 * The Jev eval: does each question separate weeks where the answer is known?
 *
 *   npx tsx scripts/drona-jev/eval.mts                 # all weeks
 *   ONLY=jumpy-scale,stall-plain npx tsx ...           # some
 *   GROUP=mixed npx tsx ...                            # one group
 *
 * One batched call per week (every signal + which_card). About 2.5k input
 * tokens a call, so the whole set costs well under one cent.
 *
 * Two reports:
 *   SIGNALS   for each yes/no: the lowest probability it gave a TRUE week, the
 *             highest it gave a FALSE week, and the GAP between them. A signal
 *             is only usable when the gap is wide: then any line in the gap
 *             separates right from wrong. Accuracy at 0.5 alone hides this.
 *   CARDS     the chosen card against the curated one, with confidence, split
 *             by group (clean / near-miss / mixed).
 */
import { readFileSync } from 'node:fs';
import { JEV_MODEL, JEV_QUESTIONS, JEV_URL, SIGNALS, type SignalName } from '../../supabase/functions/_shared/dronaJev.ts';
import { SPECS, stateFor, truthFor } from './weeks.mts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.JEV_API_KEY;
if (!KEY) { console.error('JEV_API_KEY missing from .env.local'); process.exit(2); }

const only = (process.env.ONLY ?? '').split(',').filter(Boolean);
const group = process.env.GROUP;
const specs = SPECS.filter((s) => (only.length ? only.includes(s.name) : true) && (group ? s.group === group : true));

async function ask(state: unknown, attempt = 0): Promise<any> {
  const res = await fetch(JEV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: JEV_MODEL, state, questions: JEV_QUESTIONS }) });
  if ((res.status === 429 || res.status === 529) && attempt < 4) { await new Promise((r) => setTimeout(r, 800 * 2 ** attempt)); return ask(state, attempt + 1); }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const results: { spec: typeof specs[number]; answers: any; tokens: number; ms: number }[] = [];
const CONCURRENCY = 6;
for (let i = 0; i < specs.length; i += CONCURRENCY) {
  await Promise.all(specs.slice(i, i + CONCURRENCY).map(async (spec) => {
    const t0 = Date.now();
    try {
      const out = await ask(stateFor(spec));
      results.push({ spec, answers: out.answers, tokens: out.usage?.input_tokens ?? 0, ms: Date.now() - t0 });
    } catch (e) { console.log(`ERROR ${spec.name}: ${String(e).slice(0, 200)}`); }
  }));
}
results.sort((a, b) => specs.indexOf(a.spec) - specs.indexOf(b.spec));

// ── signals ──────────────────────────────────────────────────────────────────
const pct = (v: number) => `${Math.round(v * 100)}%`.padStart(4);
console.log('\nSIGNALS   (gap = lowest TRUE minus highest FALSE; wide and positive is what we need)');
console.log('signal'.padEnd(27) + 'true wks  false wks  lowest-T  highest-F    gap   acc@50   worst offenders');
let usable = 0;
for (const name of Object.keys(SIGNALS) as SignalName[]) {
  const yes: [string, number][] = [], no: [string, number][] = [];
  for (const r of results) {
    const t = truthFor(r.spec)[name]; const p = r.answers?.[name]?.noul;
    if (t == null || typeof p !== 'number') continue;
    (t ? yes : no).push([r.spec.name, p]);
  }
  if (!yes.length || !no.length) { console.log(name.padEnd(27) + `(only one class in this run: ${yes.length} true, ${no.length} false)`); continue; }
  const lowT = yes.reduce((a, b) => (b[1] < a[1] ? b : a)), highF = no.reduce((a, b) => (b[1] > a[1] ? b : a));
  const gap = lowT[1] - highF[1];
  const acc = (yes.filter((y) => y[1] >= 0.5).length + no.filter((n) => n[1] < 0.5).length) / (yes.length + no.length);
  if (gap >= 0.2) usable++;
  const offenders = gap >= 0.2 ? '' : `T:${lowT[0]} ${pct(lowT[1]).trim()}  F:${highF[0]} ${pct(highF[1]).trim()}`;
  console.log(name.padEnd(27) + String(yes.length).padStart(5) + String(no.length).padStart(11) + pct(lowT[1]).padStart(10) + pct(highF[1]).padStart(11) + `${gap >= 0 ? '+' : ''}${Math.round(gap * 100)}`.padStart(7) + pct(acc).padStart(8) + '   ' + offenders);
}
console.log(`${usable}/${Object.keys(SIGNALS).length} signals separate cleanly (gap of 20 points or more)`);

// ── cards ────────────────────────────────────────────────────────────────────
console.log('\nCARDS');
const byGroup: Record<string, { right: number; total: number }> = {};
const confRight: number[] = [], confWrong: number[] = [];
for (const r of results) {
  const a = r.answers?.which_card ?? {};
  const ok = a.choice === r.spec.expect;
  (byGroup[r.spec.group] ??= { right: 0, total: 0 }).total++;
  if (ok) { byGroup[r.spec.group].right++; confRight.push(a.confidence ?? 0); } else confWrong.push(a.confidence ?? 0);
  const top = Object.entries(a.probabilities ?? {}).sort((x: any, y: any) => y[1] - x[1]).slice(0, 2).map(([k, v]: any) => `${k} ${pct(v).trim()}`).join(', ');
  console.log(`${ok ? 'PASS' : 'FAIL'} ${r.spec.group.padEnd(9)} ${r.spec.name.padEnd(30)} conf ${pct(a.confidence ?? 0)}  ${ok ? a.choice : `chose ${a.choice}, wanted ${r.spec.expect}`}${ok ? '' : `   [${top}]   (${r.spec.why})`}`);
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const right = Object.values(byGroup).reduce((a, g) => a + g.right, 0);
console.log(`\ncards: ${right}/${results.length} right   ` + Object.entries(byGroup).map(([g, v]) => `${g} ${v.right}/${v.total}`).join('   '));
console.log(`confidence when right: mean ${pct(mean(confRight)).trim()}, lowest ${pct(Math.min(...confRight, 1)).trim()}   when wrong: mean ${pct(mean(confWrong)).trim()}, highest ${pct(Math.max(...confWrong, 0)).trim()}`);
const tok = results.reduce((a, r) => a + r.tokens, 0);
console.log(`${results.length} calls, ${tok} input tokens, about $${(tok * 0.042 / 1e6).toFixed(4)}; median ${results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)]} ms a call (${JEV_MODEL})`);
