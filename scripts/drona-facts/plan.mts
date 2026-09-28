/**
 * Proves the plan facts (0145) on a made-up person whose every answer is worked
 * out by hand below. Runs against LIVE with a made-up user id, then deletes it.
 *
 *   npx tsx scripts/drona-facts/plan.mts
 *
 * Setup writes through the service role, which the diary triggers log as
 * 'system' at today's time. Those rows are deleted and a diary with known dates
 * is written instead. Timezone UTC.
 *
 * Programs (one active at a time; saving a new one archives the old):
 *   A  created 31 Aug, starts 31 Aug, 4 weeks, archived with no diary row
 *      A0 weeks 1-2 (2000 kcal), A1 weeks 3-4 (2200 kcal)
 *   B  created 18 Sep (diary: chat), starts 21 Sep, 6 weeks, active
 *      B0 weeks 1-3 (1900 kcal), its routine created 22 Sep
 * Diary: 18 Sep program B created (chat); 19 Sep kcal 2000 -> 1800 and protein
 *   140 -> 150 (card); 23 Sep kcal 1800 -> 1900 (manual); 24 Sep routine
 *   exercises (manual); 25 Sep goal fat_loss -> hypertrophy (manual).
 *
 * Week of 31 Aug (as of 6 Sep):  program A week 1, phase A0 week 1 of 2, not
 *   built; kcal 2000 inferred (the first later change's "from"), delta 0; diary 0 days.
 * Week of 7 Sep (as of 13 Sep):  A week 2, A0 week 2 of 2, 0 left.
 * Week of 14 Sep (as of 20 Sep): A ended 18 Sep (inferred from B's creation),
 *   so program B, week 0 = not started, no phase; 1 created, 1 ended; kcal 1800
 *   recorded, delta -200; changes 2 {chat 1, card 1}; 1 target change, 1 card
 *   change; target changed 1 day ago; goal fat_loss (inferred); diary 4 days.
 * Week of 21 Sep (as of 27 Sep): B week 1, B0 week 1 of 3, built; kcal 1900,
 *   delta +100; changes 3 {manual 3}; target changed 4 days ago, anything 2 days
 *   ago; goal hypertrophy (recorded); goal weight 70 from the profile; diary 7.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_plan_facts_0145';
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({
  clerk_user_id: UID, timezone: 'UTC', daily_calorie_target: 1900, protein_target_g: 150,
  goal: 'hypertrophy', goal_weight_kg: 70, weekly_target_sessions: 4,
}), 'profile');

const A = must(await db.from('coach_programs').insert({
  user_id: UID, title: 'Probe A', goal: 'fat_loss', start_date: '2026-08-31', total_weeks: 4, status: 'archived',
  created_at: '2026-08-31T10:00:00Z', updated_at: '2026-09-25T10:00:00Z',  // an edit after it ended: must not move the end
}).select('id').single(), 'program A') as any;
const B = must(await db.from('coach_programs').insert({
  user_id: UID, title: 'Probe B', goal: 'hypertrophy', start_date: '2026-09-21', total_weeks: 6, status: 'active',
  created_at: '2026-09-18T12:00:00Z', updated_at: '2026-09-18T12:00:00Z',
}).select('id').single(), 'program B') as any;
must(await db.from('coach_program_phases').insert([
  { program_id: A.id, user_id: UID, seq: 0, name: 'A0', start_offset_weeks: 0, duration_weeks: 2, diet_calorie_target: 2000, diet_protein_g: 140 },
  { program_id: A.id, user_id: UID, seq: 1, name: 'A1', start_offset_weeks: 2, duration_weeks: 2, diet_calorie_target: 2200, diet_protein_g: 140 },
]), 'phases A');
const B0 = must(await db.from('coach_program_phases').insert({
  program_id: B.id, user_id: UID, seq: 0, name: 'B0', start_offset_weeks: 0, duration_weeks: 3, diet_calorie_target: 1900, diet_protein_g: 150,
}).select('id').single(), 'phase B0') as any;
must(await db.from('routines').insert({ user_id: UID, name: 'B0 day', program_phase_id: B0.id, created_at: '2026-09-22T08:00:00Z' }), 'routine');

// The setup's own diary rows say 'system' at today's time: replace them with a known diary.
must(await db.from('plan_changes').delete().eq('user_id', UID), 'clear diary');
const row = (at: string, entity: string, action: string, source: string, changes: object, entity_id: string | null = null) =>
  ({ user_id: UID, occurred_at: at, updated_at: at, entity, entity_id, action, source, changes });
must(await db.from('plan_changes').insert([
  row('2026-09-18T12:00:00Z', 'program', 'created', 'chat', { title: 'Probe B', status: 'active' }, B.id),
  row('2026-09-19T09:00:00Z', 'targets', 'changed', 'card', { daily_calorie_target: { from: 2000, to: 1800 }, protein_target_g: { from: 140, to: 150 } }),
  row('2026-09-23T09:00:00Z', 'targets', 'changed', 'manual', { daily_calorie_target: { from: 1800, to: 1900 } }),
  row('2026-09-24T10:00:00Z', 'routine_exercises', 'changed', 'manual', { added: [] }),
  row('2026-09-25T10:00:00Z', 'goal', 'changed', 'manual', { goal: { from: 'fat_loss', to: 'hypertrophy' } }),
]), 'diary');

must(await db.rpc('drona_rebuild_plan_facts', { p_user_id: UID, p_from: '2026-08-31', p_to: '2026-09-21' }), 'rebuild');
const wk = must(await db.from('drona_week_facts').select('*').eq('user_id', UID).order('week_start'), 'weeks') as any[];
const w = (d: string) => wk.find((r) => r.week_start === d);
const w1 = w('2026-08-31'), w2 = w('2026-09-07'), w3 = w('2026-09-14'), w4 = w('2026-09-21');

ok('31 Aug: program A week 1, phase A0 week 1 of 2, not built', w1?.p_program_id === A.id && w1?.p_program_week === 1 && w1?.p_program_weeks_left === 3
  && w1?.p_phase_name === 'A0' && w1?.p_phase_week === 1 && w1?.p_phase_weeks === 2 && w1?.p_phase_built === false,
  { prog: w1?.p_program_title, pw: w1?.p_program_week, left: w1?.p_program_weeks_left, phase: w1?.p_phase_name, phw: w1?.p_phase_week, built: w1?.p_phase_built });
ok('31 Aug: kcal 2000 inferred, delta 0, protein 140, program A inferred, diary 0 days', w1?.p_kcal_target === 2000 && w1?.p_target_src === 'inferred'
  && w1?.p_kcal_target_delta === 0 && w1?.p_protein_target_g === 140 && w1?.p_program_src === 'inferred' && w1?.p_diary_days === 0,
  { kcal: w1?.p_kcal_target, src: w1?.p_target_src, d: w1?.p_kcal_target_delta, p: w1?.p_protein_target_g, psrc: w1?.p_program_src, diary: w1?.p_diary_days });
ok('7 Sep: A week 2, A0 week 2 of 2, 0 left, phase kcal 2000', w2?.p_program_week === 2 && w2?.p_phase_week === 2 && w2?.p_phase_weeks_left === 0 && w2?.p_phase_kcal === 2000,
  { pw: w2?.p_program_week, phw: w2?.p_phase_week, left: w2?.p_phase_weeks_left, kcal: w2?.p_phase_kcal });
ok('14 Sep: program B, not started (week 0), no phase, B recorded', w3?.p_program_id === B.id && w3?.p_program_week === 0 && w3?.p_phase_id === null && w3?.p_program_src === 'recorded',
  { prog: w3?.p_program_title, pw: w3?.p_program_week, phase: w3?.p_phase_id, src: w3?.p_program_src });
ok('14 Sep: 1 program created, 1 ended', w3?.p_programs_created === 1 && w3?.p_programs_ended === 1, [w3?.p_programs_created, w3?.p_programs_ended]);
ok('14 Sep: kcal 1800 recorded, -200 on the week, protein 150', w3?.p_kcal_target === 1800 && w3?.p_target_src === 'recorded' && w3?.p_kcal_target_delta === -200 && w3?.p_protein_target_g === 150,
  { kcal: w3?.p_kcal_target, src: w3?.p_target_src, d: w3?.p_kcal_target_delta, p: w3?.p_protein_target_g });
ok('14 Sep: 2 changes, chat 1 and card 1; 1 target, 1 program, 1 card change', w3?.p_changes === 2 && same(w3?.p_changes_by_source, { card: 1, chat: 1 })
  && w3?.p_target_changes === 1 && w3?.p_program_changes === 1 && w3?.p_card_changes === 1,
  { n: w3?.p_changes, by: w3?.p_changes_by_source, t: w3?.p_target_changes, p: w3?.p_program_changes, c: w3?.p_card_changes });
ok('14 Sep: target changed 1 day before, goal fat_loss inferred, diary 4 days', w3?.p_days_since_target_change === 1 && w3?.p_goal === 'fat_loss'
  && w3?.p_goal_src === 'inferred' && w3?.p_diary_days === 4,
  { since: w3?.p_days_since_target_change, goal: w3?.p_goal, src: w3?.p_goal_src, diary: w3?.p_diary_days });
ok('21 Sep: B week 1, B0 week 1 of 3, built', w4?.p_program_week === 1 && w4?.p_phase_name === 'B0' && w4?.p_phase_week === 1 && w4?.p_phase_weeks === 3 && w4?.p_phase_built === true,
  { pw: w4?.p_program_week, phase: w4?.p_phase_name, phw: w4?.p_phase_week, built: w4?.p_phase_built });
ok('21 Sep: kcal 1900, +100; 3 manual changes: target, routine, goal', w4?.p_kcal_target === 1900 && w4?.p_kcal_target_delta === 100 && w4?.p_changes === 3
  && same(w4?.p_changes_by_source, { manual: 3 }) && w4?.p_target_changes === 1 && w4?.p_routine_changes === 1 && w4?.p_goal_changes === 1,
  { kcal: w4?.p_kcal_target, d: w4?.p_kcal_target_delta, n: w4?.p_changes, by: w4?.p_changes_by_source });
ok('21 Sep: target 4 days ago, any change 2 days ago', w4?.p_days_since_target_change === 4 && w4?.p_days_since_plan_change === 2,
  [w4?.p_days_since_target_change, w4?.p_days_since_plan_change]);
ok('21 Sep: goal hypertrophy recorded, goal weight 70 from the profile, diary 7', w4?.p_goal === 'hypertrophy' && w4?.p_goal_src === 'recorded'
  && num(w4?.p_goal_weight_kg) === 70 && w4?.p_diary_days === 7,
  { goal: w4?.p_goal, src: w4?.p_goal_src, kg: w4?.p_goal_weight_kg, diary: w4?.p_diary_days });
ok('21 Sep: the change list is in order with who and when', w4?.p_change_list?.length === 3 && w4?.p_change_list?.[0]?.on === '2026-09-23'
  && w4?.p_change_list?.[0]?.who === 'manual' && w4?.p_change_list?.[2]?.entity === 'goal',
  w4?.p_change_list?.map((c: any) => [c.on, c.entity, c.who]));

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_week_facts').select('week_start').eq('user_id', UID), 'cleanup') as any[];
ok('delete_user_data removed every week row', left.length === 0, left.length);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
if (fails > 0) process.exitCode = 1;
