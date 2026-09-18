// Live checks for the permanent swap (migration 0124 + _shared/dronaSwap.ts).
// Runs against the LIVE project with a made-up user, then deletes it.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { decideSwap, swapCard } from '../../supabase/functions/_shared/dronaSwap.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url),'utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).trim()]));
const UID = 'user_probe_swap_20260918';
const OTHER = 'user_probe_swap_other_20260918';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now()/1000);
const tokenFor = (sub: string) => {
  const h = b64({alg:'HS256',typ:'JWT'});
  const p = b64({sub, role:'authenticated', aud:'authenticated', iat:now, exp:now+900});
  return h+'.'+p+'.'+crypto.createHmac('sha256', env.SUPABASE_JWT_SECRET).update(h+'.'+p).digest('base64url');
};
const clientFor = (sub: string) => createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, { global:{headers:{Authorization:'Bearer '+tokenFor(sub)}}, auth:{persistSession:false} });
const db = clientFor(UID);
const other = clientFor(OTHER);
const anon = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, { auth:{persistSession:false} });
const service = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });

for (const uid of [UID, OTHER]) await service.rpc('delete_user_data', { p_user_id: uid });
let fails = 0;
const ok = (n: string, c: boolean, d?: unknown) => { if(!c) fails++; console.log((c?'PASS ':'FAIL ')+n+(d===undefined?'':'  '+JSON.stringify(d))); };
const day = (back: number) => new Date(Date.now() - back*86400000).toISOString();
const today = new Date().toISOString().slice(0,10);
const slotNow = async () => (await service.from('routine_exercises').select('exercise_id').eq('routine_id', rid).eq('"order"', 0).single()).data?.exercise_id;

// Two exercises for the SAME muscle (the swap) and one for another (the rest of the day).
const pair = (await service.from('exercises').select('id, name, muscle_group').is('created_by', null).eq('muscle_group', 'Back').limit(2)).data!;
const legs = (await service.from('exercises').select('id, name').is('created_by', null).eq('muscle_group', 'Quads').limit(1)).data![0];
ok('found two Back exercises and one Quads exercise', pair?.length === 2 && !!legs, { pair: pair?.map(p=>p.name), legs: legs?.name });
const PLANNED = pair[0], STAND_IN = pair[1];

const prof = await service.from('user_profiles').upsert(
  [{ clerk_user_id: UID, goal: 'hypertrophy' }, { clerk_user_id: OTHER, goal: 'hypertrophy' }],
  { onConflict: 'clerk_user_id' });
ok('both probe profiles exist', !prof.error, prof.error?.message);

const r = await db.from('routines').insert({ user_id: UID, name: 'Pull A' }).select('id').single();
ok('routine created', !r.error, r.error?.message);
const rid = r.data!.id as string;
await db.from('routine_exercises').insert([
  { routine_id: rid, exercise_id: PLANNED.id, sets: 3, order: 0 },
  { routine_id: rid, exercise_id: legs.id, sets: 3, order: 1 },
]);

// Four finished sessions of that routine, each doing the STAND-IN, never the planned one.
for (let i = 0; i < 4; i++) {
  const w = await db.from('workouts').insert({
    user_id: UID, routine_id: rid, name: 'Pull A',
    started_at: day(3 + i*3), finished_at: day(3 + i*3), duration_seconds: 3000,
  }).select('id').single();
  await db.from('workout_sets').insert([
    { workout_id: w.data!.id, exercise_id: STAND_IN.id, weight_kg: 60, reps: 10, completed: true, order: 0 },
    { workout_id: w.data!.id, exercise_id: legs.id, weight_kg: 80, reps: 8, completed: true, order: 1 },
  ]);
}

const facts = (await service.rpc('get_drona_swap_facts', { p_user_id: UID, p_as_of: today })).data as any;
ok('facts return the routine with its plan and 4 sessions',
  facts?.routines?.length === 1 && facts.routines[0].plan.length === 2 && facts.routines[0].sessions.length === 4,
  { routines: facts?.routines?.length, sessions: facts?.routines?.[0]?.sessions?.length });
ok('facts say the auto-adjust setting is on by default', facts?.auto_adjust === true);
ok('the newest session is first', facts.routines[0].sessions[0].on > facts.routines[0].sessions[3].on, facts.routines[0].sessions.map((s:any)=>s.on));

const decision = decideSwap(facts);
ok('the rules call it an automatic swap', decision.move === 'auto', decision.move);
ok('the pair is the planned one for the stand-in',
  decision.candidate?.from_exercise_id === PLANNED.id && decision.candidate?.to_exercise_id === STAND_IN.id,
  { from: decision.candidate?.from_name, to: decision.candidate?.to_name });
ok('the run is 4 sessions', decision.candidate?.run === 4);

// The slot the card names must be the real routine_exercises row.
const card = swapCard(decision.candidate!, 'auto');
const slotRow = (await service.from('routine_exercises').select('id').eq('id', card.payload.routine_exercise_id).maybeSingle()).data;
ok('the card names a real routine slot', !!slotRow);

const savedRes = await service.from('drona_cards').insert({
  user_id: UID, week_start: today, kind: card.kind, topic: card.topic, title: card.title,
  body: card.body, evidence: card.evidence, payload: card.payload, signals: card.signals,
  facts, source: 'app',
}).select('id').single();
ok('the notice card saves', !savedRes.error, savedRes.error?.message);
const cardId = savedRes.data!.id as string;

