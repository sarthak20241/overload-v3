/**
 * Phase 0 probe for Jev (.planning/drona-jev-plan.md): does the live API behave
 * as documented, and what does it SAY about our six known weeks?
 *
 *   npx tsx scripts/drona-jev/probe.mts
 *
 * Asks the owner's three kinds of question in ONE batched call per pack:
 *   signals    can we see X in this data?          (noul -> probability)
 *   action     what should Drona do?               (choice -> probabilities + confidence)
 *   card       what kind of card is this week?     (choice)
 * The questions are general on purpose: nothing here names a pack or its numbers.
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.JEV_API_KEY;
if (!KEY) { console.error('JEV_API_KEY missing from .env.local'); process.exit(2); }
const MODEL = 'jev-1.13.0'; // pinned: thresholds get calibrated against ONE model

const day = (back: number) => new Date(Date.UTC(2026, 8, 18) - back * 86_400_000).toISOString().slice(0, 10);
const baseFood = () => Array.from({ length: 12 }, (_, i) => ({ day: day(i < 3 ? i : i + 1), kcal: 2060 + (i % 4) * 30, protein_g: 148 }));
const baseWeight = () => Array.from({ length: 10 }, (_, i) => ({ day: day(i), kg: Math.round((72.4 + ((i % 2) ? 0.15 : -0.1)) * 10) / 10 }));
const base = () => ({
  today: '2026-09-18',
  goal: { kind: 'fat_loss', current_kg: 72.4, goal_kg: 68 },
  daily_targets: { kcal: 2100, protein_g: 150 },
  food_log_last_14_days: baseFood(),
  weigh_ins_last_14_days: baseWeight(),
  calorie_target_changes: [{ at: '2026-08-28', from: 2250, to: 2100, changed_by: 'coach_chat' }] as any[],
  training: { sessions_last_14_days: 7, sessions_planned: 8 },
});

const packs: { name: string; expect: string; state: any }[] = [
  { name: 'clean-stall', expect: 'lower', state: base() },
  { name: 'clean-stall-no-history', expect: 'lower', state: { ...base(), calorie_target_changes: [] } },
  { name: 'weekend-blowouts', expect: 'hold', state: { ...base(), food_log_last_14_days: baseFood().map((r, i) => (i === 1 || i === 8 ? { ...r, kcal: 3400 } : r)) } },
  { name: 'raised-back-by-hand', expect: 'hold', state: { ...base(), calorie_target_changes: [
      { at: '2026-08-20', from: 1950, to: 2100, changed_by: 'user_by_hand' },
      { at: '2026-08-10', from: 2100, to: 1950, changed_by: 'coach_card' }] } },
  { name: 'noisy-scale', expect: 'hold', state: { ...base(), weigh_ins_last_14_days: [73.4, 71.6, 73.1, 71.9, 72.9, 71.5, 73.3, 71.8, 72.6, 71.7].map((kg, i) => ({ day: day(i), kg })) } },
  { name: 'protein-collapsed', expect: 'hold', state: { ...base(), food_log_last_14_days: baseFood().map((r) => ({ ...r, protein_g: 70 })) } },
];

const questions = {
  // signals: can we SEE this in the data?
  weight_is_flat: { type: 'noul', instructions: 'Body weight has stayed essentially flat across the weigh-ins, with no real downward or upward trend.' },
  weight_trend_readable: { type: 'noul', instructions: 'The weigh-ins are steady enough from day to day that a real trend can be read from them.' },
  intake_near_target: { type: 'noul', instructions: 'On most logged days, calorie intake is close to the daily calorie target.' },
  has_far_over_days: { type: 'noul', instructions: 'At least one logged day is far above the daily calorie target.' },
  protein_adequate: { type: 'noul', instructions: 'Protein intake is close to the daily protein target.' },
  user_undid_a_cut: { type: 'noul', instructions: 'The change history shows the user raising the calorie target back up by hand after someone else lowered it.' },
  // decision: what should the coach do?
  best_action: {
    type: 'choice',
    instructions: 'A fitness coach reviews this fortnight for someone trying to lose fat. Pick the single best next move.',
    // The live API wants `criteria`: a map of option -> what it means. (The
    // launch blog shows `options: [...]`, which 422s. Found by this probe.)
    criteria: {
      lower_calorie_target: 'Intake is honest and near target, weight is truly flat, so the target itself is too high.',
      raise_calorie_target: 'Weight is dropping too fast to be healthy.',
      keep_target_and_watch: 'Things are on track, or the data cannot support any change yet.',
      ask_the_person_a_question_first: 'Something in the history suggests the person has a view the data cannot show.',
      fix_protein_before_calories: 'Protein is well under target, which matters more than the calorie number.',
      address_the_high_days_not_the_target: 'A few very high days explain the stall, not the daily target.',
    },
  },
  card_kind: {
    type: 'choice',
    instructions: 'Which kind of message fits this fortnight? act = propose a specific plan change. talk = ask the person a question before changing anything. request = ask them to log or measure something. hold = say nothing.',
    criteria: {
      act: 'Propose one specific change to the plan.',
      talk: 'Ask the person a question before changing anything.',
      request: 'Ask the person to log or measure something.',
      hold: 'Say nothing this week.',
    },
  },
};

const pct = (v: unknown) => (typeof v === 'number' ? (v * 100).toFixed(0).padStart(3) + '%' : '  ?');
for (const p of packs) {
  const t0 = Date.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state: p.state, questions }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) { console.log(`${p.name}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`); continue; }
  const out = await res.json() as any;
  const a = out.answers ?? {};
  console.log(`\n=== ${p.name}  (we expect: ${p.expect})   ${ms} ms, ${out.usage?.input_tokens} in-tokens, model ${out.model}`);
  console.log(`  signals  flat ${pct(a.weight_is_flat?.noul)} | readable ${pct(a.weight_trend_readable?.noul)} | near-target ${pct(a.intake_near_target?.noul)} | far-over-days ${pct(a.has_far_over_days?.noul)} | protein-ok ${pct(a.protein_adequate?.noul)} | undid-a-cut ${pct(a.user_undid_a_cut?.noul)}`);
  const act = a.best_action ?? {};
  const top = Object.entries(act.probabilities ?? {}).sort((x: any, y: any) => y[1] - x[1]).slice(0, 3).map(([k, v]: any) => `${k} ${pct(v).trim()}`).join(', ');
  console.log(`  action   ${act.choice}  (confidence ${pct(act.confidence).trim()})   top: ${top}`);
  const ck = a.card_kind ?? {};
  console.log(`  card     ${ck.choice}  (confidence ${pct(ck.confidence).trim()})   ${Object.entries(ck.probabilities ?? {}).map(([k, v]: any) => `${k} ${pct(v).trim()}`).join(', ')}`);
}
