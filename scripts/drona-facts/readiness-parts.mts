/**
 * Proves readiness_parts (0144) end to end on a made-up person: the app's own
 * code (lib/readiness.ts computeReadiness + lib/readinessParts.ts
 * storeReadinessParts) writes the row as a SIGNED-IN user through RLS, then the
 * recovery facts read it. Runs against LIVE, then deletes the person.
 *
 *   npx tsx scripts/drona-facts/readiness-parts.mts
 *
 * Day 1: sleep 490 vs 450 +- 40, resting HR 57 vs 60 +- 3, HRV 58 vs 50 +- 8,
 *   all with 20 days of history -> A1, every signal z = 1, points 3 / 4.5 / 7.5,
 *   base 65; twice the usual training (-10) and protein on target (+4) -> 59.
 * Day 2: sleep only, HRV read but no resting HR -> A3, HRV "needs_rhr".
 * Day 3: the app opened, no sleep -> no score, tier "none", parts still saved.
 */
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { computeReadiness, type BaselineStat } from '../../lib/readiness';
import { storeReadinessParts } from '../../lib/readinessParts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const admin = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_readiness_parts_0144';
const OTHER = 'user_probe_readiness_parts_0144_other';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = (sub: string) => {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ sub, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 900 });
  return `${h}.${p}.${crypto.createHmac('sha256', env.SUPABASE_JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
};
const asUser = (sub: string) => createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${tokenFor(sub)}` } },
});

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

const cleanup = async () => {
  await admin.rpc('delete_user_data', { p_user_id: UID });
  await admin.rpc('delete_user_data', { p_user_id: OTHER });
};
await cleanup();
must(await admin.from('user_profiles').insert([{ clerk_user_id: UID, timezone: 'UTC' }, { clerk_user_id: OTHER, timezone: 'UTC' }]), 'profiles');

const D1 = '2026-09-07', D2 = '2026-09-08', D3 = '2026-09-09';
const base = (mean: number, sd: number, n = 20): BaselineStat => ({ mean, sd, n });
const full = { sleepMinutes: base(450, 40), restingHrBpm: base(60, 3), hrvMs: base(50, 8) };
const me = asUser(UID);

const r1 = computeReadiness({
  today: { sleepMinutes: 490, restingHrBpm: 57, hrvMs: 58 }, baseline: full,
  acuteLoad: { last7dSets: 80, typicalWeeklySets: 40 }, nutrition: { proteinRatio: 1, energyRatio: 1 },
});
const r2 = computeReadiness({ today: { sleepMinutes: 450, hrvMs: 58 }, baseline: full });
const r3 = computeReadiness({ today: { restingHrBpm: 57 }, baseline: full });

ok('day 1 saved by the signed-in person, through RLS', (await storeReadinessParts(me, UID, D1, r1)) === null);
ok('day 2 saved', (await storeReadinessParts(me, UID, D2, r2)) === null);
ok('day 3 (no score) saved', (await storeReadinessParts(me, UID, D3, r3)) === null);
ok('someone else cannot write rows for this person', (await storeReadinessParts(asUser(OTHER), UID, '2026-09-10', r1)) !== null);

const rows = must(await admin.from('readiness_parts').select('*').eq('user_id', UID).order('metric_date'), 'rows') as any[];
const row = (d: string) => rows.find((r) => r.metric_date === d);
ok('day 1: A1, score 59 = base 65 - 10 load + 4 food', row(D1)?.tier === 'A1' && row(D1)?.score === 59 && row(D1)?.base_score === 65
  && row(D1)?.load_points === -10 && row(D1)?.diet_points === 4,
  { tier: row(D1)?.tier, score: row(D1)?.score, base: row(D1)?.base_score, load: row(D1)?.load_points, diet: row(D1)?.diet_points });
ok('day 1: points sleep 3, resting HR 4.5, HRV 7.5', num(row(D1)?.sleep_points) === 3 && num(row(D1)?.rhr_points) === 4.5 && num(row(D1)?.hrv_points) === 7.5,
  [row(D1)?.sleep_points, row(D1)?.rhr_points, row(D1)?.hrv_points]);
ok('day 1: the full parts are kept as json, with the formula version', row(D1)?.parts?.hrv?.baselineN === 20 && row(D1)?.formula === 1);
ok('day 2: A3, HRV read but needs resting HR, resting HR not read', row(D2)?.tier === 'A3' && row(D2)?.hrv_why === 'needs_rhr' && row(D2)?.rhr_why === 'no_reading',
  { tier: row(D2)?.tier, hrv: row(D2)?.hrv_why, rhr: row(D2)?.rhr_why });
ok('day 3: no score, tier none, resting HR needs sleep', row(D3)?.score === null && row(D3)?.tier === 'none' && row(D3)?.rhr_why === 'needs_sleep',
  { score: row(D3)?.score, tier: row(D3)?.tier, rhr: row(D3)?.rhr_why });

const before = row(D1)?.updated_at;
await new Promise((res) => setTimeout(res, 1100));
ok('a second save the same day replaces the row', (await storeReadinessParts(me, UID, D1, r2)) === null);
const again = must(await admin.from('readiness_parts').select('tier, updated_at').eq('user_id', UID).eq('metric_date', D1).single(), 'again') as any;
ok('... and moves updated_at', again.tier === 'A3' && again.updated_at !== before, again);
await storeReadinessParts(me, UID, D1, r1);

const seen = must(await asUser(OTHER).from('readiness_parts').select('metric_date').eq('user_id', UID), 'other read') as any[];
ok('someone else reads none of these rows', seen.length === 0, seen.length);

must(await admin.rpc('drona_rebuild_recovery_facts', { p_user_id: UID, p_from: D1, p_to: D3 }), 'rebuild');
const days = must(await admin.from('drona_recovery_day_facts').select('*').eq('user_id', UID).order('day'), 'days') as any[];
const f = (d: string) => days.find((r) => r.day === d);
ok('facts: a day row exists for each saved day, even with no metrics', [D1, D2, D3].every((d) => f(d)?.readiness_parts_saved === true), days.length);
ok('facts: day 1 carries tier, points and reasons', f(D1)?.readiness_tier === 'A1' && num(f(D1)?.readiness_hrv_points) === 7.5 && f(D1)?.readiness_load_points === -10);
const wk = must(await admin.from('drona_week_facts').select('*').eq('user_id', UID).eq('week_start', D1).single(), 'week') as any;
ok('week: 3 days with parts, 1 A1, 1 A3, 1 no score', wk.r_parts_days === 3 && wk.r_a1_days === 1 && wk.r_a3_days === 1 && wk.r_no_score_days === 1,
  { parts: wk.r_parts_days, a1: wk.r_a1_days, a3: wk.r_a3_days, none: wk.r_no_score_days });
ok('week: HRV unused 1 day (day 2, needs HR), resting HR unused 1 (day 3, needs sleep)', wk.r_hrv_unused_days === 1 && wk.r_rhr_unused_days === 1,
  { hrv: wk.r_hrv_unused_days, rhr: wk.r_rhr_unused_days });
ok('week: HRV points avg 7.5 on the day it counted, load sum -10', num(wk.r_hrv_points_avg) === 7.5 && wk.r_load_points_sum === -10,
  { hrv: wk.r_hrv_points_avg, load: wk.r_load_points_sum });

await cleanup();
const left = must(await admin.from('readiness_parts').select('metric_date').eq('user_id', UID), 'cleanup') as any[];
ok('delete_user_data removed every parts row', left.length === 0, left.length);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
if (fails > 0) process.exitCode = 1;
