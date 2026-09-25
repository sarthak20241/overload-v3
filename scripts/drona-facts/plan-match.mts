/**
 * Proves the plan-match facts (0138) on a made-up person whose every answer is
 * worked out by hand below. Runs against LIVE with a made-up user id, then
 * deletes it.
 *
 *   npx tsx scripts/drona-facts/plan-match.mts
 *
 * The plan: Push, Pull, Legs, Rest, Push, Pull, Rest (5 training slots, 3
 * routines), from Monday 31 Aug.
 *   Push  Bench (Chest) 4, Incline (Upper Chest) 3, Pushdown (Triceps) 3  = 10
 *   Pull  Row (Back) 4, Curl (Biceps) 3                                   =  7
 *   Legs  Squat (Quads) 4, Leg curl (Hamstrings) 3, Calf raise (Calves) 2 =  9
 *
 * TODAY's picks and what the person did (working sets; warm-ups never count):
 *   d0  pick Legs   Squat 4 (+1 warm-up), Leg curl 1, Bench 3
 *         matched 4 + 1 + 0 = 5 of 9 = 0.56. Missed Calves. Extra Chest, 3 sets.
 *         Most like Legs: 5 in common / (9 + 8 - 5) = 0.42.
 *   d1  pick Push   Bench 9, Pushdown 3 (no incline)
 *         Parent: Chest min(7, 9) = 7, Triceps 3: 10 of 10 = 1.00. CAPPED: the
 *         two extra chest sets do not push it past 1.
 *         Raw: Chest min(4, 9) = 4, Upper Chest 0, Triceps 3: 7 of 10 = 0.70.
 *   d2  pick Pull   nothing. 0 of 7, and not counted in the week's pick match.
 *   d3  pick Legs   Row 4, Curl 3: a Pull day on a Legs pick.
 *         0 of 9. Missed Calves, Hamstrings, Quads. Extra Back, Biceps, 7 sets.
 *         Most like Pull: 7 / (7 + 7 - 7) = 1.00.
 *
 * Week 1, TODAY's picks, days trained only: 28 planned, 15 matched = 0.54.
 * Week 1, the program's own week: 5/3 of a cycle, stored per raw muscle to one
 *   decimal: Chest 6.7, Upper Chest 5.0, Triceps 5.0, Back 6.7, Biceps 5.0,
 *   Quads 6.7, Hamstrings 5.0, Calves 3.3 = 43.4.
 *   Done: Chest 12, Triceps 3, Back 4, Biceps 3, Quads 4, Hamstrings 1 = 27.
 *   Matched by parent: Chest min(11.7, 12) = 11.7, + 3 + 4 + 3 + 4 + 1 + 0
 *   = 26.7 of 43.4 = 0.62. Missed Calves. Extra 0.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_plan_match_0138';
let fails = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
};
const must = <T,>(r: { data: T; error: any }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const same = (a: unknown, b: string[]) => JSON.stringify(a ?? []) === JSON.stringify(b);

const D0 = '2026-08-31'; // a Monday
const day = (n: number) => new Date(Date.parse(`${D0}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (n: number, hour = 10) => `${day(n)}T${String(hour).padStart(2, '0')}:00:00Z`;
const today = new Date().toISOString().slice(0, 10);

const cleanup = async () => {
  await db.rpc('delete_user_data', { p_user_id: UID });
  await db.from('exercises').delete().eq('created_by', UID);
};
await cleanup();
must(await db.from('user_profiles').insert({ clerk_user_id: UID, timezone: 'UTC', weekly_target_sessions: 3 }), 'profile');

const ex: Record<string, string> = {};
for (const [name, muscle] of [['Bench', 'Chest'], ['Incline', 'Upper Chest'], ['Pushdown', 'Triceps'], ['Row', 'Back'],
  ['Curl', 'Biceps'], ['Squat', 'Quads'], ['Leg curl', 'Hamstrings'], ['Calf raise', 'Calves']] as const) {
  ex[name] = (must(await db.from('exercises').insert({ name: `Probe 0138 ${name}`, muscle_group: muscle, created_by: UID }).select('id').single(), name) as any).id;
}

const pattern = ['Push', 'Pull', 'Legs', 'Rest', 'Push', 'Pull', 'Rest'];
const prog = must(await db.from('coach_programs').insert({ user_id: UID, title: 'Probe PPL', goal: 'hypertrophy', start_date: D0, status: 'active' }).select('id').single(), 'program') as any;
const phase = must(await db.from('coach_program_phases').insert({ program_id: prog.id, user_id: UID, seq: 0, name: 'Build', duration_weeks: 6, start_offset_weeks: 0, training_block: { week_pattern: pattern } }).select('id').single(), 'phase') as any;

const routine = async (name: string, items: [string, number][]) => {
  const id = (must(await db.from('routines').insert({ user_id: UID, name, program_phase_id: phase.id }).select('id').single(), name) as any).id as string;
  must(await db.from('routine_exercises').insert(items.map(([e, sets], i) => ({ routine_id: id, exercise_id: ex[e], sets, order: i }))), `${name} exercises`);
  return id;
};
const push = await routine('Push', [['Bench', 4], ['Incline', 3], ['Pushdown', 3]]);
const pull = await routine('Pull', [['Row', 4], ['Curl', 3]]);
const legs = await routine('Legs', [['Squat', 4], ['Leg curl', 3], ['Calf raise', 2]]);

must(await db.from('daily_suggestions').insert([
  [0, legs], [1, push], [2, pull], [3, legs],
].map(([n, r]) => ({ user_id: UID, day: day(n as number), kind: 'planned', routine_id: r, basis: 'probe', source: 'cron' }))), 'picks');

const session = async (n: number, sets: [string, number, boolean?][]) => {
  const w = must(await db.from('workouts').insert({ user_id: UID, routine_id: null, name: `d${n}`, started_at: at(n), finished_at: at(n, 11), duration_seconds: 3600 }).select('id').single(), `d${n}`) as any;
  const rows = sets.flatMap(([e, count, warm]) => Array.from({ length: count }, (_, i) => ({
    workout_id: w.id, exercise_id: ex[e], weight_kg: 50, reps: 10, completed: true, order: i, set_type: warm ? 'warmup' : 'normal',
  })));
  must(await db.from('workout_sets').insert(rows), `d${n} sets`);
};
await session(0, [['Squat', 1, true], ['Squat', 4], ['Leg curl', 1], ['Bench', 3]]);
await session(1, [['Bench', 9], ['Pushdown', 3]]);
await session(3, [['Row', 4], ['Curl', 3]]);

must(await db.rpc('drona_rebuild_training_facts', { p_user_id: UID, p_from: D0, p_to: today }), 'rebuild');

const days = must(await db.from('drona_training_day_facts').select('*').eq('user_id', UID).order('day'), 'days') as any[];
const d = (n: number) => days.find((r) => r.day === day(n));

ok('d0 Legs pick: 5 of 9 sets matched = 0.56', d(0)?.pick_sets_planned === 9 && d(0)?.pick_sets_matched === 5 && num(d(0)?.pick_set_match) === 0.56,
  { planned: d(0)?.pick_sets_planned, matched: d(0)?.pick_sets_matched, match: d(0)?.pick_set_match });
ok('d0: the warm-up squat does not count', d(0)?.working_sets === 8, d(0)?.working_sets);
ok('d0: missed Calves, extra Chest (3 sets)', same(d(0)?.pick_parents_missed, ['Calves']) && same(d(0)?.pick_parents_extra, ['Chest']) && d(0)?.pick_sets_extra === 3,
  { missed: d(0)?.pick_parents_missed, extra: d(0)?.pick_parents_extra, sets: d(0)?.pick_sets_extra });
ok('d0: looked most like Legs, 0.42', d(0)?.best_routine_id === legs && num(d(0)?.best_routine_similarity) === 0.42,
  { best: d(0)?.best_routine_id === legs ? 'Legs' : d(0)?.best_routine_id, sim: d(0)?.best_routine_similarity });
ok('d1 Push pick: parent match 1.00, CAPPED (not 1.20)', num(d(1)?.pick_set_match) === 1 && d(1)?.pick_sets_matched === 10,
  { match: d(1)?.pick_set_match, matched: d(1)?.pick_sets_matched });
ok('d1: raw match 0.70 (Upper Chest is not Chest)', num(d(1)?.pick_muscle_set_match) === 0.7, d(1)?.pick_muscle_set_match);
ok('d1: no parent missed', same(d(1)?.pick_parents_missed, []), d(1)?.pick_parents_missed);
ok('d2 Pull pick, no session: 0 of 7', d(2)?.sessions === 0 && d(2)?.pick_sets_planned === 7 && num(d(2)?.pick_set_match) === 0,
  { sessions: d(2)?.sessions, planned: d(2)?.pick_sets_planned, match: d(2)?.pick_set_match });
ok('d3 Legs pick, did Pull: 0.00, missed all three', num(d(3)?.pick_set_match) === 0 && same(d(3)?.pick_parents_missed, ['Calves', 'Hamstrings', 'Quads']),
  { match: d(3)?.pick_set_match, missed: d(3)?.pick_parents_missed });
ok('d3: extra Back and Biceps, 7 sets', same(d(3)?.pick_parents_extra, ['Back', 'Biceps']) && d(3)?.pick_sets_extra === 7,
  { extra: d(3)?.pick_parents_extra, sets: d(3)?.pick_sets_extra });
ok('d3: looked exactly like Pull, 1.00', d(3)?.best_routine_id === pull && num(d(3)?.best_routine_similarity) === 1,
  { best: d(3)?.best_routine_id === pull ? 'Pull' : d(3)?.best_routine_id, sim: d(3)?.best_routine_similarity });

const w1 = (must(await db.from('drona_week_facts').select('*').eq('user_id', UID).eq('week_start', D0).single(), 'week') as any);
ok('week 1 picks: 3 days trained, 15 of 28 = 0.54', w1.t_pick_days_trained === 3 && w1.t_pick_sets_planned === 28 && w1.t_pick_sets_matched === 15 && num(w1.t_pick_set_match) === 0.54,
  { days: w1.t_pick_days_trained, planned: w1.t_pick_sets_planned, matched: w1.t_pick_sets_matched, match: w1.t_pick_set_match });
ok('week 1 program: 7 plan days, 43.4 planned', w1.t_plan_days === 7 && num(w1.t_plan_sets_planned) === 43.4,
  { days: w1.t_plan_days, planned: w1.t_plan_sets_planned });
ok('week 1 program: 26.7 matched = 0.62', num(w1.t_plan_sets_matched) === 26.7 && num(w1.t_plan_set_match) === 0.62,
  { matched: w1.t_plan_sets_matched, match: w1.t_plan_set_match });
ok('week 1 program: missed Calves, 0 extra', same(w1.t_plan_parents_missed, ['Calves']) && w1.t_plan_sets_extra === 0,
  { missed: w1.t_plan_parents_missed, extra: w1.t_plan_sets_extra });

const chest = must(await db.from('drona_parent_plan_week_facts').select('*').eq('user_id', UID).eq('week_start', D0).eq('parent', 'Chest').single(), 'chest') as any;
ok('week 1 Chest: 11.7 planned, 12 done, from Chest and Upper Chest', num(chest.planned_sets) === 11.7 && chest.done_sets === 12 && same([...chest.muscles].sort(), ['Chest', 'Upper Chest']),
  { planned: chest.planned_sets, done: chest.done_sets, muscles: chest.muscles });

await cleanup();
const left = must(await db.from('drona_pick_muscle_day_facts').select('day').eq('user_id', UID), 'cleanup') as any[];
const left2 = must(await db.from('drona_plan_muscle_week_facts').select('week_start').eq('user_id', UID), 'cleanup') as any[];
ok('cleanup removed every new fact row', left.length === 0 && left2.length === 0, [left.length, left2.length]);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
if (fails > 0) process.exitCode = 1;
