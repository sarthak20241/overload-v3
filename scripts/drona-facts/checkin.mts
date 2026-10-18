/**
 * Proves the calorie check-in end to end (20261018091823_drona_calorie_checkin)
 * on a made-up person: what the card worker reads, the card the shared rules
 * make from it, its own slot beside the weekly card, and the one tap that
 * moves the calories AND the program's future phases, signed in as the person.
 * Then Undo. LIVE database, made-up user id, deleted after.
 *
 *   npx tsx scripts/drona-facts/checkin.mts
 *
 * The person: target 2200 kcal (150 P / 220 C / 70 F), Pro. A program made the
 * week of 6 Jul, when the formula said 2700. Phases: Cut 1 (running), Diet
 * break 2700 (from 17 Aug), Cut 2 2200 (from 31 Aug). Last week the estimate
 * learned 2450 and calories_off suggested 2050.
 *
 *   card      2200 -> 2050 (a 150 step). The phases move by 2450 - 2700 = -250:
 *             Diet break 2700 -> 2450, Cut 2 2200 -> 1950. Basis 2700 -> 2450.
 *   slot      the check-in sits beside the weekly card; a second check-in in
 *             the same week is refused
 *   hand edit before the tap: Cut 2 set to 2100 by hand. The tap leaves it.
 *   tap       profile 2050, Cut 1 2050, Diet break 2450, Cut 2 still 2100, basis 2450
 *   undo      profile 2200 with its four numbers, Cut 1 2200, Diet break 2700
 *             with its own macros, Cut 2 still 2100, basis 2700
 *   facts     card facts still read one card a week: the weekly one
 */
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { cleanupOnCrash } from './_cleanup.mts';
import { checkinCooldown, decideEnergyCard, type EnergyFacts } from '../../supabase/functions/_shared/dronaEnergy.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UID = 'user_probe_checkin_v1';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = (sub: string) => {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ sub, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 900 });
  return `${h}.${p}.${crypto.createHmac('sha256', env.SUPABASE_JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
};
const me = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${tokenFor(UID)}` } },
});
cleanupOnCrash(() => db.rpc('delete_user_data', { p_user_id: UID }));
let fails = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
};
const must = <T,>(r: { data: T; error: any }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const AS_OF = '2026-08-12', WEEK = '2026-08-10', LAST = '2026-08-03';
await db.rpc('delete_user_data', { p_user_id: UID });
must(await db.from('user_profiles').insert({
  clerk_user_id: UID, timezone: 'UTC', tier: 'annual',
  daily_calorie_target: 2200, protein_target_g: 150, carb_target_g: 220, fat_target_g: 70,
}), 'profile');
// No rebuild during the read: the facts below are the ones under test.
must(await db.from('drona_facts_runs').insert({ user_id: UID, last_day_done: AS_OF, runs: 1 }), 'facts run');
const prog = must(await db.from('coach_programs').insert({
  user_id: UID, title: 'Probe cut', goal: 'fat_loss', start_date: '2026-07-06', status: 'active', created_at: '2026-07-06T09:00:00Z',
}).select('id').single(), 'program') as any;
const phase = (seq: number, name: string, offset: number, weeks: number, kcal: number, p: number, c: number, f: number) => ({
  program_id: prog.id, user_id: UID, seq, name, start_offset_weeks: offset, duration_weeks: weeks,
  diet_calorie_target: kcal, diet_protein_g: p, diet_carb_g: c, diet_fat_g: f,
});
const phases = must(await db.from('coach_program_phases').insert([
  phase(1, 'Cut 1', 0, 6, 2200, 150, 220, 70),
  phase(2, 'Diet break', 6, 2, 2700, 150, 345, 80),
  phase(3, 'Cut 2', 8, 4, 2200, 150, 220, 70),
]).select('id, seq'), 'phases') as any[];
const ph = (seq: number) => phases.find((x) => x.seq === seq).id as string;
must(await db.from('drona_week_facts').insert([
  { user_id: UID, week_start: '2026-07-06', m_guess_kcal: 2700, m_estimate_kcal: 2700 },
  { user_id: UID, week_start: LAST, m_estimate_kcal: 2450, m_bmr_kcal: 1700, m_source: 'learning' },
]), 'week facts');
must(await db.from('drona_behaviours').insert({
  user_id: UID, week_start: LAST, behaviour: 'calories_off', priority: 16, card_kind: 'act', rule_version: 3,
  detail: { estimate_kcal: 2450, suggested_kcal: 2050, floor_kcal: 1700, goal_kg: 76, pace_kg_per_week: -0.4,
            trend_rate_kg_per_week: -0.2, readings: 10, whole_days: 16, source: 'learning' },
}), 'behaviour');

// What the card worker reads.
const f = must(await db.rpc('get_drona_energy_facts', { p_user_id: UID, p_as_of: AS_OF }), 'energy facts') as EnergyFacts;
ok('the read names last week, the estimate and the running phase', f.week_start === LAST && f.estimate_kcal === 2450 && f.phase_id === ph(1), [f.week_start, f.estimate_kcal]);
ok('the program basis is the formula guess of the week it was made, 2700', f.program?.basis_kcal === 2700, f.program?.basis_kcal);
ok('the future phases: Diet break and Cut 2, not the running Cut 1',
  JSON.stringify((f.program?.phases ?? []).map((p) => [p.name, p.kcal])) === '[["Diet break",2700],["Cut 2",2200]]', f.program?.phases);

// The card the shared rules make from it, as the worker does.
const card = decideEnergyCard(f, checkinCooldown(f.cards, WEEK))!;
const pl = card.payload as any;
ok('the card: 2200 -> 2050, an act card on calories', card.kind === 'act' && card.topic === 'calories' && pl.from_kcal === 2200 && pl.to_kcal === 2050, pl);
ok('the phases move by -250: Diet break 2450, Cut 2 1950; basis 2700 -> 2450',
  JSON.stringify(pl.phases.map((p: any) => [p.name, p.from_kcal, p.to_kcal])) === '[["Diet break",2700,2450],["Cut 2",2200,1950]]'
  && pl.basis_from_kcal === 2700 && pl.basis_to_kcal === 2450 && pl.program_id === prog.id, pl.phases);
ok('the card says so', card.body.includes('Your next phases move with it: Diet break 2700 to 2450, Cut 2 2200 to 1950.'), card.body);

const row = (slot: string, c: any) => ({ user_id: UID, week_start: WEEK, slot, kind: c.kind, topic: c.topic, title: c.title, body: c.body,
  evidence: c.evidence, payload: c.payload, signals: c.signals, source: 'app' });
const saved = must(await db.from('drona_cards').insert(row('calories', card)).select('id').single(), 'check-in') as any;
const weekly = must(await db.from('drona_cards').insert(row('weekly', { kind: 'notice', topic: 'watching', title: 'Reading', body: 'Reading.', evidence: [], payload: {}, signals: [] })).select('id').single(), 'weekly') as any;
const again = await db.from('drona_cards').insert(row('calories', card));
ok('the check-in sits beside the weekly card; a second one the same week is refused', !!weekly.id && (again.error as any)?.code === '23505', again.error?.message);
ok('a second check-in that same week is now on cooldown', checkinCooldown([{ week_start: WEEK, topic: 'calories', status: 'pending' }], WEEK)('calories') === true);

// A hand edit before the tap: Cut 2 to 2100.
must(await db.from('coach_program_phases').update({ diet_calorie_target: 2100 }).eq('id', ph(3)), 'hand edit');

const readAll = async () => {
  const p = must(await db.from('user_profiles').select('daily_calorie_target, protein_target_g, carb_target_g, fat_target_g').eq('clerk_user_id', UID).single(), 'p') as any;
  const ps = must(await db.from('coach_program_phases').select('seq, diet_calorie_target, diet_protein_g, diet_carb_g, diet_fat_g').eq('program_id', prog.id).order('seq'), 'ps') as any[];
  const pr = must(await db.from('coach_programs').select('maintenance_basis_kcal').eq('id', prog.id).single(), 'pr') as any;
  const c = must(await db.from('drona_cards').select('status').eq('id', saved.id).single(), 'c') as any;
  return { p, ps, basis: pr.maintenance_basis_kcal, status: c.status };
};

const applied = must(await me.rpc('drona_apply_targets', { p_card_id: saved.id }), 'apply');
const a = await readAll();
ok('the tap, signed in as the person: ok', applied === 'ok', applied);
ok('profile 2050 with macros on its own split', a.p.daily_calorie_target === 2050 && a.p.protein_target_g + a.p.carb_target_g + a.p.fat_target_g > 0, a.p);
ok('Cut 1 (running) 2050, Diet break 2450, Cut 2 kept at the hand edit 2100',
  JSON.stringify(a.ps.map((x: any) => x.diet_calorie_target)) === '[2050,2450,2100]', a.ps.map((x: any) => x.diet_calorie_target));
ok('the program now assumes 2450; the card is applied', a.basis === 2450 && a.status === 'applied', [a.basis, a.status]);

const undone = must(await me.rpc('drona_undo_targets', { p_card_id: saved.id }), 'undo');
const u = await readAll();
ok('Undo: ok, profile back to 2200 / 150 / 220 / 70', undone === 'ok'
  && JSON.stringify([u.p.daily_calorie_target, u.p.protein_target_g, u.p.carb_target_g, u.p.fat_target_g]) === '[2200,150,220,70]', u.p);
ok('Undo: Cut 1 2200, Diet break 2700 with its own macros, Cut 2 still the hand edit',
  JSON.stringify(u.ps.map((x: any) => [x.diet_calorie_target, x.diet_carb_g])) === '[[2200,220],[2700,345],[2100,220]]', u.ps);
ok('Undo: basis back to 2700, card undone', u.basis === 2700 && u.status === 'undone', [u.basis, u.status]);

must(await db.rpc('drona_rebuild_card_facts', { p_user_id: UID, p_from: WEEK, p_to: WEEK }), 'card facts');
const wf = must(await db.from('drona_week_facts').select('c_card_id').eq('user_id', UID).eq('week_start', WEEK).single(), 'wf') as any;
ok('card facts read one card a week: the weekly one', wf.c_card_id === weekly.id, wf.c_card_id);

await db.rpc('delete_user_data', { p_user_id: UID });
const left = must(await db.from('drona_cards').select('id').eq('user_id', UID), 'left') as any[];
ok('delete_user_data cleans up', left.length === 0, left.length);

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
if (fails) process.exitCode = 1;
