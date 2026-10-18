/**
 * Proves the eight maths behaviours (drona_behaviours) and the weekly pick
 * (drona_behaviour_pick) on a made-up person. Signals and week facts are
 * written directly, each set just inside or just outside a line, then
 * drona_rebuild_behaviours runs. LIVE database, made-up user id, deleted after.
 *
 *   npx tsx scripts/drona-facts/behaviours.mts
 *
 *   W1 3 Aug   scale fired once (no pattern): nothing. Snack logging a pattern:
 *              logs_partial_days. Cards not landing: not_hearing_drona (meta),
 *              so the pick is logs_partial_days said as a notice, muting protein.
 *   W2 10 Aug  scale a pattern and goals a pattern: both rows, the scale wins
 *              the pick (priority 10 before 20) and mutes weight_wrong_way.
 *   W3 17 Aug  training dropped, a pattern, but they wrote 1 chat message last
 *              week: no drifting_away. Own way a pattern: own_way, with the
 *              muscles left out in W2 and W3 (Calves, Hamstrings).
 *   W4 24 Aug  training dropped again, 0 messages both weeks (one week empty):
 *              drifting_away. Lifts X and Y stuck now, only X last week:
 *              lift_stall with X only; 3 of 4 sessions (exactly 0.75): real_plateau.
 *   W5 31 Aug  every signal looked, nothing fired, 4 of 4 sessions: on_track.
 *   W6 7 Sep   3 of 4 sessions: not on_track. W7 14 Sep: 0 planned: not on_track.
 *   This week  set to fire, not over: no rows.
 *
 *   The lift_stall causes, on a chain of stuck weeks from 1 Jun:
 *   L1 snack logging last week AND a fat-loss program: cant_tell (it is first)
 *   L2 program target 79.5 at 80 kg (exactly 0.5 under, not more), sleep 360
 *      (not under), 2 of 4 sessions: inconsistent_training
 *   L3 program target 79.4 at 80 kg: expected_on_cut
 *   L4 sleep 359 minutes: recovery
 *   L5 2 low-readiness days: recovery
 *   L6 3 of 4 sessions: real_plateau
 *   L7 protein short this week, 3 of 4 sessions: under_fuelled (before plateau)
 *   L8 stuck, but a different lift from last week: no lift_stall
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { cleanupOnCrash } from './_cleanup.mts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_behaviours_v1';
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

const W1 = '2026-08-03', W2 = '2026-08-10', W3 = '2026-08-17', W4 = '2026-08-24', W5 = '2026-08-31', W6 = '2026-09-07', W7 = '2026-09-14';
const L = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'];
const monday = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const NOW = monday(new Date());
const X = randomUUID(), Y = randomUUID();
const lifts = (...ids: string[]) => ({ lifts: ids.map((id) => ({ exercise_id: id })) });

await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({ clerk_user_id: UID, timezone: 'UTC' }), 'profile');

const wk = (week: string, o: Record<string, unknown> = {}) => ({ user_id: UID, week_start: week, t_planned_sessions: 4, t_sessions: 2, ...o });
must(await db.from('drona_week_facts').insert([
  wk(W1), wk(W2, { wd_chat_messages: 1 }), wk(W3, { wd_chat_messages: 0 }), wk(W4, { t_sessions: 3 }),
  wk(W5, { t_sessions: 4 }), wk(W6, { t_sessions: 3 }), wk(W7, { t_planned_sessions: 0, t_sessions: 0 }),
  wk(NOW, { t_sessions: 4 }),
  wk(L[0]),
  wk(L[1], { p_program_goal: 'fat_loss' }),
  wk(L[2], { p_program_target_kg: 79.5, w_avg_kg: 80, r_sleep_avg_min: 360, r_readiness_low_days: 1 }),
  wk(L[3], { p_program_target_kg: 79.4, w_avg_kg: 80 }),
  wk(L[4], { r_sleep_avg_min: 359 }),
  wk(L[5], { r_readiness_low_days: 2 }),
  wk(L[6], { t_sessions: 3 }),
  wk(L[7], { t_sessions: 3 }),
  wk(L[8], { t_sessions: 3 }),
]), 'week facts');

const sig = (week: string, signal: string, fired: boolean, pattern = false, detail: object = {}) =>
  ({ user_id: UID, week_start: week, signal, fired, pattern, detail, rule_version: 1 });
must(await db.from('drona_signals').insert([
  sig(W1, 'scale_untrusted', true), sig(W1, 'logs_snack_not_day', true, true), sig(W1, 'cards_not_landing', true),
  sig(W2, 'scale_untrusted', true, true), sig(W2, 'goals_disagree', true, true),
  sig(W2, 'muscle_left_out', true, false, { muscles: [{ muscle: 'Calves' }] }),
  sig(W3, 'training_dropped', true, true), sig(W3, 'follows_split_not_today', true, true),
  sig(W3, 'muscle_left_out', true, false, { muscles: [{ muscle: 'Hamstrings' }] }),
  sig(W3, 'lift_stuck', true, false, lifts(X)),
  sig(W4, 'training_dropped', true, true), sig(W4, 'lift_stuck', true, true, lifts(X, Y)),
  sig(W5, 'scale_untrusted', false), sig(W5, 'lift_stuck', false, false, lifts()),
  sig(NOW, 'scale_untrusted', true, true), sig(NOW, 'goals_disagree', true, true),
  sig(L[0], 'lift_stuck', true, false, lifts(X)), sig(L[0], 'logs_snack_not_day', true),
  ...L.slice(1, 8).map((w) => sig(w, 'lift_stuck', true, true, lifts(X))),
  sig(L[7], 'protein_short', true),
  sig(L[8], 'lift_stuck', true, true, lifts(Y)),
]), 'signals');

must(await db.rpc('drona_rebuild_behaviours', { p_user_id: UID, p_from: L[0], p_to: NOW }), 'rebuild');
const rows = must(await db.from('drona_behaviours').select('*').eq('user_id', UID), 'behaviours') as any[];
const picks = must(await db.from('drona_behaviour_pick').select('*').eq('user_id', UID), 'pick') as any[];
const at = (week: string) => rows.filter((r) => r.week_start === week).map((r) => r.behaviour).sort();
const row = (week: string, b: string) => rows.find((r) => r.week_start === week && r.behaviour === b);
const pick = (week: string) => picks.find((p) => p.week_start === week);
const cause = (week: string) => row(week, 'lift_stall')?.detail?.cause;

ok('W1 scale once is not a pattern; snack + cards land', JSON.stringify(at(W1)) === '["logs_partial_days","not_hearing_drona"]', at(W1));
ok('W1 the meta is never the pick; the pick is said as a notice and mutes protein',
  pick(W1)?.behaviour === 'logs_partial_days' && pick(W1)?.card_kind === 'notice' && JSON.stringify(pick(W1)?.mutes) === '["protein_short"]', pick(W1));
ok('W2 scale and goals both land', JSON.stringify(at(W2)) === '["goals_unclear","scale_untrusted"]', at(W2));
ok('W2 the scale wins the pick, a request, muting weight', pick(W2)?.behaviour === 'scale_untrusted' && pick(W2)?.card_kind === 'request' && JSON.stringify(pick(W2)?.mutes) === '["weight_wrong_way"]', pick(W2));
ok('W3 one chat message last week: no drifting_away', !at(W3).includes('drifting_away'), at(W3));
ok('W3 own_way carries both muscles left out', JSON.stringify([...(row(W3, 'own_way')?.detail?.muscles_left_out ?? [])].sort()) === '["Calves","Hamstrings"]', row(W3, 'own_way')?.detail);
ok('W4 silent both weeks (one week empty): drifting_away', row(W4, 'drifting_away')?.detail?.said_nothing === true);
ok('W4 lift_stall keeps only the lift stuck both weeks',
  JSON.stringify((row(W4, 'lift_stall')?.detail?.lifts ?? []).map((l: any) => l.exercise_id)) === JSON.stringify([X]), row(W4, 'lift_stall')?.detail);
ok('W4 3 of 4 sessions (exactly 0.75): real_plateau', cause(W4) === 'real_plateau', cause(W4));
ok('W5 looked, nothing fired, 4 of 4: on_track only', JSON.stringify(at(W5)) === '["on_track"]' && pick(W5)?.card_kind === 'notice', at(W5));
ok('W6 3 of 4 is not on_track; W7 0 planned is not on_track', at(W6).length === 0 && at(W7).length === 0, { w6: at(W6), w7: at(W7) });
ok('this week is not over: no rows', at(NOW).length === 0, at(NOW));
ok('L1 snack logging comes first, even on a cut', cause(L[1]) === 'cant_tell', cause(L[1]));
ok('L2 target exactly 0.5 under, sleep 360, 2 of 4: inconsistent_training', cause(L[2]) === 'inconsistent_training', cause(L[2]));
ok('L3 target 0.6 under: expected_on_cut', cause(L[3]) === 'expected_on_cut', cause(L[3]));
ok('L4 sleep 359: recovery', cause(L[4]) === 'recovery', cause(L[4]));
ok('L5 2 low-readiness days: recovery', cause(L[5]) === 'recovery', cause(L[5]));
ok('L6 3 of 4 sessions: real_plateau', cause(L[6]) === 'real_plateau', cause(L[6]));
ok('L7 protein short beats plateau: under_fuelled', cause(L[7]) === 'under_fuelled', cause(L[7]));
ok('L8 a different lift from last week: no lift_stall', row(L[8], 'lift_stall') === undefined, at(L[8]));
ok('L0 stuck once, no pattern: no lift_stall', row(L[0], 'lift_stall') === undefined, at(L[0]));
ok('every row carries rule version 1', rows.length > 0 && rows.every((r) => r.rule_version === 1), rows.length);

must(await db.rpc('delete_user_data', { p_user_id: UID }), 'delete');
const left = must(await db.from('drona_behaviours').select('week_start').eq('user_id', UID), 'left') as any[];
ok('delete_user_data removes the behaviours', left.length === 0, left.length);
await db.from('user_profiles').delete().eq('clerk_user_id', UID);

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
if (fails) process.exitCode = 1;