// ── Access ───────────────────────────────────────────────────────────────────
ok('anon cannot read the facts', !!(await anon.rpc('get_drona_swap_facts', { p_user_id: UID, p_as_of: today })).error);
ok('a signed-in user cannot read anyone\'s facts', !!(await db.rpc('get_drona_swap_facts', { p_user_id: UID, p_as_of: today })).error);
ok('a signed-in user cannot call the worker\'s auto-apply', !!(await db.rpc('drona_swap_autoapply', { p_card_id: cardId })).error);
ok('another user cannot apply this card', (await other.rpc('drona_apply_swap', { p_card_id: cardId })).data === 'forbidden');
ok('another user cannot undo this card', (await other.rpc('drona_undo_swap', { p_card_id: cardId })).data === 'forbidden');
ok('the slot is untouched after those attempts', await slotNow() === PLANNED.id);

// ── Apply ────────────────────────────────────────────────────────────────────
const applied = await service.rpc('drona_swap_autoapply', { p_card_id: cardId })
  .setHeader('x-change-source', 'card').setHeader('x-change-card', cardId);
ok('the worker applies the swap', applied.data === 'ok', applied.data ?? applied.error?.message);
ok('the routine now holds the stand-in', await slotNow() === STAND_IN.id);

const changes = (await service.from('plan_changes').select('entity, action, changes, source, card_id').eq('user_id', UID).order('id')).data ?? [];
const swapLog = changes.filter((c: any) => c.entity === 'routine_exercises' && c.source === 'card');
ok('the plan change log records it as a card change with the card id',
  swapLog.length === 1 && swapLog[0].card_id === cardId, swapLog);
ok('the log names both exercises: one removed, one added',
  swapLog[0]?.changes?.removed?.[0]?.name === PLANNED.name && swapLog[0]?.changes?.added?.[0]?.name === STAND_IN.name,
  swapLog[0]?.changes);
ok('the card is still pending, so the user still sees the notice',
  (await service.from('drona_cards').select('status').eq('id', cardId).single()).data?.status === 'pending');

// Applying twice must not move anything: the slot no longer holds the old one.
ok('a replayed apply answers ok, so a retry cannot read as a failure',
  (await service.rpc('drona_swap_autoapply', { p_card_id: cardId })).data === 'ok');

// ── Undo ─────────────────────────────────────────────────────────────────────
const undone = await db.rpc('drona_undo_swap', { p_card_id: cardId });
ok('the user can undo their own card', undone.data === 'ok', undone.data ?? undone.error?.message);
ok('the planned exercise is back', await slotNow() === PLANNED.id);
ok('the card is closed', (await service.from('drona_cards').select('status').eq('id', cardId).single()).data?.status === 'dismissed');
ok('a replayed undo answers ok too', (await db.rpc('drona_undo_swap', { p_card_id: cardId })).data === 'ok');
ok('a card the user already answered is never re-applied by the worker',
  (await service.rpc('drona_swap_autoapply', { p_card_id: cardId })).data === 'already_decided');

// ── A hand edit wins ─────────────────────────────────────────────────────────
const card2 = (await service.from('drona_cards').insert({
  user_id: UID, week_start: '2026-01-05', kind: 'act', topic: 'swap', title: 'x', body: 'y',
  evidence: [], payload: { ...card.payload, action: 'apply_swap' }, signals: [], facts: {}, source: 'app',
}).select('id').single()).data!;
await db.from('routine_exercises').update({ exercise_id: legs.id }).eq('id', card.payload.routine_exercise_id);
ok('a card cannot overwrite the user\'s own later edit',
  (await db.rpc('drona_apply_swap', { p_card_id: card2.id })).data === 'moved_on');
ok('the hand edit stands', await slotNow() === legs.id);

// ── Sessions that are not a swap ─────────────────────────────────────────────
await db.from('routine_exercises').update({ exercise_id: PLANNED.id }).eq('id', card.payload.routine_exercise_id);
const w = await db.from('workouts').insert({
  user_id: UID, routine_id: rid, name: 'Pull A', started_at: day(0), finished_at: day(0), duration_seconds: 3000,
}).select('id').single();
await db.from('workout_sets').insert([
  { workout_id: w.data!.id, exercise_id: PLANNED.id, weight_kg: 60, reps: 10, completed: true, order: 0 },
  { workout_id: w.data!.id, exercise_id: legs.id, weight_kg: 80, reps: 8, completed: true, order: 1 },
]);
const facts2 = (await service.rpc('get_drona_swap_facts', { p_user_id: UID, p_as_of: today })).data as any;
ok('one session back on plan breaks the run', decideSwap(facts2).move === 'none', decideSwap(facts2).move);

// Sets left UNCOMPLETED do not count as performed.
const w2 = await db.from('workouts').insert({
  user_id: UID, routine_id: rid, name: 'Pull A', started_at: day(0), finished_at: day(0), duration_seconds: 10,
}).select('id').single();
await db.from('workout_sets').insert([{ workout_id: w2.data!.id, exercise_id: STAND_IN.id, weight_kg: 60, reps: 10, completed: false, order: 0 }]);
const facts3 = (await service.rpc('get_drona_swap_facts', { p_user_id: UID, p_as_of: today })).data as any;
const newest = facts3.routines[0].sessions.find((s: any) => s.workout_id === w2.data!.id);
ok('an opened-but-empty session counts as nothing performed', newest?.performed?.length === 0, newest);

for (const uid of [UID, OTHER]) await service.rpc('delete_user_data', { p_user_id: uid });
ok('cleanup', ((await service.from('drona_cards').select('id').eq('user_id', UID)).data?.length ?? 0) === 0
  && ((await service.from('plan_changes').select('id').eq('user_id', UID)).data?.length ?? 0) === 0);
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
if (fails > 0) process.exitCode = 1;
