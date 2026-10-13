/**
 * Probe 2: perception first, THEN policy. Probe 1 showed Jev sees each signal
 * sharply but a single "what should we do" question does not combine them
 * (it saw the user undo a cut at 96% and still voted to cut again). Questions
 * are scored independently, so the decision never sees the signals. Here pass 2
 * gets pass 1's findings inside its state, and the actions are asked one by one.
 */
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.JEV_API_KEY; const MODEL = 'jev-1.13.0';
const ask = async (state: unknown, questions: unknown) => {
  const r = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, state, questions }) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json() as any).answers;
};
const day = (b: number) => new Date(Date.UTC(2026, 8, 18) - b * 86_400_000).toISOString().slice(0, 10);
const food = () => Array.from({ length: 12 }, (_, i) => ({ day: day(i < 3 ? i : i + 1), kcal: 2060 + (i % 4) * 30, protein_g: 148 }));
const wts = () => Array.from({ length: 10 }, (_, i) => ({ day: day(i), kg: Math.round((72.4 + ((i % 2) ? 0.15 : -0.1)) * 10) / 10 }));
const base = () => ({ today: '2026-09-18', goal: { kind: 'fat_loss', current_kg: 72.4, goal_kg: 68 }, daily_targets: { kcal: 2100, protein_g: 150 }, food_log_last_14_days: food(), weigh_ins_last_14_days: wts(), calorie_target_changes: [{ at: '2026-08-28', from: 2250, to: 2100, changed_by: 'coach_chat' }] as any[] });
const packs: { name: string; expect: string; state: any }[] = [
  { name: 'clean-stall', expect: 'LOWER', state: base() },
  { name: 'clean-stall-no-history', expect: 'LOWER', state: { ...base(), calorie_target_changes: [] } },
  { name: 'weekend-blowouts', expect: 'not lower', state: { ...base(), food_log_last_14_days: food().map((r, i) => (i === 1 || i === 8 ? { ...r, kcal: 3400 } : r)) } },
  { name: 'raised-back-by-hand', expect: 'not lower', state: { ...base(), calorie_target_changes: [{ at: '2026-08-20', from: 1950, to: 2100, changed_by: 'user_by_hand' }, { at: '2026-08-10', from: 2100, to: 1950, changed_by: 'coach_card' }] } },
  { name: 'noisy-scale', expect: 'not lower', state: { ...base(), weigh_ins_last_14_days: [73.4, 71.6, 73.1, 71.9, 72.9, 71.5, 73.3, 71.8, 72.6, 71.7].map((kg, i) => ({ day: day(i), kg })) } },
  { name: 'protein-collapsed', expect: 'not lower', state: { ...base(), food_log_last_14_days: food().map((r) => ({ ...r, protein_g: 70 })) } },
];
const perceive = {
  weight_is_flat: { type: 'noul', instructions: 'Body weight has stayed essentially flat across the weigh-ins.' },
  scale_is_jumpy: { type: 'noul', instructions: 'The weigh-ins swing by a kilogram or more from one day to the next.' },
  has_far_over_days: { type: 'noul', instructions: 'At least one logged day is far above the daily calorie target.' },
  protein_adequate: { type: 'noul', instructions: 'Protein intake is close to the daily protein target.' },
  user_undid_a_cut: { type: 'noul', instructions: 'The change history shows the user raising the calorie target back up by hand after someone else lowered it.' },
};
const decide = {
  lower_is_sound: { type: 'noul', instructions: 'Taking everything into account, INCLUDING what the coach already noticed, lowering the daily calorie target now is a sound and respectful next step.' },
  should_ask_first: { type: 'noul', instructions: 'Taking everything into account, INCLUDING what the coach already noticed, the coach should ask this person a question before changing anything.' },
};
const pct = (v: unknown) => (typeof v === 'number' ? (v * 100).toFixed(0).padStart(3) + '%' : '  ?');
for (const p of packs) {
  const s1 = await ask(p.state, perceive);
  const noticed = Object.fromEntries(Object.entries(s1).map(([k, v]: any) => [k, v.noul >= 0.8 ? 'yes, clearly' : v.noul <= 0.2 ? 'no' : 'unclear']));
  const blind = await ask(p.state, decide);
  const informed = await ask({ ...p.state, what_the_coach_already_noticed: noticed }, decide);
  console.log(`${p.name.padEnd(24)} expect ${p.expect.padEnd(10)} | lower_is_sound  blind ${pct(blind.lower_is_sound.noul)} -> informed ${pct(informed.lower_is_sound.noul)} | ask_first  blind ${pct(blind.should_ask_first.noul)} -> informed ${pct(informed.should_ask_first.noul)}`);
}
