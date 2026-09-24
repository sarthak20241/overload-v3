/**
 * Do the training facts add up to the raw workouts? For every person, sessions
 * and working sets in drona_week_facts must equal a count straight from
 * workouts + workout_sets, and the exercise and muscle rows must hold the same
 * sets. Re-run after any change to the training facts.
 *
 *   npx tsx scripts/drona-facts/reconcile-training.mts
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function all<T>(q: () => any, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await q().range(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) return out;
  }
}
const localDay = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const monday = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); const dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * 86_400_000).toISOString().slice(0, 10); };

const profiles = await all<any>(() => db.from('user_profiles').select('clerk_user_id, timezone').order('clerk_user_id'));
const tzOf = new Map(profiles.map((p) => { let tz = 'UTC'; try { if (p.timezone) { new Intl.DateTimeFormat('en', { timeZone: p.timezone }); tz = p.timezone; } } catch {} return [p.clerk_user_id, tz]; }));
const cutoff = monday(new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10));

const workouts = (await all<any>(() => db.from('workouts').select('id, user_id, started_at').not('finished_at', 'is', null).order('id')))
  .filter((w) => tzOf.has(w.user_id) && localDay(w.started_at, tzOf.get(w.user_id)!) >= cutoff);
const inRange = new Map(workouts.map((w) => [w.id, w.user_id]));
const sets = await all<any>(() => db.from('workout_sets').select('workout_id, completed, set_type').eq('completed', true).neq('set_type', 'warmup').order('id'));

const raw = new Map<string, { sessions: number; sets: number }>();
for (const w of workouts) { const r = raw.get(w.user_id) ?? { sessions: 0, sets: 0 }; r.sessions++; raw.set(w.user_id, r); }
for (const s of sets) { const u = inRange.get(s.workout_id); if (u) raw.get(u)!.sets++; }

const facts = await all<any>(() => db.from('drona_week_facts').select('user_id, week_start, t_sessions, t_working_sets').order('user_id').order('week_start'));
const f = new Map<string, { sessions: number; sets: number }>();
for (const r of facts) { const x = f.get(r.user_id) ?? { sessions: 0, sets: 0 }; x.sessions += r.t_sessions ?? 0; x.sets += r.t_working_sets ?? 0; f.set(r.user_id, x); }
const ex = await all<any>(() => db.from('drona_exercise_week_facts').select('working_sets').order('user_id').order('week_start').order('exercise_id'));
const mu = await all<any>(() => db.from('drona_muscle_week_facts').select('working_sets').order('user_id').order('week_start').order('muscle'));

let exact = 0, rawS = 0, rawSets = 0, fS = 0, fSets = 0;
const off: string[] = [];
for (const [u, r] of raw) {
  const x = f.get(u) ?? { sessions: 0, sets: 0 };
  rawS += r.sessions; rawSets += r.sets; fS += x.sessions; fSets += x.sets;
  if (r.sessions === x.sessions && r.sets === x.sets) exact++; else off.push(`${u.slice(0, 16)} raw ${r.sessions}/${r.sets} facts ${x.sessions}/${x.sets}`);
}
const exSets = ex.reduce((a, r) => a + (r.working_sets ?? 0), 0), muSets = mu.reduce((a, r) => a + (r.working_sets ?? 0), 0);
console.log(`people with workouts: ${raw.size}, exact: ${exact}`);
console.log(`sessions  raw ${rawS}  facts ${fS}`);
console.log(`sets      raw ${rawSets}  week facts ${fSets}  exercise rows ${exSets}  muscle rows ${muSets}`);
for (const o of off) console.log('  MISMATCH', o);
const pass = off.length === 0 && rawSets === exSets && rawSets === muSets;
console.log(pass ? 'ALL MATCH' : 'MISMATCH');
if (!pass) process.exitCode = 1;
