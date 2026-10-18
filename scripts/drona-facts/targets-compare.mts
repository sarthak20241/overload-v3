/**
 * Does the facts' target lookup (SQL private.drona_target_on) give the same
 * day targets as the app (supabase/functions/_shared/targetHistory.ts
 * targetsForDay)? Reads a probe table the caller fills with the SQL answers for
 * every person and day, computes the app's answer from the same three sources,
 * and compares all four targets.
 *
 *   npx tsx scripts/drona-facts/targets-compare.mts
 *
 * Fill the probe table first (service role only, drop it afterwards):
 *   create table public._probe_targets as select user_id, day, tz, kcal, protein, carb, fat, src ...
 *
 * A field the SQL leaves empty (no target set) is skipped: the app fills those
 * with its defaults (2000 kcal, 125 g protein), the facts keep "no target".
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { targetsForDay } from '../../supabase/functions/_shared/targetHistory.ts';
import { normalizeFuelDays } from '../../supabase/functions/_shared/fuelDays.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function all<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (data.length < 1000) return out;
  }
}

const rows = await all<any>('_probe_targets', '*');
const profiles = await all<any>('user_profiles', 'clerk_user_id, daily_calorie_target, protein_target_g, carb_target_g, fat_target_g, calorie_day_boosts');
const history = await all<any>('user_target_history', 'user_id, effective_from, kcal, protein_g, carb_g, fat_g, calorie_day_boosts');
const overrides = await all<any>('user_day_targets', 'user_id, day, kcal, protein_g, carb_g, fat_g');

const prof = new Map(profiles.map((p) => [p.clerk_user_id, p]));
let compared = 0, same = 0, skipped = 0, noProfile = 0;
const diffs: unknown[] = [];
const bySrc: Record<string, number> = {};

for (const r of rows) {
  const p = prof.get(r.user_id);
  if (!p) { noProfile++; continue; }
  const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: r.tz }).format(new Date());
  const t = targetsForDay({
    dayISO: r.day,
    todayISO,
    dow: new Date(r.day + 'T12:00:00Z').getUTCDay(),
    live: { kcal: Number(p.daily_calorie_target), protein: Number(p.protein_target_g), carb: Number(p.carb_target_g), fat: Number(p.fat_target_g) },
    liveFuel: normalizeFuelDays(p.calorie_day_boosts),
    history: history.filter((h) => h.user_id === r.user_id),
    defaults: { kcal: NaN, protein: NaN, carb: NaN, fat: NaN },
    overrides: overrides.filter((o) => o.user_id === r.user_id),
  });
  for (const [k, app, sql] of [['kcal', t.kcal, r.kcal], ['protein', t.protein, r.protein], ['carb', t.carb, r.carb], ['fat', t.fat, r.fat]] as const) {
    if (sql === null || !Number.isFinite(app)) { skipped++; continue; }
    compared++;
    if (Math.abs(app - Number(sql)) < 0.001) { same++; bySrc[r.src] = (bySrc[r.src] ?? 0) + 1; }
    else if (diffs.length < 12) diffs.push({ who: r.user_id.slice(0, 13), day: r.day, k, app, sql: Number(sql), src: r.src });
  }
}
console.log({ rows: rows.length, compared, same, different: compared - same, skipped, noProfile, matchedBySource: bySrc });
if (diffs.length) console.log(diffs);
console.log(compared > 0 && compared === same ? 'ALL MATCH' : 'MISMATCH');
if (compared === 0 || compared !== same) process.exitCode = 1;
