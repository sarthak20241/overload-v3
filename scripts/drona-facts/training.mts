/**
 * One person's training facts, read back (0136 + 0137).
 *
 *   USER_ID=user_3Gt86 npx tsx scripts/drona-facts/training.mts
 *   WEEKS=12 USER_ID=... npx tsx scripts/drona-facts/training.mts
 *
 * Three views, one per question the facts were built for:
 *   rhythm and the program   sessions, planned, program vs freestyle, early,
 *                            overdue, picks, back-to-back muscles
 *   lifts                    each main lift's best estimated 1RM, week by week
 *   muscles                  working sets per parent muscle, week by week
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const who = process.env.USER_ID;
if (!who) { console.error('Set USER_ID (a prefix is enough).'); process.exit(2); }
const nWeeks = Number(process.env.WEEKS ?? 8);

const { data: prof } = await db.from('user_profiles').select('clerk_user_id, goal_focus_areas').like('clerk_user_id', `${who}%`).limit(1).single();
if (!prof) { console.error('no such user'); process.exit(1); }
const uid = prof.clerk_user_id;
const since = new Date(Date.now() - nWeeks * 7 * 86_400_000).toISOString().slice(0, 10);
const pad = (v: any, w: number) => String(v ?? '-').padStart(w);

const { data: wk } = await db.from('drona_week_facts').select('*').eq('user_id', uid).gte('week_start', since).order('week_start');
console.log(`${uid}   focus areas: ${JSON.stringify(prof.goal_focus_areas ?? [])}\n`);
console.log('RHYTHM AND THE PROGRAM');
console.log('week        sess days plan(src)       prog free othr  early overdue  picks/followed/other  overlap  run rest  b2b muscles');
for (const r of wk ?? []) {
  console.log(`${r.week_start}${pad(r.t_sessions, 5)}${pad(r.t_training_days, 5)}  ${String(`${r.t_planned_sessions ?? '-'} (${r.t_plan_source ?? '-'})`).padEnd(16)}${pad(r.t_sessions_phase, 4)}${pad(r.t_sessions_freestyle, 5)}${pad(r.t_sessions_other_routine, 5)}${pad(r.t_early_sessions, 7)}${pad(r.t_overdue_days, 8)}   ${pad(`${r.t_picks_offered}/${r.t_picks_followed}/${r.t_picks_trained_other}`, 18)}${pad(r.t_pick_parent_overlap_avg, 9)}${pad(r.t_longest_train_run, 5)}${pad(r.t_longest_rest_run, 5)}  ${(r.t_back_to_back_muscles ?? []).join(',') || '-'}`);
}

const { data: ex } = await db.from('drona_exercise_week_facts').select('*').eq('user_id', uid).gte('week_start', since).order('week_start');
const byEx = new Map<string, any[]>();
for (const r of ex ?? []) { if (!byEx.has(r.exercise_name)) byEx.set(r.exercise_name, []); byEx.get(r.exercise_name)!.push(r); }
const top = [...byEx.entries()].filter(([, rows]) => rows.some((r) => r.best_e1rm_kg)).sort((a, b) => b[1].length - a[1].length).slice(0, 8);
const weeks = [...new Set((wk ?? []).map((r: any) => r.week_start))];
console.log('\nLIFTS: best estimated 1RM (kg) per week, most-trained first');
console.log('exercise'.padEnd(34) + weeks.map((w) => w.slice(5)).map((w) => w.padStart(7)).join(''));
for (const [name, rows] of top) {
  console.log(String(name).slice(0, 33).padEnd(34) + weeks.map((w) => pad(rows.find((r) => r.week_start === w)?.best_e1rm_kg, 7)).join(''));
}

const { data: mu } = await db.from('drona_parent_muscle_week_facts').select('*').eq('user_id', uid).gte('week_start', since);
const parents = [...new Set((mu ?? []).map((r: any) => r.parent))].sort();
const total = (p: string) => (mu ?? []).filter((r: any) => r.parent === p).reduce((a: number, r: any) => a + r.working_sets, 0);
parents.sort((a, b) => total(b) - total(a));
console.log('\nMUSCLES: working sets per week (primary muscle only; compound lifts also train secondaries)');
console.log('muscle'.padEnd(14) + weeks.map((w) => w.slice(5).padStart(7)).join('') + '   total');
for (const p of parents) {
  console.log(p.padEnd(14) + weeks.map((w) => pad((mu ?? []).find((r: any) => r.parent === p && r.week_start === w)?.working_sets, 7)).join('') + pad(total(p), 8));
}
const catalogue = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Quads', 'Hamstrings', 'Glutes', 'Calves', 'Core'];
const never = catalogue.filter((p) => !parents.includes(p));
if (never.length) console.log(`no working sets at all in ${nWeeks} weeks: ${never.join(', ')}`);
