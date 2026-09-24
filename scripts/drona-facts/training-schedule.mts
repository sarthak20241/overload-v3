/**
 * Proves the training facts' schedule logic (0136 + 0137) on a made-up person
 * whose every answer is known in advance. No real tester has ever done a
 * session from their active program's routines, so real data cannot test
 * "early" and "overdue". Runs against LIVE with a made-up user id, then deletes
 * it with delete_user_data.
 *
 *   npx tsx scripts/drona-facts/training-schedule.mts
 *
 * The plan: Push, Pull, Legs, Rest, Push, Pull, Rest (slots 0,1,2,4,5), from
 * Monday 31 Aug. Sessions of the program's routines, as day offsets:
 *   d0  Push   first session
 *   d1  Pull   on time   (no rest between Push and Pull)
 *   d2  Legs   on time
 *   d3  Push   EARLY     (one rest day after Legs, so due d4)
 *   d7  Pull   LATE by 3 (due d4, came d7: d4, d5, d6 overdue)
 *   d9  Push   on time   (one rest day after the second Pull, so due d9)
 *   then nothing: Pull due d10, overdue d10 .. yesterday.
 * Plus one freestyle session and one from an ARCHIVED program's routine, which
 * must count as freestyle and "other routine", never as the program.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_training_schedule_0137';
let fails = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
};
const must = <T,>(r: { data: T; error: any }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const D0 = '2026-08-31'; // a Monday
const day = (n: number) => new Date(Date.parse(`${D0}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (n: number, hour = 10) => `${day(n)}T${String(hour).padStart(2, '0')}:00:00Z`;
const today = new Date().toISOString().slice(0, 10);

await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({ clerk_user_id: UID, timezone: 'UTC', weekly_target_sessions: 3 }), 'profile');

const pattern = ['Push', 'Pull', 'Legs', 'Rest', 'Push', 'Pull', 'Rest'];
const prog = must(await db.from('coach_programs').insert({ user_id: UID, title: 'Probe PPL', goal: 'hypertrophy', start_date: D0, status: 'active' }).select('id').single(), 'program') as any;
const phase = must(await db.from('coach_program_phases').insert({ program_id: prog.id, user_id: UID, seq: 0, name: 'Build', duration_weeks: 6, start_offset_weeks: 0, training_block: { week_pattern: pattern } }).select('id').single(), 'phase') as any;
const old = must(await db.from('coach_programs').insert({ user_id: UID, title: 'Old', goal: 'hypertrophy', start_date: D0, status: 'archived' }).select('id').single(), 'old program') as any;
const oldPhase = must(await db.from('coach_program_phases').insert({ program_id: old.id, user_id: UID, seq: 0, name: 'Old', duration_weeks: 6, start_offset_weeks: 0, training_block: { week_pattern: pattern } }).select('id').single(), 'old phase') as any;

const routine = async (name: string, phaseId: string) =>
  (must(await db.from('routines').insert({ user_id: UID, name, program_phase_id: phaseId }).select('id').single(), name) as any).id as string;
const push = await routine('Push', phase.id), pull = await routine('Pull', phase.id), legs = await routine('Legs', phase.id);
const oldLegs = await routine('Old Legs', oldPhase.id);

const session = async (n: number, routineId: string | null, name: string, hour = 10) =>
  must(await db.from('workouts').insert({ user_id: UID, routine_id: routineId, name, started_at: at(n, hour), finished_at: at(n, hour + 1), duration_seconds: 3600 }), name);
await session(0, push, 'Push');
await session(1, pull, 'Pull');
await session(2, legs, 'Legs');
await session(3, push, 'Push');
await session(7, pull, 'Pull');
await session(9, push, 'Push');
await session(5, null, 'Freestyle');           // on an overdue day: trained, just not the plan
await session(6, oldLegs, 'Old program legs');  // archived program: "other routine"

const weeks = must(await db.rpc('drona_rebuild_training_facts', { p_user_id: UID, p_from: D0, p_to: today }), 'rebuild');
ok('the rebuild ran', typeof weeks === 'number' && weeks > 0, weeks);

const days = must(await db.from('drona_training_day_facts').select('*').eq('user_id', UID).order('day'), 'days') as any[];
const d = (n: number) => days.find((r) => r.day === day(n));

ok('d1 and d2 are on time', d(1)?.early_sessions === 0 && d(1)?.late_days === 0 && d(2)?.early_sessions === 0 && d(2)?.late_days === 0);
ok('d3 Push is EARLY (a rest day was due after Legs)', d(3)?.early_sessions === 1, d(3)?.early_sessions);
ok('d7 Pull is LATE by 3 days', d(7)?.late_days === 3, d(7)?.late_days);
ok('d9 Push is on time', d(9)?.early_sessions === 0 && d(9)?.late_days === 0, { early: d(9)?.early_sessions, late: d(9)?.late_days });
ok('d4, d5, d6 are overdue', [4, 5, 6].every((n) => d(n)?.overdue === true), [4, 5, 6].map((n) => d(n)?.overdue));
ok('d3 and d7 are not overdue', d(3)?.overdue === false && d(7)?.overdue === false);
ok('d8 and d9 are not overdue (Push was not due until d9)', !d(8)?.overdue && d(9)?.overdue === false, { d8: d(8)?.overdue ?? 'no row', d9: d(9)?.overdue });
ok('from d10 the next Pull is overdue', d(10)?.overdue === true && d(12)?.overdue === true, { d10: d(10)?.overdue, d12: d(12)?.overdue });
ok('today is not counted as overdue (it is not over)', !days.find((r) => r.day === today)?.overdue);
ok('the freestyle session on d5 is freestyle, on an overdue day', d(5)?.sessions_freestyle === 1 && d(5)?.overdue === true);
ok('the archived program\'s routine is "other", never the program', d(6)?.sessions_other_routine === 1 && d(6)?.sessions_phase === 0);
ok('program sessions counted: 6', days.reduce((a, r) => a + r.sessions_phase, 0) === 6, days.reduce((a, r) => a + r.sessions_phase, 0));

const wk = must(await db.from('drona_week_facts').select('*').eq('user_id', UID).order('week_start'), 'weeks') as any[];
const w1 = wk.find((r) => r.week_start === D0), w2 = wk.find((r) => r.week_start === day(7));
ok('week 1: planned 5 from the pattern', w1?.t_planned_sessions === 5 && w1?.t_plan_source === 'phase_pattern', { planned: w1?.t_planned_sessions, source: w1?.t_plan_source });
ok('week 1: 4 program sessions, 1 early, 3 overdue days', w1?.t_sessions_phase === 4 && w1?.t_early_sessions === 1 && w1?.t_overdue_days === 3,
  { ph: w1?.t_sessions_phase, early: w1?.t_early_sessions, overdue: w1?.t_overdue_days });
ok('week 1: 6 sessions in all, 1 freestyle, 1 other routine', w1?.t_sessions === 6 && w1?.t_sessions_freestyle === 1 && w1?.t_sessions_other_routine === 1,
  { all: w1?.t_sessions, free: w1?.t_sessions_freestyle, other: w1?.t_sessions_other_routine });
ok('week 1: trained 6 days running, d0..d3 and d5, d6 (runs of 4 and 2)', w1?.t_longest_train_run === 4, w1?.t_longest_train_run);
ok('week 2: d7 late, d9 on time, overdue d10..d13 = 4', w2?.t_sessions_phase === 2 && w2?.t_overdue_days === 4, { ph: w2?.t_sessions_phase, overdue: w2?.t_overdue_days });

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_training_day_facts').select('day').eq('user_id', UID), 'cleanup') as any[];
ok('cleanup removed every fact row', left.length === 0, left.length);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
if (fails > 0) process.exitCode = 1;
