/**
 * The weight facts, week by week, for every user who has any (migration 0131).
 *
 *   npx tsx scripts/drona-facts/weight.mts                  # a line per user
 *   USER_ID=user_3Gt86 npx tsx scripts/drona-facts/weight.mts  # that person's weeks
 *   REBUILD=1 npx tsx scripts/drona-facts/weight.mts         # recompute first
 *
 * Facts only: counting, no judgment. The point of reading this output is to
 * choose signals from what the data ACTUALLY looks like.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// NOT process.env.USER: the shell already sets that to the login name, which
// silently filtered every row out on the first run.
const who = process.env.USER_ID;

if (process.env.REBUILD === '1') {
  const { data: users } = await db.from('user_profiles').select('clerk_user_id');
  let rows = 0;
  const from = new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  for (const u of users ?? []) {
    const { data } = await db.rpc('drona_rebuild_weight_facts', { p_user_id: u.clerk_user_id, p_from: from, p_to: to });
    rows += data ?? 0;
  }
  console.log(`rebuilt ${rows} week rows for ${users?.length ?? 0} users\n`);
}

const { data, error } = await db.from('drona_week_facts')
  .select('user_id, week_start, w_readings, w_dropped_impossible, w_avg_kg, w_min_kg, w_max_kg, w_delta_prev_week_kg, w_typical_swing_kg, w_sources, bf_readings, bf_avg_percent, tape_days')
  .order('user_id').order('week_start');
if (error) { console.error(error.message); process.exit(1); }

const rows = (data ?? []).filter((r: any) => r.w_readings > 0 || r.bf_readings > 0 || r.tape_days > 0);
const byUser = new Map<string, any[]>();
for (const r of rows) {
  if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
  byUser.get(r.user_id)!.push(r);
}

const num = (v: any, w = 6) => (v == null ? '-' : String(v)).padStart(w);
if (who) {
  for (const [uid, weeks] of byUser) {
    if (!uid.startsWith(who)) continue;
    console.log(`\n${uid}`);
    console.log('week        n  bad     avg      lo      hi  vs prev   swing  bf   tape  sources');
    for (const r of weeks) {
      console.log(`${r.week_start}${num(r.w_readings, 4)}${num(r.w_dropped_impossible, 5)}${num(r.w_avg_kg, 8)}${num(r.w_min_kg, 8)}${num(r.w_max_kg, 8)}${num(r.w_delta_prev_week_kg, 9)}${num(r.w_typical_swing_kg, 8)}${num(r.bf_avg_percent, 5)}${num(r.tape_days, 6)}  ${(r.w_sources ?? []).join(',')}`);
    }
  }
} else {
  console.log('user             weeks  readings  dropped  worst swing  span kg  sources');
  for (const [uid, weeks] of byUser) {
    const readings = weeks.reduce((a, r) => a + (r.w_readings ?? 0), 0);
    const dropped = weeks.reduce((a, r) => a + (r.w_dropped_impossible ?? 0), 0);
    const swings = weeks.map((r) => r.w_typical_swing_kg).filter((v) => v != null).map(Number);
    const avgs = weeks.map((r) => r.w_avg_kg).filter((v) => v != null).map(Number);
    const span = avgs.length ? (Math.max(...avgs) - Math.min(...avgs)).toFixed(1) : '-';
    const src = [...new Set(weeks.flatMap((r) => r.w_sources ?? []))].join(',');
    console.log(`${uid.slice(0, 16).padEnd(17)}${String(weeks.length).padStart(5)}${String(readings).padStart(10)}${String(dropped).padStart(9)}${(swings.length ? Math.max(...swings).toFixed(2) : '-').padStart(13)}${String(span).padStart(9)}  ${src}`);
  }
  console.log('\nswing = mean change between neighbouring weigh-ins. A real scale is under ~0.4.');
}
