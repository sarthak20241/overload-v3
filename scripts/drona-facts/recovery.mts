/**
 * Proves the recovery facts (0142) on a made-up person whose every answer is
 * worked out by hand below. Runs against LIVE with a made-up user id, then
 * deletes it.
 *
 *   npx tsx scripts/drona-facts/recovery.mts
 *
 * Timezone Asia/Kolkata (UTC+5:30), so "partial" must be judged on the LOCAL
 * day the steps were last written, not the UTC day.
 *
 * Week A, Mon 31 Aug:
 *   sleep 420, 480                       -> 2 nights, avg 450
 *   steps d0 6000 written next day       -> complete
 *         d1 8000 written 23:00 same day -> partial, left out
 *         d2 0                           -> zero, left out
 *   readiness d0 50
 * Week B, Mon 7 Sep:
 *   sleep d7 360 (manual), d8 1382 (23 h, implausible), d9 600
 *         -> 2 nights, avg 480, min 360, max 600, stddev 170, 1 implausible, +30 vs A
 *   quality d7 2, d9 4                   -> 2 days, avg 3.0
 *   steps d7 10000 written 19:00 UTC = 00:30 NEXT local day -> complete
 *                  (a UTC reading would call it partial: the timezone trap)
 *         d8 4000 written 23:30 local same day              -> partial
 *         d9 12000 written two days later                   -> complete
 *         -> 2 days, avg 11000, min 10000, max 12000, 1 partial, +5000 vs A
 *   readiness 35, 70, 30                 -> avg 45, min 30, max 70, 2 low (< 40), -5 vs A
 *   resting HR d7 60, d8 200 (dropped)   -> 1 day, avg 60
 *   HRV d9 55, active kcal 400 and 600   -> avg 55, avg 500
 *   dropped in week B: sleep d8 + HR d8  = 2
 * Week C, Mon 14 Sep (0143, the log form prefills yesterday's sleep, else 8 h):
 *   d14 manual 480, no night before      -> equals the prefill
 *   d15 manual 480, the night before 480 -> equals the prefill
 *   d16 manual 450                       -> does not
 *   and d7 manual 360 (no d6) does not; a healthkit night is never "prefill"
 *   -> week C: 2 prefill nights, week B: 0
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_recovery_0142';
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

const A = '2026-08-31', B = '2026-09-07', C = '2026-09-14';
const day = (n: number) => new Date(Date.parse(`${A}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// A local IST time on day n, as a UTC timestamp.
const ist = (n: number, hh: number, mm = 0) => new Date(Date.parse(`${day(n)}T00:00:00Z`) + ((hh * 60 + mm) - 330) * 60_000).toISOString();

await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({ clerk_user_id: UID, timezone: 'Asia/Kolkata' }), 'profile');

type Row = [number, string, number, string, string];  // day, type, value, source, updated_at
const rows: Row[] = [
  [0, 'sleep_minutes', 420, 'healthkit', ist(0, 9)],
  [1, 'sleep_minutes', 480, 'healthkit', ist(1, 9)],
  [0, 'steps', 6000, 'healthkit', ist(1, 10)],
  [1, 'steps', 8000, 'healthkit', ist(1, 23)],
  [2, 'steps', 0, 'healthkit', ist(4, 10)],
  [0, 'readiness_score', 50, 'manual', ist(0, 9)],

  [7, 'sleep_minutes', 360, 'manual', ist(7, 8)],
  [8, 'sleep_minutes', 1382, 'health_connect', ist(8, 8)],
  [9, 'sleep_minutes', 600, 'health_connect', ist(9, 8)],
  [7, 'sleep_quality', 2, 'manual', ist(7, 8)],
  [9, 'sleep_quality', 4, 'manual', ist(9, 8)],
  [7, 'steps', 10000, 'healthkit', '2026-09-07T19:00:00Z'],
  [8, 'steps', 4000, 'healthkit', ist(8, 23, 30)],
  [9, 'steps', 12000, 'healthkit', ist(11, 9)],
  [7, 'readiness_score', 35, 'manual', ist(7, 8)],
  [8, 'readiness_score', 70, 'manual', ist(8, 8)],
  [9, 'readiness_score', 30, 'manual', ist(9, 8)],
  [7, 'resting_hr_bpm', 60, 'healthkit', ist(7, 8)],
  [8, 'resting_hr_bpm', 200, 'healthkit', ist(8, 8)],
  [9, 'hrv_sdnn_ms', 55, 'healthkit', ist(9, 8)],
  [7, 'active_energy_kcal', 400, 'healthkit', ist(8, 8)],
  [9, 'active_energy_kcal', 600, 'healthkit', ist(10, 8)],

  [14, 'sleep_minutes', 480, 'manual', ist(14, 8)],
  [15, 'sleep_minutes', 480, 'manual', ist(15, 8)],
  [16, 'sleep_minutes', 450, 'manual', ist(16, 8)],
];
must(await db.from('daily_metrics').insert(rows.map(([n, t, v, s, u]) => ({ user_id: UID, metric_date: day(n), metric_type: t, value: v, source: s, updated_at: u }))), 'metrics');
must(await db.rpc('drona_rebuild_recovery_facts', { p_user_id: UID, p_from: A, p_to: C }), 'rebuild');

const days = must(await db.from('drona_recovery_day_facts').select('*').eq('user_id', UID).order('day'), 'days') as any[];
const d = (n: number) => days.find((r) => r.day === day(n));
ok('d1 steps written 23:00 the same day are partial', d(1)?.steps_partial === true, d(1)?.steps_partial);
ok('d7 steps written 00:30 the NEXT local day are complete (UTC would say partial)', d(7)?.steps_partial === false, d(7)?.steps_partial);
ok('d2 zero steps are flagged zero', d(2)?.steps_zero === true && d(2)?.steps === 0);
ok('d8 23 h of sleep is kept on the day and flagged', d(8)?.sleep_min === 1382 && d(8)?.sleep_ok === false);
ok('d8 resting HR 200 is dropped and named', d(8)?.rhr_bpm === null && JSON.stringify(d(8)?.dropped) === JSON.stringify(['sleep', 'rhr']), d(8)?.dropped);

ok('prefill: d14 480 with no night before, d15 480 after 480', d(14)?.sleep_matches_prefill === true && d(15)?.sleep_matches_prefill === true,
  [d(14)?.sleep_matches_prefill, d(15)?.sleep_matches_prefill]);
ok('not prefill: d16 450, d7 360 manual; a healthkit night is null', d(16)?.sleep_matches_prefill === false && d(7)?.sleep_matches_prefill === false && d(0)?.sleep_matches_prefill === null,
  [d(16)?.sleep_matches_prefill, d(7)?.sleep_matches_prefill, d(0)?.sleep_matches_prefill]);

const wk = must(await db.from('drona_week_facts').select('*').eq('user_id', UID).order('week_start'), 'weeks') as any[];
const wa = wk.find((r) => r.week_start === A), wb = wk.find((r) => r.week_start === B);
ok('A: 2 nights, avg 450', wa?.r_sleep_nights === 2 && wa?.r_sleep_avg_min === 450, { n: wa?.r_sleep_nights, avg: wa?.r_sleep_avg_min });
ok('A: 1 complete step day (6000), 1 partial, 1 zero', wa?.r_steps_days === 1 && wa?.r_steps_avg === 6000 && wa?.r_steps_partial_days === 1 && wa?.r_steps_zero_days === 1,
  { days: wa?.r_steps_days, avg: wa?.r_steps_avg, partial: wa?.r_steps_partial_days, zero: wa?.r_steps_zero_days });
ok('B: 2 nights, avg 480, 360..600, stddev 170, 1 implausible', wb?.r_sleep_nights === 2 && wb?.r_sleep_avg_min === 480 && wb?.r_sleep_min_min === 360
  && wb?.r_sleep_max_min === 600 && wb?.r_sleep_stddev_min === 170 && wb?.r_sleep_implausible === 1,
  { n: wb?.r_sleep_nights, avg: wb?.r_sleep_avg_min, min: wb?.r_sleep_min_min, max: wb?.r_sleep_max_min, sd: wb?.r_sleep_stddev_min, bad: wb?.r_sleep_implausible });
ok('B: sleep sources are health_connect and manual', JSON.stringify([...(wb?.r_sleep_sources ?? [])].sort()) === '["health_connect","manual"]', wb?.r_sleep_sources);
ok('B: quality 2 days, avg 3.0', wb?.r_sleep_quality_days === 2 && num(wb?.r_sleep_quality_avg) === 3, { d: wb?.r_sleep_quality_days, avg: wb?.r_sleep_quality_avg });
ok('B: steps 2 days, avg 11000, 10000..12000, 1 partial', wb?.r_steps_days === 2 && wb?.r_steps_avg === 11000 && wb?.r_steps_min === 10000
  && wb?.r_steps_max === 12000 && wb?.r_steps_partial_days === 1,
  { d: wb?.r_steps_days, avg: wb?.r_steps_avg, min: wb?.r_steps_min, max: wb?.r_steps_max, partial: wb?.r_steps_partial_days });
ok('B: readiness avg 45, 30..70, 2 low days', num(wb?.r_readiness_avg) === 45 && wb?.r_readiness_min === 30 && wb?.r_readiness_max === 70 && wb?.r_readiness_low_days === 2,
  { avg: wb?.r_readiness_avg, min: wb?.r_readiness_min, max: wb?.r_readiness_max, low: wb?.r_readiness_low_days });
ok('B: resting HR 1 day avg 60, HRV 55, active kcal avg 500', wb?.r_rhr_days === 1 && num(wb?.r_rhr_avg) === 60 && num(wb?.r_hrv_avg) === 55 && wb?.r_active_kcal_avg === 500,
  { rhr: [wb?.r_rhr_days, wb?.r_rhr_avg], hrv: wb?.r_hrv_avg, kcal: wb?.r_active_kcal_avg });
const wc = wk.find((r) => r.week_start === C);
ok('prefill nights: week C 2, week B 0', wc?.r_sleep_prefill_nights === 2 && wb?.r_sleep_prefill_nights === 0, [wc?.r_sleep_prefill_nights, wb?.r_sleep_prefill_nights]);
ok('B: 2 readings dropped as impossible', wb?.r_dropped_implausible === 2, wb?.r_dropped_implausible);
ok('B vs A: sleep +30, steps +5000, readiness -5', wb?.r_sleep_avg_delta_prev_week === 30 && wb?.r_steps_avg_delta_prev_week === 5000 && num(wb?.r_readiness_avg_delta_prev_week) === -5,
  { sleep: wb?.r_sleep_avg_delta_prev_week, steps: wb?.r_steps_avg_delta_prev_week, readiness: wb?.r_readiness_avg_delta_prev_week });

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_recovery_day_facts').select('day').eq('user_id', UID), 'cleanup') as any[];
ok('delete_user_data removed every recovery row', left.length === 0, left.length);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
if (fails > 0) process.exitCode = 1;
