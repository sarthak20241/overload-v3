import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url),'utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).trim()]));
const UID = 'user_probe_planlog_20260917';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now()/1000);
const h = b64({alg:'HS256',typ:'JWT'}), p = b64({sub:UID, role:'authenticated', aud:'authenticated', iat:now, exp:now+900});
const sig = crypto.createHmac('sha256', env.SUPABASE_JWT_SECRET).update(h+'.'+p).digest('base64url');
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, { global:{headers:{Authorization:'Bearer '+h+'.'+p+'.'+sig}}, auth:{persistSession:false} });
const service = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
let fails = 0;
const ok = (n: string, c: boolean, d?: unknown) => { if(!c) fails++; console.log((c?'PASS ':'FAIL ')+n+(d===undefined?'':'  '+JSON.stringify(d))); };
const log = async () => (await db.from('plan_changes').select('entity, action, changes, source, label, card_id').order('id')).data ?? [];
const rowsFor = async (entity: string) => (await log()).filter((r: any) => r.entity === entity);

const ins = await db.from('user_profiles').insert({ clerk_user_id: UID, daily_calorie_target: 2250, protein_target_g: 150, goal: 'fat_loss' });
ok('profile insert works with the trigger', !ins.error, ins.error?.message);
const t0 = await rowsFor('targets');
ok('starting targets logged as created', t0.length === 1 && t0[0].action === 'created' && t0[0].changes.daily_calorie_target === 2250, t0);

const chat = await db.from('user_profiles').update({ daily_calorie_target: 2100 }).eq('clerk_user_id', UID).setHeader('x-change-source', 'chat');
ok('chat update works', !chat.error, chat.error?.message);
let t = (await rowsFor('targets')).filter((r: any) => r.action === 'changed');
ok('change 2250 to 2100 recorded, source chat', t.length === 1 && t[0].source === 'chat' && t[0].changes.daily_calorie_target.from === 2250 && t[0].changes.daily_calorie_target.to === 2100, t);

for (const v of [7, 76]) await db.from('user_profiles').update({ goal_weight_kg: v }).eq('clerk_user_id', UID);
const g = (await rowsFor('goal')).filter((r: any) => r.action === 'changed');
ok('typing 7 then 76 is ONE change, null to 76, manual', g.length === 1 && g[0].source === 'manual' && g[0].changes.goal_weight_kg.from === null && g[0].changes.goal_weight_kg.to === 76, g);

await db.from('user_profiles').update({ protein_target_g: 160 }).eq('clerk_user_id', UID);
await db.from('user_profiles').update({ protein_target_g: 150 }).eq('clerk_user_id', UID);
t = (await rowsFor('targets')).filter((r: any) => r.action === 'changed' && r.source === 'manual');
ok('150 to 160 and back leaves no manual change', t.length === 0, t);

const card = crypto.randomUUID();
await db.from('user_profiles').update({ daily_calorie_target: 2000 }).eq('clerk_user_id', UID).setHeader('x-change-source', 'card').setHeader('x-change-card', card);
t = (await rowsFor('targets')).filter((r: any) => r.source === 'card');
ok('card change tagged with its card id', t.length === 1 && t[0].card_id === card && t[0].changes.daily_calorie_target.from === 2100, t);

const ex = (await service.from('exercises').select('id, name').is('created_by', null).limit(4)).data!;
const r = await db.from('routines').insert({ user_id: UID, name: 'Legs + Abs' }).select('id').single();
ok('routine insert works', !r.error, r.error?.message);
const rid = r.data!.id;
const save = async (list: { id: string; sets: number; order: number }[], source = 'manual') => {
  const d = await db.from('routine_exercises').delete().eq('routine_id', rid).setHeader('x-change-source', source);
  if (d.error) console.log('delete error', d.error.message);
  const i = await db.from('routine_exercises').insert(list.map((e) => ({ routine_id: rid, exercise_id: e.id, sets: e.sets, reps_min: 8, reps_max: 12, rest_seconds: 90, order: e.order }))).setHeader('x-change-source', source);
  if (i.error) console.log('insert error', i.error.message);
};
await save([{ id: ex[0].id, sets: 4, order: 0 }, { id: ex[1].id, sets: 3, order: 1 }, { id: ex[2].id, sets: 3, order: 2 }], 'onboarding');
let re = await rowsFor('routine_exercises');
ok('first save logs 3 exercises added', re.length === 1 && re[0].changes.added?.length === 3 && re[0].label === 'Legs + Abs', re.map((x: any) => x.changes));
ok('routine creation logged', (await rowsFor('routine')).some((x: any) => x.action === 'created' && x.label === 'Legs + Abs'));

