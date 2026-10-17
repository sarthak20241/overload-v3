/**
 * Proves the six steering facts on a made-up person in UTC, every number worked
 * by hand. LIVE database, made-up user id, deleted after.
 *
 *   npx tsx scripts/drona-facts/steering.mts
 *
 * W = week of 3 Aug 2026; its window is 13 Jul .. 9 Aug (28 days).
 *
 * 1 Pace. Weigh-ins fall 0.5 kg a week in a straight line: 80.0 (13 Jul), 79.5
 *   (20 Jul), 79.0 (27 Jul), 78.5 (3 Aug), 78.0 (10 Aug). 90 kg on 12 Jul is
 *   outside the window; 5 kg on 4 Aug is impossible and dropped.
 *   W:  4 readings over 21 days, -0.5 kg/week, now 78.5. Program target 76 kg
 *       by 6 Sep (4 weeks): 2.5 to go, needs -0.625/week, arrives in 5 weeks (13 Sep)
 *   W2: profile goal 79 kg, now 78.0: the trend moves away, so no arrival date
 *   W3: 3 readings over 14 days; program target 78.0 = now: arrived (0 weeks)
 * 2 Maintenance (W). 15 days at 2000, 1 day at 1100 (exactly half the 2200
 *   target: NOT under half), 4 days at 500 (under half), a day with no entries,
 *   and 9000 on 12 Jul outside the window. All 20 days: 1655; whole days: 1943.75.
 *   Losing 0.5 kg a week = 550 kcal a day under: maintenance 2205 and 2494.
 * 3 Weekdays (W). Trained Mon 3 Aug and Wed 5 Aug (2 sessions); Thu 6 Aug is a
 *   pick day with no session. Mondays also 15 Jun (49 days back, inside), 20 and
 *   27 Jul; 8 Jun (56 days back) is outside. Mon 4 of 8 weeks, Wed 1, 4 weeks trained.
 * 4 Habits (W). Routine R1 = A, A (twice), B. The phase's routine = B, C.
 *   Mon R1: A 2 sets + a warm-up, B not done, D 1 set (added).
 *   Wed R1: A 1, B 3. Wed freestyle: D 2, E only a warm-up. An unfinished R1
 *   session with A 5 sets does not count.
 *   A 2 sessions 3 sets, planned 2 done 2. B planned 2 done 1 skipped 1, in phase.
 *   C in phase, never done. D custom, 2 sessions: 1 added, 1 freestyle. E: no row.
 * 5 Change outcome. C1 targets 5 Aug, C2 goal the same day, C3 25 Jul (11 days
 *   before), C4 19 Aug (14 days after, inside), C5 20 Aug (15 days, outside).
 *   C1 before (22 Jul .. 4 Aug): 2 sessions, 22 sets, TODAY match 0.5; 11 food
 *   days averaging 1373; weigh-ins 79.0 and 78.5. After (6 .. 19 Aug): 2
 *   sessions, 14 sets, match 0.25; no food; one weigh-in 78.0.
 * 6 Cards by topic. weigh_in applied-not-done (20 Jul), weigh_in expired
 *   (27 Jul), due_session applied and done (3 Aug); W2 adds a weigh_in "no thanks".
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { cleanupOnCrash } from './_cleanup.mts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_steering_v1';
let customId: string | null = null;
const cleanup = async () => {
  await db.rpc('delete_user_data', { p_user_id: UID });
  if (customId) await db.from('exercises').delete().eq('id', customId);
};
cleanupOnCrash(cleanup);
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

const W = '2026-08-03', W2 = '2026-08-10', W3 = '2026-08-17';

await cleanup();
must(await db.from('user_profiles').insert({ clerk_user_id: UID, timezone: 'UTC' }), 'profile');

// 1. Weigh-ins.
const kg = (day: string, value: number) => ({ user_id: UID, metric_date: day, metric_type: 'bodyweight_kg', value, unit: 'kg', source: 'manual' });
must(await db.from('daily_metrics').insert([
  kg('2026-07-12', 90), kg('2026-07-13', 80.0), kg('2026-07-20', 79.5), kg('2026-07-27', 79.0),
  kg('2026-08-03', 78.5), kg('2026-08-04', 5.0), kg('2026-08-10', 78.0),
]), 'weights');

// 2. Food days.
const food: Record<string, unknown>[] = [];
const fday = (day: string, kcal: number, entries = 3) => ({ user_id: UID, day, kcal, protein_g: 100, entries, target_kcal: 2200 });
for (let d = 13; d <= 27; d++) food.push(fday(`2026-07-${d}`, 2000));
food.push(fday('2026-07-28', 1100));
for (const d of ['2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01']) food.push(fday(d, 500));
food.push(fday('2026-08-02', 0, 0), fday('2026-07-12', 9000));
must(await db.from('drona_day_facts').insert(food), 'food days');

// 3 + 5. Training days.
const tday = (day: string, sessions: number, working_sets: number, pick_set_match: number | null = null) =>
  ({ user_id: UID, day, sessions, working_sets, pick_set_match });
must(await db.from('drona_training_day_facts').insert([
  tday('2026-06-08', 1, 5), tday('2026-06-15', 1, 5), tday('2026-07-20', 1, 5), tday('2026-07-27', 1, 10),
  tday('2026-08-03', 1, 12, 0.5), tday('2026-08-05', 2, 20, 1.0), tday('2026-08-06', 0, 0),
  tday('2026-08-10', 1, 8, 0.25), tday('2026-08-19', 1, 6),
]), 'training days');

// 4. Program, phase, routines, workouts.
const cat = must(await db.from('exercises').select('id, name').is('created_by', null).order('name').limit(4), 'catalog') as any[];
const [A, B, C, E] = cat.map((x) => x.id);
const custom = must(await db.from('exercises').insert({ name: 'Probe Custom Row', muscle_group: 'Back', created_by: UID }).select('id').single(), 'custom') as any;
customId = custom.id;
const D = customId!;
const prog = must(await db.from('coach_programs').insert({ user_id: UID, title: 'Probe', start_date: '2026-07-01', status: 'active' }).select('id').single(), 'program') as any;
const phase = must(await db.from('coach_program_phases').insert({ program_id: prog.id, user_id: UID, seq: 1, name: 'P1', duration_weeks: 8, start_offset_weeks: 0 }).select('id').single(), 'phase') as any;
const r1 = must(await db.from('routines').insert({ user_id: UID, name: 'R1' }).select('id').single(), 'r1') as any;
const r2 = must(await db.from('routines').insert({ user_id: UID, name: 'Phase day', program_phase_id: phase.id }).select('id').single(), 'r2') as any;
must(await db.from('routine_exercises').insert([
  { routine_id: r1.id, exercise_id: A, order: 0 }, { routine_id: r1.id, exercise_id: A, order: 1 }, { routine_id: r1.id, exercise_id: B, order: 2 },
  { routine_id: r2.id, exercise_id: B, order: 0 }, { routine_id: r2.id, exercise_id: C, order: 1 },
]), 'routine exercises');
const session = async (day: string, routine: string | null, finished: boolean, sets: [string, number, string?][]) => {
  const w = must(await db.from('workouts').insert({
    user_id: UID, name: 'probe', routine_id: routine, started_at: `${day}T10:00:00Z`,
    finished_at: finished ? `${day}T11:00:00Z` : null,
  }).select('id').single(), 'workout') as any;
  const rows = sets.flatMap(([ex, n, type], i) => Array.from({ length: n }, (_, k) =>
    ({ workout_id: w.id, exercise_id: ex, weight_kg: 50, reps: 8, completed: true, order: i * 10 + k, set_type: type ?? 'normal' })));
  if (rows.length) must(await db.from('workout_sets').insert(rows), 'sets');
};
await session('2026-08-03', r1.id, true, [[A, 2], [A, 1, 'warmup'], [D, 1]]);
await session('2026-08-05', r1.id, true, [[A, 1], [B, 3]]);
await session('2026-08-05', null, true, [[D, 2], [E, 1, 'warmup']]);
await session('2026-08-06', r1.id, false, [[A, 5]]);

// 5. Plan changes.
const change = (at: string, entity: string) => ({ user_id: UID, occurred_at: at, entity, action: 'changed', source: 'manual', changes: {} });
must(await db.from('plan_changes').insert([
  change('2026-08-05T12:00:00Z', 'targets'), change('2026-08-05T13:00:00Z', 'goal'),
  change('2026-07-25T12:00:00Z', 'routine'), change('2026-08-19T12:00:00Z', 'phase'), change('2026-08-20T12:00:00Z', 'phase'),
]), 'changes');
const c1 = (must(await db.from('plan_changes').select('id').eq('user_id', UID).eq('entity', 'targets').single(), 'c1') as any).id;

// Week rows: goals (plan facts) and cards.
const card = (topic: string, outcome: string, did: boolean | null) =>
  ({ c_card_id: randomUUID(), c_kind: 'request', c_topic: topic, c_outcome: outcome, c_followed_through: did });
must(await db.from('drona_week_facts').insert([
  { user_id: UID, week_start: '2026-07-20', ...card('weigh_in', 'applied', false) },
  { user_id: UID, week_start: '2026-07-27', ...card('weigh_in', 'expired', null) },
  { user_id: UID, week_start: W, p_program_target_kg: 76, p_program_target_date: '2026-09-06', p_goal_weight_kg: 70,
    p_phase_id: phase.id, ...card('due_session', 'applied', true) },
  { user_id: UID, week_start: W2, p_goal_weight_kg: 79, ...card('weigh_in', 'dismissed', null) },
  { user_id: UID, week_start: W3, p_program_target_kg: 78.0, p_goal_weight_kg: 70 },
]), 'weeks');

must(await db.rpc('drona_rebuild_steering_facts', { p_user_id: UID, p_from: W, p_to: W3 }), 'rebuild');
const weeks = must(await db.from('drona_week_facts').select('*').eq('user_id', UID), 'read weeks') as any[];
const wk = (d: string) => weeks.find((r) => r.week_start === d);
const w = wk(W), w2 = wk(W2), w3 = wk(W3);

// 1
ok('1 W window 13 Jul .. 9 Aug, 4 readings over 21 days', w.g_window_from === '2026-07-13' && w.g_window_to === '2026-08-09' && w.g_readings === 4 && w.g_span_days === 21, [w.g_window_from, w.g_window_to, w.g_readings, w.g_span_days]);
ok('1 W -0.5 kg a week, now 78.5 on 3 Aug', num(w.g_rate_kg_per_week) === -0.5 && num(w.g_now_kg) === 78.5 && w.g_now_on === '2026-08-03', [w.g_rate_kg_per_week, w.g_now_kg, w.g_now_on]);
ok('1 W program goal 76 by 6 Sep: 2.5 to go, 4 weeks, needs -0.625', num(w.g_goal_kg) === 76 && w.g_goal_from === 'program' && w.g_target_from === 'program' && num(w.g_kg_to_go) === -2.5 && num(w.g_weeks_left) === 4 && num(w.g_needed_kg_per_week) === -0.625,
  [w.g_goal_kg, w.g_goal_from, w.g_kg_to_go, w.g_weeks_left, w.g_needed_kg_per_week]);
ok('1 W arrives in 5 weeks, 13 Sep', num(w.g_eta_weeks) === 5 && w.g_eta_date === '2026-09-13', [w.g_eta_weeks, w.g_eta_date]);
ok('1 W2 profile goal 79, trend moves away: no arrival, no target date', w2.g_goal_from === 'profile' && num(w2.g_kg_to_go) === 1 && w2.g_eta_weeks === null && w2.g_eta_date === null && w2.g_weeks_left === null,
  [w2.g_goal_from, w2.g_kg_to_go, w2.g_eta_weeks, w2.g_weeks_left]);
ok('1 W3 3 readings over 14 days, at the goal: arrived', w3.g_readings === 3 && w3.g_span_days === 14 && num(w3.g_eta_weeks) === 0 && w3.g_eta_date === '2026-08-23', [w3.g_readings, w3.g_span_days, w3.g_eta_weeks, w3.g_eta_date]);
// 2
ok('2 W 20 food days, 4 under half (exactly half is not)', w.e_food_days === 20 && w.e_food_days_under_half === 4, [w.e_food_days, w.e_food_days_under_half]);
ok('2 W averages 1655 all days, 1944 whole days', num(w.e_avg_kcal) === 1655 && num(w.e_avg_kcal_full) === 1944, [w.e_avg_kcal, w.e_avg_kcal_full]);
ok('2 W maintenance 2205 (all), 2494 (whole days)', w.e_maint_kcal === 2205 && w.e_maint_kcal_full === 2494, [w.e_maint_kcal, w.e_maint_kcal_full]);
// 3
ok('3 W trained Mon and Wed', JSON.stringify(w.t_weekdays) === '[1,3]', w.t_weekdays);
ok('3 W Mon 4 of 8 weeks (15 Jun in, 8 Jun out), Wed 1, 4 weeks trained',
  JSON.stringify(w.t_weekday_weeks_8w) === JSON.stringify({ 1: 4, 2: 0, 3: 1, 4: 0, 5: 0, 6: 0, 7: 0 }) && w.t_weeks_trained_8w === 4, [w.t_weekday_weeks_8w, w.t_weeks_trained_8w]);
// 6
ok('6 W cards by topic up to W', JSON.stringify(w.c_by_topic_to_date?.weigh_in) === JSON.stringify({ cards: 2, other: 0, applied: 1, expired: 1, waiting: 0, followed: 0, dismissed: 0, not_followed: 1 })
  && w.c_by_topic_to_date?.due_session?.cards === 1 && w.c_by_topic_to_date?.due_session?.followed === 1, w.c_by_topic_to_date);
ok('6 W2 adds the "no thanks"', w2.c_by_topic_to_date?.weigh_in?.cards === 3 && w2.c_by_topic_to_date?.weigh_in?.dismissed === 1, w2.c_by_topic_to_date?.weigh_in);

// 4
const habits = must(await db.from('drona_exercise_habit_week_facts').select('*').eq('user_id', UID).eq('week_start', W), 'habits') as any[];
const h = (id: string) => habits.find((x) => x.exercise_id === id);
const pick = (x: any) => x && [x.sessions, x.working_sets, x.routine_sessions_planned, x.routine_sessions_done, x.routine_sessions_skipped, x.sessions_added, x.sessions_freestyle, x.in_phase, x.custom];
ok('4 A: 2 sessions, 3 sets, planned 2 done 2 (listed twice, counted once; warm-up and unfinished left out)', JSON.stringify(pick(h(A))) === JSON.stringify([2, 3, 2, 2, 0, 0, 0, false, false]), pick(h(A)));
ok('4 B: planned 2, done 1, skipped 1, in the phase', JSON.stringify(pick(h(B))) === JSON.stringify([1, 3, 2, 1, 1, 0, 0, true, false]) && h(B).phase_routines === 1, pick(h(B)));
ok('4 C: in the phase, never done', JSON.stringify(pick(h(C))) === JSON.stringify([0, 0, 0, 0, 0, 0, 0, true, false]), pick(h(C)));
ok('4 D: custom, 1 added to a routine session, 1 freestyle', JSON.stringify(pick(h(D))) === JSON.stringify([2, 3, 0, 0, 0, 1, 1, false, true]), pick(h(D)));
ok('4 E: only a warm-up, so no row', h(E) === undefined && habits.length === 4, habits.length);

// 5
const out = must(await db.from('drona_change_outcome_facts').select('*').eq('change_id', c1).single(), 'c1 outcome') as any;
ok('5 C1: 1 other the same day, 1 before (11 days), 1 after (14 days in, 15 out), 14 days seen',
  out.same_day_changes === 1 && out.other_changes_before === 1 && out.other_changes_after === 1 && out.after_days === 14,
  [out.same_day_changes, out.other_changes_before, out.other_changes_after, out.after_days]);
ok('5 C1 training before 2 sessions 22 sets 0.5, after 2 sessions 14 sets 0.25',
  JSON.stringify([out.b_sessions, out.b_training_days, out.b_working_sets, num(out.b_pick_match), out.a_sessions, out.a_training_days, out.a_working_sets, num(out.a_pick_match)]) === JSON.stringify([2, 2, 22, 0.5, 2, 2, 14, 0.25]),
  [out.b_sessions, out.b_working_sets, out.b_pick_match, out.a_sessions, out.a_working_sets, out.a_pick_match]);
ok('5 C1 food before 11 days at 1373 (target 2200), after none',
  out.b_food_days === 11 && num(out.b_avg_kcal) === 1373 && num(out.b_avg_target_kcal) === 2200 && out.a_food_days === 0 && out.a_avg_kcal === null,
  [out.b_food_days, out.b_avg_kcal, out.a_food_days]);
ok('5 C1 weight before 2 at 78.75 (impossible dropped), after 1 at 78.0',
  out.b_weigh_ins === 2 && num(out.b_avg_kg) === 78.75 && out.a_weigh_ins === 1 && num(out.a_avg_kg) === 78,
  [out.b_weigh_ins, out.b_avg_kg, out.a_weigh_ins, out.a_avg_kg]);
const all = must(await db.from('drona_change_outcome_facts').select('change_id').eq('user_id', UID), 'all outcomes') as any[];
ok('5 one row per change in reach', all.length === 5, all.length);

await cleanup();
const left = [
  ...(must(await db.from('drona_exercise_habit_week_facts').select('user_id').eq('user_id', UID), 'left h') as any[]),
  ...(must(await db.from('drona_change_outcome_facts').select('user_id').eq('user_id', UID), 'left c') as any[]),
];
ok('delete_user_data removes both new tables', left.length === 0, left.length);

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
if (fails) process.exitCode = 1;
