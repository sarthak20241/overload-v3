/**
 * Proves the words facts (0146) on a made-up person whose every answer is
 * worked out by hand below. Runs against LIVE with a made-up user id, then
 * deletes it.
 *
 *   npx tsx scripts/drona-facts/words.mts
 *
 * Timezone Asia/Kolkata (UTC+5:30). All in the week of Mon 7 Sep:
 *   workout at 20:00 UTC on 7 Sep = 01:30 on 8 Sep local: its note and its
 *     exercise note land on 8 Sep (UTC would say 7 Sep)
 *   sticky note last edited 9 Sep; meal note 10 Sep
 *   chat 10 Sep 10:00 "my knee hurts" unanswered (unauthorized), resent 10:01
 *     and answered: the first send is a repeat, the message counts as answered
 *   chat 11 Sep "hi" rate limited: unanswered
 *   discuss_program 11 Sep, 200 characters: kept as a preview
 *   generate_plan 11 Sep "Design my training split...": written by the app, left out
 *   memory 12 Sep injury / knee: left knee pain
 * Week: 1 workout, 1 exercise, 1 sticky, 1 meal note; 3 chat messages
 *   (chat 2, discuss_program 1), 1 unanswered, 1 repeat; 1 memory fact;
 *   words on 5 days (8-12 Sep); 8 texts in the list.
 * Injury notes ("ACL") show on the running week only.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_word_facts_0146';
let fails = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
};
const must = <T,>(r: { data: T; error: any }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({ clerk_user_id: UID, timezone: 'Asia/Kolkata', injury_notes: 'ACL' }), 'profile');
const ex = (must(await db.from('exercises').select('id').eq('muscle_group', 'Quads').limit(1).single(), 'exercise') as any).id;

const w = must(await db.from('workouts').insert({ user_id: UID, name: 'Legs', notes: 'felt heavy today', started_at: '2026-09-07T20:00:00Z', finished_at: '2026-09-07T21:00:00Z' }).select('id').single(), 'workout') as any;
must(await db.from('workout_exercise_notes').insert({ workout_id: w.id, exercise_id: ex, note: 'knee clicked on set 3' }), 'exercise note');
must(await db.from('user_exercise_notes').insert({ user_id: UID, exercise_id: ex, note: 'feet shoulder width', updated_at: '2026-09-09T06:00:00Z' }), 'sticky');
must(await db.from('meals').insert({ user_id: UID, meal_type: 'dinner', note: 'ate out', logged_at: '2026-09-10T14:00:00Z' }), 'meal');
const long = 'x'.repeat(200);
must(await db.from('coach_traces').insert([
  { user_id: UID, request_at: '2026-09-10T10:00:00Z', status: 'unauthorized', http_status: 401, mode: null, last_user_message_preview: 'my knee hurts' },
  { user_id: UID, request_at: '2026-09-10T10:01:00Z', status: 'success', http_status: 200, mode: null, last_user_message_preview: 'my knee hurts' },
  { user_id: UID, request_at: '2026-09-11T05:00:00Z', status: 'rate_limited', http_status: 429, mode: 'chat', last_user_message_preview: 'hi' },
  { user_id: UID, request_at: '2026-09-11T06:00:00Z', status: 'success', http_status: 200, mode: 'discuss_program', last_user_message_preview: long },
  { user_id: UID, request_at: '2026-09-11T07:00:00Z', status: 'success', http_status: 200, mode: 'generate_plan', last_user_message_preview: 'Design my training split.' },
]), 'traces');
must(await db.from('coach_memory').insert({ user_id: UID, category: 'injury', key: 'knee', value: 'left knee pain', source: 'chat', updated_at: '2026-09-12T06:00:00Z' }), 'memory');

must(await db.rpc('drona_rebuild_word_facts', { p_user_id: UID, p_from: '2026-09-07', p_to: new Date().toISOString().slice(0, 10) }), 'rebuild');
const rows = must(await db.from('drona_word_facts').select('*').eq('user_id', UID), 'rows') as any[];
const r = (kind: string) => rows.filter((x) => x.kind === kind);

ok('the workout note lands on 8 Sep, the local day (UTC would say 7 Sep)', r('workout_note')[0]?.day === '2026-09-08' && r('exercise_note')[0]?.day === '2026-09-08',
  [r('workout_note')[0]?.day, r('exercise_note')[0]?.day]);
ok('the exercise note carries its exercise name', !!r('exercise_note')[0]?.context);
ok('the app-written plan request is left out', !rows.some((x) => x.text.startsWith('Design my')));
const knee = r('chat_message').filter((x) => x.text === 'my knee hurts');
ok('the first "my knee hurts" is a repeat, the resend is answered', same(knee.map((x) => [x.is_repeat, x.answered]).sort(), [[false, true], [true, false]]),
  knee.map((x) => [x.is_repeat, x.answered]));
ok('the 200-character message is a preview', r('chat_message').find((x) => x.chars === 200)?.is_preview === true);
ok('memory kept with its category', r('memory')[0]?.text === 'knee: left knee pain' && r('memory')[0]?.context === 'injury / active / chat', r('memory')[0]);

const wk = must(await db.from('drona_week_facts').select('*').eq('user_id', UID).order('week_start'), 'weeks') as any[];
const w1 = wk.find((x) => x.week_start === '2026-09-07');
ok('week: 1 workout, 1 exercise, 1 sticky, 1 meal note', w1?.wd_workout_notes === 1 && w1?.wd_exercise_notes === 1 && w1?.wd_sticky_notes === 1 && w1?.wd_meal_notes === 1);
ok('week: 3 chat messages, 1 unanswered, 1 repeat', w1?.wd_chat_messages === 3 && w1?.wd_chat_unanswered === 1 && w1?.wd_chat_repeats === 1,
  [w1?.wd_chat_messages, w1?.wd_chat_unanswered, w1?.wd_chat_repeats]);
ok('week: chat by mode, chat 2 and discuss_program 1', same(w1?.wd_chat_by_mode, { chat: 2, discuss_program: 1 }), w1?.wd_chat_by_mode);
ok('week: 1 memory fact, words on 5 days, 8 texts', w1?.wd_memory_facts === 1 && w1?.wd_days_with_words === 5 && w1?.wd_texts?.length === 8,
  [w1?.wd_memory_facts, w1?.wd_days_with_words, w1?.wd_texts?.length]);
ok('week: characters add up (16 + 21 + 19 + 7 + 13 + 2 + 200 + 20 = 298)', w1?.wd_chars === 298, w1?.wd_chars);
ok('injury notes: not on that past week, only on the running week', w1?.wd_injury_notes === null && wk[wk.length - 1]?.wd_injury_notes === 'ACL',
  [w1?.wd_injury_notes, wk[wk.length - 1]?.wd_injury_notes]);

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_word_facts').select('kind').eq('user_id', UID), 'cleanup') as any[];
ok('delete_user_data removed every word row', left.length === 0, left.length);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
if (fails > 0) process.exitCode = 1;