await save([{ id: ex[0].id, sets: 4, order: 0 }, { id: ex[1].id, sets: 3, order: 1 }, { id: ex[2].id, sets: 3, order: 2 }], 'onboarding');
re = await rowsFor('routine_exercises');
ok('an unchanged save (delete all + insert all) logs nothing', re.length === 1, re.length);

await save([{ id: ex[2].id, sets: 3, order: 0 }, { id: ex[0].id, sets: 3, order: 1 }, { id: ex[3].id, sets: 2, order: 2 }]);
re = await rowsFor('routine_exercises');
const last = re[re.length - 1]?.changes ?? {};
ok('edit logs exactly one entry', re.length === 2, re.length);
ok('removed the dropped exercise', last.removed?.length === 1 && last.removed[0].name === ex[1].name, last.removed);
ok('added the new exercise', last.added?.length === 1 && last.added[0].name === ex[3].name, last.added);
ok('sets 4 to 3 recorded', last.changed?.length === 1 && last.changed[0].fields.sets.from === 4 && last.changed[0].fields.sets.to === 3, last.changed);
ok('reorder noticed', last.reordered === true, last.reordered);

// Chat builds a routine one exercise per request: six requests, one entry.
const r2 = await db.from('routines').insert({ user_id: UID, name: 'Chat Push' }).select('id').single().setHeader('x-change-source', 'chat');
const more = (await service.from('exercises').select('id').is('created_by', null).range(10, 15)).data!;
for (const [i, e] of more.entries()) {
  await db.from('routine_exercises').insert({ routine_id: r2.data!.id, exercise_id: e.id, sets: 3, reps_min: 8, reps_max: 12, rest_seconds: 60, order: i }).setHeader('x-change-source', 'chat');
}
const chatRows = (await rowsFor('routine_exercises')).filter((x: any) => x.label === 'Chat Push');
ok('six one-by-one chat inserts fold into ONE entry with 6 added', chatRows.length === 1 && chatRows[0].changes.added?.length === 6 && chatRows[0].source === 'chat', chatRows.map((x: any) => x.changes.added?.length));

const prog = await db.from('coach_programs').insert({ user_id: UID, title: '12-week cut', objective: 'Lose fat', goal: 'fat_loss', start_date: '2026-09-14', status: 'active', total_weeks: 12, target_weight_kg: 68 }).select('id').single();
ok('program insert works', !prog.error, prog.error?.message);
const ph = await db.from('coach_program_phases').insert({ program_id: prog.data?.id, user_id: UID, seq: 0, name: 'Base', duration_weeks: 4, start_offset_weeks: 0, diet_calorie_target: 2200 }).select('id').single();
ok('phase insert works', !ph.error, ph.error?.message);
await db.from('coach_program_phases').update({ duration_weeks: 6 }).eq('id', ph.data?.id).setHeader('x-change-source', 'card');
const phases = await rowsFor('phase');
ok('phase created, then stretched 4 to 6 weeks by a card', phases.some((x: any) => x.action === 'created' && x.label === 'Base') && phases.some((x: any) => x.action === 'changed' && x.source === 'card' && x.changes.duration_weeks?.to === 6), phases);

const forge = await db.from('plan_changes').insert({ user_id: UID, entity: 'targets', action: 'changed', source: 'manual', changes: {} });
ok('a user cannot write the log', !!forge.error, forge.error?.code);
const others = await db.from('plan_changes').select('id').neq('user_id', UID).limit(1);
ok('a user cannot read other logs', (others.data?.length ?? 0) === 0);
const snap = await db.from('routine_snapshots').select('routine_id').limit(1);
ok('a user cannot read snapshots', !!snap.error || (snap.data?.length ?? 0) === 0, snap.error?.code);
const bad = await db.from('user_profiles').update({ goal_focus_areas: ['abs', 'wings'] }).eq('clerk_user_id', UID);
ok('an unknown focus area is refused', !!bad.error, bad.error?.code);
await db.from('user_profiles').update({ goal_focus_areas: ['abs', 'glutes'] }).eq('clerk_user_id', UID);
ok('focus areas change logged', (await rowsFor('goal')).some((x: any) => JSON.stringify(x.changes.goal_focus_areas?.to) === '["abs","glutes"]'));

await service.rpc('delete_user_data', { p_user_id: UID });
const left = await service.from('plan_changes').select('id').eq('user_id', UID);
ok('account deletion clears the log', (left.data?.length ?? 0) === 0, left.data?.length);
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
