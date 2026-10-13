/**
 * Probe 3 (owner's idea): give the card question worked examples. Probe 1 asked
 * "act / talk / request / hold" in the abstract and got 10-20% confidence on
 * everything. Here each option says WHEN to choose it, with a small example.
 * The examples use different people and numbers from the six test weeks, so the
 * weeks stay held-out.
 */
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.JEV_API_KEY; const MODEL = 'jev-1.13.0';
const day = (b: number) => new Date(Date.UTC(2026, 8, 18) - b * 86_400_000).toISOString().slice(0, 10);
const food = () => Array.from({ length: 12 }, (_, i) => ({ day: day(i < 3 ? i : i + 1), kcal: 2060 + (i % 4) * 30, protein_g: 148 }));
const wts = () => Array.from({ length: 10 }, (_, i) => ({ day: day(i), kg: Math.round((72.4 + ((i % 2) ? 0.15 : -0.1)) * 10) / 10 }));
const base = () => ({ today: '2026-09-18', goal: { kind: 'fat_loss', current_kg: 72.4, goal_kg: 68 }, daily_targets: { kcal: 2100, protein_g: 150 }, food_log_last_14_days: food(), weigh_ins_last_14_days: wts(), calorie_target_changes: [{ at: '2026-08-28', from: 2250, to: 2100, changed_by: 'coach_chat' }] as any[] });
const packs: { name: string; expect: string; state: any }[] = [
  { name: 'clean-stall', expect: 'propose_lower_calories', state: base() },
  { name: 'clean-stall-no-history', expect: 'propose_lower_calories', state: { ...base(), calorie_target_changes: [] } },
  { name: 'weekend-blowouts', expect: 'talk_about_high_days', state: { ...base(), food_log_last_14_days: food().map((r, i) => (i === 1 || i === 8 ? { ...r, kcal: 3400 } : r)) } },
  { name: 'raised-back-by-hand', expect: 'talk_about_undone_change', state: { ...base(), calorie_target_changes: [{ at: '2026-08-20', from: 1950, to: 2100, changed_by: 'user_by_hand' }, { at: '2026-08-10', from: 2100, to: 1950, changed_by: 'coach_card' }] } },
  { name: 'noisy-scale', expect: 'request_steadier_weigh_ins', state: { ...base(), weigh_ins_last_14_days: [73.4, 71.6, 73.1, 71.9, 72.9, 71.5, 73.3, 71.8, 72.6, 71.7].map((kg, i) => ({ day: day(i), kg })) } },
  { name: 'protein-collapsed', expect: 'propose_protein_fix', state: { ...base(), food_log_last_14_days: food().map((r) => ({ ...r, protein_g: 70 })) } },
];
const questions = {
  which_card: {
    type: 'choice',
    instructions: [
      'You are choosing ONE coaching card for a person trying to lose fat, from their last fortnight.',
      'Check the special cases FIRST, in this order. Only if none of them applies may you propose lowering calories.',
      '1. If the change history shows the person raising their calorie target back up by hand after a coach lowered it, choose talk_about_undone_change. They already said no once; ask, do not repeat it.',
      '2. If a few logged days are far above the target while the rest are near it, choose talk_about_high_days. The target is not the problem.',
      '3. If protein is far under its target, choose propose_protein_fix.',
      '4. If the weigh-ins jump by a kilogram or more between neighbouring days, choose request_steadier_weigh_ins. No trend can be read.',
      '5. Otherwise, if intake is honestly near target and weight is flat, choose propose_lower_calories.',
      '6. If none of this is clear, choose hold.',
    ],
    criteria: {
      propose_lower_calories: 'Near target nearly every day, weight flat, nothing odd in the history. Example: target 1800, days between 1750 and 1850, scale 81.0 to 81.3 kg for two weeks.',
      talk_about_high_days: 'Most days near target but one or more far above it. Example: target 1800, ten days near it, two days at 3000.',
      talk_about_undone_change: 'The person reversed a coach-made calorie cut themselves. Example: coach set 2400 to 2250, then the person set 2250 back to 2400 by hand.',
      request_steadier_weigh_ins: 'Weigh-ins bounce too much to read. Example: 80.2, 81.9, 80.4, 81.7 on neighbouring days.',
      propose_protein_fix: 'Protein far under target. Example: target 140 g, logging 60 to 75 g.',
      hold: 'On track, or nothing is clear enough to act on.',
    },
  },
};
const pct = (v: number) => (v * 100).toFixed(0) + '%';
let right = 0;
for (const p of packs) {
  const r = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, state: p.state, questions }) });
  if (!r.ok) { console.log(p.name, 'HTTP', r.status, (await r.text()).slice(0, 200)); continue; }
  const a = (await r.json() as any).answers.which_card;
  const ok = a.choice === p.expect; if (ok) right++;
  const top = Object.entries(a.probabilities).sort((x: any, y: any) => y[1] - x[1]).slice(0, 3).map(([k, v]: any) => `${k} ${pct(v)}`).join(', ');
  console.log(`${ok ? 'PASS' : 'FAIL'} ${p.name.padEnd(24)} chose ${String(a.choice).padEnd(28)} conf ${pct(a.confidence).padStart(4)} | ${top}`);
}
console.log(`${right}/6 right`);
