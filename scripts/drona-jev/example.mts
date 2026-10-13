/** Prints one week exactly as Jev sees it, and Jev's raw answer. For the README. */
import { readFileSync } from 'node:fs';
import { JEV_MODEL, JEV_URL, JEV_QUESTIONS } from '../../supabase/functions/_shared/dronaJev.ts';
import { SPECS, stateFor } from './weeks.mts';
const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const spec = SPECS.find((s) => s.name === (process.env.WEEK ?? 'blowouts-and-low-protein'))!;
const st: any = stateFor(spec);
const show = { ...st, food_log_last_14_days: [...st.food_log_last_14_days.slice(0, 3), `... ${st.food_log_last_14_days.length - 3} more days`], weigh_ins_last_14_days: [...st.weigh_ins_last_14_days.slice(0, 3), `... ${st.weigh_ins_last_14_days.length - 3} more`] };
console.log(`WEEK: ${spec.name}  (${spec.group})  expected card: ${spec.expect}\nwhy: ${spec.why}\n\nSTATE SENT (lists trimmed):`);
console.log(JSON.stringify(show, null, 1));
const r = await fetch(JEV_URL, { method: 'POST', headers: { Authorization: `Bearer ${env.JEV_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: JEV_MODEL, state: st, questions: JEV_QUESTIONS }) });
const out: any = await r.json();
const n = (k: string) => Math.round(out.answers[k].noul * 100) / 100;
console.log('\nYES/NO ANSWERS (probability of yes):');
console.log(JSON.stringify(Object.fromEntries(Object.keys(out.answers).filter((k) => k !== 'which_card').map((k) => [k, n(k)]))));
const wc = out.answers.which_card;
console.log('\nWHICH_CARD ANSWER:');
console.log(JSON.stringify({ type: wc.type, choice: wc.choice, confidence: Math.round(wc.confidence * 100) / 100, probabilities_top4: Object.fromEntries(Object.entries(wc.probabilities).sort((a: any, b: any) => b[1] - a[1]).slice(0, 4).map(([k, v]: any) => [k, Math.round(v * 100) / 100])) }, null, 1));
console.log('\nusage:', JSON.stringify(out.usage));
