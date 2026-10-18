/**
 * Proves the first five signals (drona_signals) on a made-up person whose week
 * facts are written directly, each one set to land just inside or just outside
 * a line. Runs against LIVE with a made-up user id, then deletes it.
 *
 *   npx tsx scripts/drona-facts/signals.mts
 *
 *   W1 3 Aug   1 TODAY 39% (under 40), program 50% (at 50): fires
 *              2 sessions 3 of 5; Hamstrings 1 of 4: fires; Calves 0 of 3.9 (under 4 planned): ignored;
 *                Chest 5 of 10 (exactly half, not under): ignored
 *              3 typical jump 1.6 kg: fires
 *              4 3 of 4 logged days under half: fires
 *              5 card expired, but only one finished card so far: no row
 *   W2 10 Aug  1 TODAY 10%, program 80%: fires, a pattern
 *              2 Calves 0 of 5: fires; a different muscle from W1, so NOT a pattern
 *              3 typical jump 1.5 kg (not over): no
 *              4 2 of 4 under half: no
 *              5 tapped, not done: two misses in a row, fires
 *   W3 17 Aug  1 only 1 training day on a pick: no row
 *              2 Calves 1 of 5 again: fires, a pattern (same muscle)
 *              3 one reading, impossible: fires; W2 did not, so not a pattern
 *              4 2 days logged: no row
 *              5 "no thanks": an answer, so 1 miss of the last 2: no
 *   This week  every value set to fire, but the week is not over: no rows
 * Signals 6-10 are proved on July weeks, described above their block.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { cleanupOnCrash } from './_cleanup.mts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_signals_v1';
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

const W1 = '2026-08-03', W2 = '2026-08-10', W3 = '2026-08-17';
const monday = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const NOW = monday(new Date());

await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({ clerk_user_id: UID, timezone: 'UTC' }), 'profile');

const card = (outcome: string, action: string, did: boolean | null) =>
  ({ c_card_id: randomUUID(), c_kind: 'request', c_action: action, c_outcome: outcome, c_followed_through: did, c_done_before_card: false });
must(await db.from('drona_week_facts').insert([
  { user_id: UID, week_start: W1,
    t_pick_days_trained: 3, t_pick_set_match: 0.39, t_plan_set_match: 0.50,
    t_plan_days: 7, t_planned_sessions: 5, t_sessions: 3,
    w_readings: 3, w_typical_swing_kg: 1.6, w_dropped_impossible: 0,
    f_days_logged: 4, f_days_under_half_target: 3, f_target_kcal: 2000, f_avg_kcal: 700,
    ...card('expired', 'start_session', false) },
  { user_id: UID, week_start: W2,
    t_pick_days_trained: 4, t_pick_set_match: 0.10, t_plan_set_match: 0.80,
    t_plan_days: 7, t_planned_sessions: 5, t_sessions: 3,
    w_readings: 2, w_typical_swing_kg: 1.5, w_dropped_impossible: 0,
    f_days_logged: 4, f_days_under_half_target: 2, f_target_kcal: 2000, f_avg_kcal: 1500,
    ...card('applied', 'log_weight', false) },
  { user_id: UID, week_start: W3,
    t_pick_days_trained: 1, t_pick_set_match: 0.10, t_plan_set_match: 0.90,
    t_plan_days: 7, t_planned_sessions: 5, t_sessions: 5,
    w_readings: 1, w_typical_swing_kg: null, w_dropped_impossible: 1,
    f_days_logged: 2, f_days_under_half_target: 2, f_target_kcal: 2000, f_avg_kcal: 400,
    ...card('dismissed', 'log_weight', false) },
  { user_id: UID, week_start: NOW,
    t_pick_days_trained: 4, t_pick_set_match: 0.10, t_plan_set_match: 0.90,
    t_plan_days: 7, t_planned_sessions: 5, t_sessions: 5,
    w_readings: 3, w_typical_swing_kg: 9, w_dropped_impossible: 0,
    f_days_logged: 4, f_days_under_half_target: 4, f_target_kcal: 2000, f_avg_kcal: 300 },
]), 'week facts');

const muscle = (week: string, parent: string, planned: number, done: number) =>
  ({ user_id: UID, week_start: week, muscle: parent, parent, plan_days: 7, planned_sets: planned, done_sets: done });
must(await db.from('drona_plan_muscle_week_facts').insert([
  muscle(W1, 'Hamstrings', 4, 1), muscle(W1, 'Calves', 3.9, 0), muscle(W1, 'Chest', 10, 5),
  muscle(W2, 'Hamstrings', 4, 2), muscle(W2, 'Calves', 5, 0),
  muscle(W3, 'Calves', 5, 1),
  muscle(NOW, 'Calves', 5, 0),
]), 'muscles');

must(await db.rpc('drona_rebuild_signals', { p_user_id: UID, p_from: W1, p_to: NOW }), 'rebuild');
const rows = must(await db.from('drona_signals').select('*').eq('user_id', UID), 'signals') as any[];
const s = (signal: string, week: string) => rows.find((r) => r.signal === signal && r.week_start === week);
const fired = (signal: string, week: string) => s(signal, week)?.fired;
const muscles = (week: string) => (s('muscle_left_out', week)?.detail?.muscles ?? []).map((m: any) => m.muscle);

ok('1 W1 fires at TODAY 39% / program 50%', fired('follows_split_not_today', W1) === true);
ok('1 W2 fires again: a pattern', fired('follows_split_not_today', W2) === true && s('follows_split_not_today', W2)?.pattern === true);
ok('1 W3 one training day on a pick: no row', s('follows_split_not_today', W3) === undefined);
ok('2 W1 Hamstrings only (Calves under 4 planned, Chest exactly half)', fired('muscle_left_out', W1) === true && JSON.stringify(muscles(W1)) === '["Hamstrings"]', muscles(W1));
ok('2 W2 Calves, a different muscle: not a pattern', JSON.stringify(muscles(W2)) === '["Calves"]' && s('muscle_left_out', W2)?.pattern === false, { m: muscles(W2), p: s('muscle_left_out', W2)?.pattern });
ok('2 W3 Calves again: a pattern', JSON.stringify(muscles(W3)) === '["Calves"]' && s('muscle_left_out', W3)?.pattern === true, { m: muscles(W3), p: s('muscle_left_out', W3)?.pattern });
ok('3 W1 jump 1.6 kg fires, W2 jump 1.5 kg does not', fired('scale_untrusted', W1) === true && fired('scale_untrusted', W2) === false);
ok('3 W3 one impossible reading fires, not a pattern', fired('scale_untrusted', W3) === true && s('scale_untrusted', W3)?.pattern === false);
ok('4 W1 3 of 4 under half fires, W2 2 of 4 does not', fired('logs_snack_not_day', W1) === true && fired('logs_snack_not_day', W2) === false);
ok('4 W3 2 days logged: no row', s('logs_snack_not_day', W3) === undefined);
ok('5 W1 only one finished card: no row', s('cards_not_landing', W1) === undefined);
ok('5 W2 expired then tapped-not-done: fires', fired('cards_not_landing', W2) === true);
ok('5 W3 a "no thanks" is an answer: does not fire', fired('cards_not_landing', W3) === false);
ok('this week is not over: no rows at all', rows.every((r) => r.week_start !== NOW), rows.filter((r) => r.week_start === NOW).map((r) => r.signal));
ok('every row carries rule version 1', rows.length > 0 && rows.every((r) => r.rule_version === 1), rows.length);

// ── Signals 6-10 (rule_version 1, 2026-10-16), on July weeks ─────────────────
//   A 6 Jul, B 13 Jul, C 20 Jul, D 27 Jul; 3 sessions a week before them.
//   6 weight 80.0, 80.0, 80.2, 80.4: the last 2 weeks moved +0.3 kg away from a
//     72.9 kg program target: fires at D (exactly the 0.3 line)
//   7 B: 3 of 4 whole days under 70% protein: fires. C: a snack week: no row
//   8 C: 1 of 4 sessions after 3 of 4: no. D: 0 of 4 after 1 of 4: fires
//   9 lift X 100, 105, 100 (no higher than 3 weeks back): stuck at D; lift Y
//     99, 100, 101, 102 climbs: never stuck; at C both climbed: no
//  10 C: goal weights 75 vs 73.0 (exactly 2 kg): no. D: 75 vs 72.9: fires
const A = '2026-07-06', B = '2026-07-13', C = '2026-07-20', D = '2026-07-27';
const prog = randomUUID();
const wk = (week: string, o: Record<string, unknown>) => ({ user_id: UID, week_start: week, t_planned_sessions: 4, ...o });
must(await db.from('drona_week_facts').insert([
  wk('2026-06-22', { t_sessions: 3 }), wk('2026-06-29', { t_sessions: 3 }),
  wk(A, { t_sessions: 3, w_readings: 2, w_avg_kg: 80.0, w_typical_swing_kg: 0.2, w_dropped_impossible: 0 }),
  wk(B, { t_sessions: 3, w_readings: 2, w_avg_kg: 80.0, w_typical_swing_kg: 0.2, w_dropped_impossible: 0,
          f_days_logged: 4, f_days_under_half_target: 0, f_target_kcal: 2000 }),
  wk(C, { t_sessions: 1, w_readings: 2, w_avg_kg: 80.2, w_typical_swing_kg: 0.2, w_dropped_impossible: 0,
          f_days_logged: 4, f_days_under_half_target: 4, f_target_kcal: 2000,
          p_program_id: prog, p_goal: 'hypertrophy', p_program_goal: 'hypertrophy', p_goal_weight_kg: 75, p_program_target_kg: 73.0 }),
  wk(D, { t_sessions: 0, w_readings: 2, w_avg_kg: 80.4, w_typical_swing_kg: 0.2, w_dropped_impossible: 0,
          p_program_id: prog, p_goal: 'hypertrophy', p_program_goal: 'hypertrophy', p_goal_weight_kg: 75, p_program_target_kg: 72.9 }),
]), 'july weeks');
const dayFact = (day: string, protein: number) => ({ user_id: UID, day, entries: 3, protein_g: protein, target_protein_g: 100 });
must(await db.from('drona_day_facts').insert([
  dayFact('2026-07-13', 60), dayFact('2026-07-14', 60), dayFact('2026-07-15', 60), dayFact('2026-07-16', 90),
  dayFact('2026-07-20', 10), dayFact('2026-07-21', 10), dayFact('2026-07-22', 10), dayFact('2026-07-23', 10),
]), 'day facts');
const X = randomUUID(), Y = randomUUID();
const lift = (id: string, name: string, week: string, e1rm: number) => ({ user_id: UID, week_start: week, exercise_id: id, exercise_name: name, best_e1rm_kg: e1rm });
must(await db.from('drona_exercise_week_facts').insert([
  lift(X, 'Lift X', A, 100), lift(X, 'Lift X', B, 100), lift(X, 'Lift X', C, 105), lift(X, 'Lift X', D, 100),
  lift(Y, 'Lift Y', A, 99), lift(Y, 'Lift Y', B, 100), lift(Y, 'Lift Y', C, 101), lift(Y, 'Lift Y', D, 102),
]), 'lifts');

must(await db.rpc('drona_rebuild_signals', { p_user_id: UID, p_from: '2026-06-22', p_to: NOW }), 'rebuild 2');
const rows2 = must(await db.from('drona_signals').select('*').eq('user_id', UID), 'signals 2') as any[];
const s2 = (signal: string, week: string) => rows2.find((r) => r.signal === signal && r.week_start === week);

ok('6 D: +0.3 kg away from a 72.9 kg program target fires', s2('weight_wrong_way', D)?.fired === true
  && Number(s2('weight_wrong_way', D)?.detail?.change_kg) === 0.3 && s2('weight_wrong_way', D)?.detail?.goal_from === 'program',
  s2('weight_wrong_way', D)?.detail);
ok('7 B: 3 of 4 whole days under 70% protein fires', s2('protein_short', B)?.fired === true, s2('protein_short', B)?.detail);
ok('7 C: a snack week is not judged for protein', s2('protein_short', C) === undefined);
ok('8 C: one low week after a normal one does not fire', s2('training_dropped', C)?.fired === false);
ok('8 D: two low weeks after training fires', s2('training_dropped', D)?.fired === true, s2('training_dropped', D)?.detail);
ok('9 C: both lifts climbed, not stuck', s2('lift_stuck', C)?.fired === false);
ok('9 D: Lift X (100 then 105 then 100) is stuck, Lift Y is not', s2('lift_stuck', D)?.fired === true
  && JSON.stringify((s2('lift_stuck', D)?.detail?.lifts ?? []).map((l: any) => l.exercise)) === '["Lift X"]', s2('lift_stuck', D)?.detail);
ok('10 C: goal weights exactly 2 kg apart do not fire', s2('goals_disagree', C)?.fired === false);
ok('10 D: 2.1 kg apart fires', s2('goals_disagree', D)?.fired === true);

// ── Null paths (PR #253 review, 2026-10-18) ────────────────────────────────
//   E 7 Sep: a protein target but no calorie target, 3 days at half the protein:
//     the snack-week test cannot be judged, which must not drop the week
//   F 14 Sep: planned 4, sessions unknown: training_dropped is not fired, and
//     one empty count must not abort the whole rebuild
const E = '2026-09-07', F = '2026-09-14';
must(await db.from('drona_week_facts').insert([
  { user_id: UID, week_start: E, t_planned_sessions: 4, t_sessions: 1, f_days_logged: 3, f_days_under_half_target: null, f_target_kcal: null },
  { user_id: UID, week_start: F, t_planned_sessions: 4, t_sessions: null },
]), 'null weeks');
must(await db.from('drona_day_facts').insert(['2026-09-07', '2026-09-08', '2026-09-09'].map((day) =>
  ({ user_id: UID, day, entries: 2, protein_g: 50, target_protein_g: 100 }))), 'null days');
const nullRun = await db.rpc('drona_rebuild_signals', { p_user_id: UID, p_from: E, p_to: F });
ok('an unknown session count does not abort the rebuild', !nullRun.error, nullRun.error?.message);
const rows3 = must(await db.from('drona_signals').select('*').eq('user_id', UID), 'signals 3') as any[];
const s3 = (signal: string, week: string) => rows3.find((r) => r.signal === signal && r.week_start === week);
ok('7 E: no calorie target is not a snack week: protein judged, and short', s3('protein_short', E)?.fired === true, s3('protein_short', E)?.detail);
ok('8 F: sessions unknown: judged, not fired', s3('training_dropped', F)?.fired === false, s3('training_dropped', F));

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_signals').select('signal').eq('user_id', UID), 'cleanup') as any[];
ok('delete_user_data removed every signal row', left.length === 0, left.length);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
if (fails > 0) process.exitCode = 1;
