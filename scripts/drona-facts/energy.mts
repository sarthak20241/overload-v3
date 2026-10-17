/**
 * Proves the adaptive maintenance engine (drona_rebuild_energy_facts) on a
 * made-up person in UTC, every number worked by hand. LIVE database, made-up
 * user id, deleted after.
 *
 *   npx tsx scripts/drona-facts/energy.mts
 *
 * The person: male, 180 cm, born 1 Jan 1996 (30), 3 planned sessions a week.
 * Formula: 10 x 80 + 6.25 x 180 - 5 x 30 + 5 = 1780 resting, x 1.4 = 2492 -> 2500.
 * They weigh in every morning at exactly 80.0 and eat exactly 2000 kcal a day
 * (target 2200). The truth is 2000; the formula says 2500.
 *
 *   W1 1 Jun   7 weigh-ins over 6 days: no rate yet. Estimate = the guess, 2500
 *   W2 8 Jun   13 days: still no rate (14 needed). 2500, guess
 *   W3 15 Jun  20 days, 21 whole days: data weight 0.95, observed 2000.
 *              Half the gap x 0.95 = -238, capped at -150: 2350, learning
 *   W4 22 Jun  full data: -175 capped -150: 2200
 *   W5 29 Jun  -100: 2100
 *   W6 6 Jul   a 90 kg reading on 8 Jul is an outlier: the trend stays 80,
 *              1 outlier, 27 kept. -50: 2050, 3.95 data weeks: measured
 *   W7 13 Jul  -25: 2025
 *   W8 20 Jul  from 20 Jul the scale reads 85 and stays there. The second 85
 *              confirms the first: the trend restarts at 85, and a restart is
 *              a new level, not 5 kg of gain. 6 days since: no rate, no step,
 *              the estimate holds at 2025
 * Then get_drona_energy_facts, as the card worker calls it: the person has no
 * facts run today, so it rebuilds them and records the run.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { cleanupOnCrash } from './_cleanup.mts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_energy_v1';
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
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};
const W = ['', '2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20'];

await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({
  clerk_user_id: UID, timezone: 'UTC', gender: 'M', height_cm: 180, date_of_birth: '1996-01-01', weight_kg: 80, weekly_target_sessions: 3,
}), 'profile');
must(await db.from('daily_metrics').insert(days('2026-06-01', '2026-07-31').map((d) => ({
  user_id: UID, metric_date: d, metric_type: 'bodyweight_kg', unit: 'kg', source: 'manual',
  value: d === '2026-07-08' ? 90 : d >= '2026-07-20' ? 85 : 80,
}))), 'weights');
must(await db.from('drona_day_facts').insert(days('2026-06-01', '2026-07-31').map((d) => ({
  user_id: UID, day: d, kcal: 2000, protein_g: 150, entries: 3, target_kcal: 2200,
}))), 'food');

must(await db.rpc('drona_rebuild_energy_facts', { p_user_id: UID, p_from: W[1], p_to: W[8] }), 'rebuild');
const rows = must(await db.from('drona_week_facts').select('*').eq('user_id', UID).order('week_start'), 'read') as any[];
const w = (i: number) => rows.find((r) => r.week_start === W[i]);
const num = (v: unknown) => (v == null ? null : Number(v));
const pick = (i: number) => { const r = w(i); return r && [r.m_estimate_kcal, r.m_step_kcal, r.m_source]; };

ok('W1 the formula guess: 2500, nothing learned', JSON.stringify(pick(1)) === '[2500,0,"guess"]' && w(1).m_guess_kcal === 2500 && w(1).m_bmr_kcal === 1780, [pick(1), w(1).m_bmr_kcal]);
ok('W1 7 weigh-ins over 6 days: no rate', w(1).m_readings_28 === 7 && w(1).m_span_days === 6 && w(1).m_trend_rate_kg_per_week === null);
ok('W2 13 days: still no rate, still the guess', JSON.stringify(pick(2)) === '[2500,0,"guess"]' && w(2).m_trend_rate_kg_per_week === null);
ok('W3 data weight 0.95, observed 2000, the step capped at 150', JSON.stringify(pick(3)) === '[2350,-150,"learning"]'
  && num(w(3).m_data_weight) === 0.95 && w(3).m_observed_kcal === 2000 && num(w(3).m_trend_rate_kg_per_week) === 0, [pick(3), w(3).m_data_weight]);
ok('W4 capped again: 2200', JSON.stringify(pick(4)) === '[2200,-150,"learning"]', pick(4));
ok('W5 half the gap: 2100', JSON.stringify(pick(5)) === '[2100,-100,"learning"]', pick(5));
ok('W6 the 90 kg reading is an outlier: trend 80, 27 kept, 1 out', num(w(6).m_trend_kg) === 80 && w(6).m_readings_28 === 27 && w(6).m_outliers_28 === 1, [w(6).m_trend_kg, w(6).m_readings_28, w(6).m_outliers_28]);
ok('W6 2050, 3.95 data weeks: measured', JSON.stringify(pick(6)) === '[2050,-50,"measured"]' && num(w(6).m_data_weeks) === 3.95, [pick(6), w(6).m_data_weeks]);
ok('W7 2025', JSON.stringify(pick(7)) === '[2025,-25,"measured"]', pick(7));
ok('W8 the scale moved to 85 and stayed: the trend restarts at 85', num(w(8).m_trend_kg) === 85, w(8).m_trend_kg);
ok('W8 a new level is not a rate: no step, the estimate holds', w(8).m_trend_rate_kg_per_week === null && JSON.stringify(pick(8)) === '[2025,0,"measured"]', [w(8).m_trend_rate_kg_per_week, pick(8)]);

// The card worker's read. No facts run exists for this person, so it rebuilds first.
const facts = must(await db.rpc('get_drona_energy_facts', { p_user_id: UID, p_as_of: '2026-07-29' }), 'energy facts') as any;
const run = must(await db.from('drona_facts_runs').select('last_day_done').eq('user_id', UID).maybeSingle(), 'run') as any;
ok('the card read rebuilt the facts first and recorded the run', run?.last_day_done === '2026-07-29', run);
ok('the card read names last week and carries the targets slot and behaviours list',
  facts?.week_start === '2026-07-20' && Array.isArray(facts?.behaviours) && 'targets' in facts, facts && { week: facts.week_start, n: facts.behaviours?.length });

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_week_facts').select('user_id').eq('user_id', UID), 'left') as any[];
ok('delete_user_data cleans up', left.length === 0, left.length);

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
if (fails) process.exitCode = 1;
