/**
 * Proves the facts schedule (0149) on a made-up person. Runs against LIVE with
 * a made-up user id, then deletes it.
 *
 *   npx tsx scripts/drona-facts/schedule.mts
 *
 *   1. One failing domain does not stop the others: for someone with no profile
 *      every domain fails, and all 7 errors come back instead of a throw.
 *   2. The due picker rebuilds a person once per local day, and records it.
 *   3. Chat older than 85 days survives the log's 90-day prune: its trace is
 *      deleted and a rebuild keeps the word row. A recent message whose trace
 *      is gone is removed, as before.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_facts_schedule_0149';
let fails = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
};
const must = <T,>(r: { data: T; error: any }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

// 1. Errors are collected, not thrown.
const ghost = must(await db.rpc('drona_rebuild_all_facts', { p_user_id: 'user_probe_no_such_person', p_from: iso(daysAgo(13)), p_to: iso(daysAgo(0)) }), 'ghost') as Record<string, string>;
// Every domain writes rows that need a profile, so each one fails. All 7 errors
// coming back proves each domain ran after the one before it failed.
ok('a person with no profile: all 7 domains ran and failed alone, nothing thrown', Object.keys(ghost).length === 7,
  Object.keys(ghost));

await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({ clerk_user_id: UID, timezone: 'UTC' }), 'profile');

// 3. Old chat outlives its trace.
const oldAt = daysAgo(100).toISOString(), newAt = daysAgo(3).toISOString();
const traces = must(await db.from('coach_traces').insert([
  { user_id: UID, request_at: oldAt, status: 'success', http_status: 200, last_user_message_preview: 'old words' },
  { user_id: UID, request_at: newAt, status: 'success', http_status: 200, last_user_message_preview: 'new words' },
]).select('id'), 'traces') as any[];
const span = { p_user_id: UID, p_from: iso(daysAgo(110)), p_to: iso(daysAgo(0)) };
must(await db.rpc('drona_rebuild_word_facts', span), 'words 1');
const before = must(await db.from('drona_word_facts').select('text').eq('user_id', UID).eq('kind', 'chat_message'), 'before') as any[];
ok('both messages become word facts', before.length === 2, before.map((r) => r.text));
must(await db.from('coach_traces').delete().in('id', traces.map((t) => t.id)), 'prune');
must(await db.rpc('drona_rebuild_word_facts', span), 'words 2');
const after = must(await db.from('drona_word_facts').select('text').eq('user_id', UID).eq('kind', 'chat_message'), 'after') as any[];
ok('after the log is pruned: the 100-day-old message is kept, the 3-day-old one is gone', after.length === 1 && after[0].text === 'old words',
  after.map((r) => r.text));

// 2. The picker: due once per local day.
must(await db.rpc('drona_rebuild_facts_due', { p_limit: 1000 }), 'due 1');
const run = must(await db.from('drona_facts_runs').select('*').eq('user_id', UID).single(), 'run') as any;
const localNow = new Date();
const due = localNow.getUTCHours() * 60 + localNow.getUTCMinutes() >= 15;
ok('the picker rebuilt this person for today, with no errors', !due || (run.last_day_done === iso(localNow) && JSON.stringify(run.last_errors) === '{}'),
  { due, day: run.last_day_done, errors: run.last_errors });
const runsBefore = run.runs;
must(await db.rpc('drona_rebuild_facts_due', { p_limit: 1000 }), 'due 2');
const again = must(await db.from('drona_facts_runs').select('runs').eq('user_id', UID).single(), 'again') as any;
ok('a second pass the same day leaves them alone', again.runs === runsBefore, [runsBefore, again.runs]);

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_facts_runs').select('user_id').eq('user_id', UID), 'cleanup') as any[];
const leftWords = must(await db.from('drona_word_facts').select('kind').eq('user_id', UID), 'cleanup words') as any[];
ok('delete_user_data removed the run row and the kept chat', left.length === 0 && leftWords.length === 0, [left.length, leftWords.length]);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
if (fails > 0) process.exitCode = 1;
