/**
 * The weekly facts ledger, read back (0131 weight, 0132 + 0134 food, rolled up from day facts).
 *
 *   npx tsx scripts/drona-facts/weeks.mts                     # a line per user
 *   USER_ID=user_3Gt86 npx tsx scripts/drona-facts/weeks.mts   # that person's weeks
 *   REBUILD=1 npx tsx scripts/drona-facts/weeks.mts            # recompute first
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
    for (const fn of ['drona_rebuild_weight_facts', 'drona_rebuild_food_facts']) {
      const { data } = await db.rpc(fn, { p_user_id: u.clerk_user_id, p_from: from, p_to: to });
      rows += data ?? 0;
    }
  }
  console.log(`rebuilt ${rows} week rows for ${users?.length ?? 0} users\n`);
}

const { data, error } = await db.from('drona_week_facts')
  .select('*')
  .order('user_id').order('week_start');
if (error) { console.error(error.message); process.exit(1); }

const rows = (data ?? []).filter((r: any) => r.w_readings > 0 || r.bf_readings > 0 || r.tape_days > 0 || r.f_days_logged > 0);
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
    console.log('            --- weight ---   ----------------------------- food ------------------------------');
    console.log('week          n    avg  swing   logged miss dark  avg  median  target        in/over/under  <half  live  low-macro  ai/cat/est/typed');
    for (const r of weeks) {
      const target = r.f_target_kcal == null ? '-' : `${r.f_target_kcal} ${String(r.f_target_source ?? '').slice(0, 8)}`;
      console.log(`${r.week_start}${num(r.w_readings, 4)}${num(r.w_avg_kg, 7)}${num(r.w_typical_swing_kg, 7)}   ${num(`${r.f_days_logged ?? '-'}/${r.f_days_elapsed ?? '-'}`, 6)}${num(r.f_days_missed, 5)}${num(r.f_longest_missed_run, 5)}${num(r.f_avg_kcal, 7)}${num(r.f_median_kcal, 8)}  ${String(target).padEnd(15)}${num(`${r.f_days_within_10pct ?? '-'}/${r.f_days_over_10pct ?? '-'}/${r.f_days_under_10pct ?? '-'}`, 9)}${num(r.f_days_under_half_target, 7)}${num(r.f_days_logged_same_day, 6)}${num(r.f_days_any_macro_under_half, 11)}  ${r.f_entries_ai ?? '-'}/${r.f_entries_catalog ?? '-'}/${r.f_entries_estimate ?? '-'}/${r.f_entries_typed ?? '-'}`);
    }
    const { data: w } = await db.rpc('drona_food_windows', { p_user_id: uid });
    if (w) {
      console.log(`\nwindows as of ${w.today} (complete days only):`);
      for (const [k, v] of Object.entries(w.windows ?? {})) console.log(`  ${k.padEnd(12)} ${JSON.stringify(v)}`);
    }
  }
} else {
  console.log('user              weeks | weigh-ins dropped worst-swing | food-days entries  within over under  targets');
  for (const [uid, weeks] of byUser) {
    const sum = (k: string) => weeks.reduce((a, r) => a + (r[k] ?? 0), 0);
    const swings = weeks.map((r) => r.w_typical_swing_kg).filter((v) => v != null).map(Number);
    const srcs = [...new Set(weeks.filter((r) => r.f_days_logged > 0).map((r) => r.f_target_source))].join(',');
    console.log(`${uid.slice(0, 16).padEnd(17)}${String(weeks.length).padStart(6)} |${String(sum('w_readings')).padStart(10)}${String(sum('w_dropped_impossible')).padStart(8)}${(swings.length ? Math.max(...swings).toFixed(2) : '-').padStart(12)} |${String(sum('f_days_logged')).padStart(10)}${String(sum('f_entries')).padStart(8)}${String(sum('f_days_within_10pct')).padStart(8)}${String(sum('f_days_over_10pct')).padStart(5)}${String(sum('f_days_under_10pct')).padStart(6)}  ${srcs || '-'}`);
  }
  console.log('\nswing = mean change between neighbouring weigh-ins (a real scale is under ~0.65).');
  console.log('within/over/under = logged days against the calorie target that day HAD (0132).');
}
