/**
 * Proves the cards facts (0147 + 0148) on a made-up person whose every answer
 * is worked out by hand below. Runs against LIVE with a made-up user id, then
 * deletes it.
 *
 *   npx tsx scripts/drona-facts/cards.mts
 *
 * Timezone UTC. One card a week:
 *   W1 31 Aug  request log_weight, made 1 Sep 08:00, tapped 10:00 (2.0 h).
 *              A weigh-in dated 31 Aug synced 1 Sep 09:00: done before the card.
 *              A weigh-in on 2 Sep 07:00: followed through, 23.0 h after.
 *   W2 7 Sep   request start_session, made 8 Sep 06:00, Later at 12:00 (6.0 h),
 *              never answered: pending past its expiry = expired. The workout
 *              came on 15 Sep, the NEXT week: not followed through.
 *   W3 14 Sep  act apply_targets, answered after 1.0 h, then undone; one diary
 *              row carries its card id. No test: followed through is null.
 *   W4 21 Sep  a hold: never shown.
 * Running totals: W2 shown 2, answered 1, Later 1, ignored 1.
 *                 W4 shown 3, answered 2, Later 1, ignored 1, holds 1.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_card_facts_0147';
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

await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({ clerk_user_id: UID, timezone: 'UTC' }), 'profile');

const card = (o: Record<string, unknown>) => ({ user_id: UID, source: 'cron', title: 't', body: 'b', signals: ['probe'], ...o });
const cards = must(await db.from('drona_cards').insert([
  card({ week_start: '2026-08-31', kind: 'request', topic: 'weigh_in', payload: { action: 'log_weight' }, status: 'applied',
    created_at: '2026-09-01T08:00:00Z', decided_at: '2026-09-01T10:00:00Z' }),
  card({ week_start: '2026-09-07', kind: 'request', topic: 'due_session', payload: { action: 'start_session' }, status: 'pending',
    created_at: '2026-09-08T06:00:00Z', deferred_at: '2026-09-08T12:00:00Z', expires_at: '2026-09-14T00:00:00Z' }),
  card({ week_start: '2026-09-14', kind: 'act', topic: 'calories', payload: { action: 'apply_targets' }, status: 'undone',
    created_at: '2026-09-15T06:00:00Z', decided_at: '2026-09-15T07:00:00Z' }),
  card({ week_start: '2026-09-21', kind: 'hold', topic: 'calories', title: '', body: '', payload: {}, status: 'held',
    created_at: '2026-09-22T06:00:00Z' }),
]).select('id, week_start'), 'cards') as any[];
const actCard = cards.find((c) => c.week_start === '2026-09-14').id;

must(await db.from('daily_metrics').insert([
  { user_id: UID, metric_date: '2026-08-31', metric_type: 'bodyweight_kg', value: 80, source: 'manual', updated_at: '2026-09-01T09:00:00Z' },
  { user_id: UID, metric_date: '2026-09-02', metric_type: 'bodyweight_kg', value: 79.8, source: 'manual', updated_at: '2026-09-02T07:00:00Z' },
]), 'weights');
must(await db.from('workouts').insert({ user_id: UID, name: 'late', started_at: '2026-09-15T08:00:00Z', finished_at: '2026-09-15T09:00:00Z' }), 'workout');
must(await db.from('plan_changes').delete().eq('user_id', UID), 'clear diary');
must(await db.from('plan_changes').insert({ user_id: UID, occurred_at: '2026-09-15T07:00:00Z', updated_at: '2026-09-15T07:00:00Z',
  entity: 'targets', action: 'changed', source: 'card', card_id: actCard, changes: { daily_calorie_target: { from: 2000, to: 1900 } } }), 'diary');

must(await db.rpc('drona_rebuild_card_facts', { p_user_id: UID, p_from: '2026-08-31', p_to: '2026-09-21' }), 'rebuild');
const wk = must(await db.from('drona_week_facts').select('*').eq('user_id', UID).order('week_start'), 'weeks') as any[];
const w = (d: string) => wk.find((r) => r.week_start === d);
const w1 = w('2026-08-31'), w2 = w('2026-09-07'), w3 = w('2026-09-14'), w4 = w('2026-09-21');

ok('W1: tapped after 2.0 h, followed through 23.0 h after the card', w1?.c_outcome === 'applied' && num(w1?.c_hours_to_answer) === 2
  && w1?.c_followed_through === true && num(w1?.c_hours_to_follow) === 23,
  { out: w1?.c_outcome, ans: w1?.c_hours_to_answer, fol: w1?.c_followed_through, h: w1?.c_hours_to_follow });
ok('W1: a weigh-in dated before the card, synced after: done before the card', w1?.c_done_before_card === true, w1?.c_done_before_card);
ok('W2: Later after 6.0 h, then never answered: expired, status still pending', w2?.c_deferred === true && num(w2?.c_hours_to_later) === 6
  && w2?.c_status === 'pending' && w2?.c_outcome === 'expired',
  { later: w2?.c_deferred, h: w2?.c_hours_to_later, status: w2?.c_status, out: w2?.c_outcome });
ok('W2: the workout came the next week: not followed through', w2?.c_followed_through === false, w2?.c_followed_through);
ok('W3: undone, 1 diary row, no test so followed through is null', w3?.c_outcome === 'undone' && w3?.c_plan_changes === 1 && w3?.c_followed_through === null,
  { out: w3?.c_outcome, changes: w3?.c_plan_changes, fol: w3?.c_followed_through });
ok('W4: a hold was never shown', w4?.c_kind === 'hold' && w4?.c_seen_possible === false, [w4?.c_kind, w4?.c_seen_possible]);
ok('W2 totals: shown 2, answered 1, Later 1, ignored 1', w2?.c_cards_to_date === 2 && w2?.c_answered_to_date === 1 && w2?.c_later_to_date === 1 && w2?.c_ignored_to_date === 1,
  [w2?.c_cards_to_date, w2?.c_answered_to_date, w2?.c_later_to_date, w2?.c_ignored_to_date]);
ok('W4 totals: shown 3, answered 2, Later 1, ignored 1, holds 1', w4?.c_cards_to_date === 3 && w4?.c_answered_to_date === 2 && w4?.c_later_to_date === 1
  && w4?.c_ignored_to_date === 1 && w4?.c_holds_to_date === 1,
  [w4?.c_cards_to_date, w4?.c_answered_to_date, w4?.c_later_to_date, w4?.c_ignored_to_date, w4?.c_holds_to_date]);

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_week_facts').select('week_start').eq('user_id', UID), 'cleanup') as any[];
ok('delete_user_data removed every week row', left.length === 0, left.length);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
if (fails > 0) process.exitCode = 1;
