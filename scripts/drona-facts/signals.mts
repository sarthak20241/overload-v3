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

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_signals').select('signal').eq('user_id', UID), 'cleanup') as any[];
ok('delete_user_data removed every signal row', left.length === 0, left.length);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
if (fails > 0) process.exitCode = 1;
