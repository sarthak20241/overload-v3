/**
 * Probe 4 (owner's question): does Jev KNOW what jumpy or far-above means, or
 * is it only comparing my number with my threshold? Three versions of the same
 * five signals, over all 68 weeks:
 *   A  told    the shipped wording: criteria state the line (0.8 kg, 140%...)
 *   B  untold  same state, but criteria in a coach's words with NO numbers
 *   C  raw     no numbers in the criteria AND no precomputed summaries: only the
 *              raw food days and weigh-ins
 */
import { readFileSync } from 'node:fs';
import { JEV_MODEL, JEV_URL, SIGNALS } from '../../supabase/functions/_shared/dronaJev.ts';
import { SPECS, stateFor, truthFor } from './weeks.mts';
const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.JEV_API_KEY;
const NAMES = ['scale_is_jumpy', 'has_far_over_days', 'protein_adequate', 'weight_falling_fast', 'food_log_sparse'] as const;
const told = Object.fromEntries(NAMES.map((n) => [n, SIGNALS[n]]));
const untold = {
  scale_is_jumpy: { type: 'noul', instructions: 'Would an experienced coach say this scale is too erratic from one weigh-in to the next to trust any trend from it?', criteria: { true: 'Yes: the readings bounce around far more than a body really changes overnight.', false: 'No: this is ordinary day-to-day wobble.' } },
  has_far_over_days: { type: 'noul', instructions: 'Would an experienced coach say this person had one or more blowout days: days eaten far beyond their calorie target?', criteria: { true: 'Yes: at least one day is a clear blowout, not a small overshoot.', false: 'No: the high days are ordinary small overshoots, or nothing is logged.' } },
  protein_adequate: { type: 'noul', instructions: 'Would an experienced coach be satisfied with this person\'s protein intake against their protein target?', criteria: { true: 'Yes: close enough to the target.', false: 'No: clearly short of the target, or nothing is logged.' } },
  weight_falling_fast: { type: 'noul', instructions: 'Would an experienced coach say this person is losing weight too fast to be healthy for their body size?', criteria: { true: 'Yes: the pace risks muscle loss.', false: 'No: the pace is moderate, flat, rising, or unknown.' } },
  food_log_sparse: { type: 'noul', instructions: 'Would an experienced coach say too few days of food are logged to judge how this person eats?', criteria: { true: 'Yes: too few days to judge.', false: 'No: enough days are logged.' } },
};
const rawOnly = (st: any) => { const { food_summary, weigh_in_summary, ...rest } = st; return rest; };
async function ask(state: unknown, questions: unknown) {
  const r = await fetch(JEV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: JEV_MODEL, state, questions }) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json() as any).answers;
}
const rows: { spec: any; A: any; B: any; C: any }[] = [];
for (let i = 0; i < SPECS.length; i += 6) {
  await Promise.all(SPECS.slice(i, i + 6).map(async (spec) => {
    const st = stateFor(spec);
    const [A, B, C] = await Promise.all([ask(st, told), ask(st, untold), ask(rawOnly(st), untold)]);
    rows.push({ spec, A, B, C });
  }));
}
const pct = (v: number) => `${Math.round(v * 100)}%`;
console.log('signal'.padEnd(22) + 'A told (numbers given)'.padEnd(30) + 'B untold (summaries, no numbers)'.padEnd(38) + 'C raw data only, no numbers');
for (const n of NAMES) {
  const cell = (k: 'A' | 'B' | 'C') => {
    const yes: number[] = [], no: [string, number][] = [], yesN: [string, number][] = [];
    for (const r of rows) { const t = truthFor(r.spec)[n]; const p = r[k]?.[n]?.noul; if (t == null || typeof p !== 'number') continue; if (t) { yes.push(p); yesN.push([r.spec.name, p]); } else no.push([r.spec.name, p]); }
    const lowT = yesN.reduce((a, b) => (b[1] < a[1] ? b : a)), highF = no.reduce((a, b) => (b[1] > a[1] ? b : a));
    const gap = Math.round((lowT[1] - highF[1]) * 100);
    return `gap ${gap >= 0 ? '+' : ''}${gap} (T>=${pct(lowT[1])}, F<=${pct(highF[1])})${gap < 20 ? ` !${highF[0]}` : ''}`;
  };
  console.log(n.padEnd(22) + cell('A').padEnd(30) + cell('B').padEnd(38) + cell('C'));
}
