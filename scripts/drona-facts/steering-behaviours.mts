/**
 * Proves the ten steering signals and twelve steering behaviours on a made-up
 * person. Week facts, habit rows and change outcomes are written directly, each
 * set just inside or just outside a line; then drona_rebuild_steering_signals
 * and drona_rebuild_behaviours run. LIVE database, made-up user id, deleted after.
 *
 *   npx tsx scripts/drona-facts/steering-behaviours.mts
 *
 * Pace (trusted trend: 8 weigh-ins over 21 days; 80 kg, goal 76):
 *   W1  needs -0.80 kg/wk (exactly 1%), arrives exactly 2 weeks late: on pace
 *   W2  needs -0.81: off pace (unsafe)
 *   W3  arrives 15 days late: off pace again -> off_pace
 *   W4  the date has passed: off pace.  W5 no date: pace not judged
 * Calories, rule_version 2 (the adaptive estimate, m_*: 2500 kcal, measured):
 *   W1  date pace -0.8 -> 2500 - 880 = 1620 -> 1625; target 1725, exactly 100 away: off
 *   W2  again -> calories_off, an act card
 *   W3  resting floor 1690 -> 1700 beats 1625; target 1799 is 99 away: not off
 *   W4  no kcal target: not judged.  W5 default pace -0.4 -> 2060 -> 2050 = the target
 *   W6  13 days since the last target change: not judged (it settles 14)
 *   W7  last weigh-in 11 days before the window ends: stale, not judged
 *   W8  the estimate is still the formula guess: not judged
 * Finding maintenance, rule_version 2 (goal 76; asks the first week):
 *   W6  13 whole days: missing whole days (1 more) -> finding_maintenance at once
 *   W7  weigh-ins over 20 days and stale: missing weigh-ins and stale
 *   W8  7 weigh-ins: 1 more needed
 *   W9  3 outliers to 2 kept weigh-ins: missing scale
 *   W10 0.4 kg from the goal: not judged
 *   W11 no weigh-in and 2 food days: not judged (not trying yet)
 *   W12 3 food days, weight from the profile (90), one outlier alone: judged,
 *       missing weigh-ins, stale, whole days, and NOT scale
 * Training days (3 sessions every week, so 3.0 a week over 8):
 *   W10 6 of 8 weeks, 1 steady day: trains any day. Planned 4 = 1 above: too big
 *   W11 5 of 8 weeks: none of these judged
 *   W12 3 steady days: fixed days. Planned 3: not too big
 *   W13 2 steady days: neither. Planned 4: too big; W14 again -> plan_too_big
 * Exercises (window = the last 8 weeks):
 *   F1 done 6 weeks, not in the phase: a favourite. F2 5 weeks: not.
 *   F3 done 6 weeks but in this week's phase: not a favourite.
 *   S1 skipped 2 of 4 routine sessions (half): skipped. S2 1 of 4: not.
 *   S3 in the phase 4 trained weeks, never done: at W12 the phase's others are
 *      0 of 1 done (own way, not this); at W13 F3 joins the phase, 1 of 2: skipped.
 *   -> exercise_skipped at W13 names S1 only (S3 was not skipped at W12)
 * Card topics: weigh_in 2 cards, none followed, last one in W11.
 *   W13 not landing: talk, mutes topic:weigh_in. W14 (21 days after the last
 *   card, inside): steer. W15 (28 days): no longer.
 *   due_session 1 of 2 followed, watching has no follow test: never.
 * Changes whose 14 days after closed in W11:
 *   X1 4 sessions before, 2 after (under 3 in 4): backfired. X2 4 then 3 (exactly
 *   3 in 4): worked. X3 1 session and 3 food days before: too little history.
 *   X4 another change after it. X5 two others the same day. Neither judged.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { cleanupOnCrash } from './_cleanup.mts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_steering_behaviours_v1';
cleanupOnCrash(() => db.rpc('delete_user_data', { p_user_id: UID }));
let fails = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
};
const must = <T,>(r: { data: T; error: any }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const W = ['', '2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20',
  '2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'];
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({ clerk_user_id: UID, timezone: 'UTC', weight_kg: 90 }), 'profile');

const trend = { g_readings: 8, g_span_days: 21, g_goal_kg: 76, g_now_kg: 80, g_kg_to_go: -4 };
const T = '2026-07-05';
const m = (i: number, o: Record<string, unknown> = {}) => ({
  m_window_to: addDays(W[i], 6), m_last_weigh_in: addDays(W[i], 6), m_trend_kg: 80, m_readings_28: 8, m_span_days: 21,
  m_whole_days_28: 14, m_outliers_28: 0, m_data_weight: 1, m_estimate_kcal: 2500, m_source: 'measured', m_data_weeks: 4,
  m_bmr_kcal: 1500, ...o,
});
const rows: Record<string, unknown>[] = [
  { week_start: W[1], ...trend, g_target_date: T, g_weeks_left: 5, g_needed_kg_per_week: -0.80, g_eta_date: addDays(T, 14), ...m(1), p_kcal_target: 1725 },
  { week_start: W[2], ...trend, g_target_date: T, g_weeks_left: 5, g_needed_kg_per_week: -0.81, g_eta_date: addDays(T, 14), ...m(2), p_kcal_target: 1725 },
  { week_start: W[3], ...trend, g_target_date: T, g_weeks_left: 5, g_needed_kg_per_week: -0.80, g_eta_date: addDays(T, 15), ...m(3, { m_bmr_kcal: 1690 }), p_kcal_target: 1799 },
  { week_start: W[4], ...trend, g_target_date: T, g_weeks_left: 0, g_needed_kg_per_week: null, g_eta_date: addDays(T, 40), ...m(4), p_kcal_target: null },
  { week_start: W[5], ...trend, ...m(5), p_kcal_target: 2050 },
  { week_start: W[6], ...trend, ...m(6, { m_whole_days_28: 13, m_data_weight: 0.93 }), p_kcal_target: 2500, p_days_since_target_change: 13 },
  { week_start: W[7], ...trend, ...m(7, { m_span_days: 20, m_data_weight: 0.95, m_last_weigh_in: addDays(W[7], -5) }), p_kcal_target: 2500 },
  { week_start: W[8], ...trend, ...m(8, { m_readings_28: 7, m_data_weight: 0.88, m_source: 'guess', m_data_weeks: 0 }), p_kcal_target: 2500 },
  { week_start: W[9], ...trend, ...m(9, { m_readings_28: 2, m_outliers_28: 3, m_data_weight: 0 }) },
  { week_start: W[10], ...trend, ...m(10, { m_trend_kg: 76.4 }), g_now_kg: 76.4, g_kg_to_go: -0.4, t_weeks_trained_8w: 6, t_weekday_weeks_8w: { 1: 6, 2: 5, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }, t_planned_sessions: 4 },
  { week_start: W[11], g_goal_kg: 76, ...m(11, { m_trend_kg: null, m_readings_28: 0, m_span_days: null, m_last_weigh_in: null, m_whole_days_28: 0, m_data_weight: 0 }), e_food_days: 2, t_weeks_trained_8w: 5, t_weekday_weeks_8w: { 1: 5 }, c_card_id: randomUUID(), c_topic: 'weigh_in' },
  { week_start: W[12], g_goal_kg: 76, ...m(12, { m_trend_kg: null, m_readings_28: 0, m_outliers_28: 1, m_span_days: null, m_last_weigh_in: null, m_whole_days_28: 0, m_data_weight: 0 }), e_food_days: 3, t_weeks_trained_8w: 6, t_weekday_weeks_8w: { 1: 6, 2: 0, 3: 6, 4: 0, 5: 6, 6: 0, 7: 0 }, t_planned_sessions: 3, c_card_id: randomUUID(), c_topic: 'due_session' },
  { week_start: W[13], t_weeks_trained_8w: 6, t_weekday_weeks_8w: { 1: 6, 2: 6 }, t_planned_sessions: 4 },
  { week_start: W[14], t_weeks_trained_8w: 6, t_weekday_weeks_8w: { 1: 6, 2: 6 }, t_planned_sessions: 4 },
  { week_start: W[15] },
];
const topics = {
  weigh_in: { cards: 2, followed: 0, not_followed: 2 },
  due_session: { cards: 2, followed: 1, not_followed: 1 },
  watching: { cards: 3, followed: 0, not_followed: 0 },
};
for (const r of rows) {
  r.user_id = UID;
  r.t_sessions = 3;
  if ([W[13], W[14], W[15]].includes(r.week_start as string)) r.c_by_topic_to_date = topics;
}
must(await db.from('drona_week_facts').insert(rows), 'weeks');
must(await db.from('drona_signals').insert({ user_id: UID, week_start: W[9], signal: 'scale_untrusted', fired: true, detail: {}, rule_version: 1 }), 'scale');

const F1 = randomUUID(), F2 = randomUUID(), F3 = randomUUID(), S1 = randomUUID(), S2 = randomUUID(), S3 = randomUUID();
const habit = (week: string, id: string, name: string, o: Record<string, unknown>) =>
  ({ user_id: UID, week_start: week, exercise_id: id, exercise_name: name, custom: false, in_phase: false, phase_routines: 0,
     sessions: 0, working_sets: 0, routine_sessions_planned: 0, routine_sessions_done: 0, routine_sessions_skipped: 0,
     sessions_added: 0, sessions_freestyle: 0, ...o });
must(await db.from('drona_exercise_habit_week_facts').insert([
  ...[8, 9, 10, 11, 12, 13].map((i) => habit(W[i], F1, 'F1', { sessions: 1 })),
  ...[9, 10, 11, 12, 13].map((i) => habit(W[i], F2, 'F2', { sessions: 1 })),
  ...[8, 9, 10, 11, 12, 13].map((i) => habit(W[i], F3, 'F3', { sessions: 1, in_phase: i === 13 })),
  habit(W[9], S1, 'S1', { routine_sessions_planned: 2, routine_sessions_skipped: 1, routine_sessions_done: 1, sessions: 1 }),
  habit(W[10], S1, 'S1', { routine_sessions_planned: 2, routine_sessions_skipped: 1, routine_sessions_done: 1, sessions: 1 }),
  habit(W[10], S2, 'S2', { routine_sessions_planned: 4, routine_sessions_skipped: 1, routine_sessions_done: 3, sessions: 3 }),
  ...[9, 10, 11, 12].map((i) => habit(W[i], S3, 'S3', { in_phase: true, phase_routines: 1 })),
]), 'habits');

const base = 9_000_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
const change = (n: number, on: string, o: Record<string, unknown>) => ({
  change_id: base + n, user_id: UID, changed_at: on + 'T12:00:00Z', changed_on: on, entity: 'phase', action: 'changed', source: 'manual',
  after_days: 14, same_day_changes: 0, other_changes_before: 0, other_changes_after: 0,
  b_sessions: 4, a_sessions: 4, b_food_days: 0, a_food_days: 0, ...o,
});
must(await db.from('drona_change_outcome_facts').insert([
  change(1, '2026-07-27', { a_sessions: 2 }),
  change(2, '2026-07-28', { a_sessions: 3 }),
  change(3, '2026-07-29', { b_sessions: 1, b_food_days: 3, a_sessions: 0 }),
  change(4, '2026-07-30', { other_changes_after: 1, a_sessions: 0 }),
  change(5, '2026-07-31', { same_day_changes: 2, a_sessions: 0 }),
]), 'changes');

must(await db.rpc('drona_rebuild_steering_signals', { p_user_id: UID, p_from: W[1], p_to: W[15] }), 'signals');
must(await db.rpc('drona_rebuild_behaviours', { p_user_id: UID, p_from: W[1], p_to: W[15] }), 'behaviours');
const sigs = must(await db.from('drona_signals').select('*').eq('user_id', UID), 'read signals') as any[];
const behs = must(await db.from('drona_behaviours').select('*').eq('user_id', UID), 'read behaviours') as any[];
const picks = must(await db.from('drona_behaviour_pick').select('*').eq('user_id', UID), 'read picks') as any[];
const s = (signal: string, i: number) => sigs.find((r) => r.signal === signal && r.week_start === W[i]);
const b = (behaviour: string, i: number) => behs.find((r) => r.behaviour === behaviour && r.week_start === W[i]);
const pick = (i: number) => picks.find((p) => p.week_start === W[i]);
const names = (list: any[] | undefined) => (list ?? []).map((x) => x.exercise).sort();

ok('W1 needs exactly 1% a week, arrives exactly 2 weeks late: on pace', s('off_pace', 1)?.fired === false, s('off_pace', 1)?.detail);
ok('W2 needs 0.81: unsafe pace', s('off_pace', 2)?.fired === true && s('off_pace', 2)?.detail?.reason === 'pace_unsafe');
ok('W3 15 days late, second week: off_pace', s('off_pace', 3)?.detail?.reason === 'late' && b('off_pace', 3)?.card_kind === 'talk');
ok('W4 the date passed', s('off_pace', 4)?.detail?.reason === 'date_passed');
ok('W5 no date: pace not judged', s('off_pace', 5) === undefined);
ok('W1 estimate 2500, pace -0.8 -> 1625; target exactly 100 away: calories off',
  s('calories_off', 1)?.fired === true && s('calories_off', 1)?.detail?.suggested_kcal === 1625 && s('calories_off', 1)?.detail?.gap_kcal === 100, s('calories_off', 1)?.detail);
ok('W2 again: calories_off, an act card', b('calories_off', 2)?.card_kind === 'act' && b('calories_off', 2)?.rule_version === 2);
ok('W3 floor 1690 -> 1700; target 99 away: not off', s('calories_off', 3)?.fired === false && s('calories_off', 3)?.detail?.suggested_kcal === 1700, s('calories_off', 3)?.detail);
ok('W4 no kcal target: calories not judged, no maintenance_found', s('calories_off', 4) === undefined && b('maintenance_found', 4) === undefined);
ok('W5 default pace -0.4 -> 2060 -> 2050 = the target', s('calories_off', 5)?.fired === false && s('calories_off', 5)?.detail?.suggested_kcal === 2050 && s('calories_off', 5)?.detail?.pace_from === 'default', s('calories_off', 5)?.detail);
ok('W6 changed 13 days ago, W7 stale, W8 still a guess: calories not judged', [6, 7, 8].every((i) => s('calories_off', i) === undefined));
ok('W1-W3, W5 maintenance known: maintenance_found (steer), never unknown',
  [1, 2, 3, 5].every((i) => b('maintenance_found', i)?.card_kind === 'steer') && [1, 2, 3, 4, 5].every((i) => s('maintenance_unknown', i)?.fired === false));
ok('W6 13 whole days: 1 more, and finding_maintenance asks at once', JSON.stringify(s('maintenance_unknown', 6)?.detail?.missing) === '["whole_days"]'
  && s('maintenance_unknown', 6)?.detail?.whole_days_needed === 1 && b('finding_maintenance', 6)?.card_kind === 'request' && b('finding_maintenance', 6)?.rule_version === 2, s('maintenance_unknown', 6)?.detail);
ok('W7 weigh-ins over 20 days, and stale', JSON.stringify(s('maintenance_unknown', 7)?.detail?.missing) === '["weigh_ins","stale"]', s('maintenance_unknown', 7)?.detail);
ok('W8 7 weigh-ins: 1 more needed', s('maintenance_unknown', 8)?.detail?.weigh_ins_needed === 1);
ok('W9 3 outliers to 2 kept: missing scale', (s('maintenance_unknown', 9)?.detail?.missing ?? []).includes('scale'), s('maintenance_unknown', 9)?.detail);
ok('W10 0.4 kg from the goal, W11 not trying yet: not judged', s('maintenance_unknown', 10) === undefined && s('maintenance_unknown', 11) === undefined);
ok('W12 3 food days, profile weight 90, one outlier alone is not a broken scale', s('maintenance_unknown', 12)?.fired === true
  && Number(s('maintenance_unknown', 12)?.detail?.weight_kg) === 90
  && JSON.stringify(s('maintenance_unknown', 12)?.detail?.missing) === '["weigh_ins","stale","whole_days"]', s('maintenance_unknown', 12)?.detail);
ok('the two changed signals carry rule_version 2', ['maintenance_unknown', 'calories_off'].every((x) => sigs.filter((r) => r.signal === x).every((r) => r.rule_version === 2)));

ok('W10 3.0 a week, 1 steady day: trains_any_day (steer)', s('trains_any_day', 10)?.fired === true && b('trains_any_day', 10)?.card_kind === 'steer');
ok('W10 planned 4 vs 3.0: too big', s('plan_too_big', 10)?.fired === true);
ok('W11 5 of 8 weeks: not judged', ['trains_any_day', 'fixed_days', 'plan_too_big', 'favourite_exercises'].every((x) => s(x, 11) === undefined));
ok('W12 3 steady days: fixed_days; planned 3 not too big', s('fixed_days', 12)?.fired === true && s('trains_any_day', 12)?.fired === false && s('plan_too_big', 12)?.fired === false);
ok('W13 2 steady days: neither', s('fixed_days', 13)?.fired === false && s('trains_any_day', 13)?.fired === false);
ok('W14 too big two weeks running: plan_too_big (talk)', b('plan_too_big', 14)?.card_kind === 'talk' && b('plan_too_big', 13) === undefined);

ok('W13 favourites: F1 only (F2 5 weeks, F3 in the phase)', JSON.stringify(names(s('favourite_exercises', 13)?.detail?.exercises)) === '["F1"]' && b('keep_favourites', 13)?.card_kind === 'steer', names(s('favourite_exercises', 13)?.detail?.exercises));
ok('W12 skipped: S1 only (S3 is own way there)', JSON.stringify(names(s('exercise_skipped', 12)?.detail?.exercises)) === '["S1"]', names(s('exercise_skipped', 12)?.detail?.exercises));
ok('W13 skipped: S1 and S3 (S2 skipped 1 of 4: no)', JSON.stringify(names(s('exercise_skipped', 13)?.detail?.exercises)) === '["S1","S3"]', names(s('exercise_skipped', 13)?.detail?.exercises));
ok('W13 exercise_skipped names only the one skipped both weeks', JSON.stringify(names(b('exercise_skipped', 13)?.detail?.exercises)) === '["S1"]', b('exercise_skipped', 13)?.detail);

ok('W13 weigh_in not landing: talk, mutes topic:weigh_in', b('topic_not_landing', 13)?.card_kind === 'talk'
  && JSON.stringify(b('topic_not_landing', 13)?.mutes) === '["topic:weigh_in"]' && (s('topic_not_landing', 13)?.detail?.topics ?? []).length === 1, s('topic_not_landing', 13)?.detail);
ok('W14 21 days after the last card: still muted, now steer', b('topic_not_landing', 14)?.card_kind === 'steer');
ok('W15 28 days after: no longer', s('topic_not_landing', 15)?.fired === false && b('topic_not_landing', 15) === undefined);

const cs = (s('change_backfired', 11)?.detail?.changes ?? []).map((c: any) => [c.change_id - base, c.backfired]);
ok('W11 judged X1 (backfired) and X2 (exactly 3 in 4: worked) only', JSON.stringify(cs) === '[[1,true],[2,false]]', cs);
ok('W11 change_backfired names X1, change_worked names X2',
  JSON.stringify((b('change_backfired', 11)?.detail?.changes ?? []).map((c: any) => c.change_id - base)) === '[1]'
  && JSON.stringify((b('change_worked', 11)?.detail?.changes ?? []).map((c: any) => c.change_id - base)) === '[2]');

ok('pick W2: calories_off, not the steer row', pick(2)?.behaviour === 'calories_off', pick(2)?.behaviour);
ok('pick W7: finding_maintenance', pick(7)?.behaviour === 'finding_maintenance' && pick(7)?.card_kind === 'request');
ok('pick W13: topic_not_landing, muting weigh_in', pick(13)?.behaviour === 'topic_not_landing' && JSON.stringify(pick(13)?.mutes) === '["topic:weigh_in"]');
ok('pick W14: plan_too_big (the topic row is steer now)', pick(14)?.behaviour === 'plan_too_big', pick(14)?.behaviour);
ok('pick W10: only steer rows, so no card', pick(10) === undefined, pick(10)?.behaviour);

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_signals').select('user_id').eq('user_id', UID), 'left') as any[];
ok('delete_user_data cleans up', left.length === 0, left.length);

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
if (fails) process.exitCode = 1;
