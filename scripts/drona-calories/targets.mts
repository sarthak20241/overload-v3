// Live checks for B1's data and moves (migration 0130) with a made-up user,
// removed afterwards with delete_user_data. The model is NOT called here; the
// gate and the card are exercised on the real facts the database returns.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { calorieGate, caloriesCard } from '../../supabase/functions/_shared/dronaCalories.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url),'utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).trim()]));
const UID = 'user_probe_calories_20260919';
const OTHER = 'user_probe_calories_other_20260919';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now()/1000);
const tokenFor = (sub: string) => { const h=b64({alg:'HS256',typ:'JWT'}), p=b64({sub, role:'authenticated', aud:'authenticated', iat:now, exp:now+900}); return h+'.'+p+'.'+crypto.createHmac('sha256', env.SUPABASE_JWT_SECRET).update(h+'.'+p).digest('base64url'); };
const clientFor = (sub: string) => createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, { global:{headers:{Authorization:'Bearer '+tokenFor(sub)}}, auth:{persistSession:false} });
const db = clientFor(UID), other = clientFor(OTHER);
const service = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
for (const uid of [UID, OTHER]) await service.rpc('delete_user_data', { p_user_id: uid });
let fails = 0;
const ok = (n: string, c: boolean, d?: unknown) => { if(!c) fails++; console.log((c?'PASS ':'FAIL ')+n+(d===undefined?'':'  '+JSON.stringify(d))); };
const today = new Date().toISOString().slice(0,10);
const dayISO = (back: number) => new Date(Date.now() - back*86400000).toISOString().slice(0,10);
const targets = async () => (await service.from('user_profiles').select('daily_calorie_target, protein_target_g, carb_target_g, fat_target_g').eq('clerk_user_id', UID).single()).data!;

// A Pro user on a cut, 2100 kcal, who logs 12 of 14 days near target and whose weight has held.
const prof = await service.from('user_profiles').upsert([
  { clerk_user_id: UID, goal: 'fat_loss', tier: 'annual', gender: 'M', height_cm: 178, weight_kg: 72.4, date_of_birth: '1996-03-01',
    goal_weight_kg: 68, daily_calorie_target: 2100, protein_target_g: 150, carb_target_g: 210, fat_target_g: 60, timezone: 'Asia/Kolkata' },
  { clerk_user_id: OTHER, goal: 'fat_loss', tier: 'free' },
], { onConflict: 'clerk_user_id' });
ok('probe profiles exist', !prof.error, prof.error?.message);
// A calorie change 21 days ago, from chat: the diary row the model will read.
await service.from('plan_changes').insert({ user_id: UID, entity: 'targets', entity_id: UID, action: 'changed', source: 'chat',
  changes: { daily_calorie_target: { from: 2250, to: 2100 } }, occurred_at: new Date(Date.now() - 21*86400000).toISOString() });
const food = Array.from({ length: 14 }, (_, i) => i).filter((i) => i !== 3 && i !== 9).map((i) => ({ user_id: UID, day: dayISO(i), kcal: 2080 + (i % 3) * 40, protein_g: 145, carb_g: 200, fat_g: 60, entry_count: 3 }));
await service.from('user_nutrition_stats').insert(food);
const weights = Array.from({ length: 10 }, (_, i) => ({ user_id: UID, metric_date: dayISO(i), metric_type: 'bodyweight_kg', value: 72.4 + ((i % 2) ? 0.1 : -0.1), source: 'manual' }));
await service.from('daily_metrics').insert(weights);

// ── Facts ────────────────────────────────────────────────────────────────────
const monday = (() => { const d = new Date(Date.now() + 5.5*3600000); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0,10); })();
const facts = (await service.rpc('get_drona_facts', { p_user_id: UID, p_as_of: today, p_week_start: monday })).data as any;
const diet = (await service.rpc('get_drona_diet_facts', { p_user_id: UID, p_as_of: today })).data as any;
ok('diet facts carry the body, the four targets and the tier', diet?.body?.gender === 'M' && diet.targets.kcal === 2100 && diet.tier === 'annual', { body: diet?.body, targets: diet?.targets });
ok('food series: 12 days, newest first', diet.food.length === 12 && diet.food[0].day > diet.food[11].day, diet.food.length);
ok('weight series: 10 readings', diet.weight.length === 10);
ok('the diary row is there: 2250 -> 2100 by chat, 21 days ago', diet.target_changes.length === 1 && diet.target_changes[0].from === 2250 && diet.target_changes[0].source === 'chat' && diet.days_since_target_change === 21, diet.target_changes);
ok('weekly facts agree: 12 logged, 12 near target, 10 weigh-ins', facts.nutrition.days_logged_14d === 12 && facts.nutrition.on_target_days_14d === 12 && facts.weight.weigh_ins_14d === 10, facts.nutrition);

// The gate, on real numbers. (The tenure gate is the worker's; this user has no sessions.)
const gate = calorieGate(facts, diet);
ok('the gate opens on this week', gate.eligible, gate.reasons);
// The profile's weight follows the newest scale reading (0119), so the floor
// is Mifflin-St Jeor on THAT weight, not the one the profile was seeded with.
const expectedFloor = Math.round(10 * diet.body.weight_kg + 6.25 * 178 - 5 * 30 + 5);
ok(`anchor: 2100 -> 1950, floor ${expectedFloor} (Mifflin-St Jeor on the synced weight)`, gate.anchor?.from === 2100 && gate.anchor?.to === 1950 && gate.anchor?.floor === expectedFloor, gate.anchor);

// ── The card and the move ────────────────────────────────────────────────────
const card = caloriesCard(facts, diet, 1950, 'Twelve of fourteen days logged within a hundred of 2100 and the scale has held two weeks. The last cut worked for a while. Try 1950.');
const saved = await service.from('drona_cards').insert({ user_id: UID, week_start: monday, kind: card.kind, topic: card.topic, title: card.title, body: card.body,
  evidence: card.evidence, payload: card.payload, signals: card.signals, facts: {}, source: 'app' }).select('id').single();
ok('the act card saves', !saved.error, saved.error?.message);
const cardId = saved.data!.id as string;

ok('anon cannot read diet facts', !!(await createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY).rpc('get_drona_diet_facts', { p_user_id: UID, p_as_of: today })).error);
ok('another user cannot apply this card', (await other.rpc('drona_apply_targets', { p_card_id: cardId })).data === 'forbidden');
ok('targets untouched by that', (await targets()).daily_calorie_target === 2100);

const applied = await db.rpc('drona_apply_targets', { p_card_id: cardId }).setHeader('x-change-source', 'card').setHeader('x-change-card', cardId);
ok('the owner applies the card', applied.data === 'ok', applied.data ?? applied.error?.message);
let t = await targets();
ok('calories are 1950', t.daily_calorie_target === 1950, t);
const sum = t.protein_target_g * 4 + t.carb_target_g * 4 + t.fat_target_g * 9;
ok('the four numbers add up (within rounding)', Math.abs(sum - 1950) <= 4, { sum, t });
ok('the split is kept: protein stays about 29% of energy', Math.abs(t.protein_target_g * 4 / 1950 - 0.29) < 0.02, t.protein_target_g);
const logged = (await service.from('plan_changes').select('source, card_id, changes').eq('user_id', UID).eq('entity', 'targets').order('id', { ascending: false }).limit(1)).data?.[0];
ok('the diary records it as a card change with the card id', logged?.source === 'card' && logged?.card_id === cardId && logged?.changes?.daily_calorie_target?.to === 1950, logged);
ok('the card is applied', (await service.from('drona_cards').select('status').eq('id', cardId).single()).data?.status === 'applied');
ok('a replayed apply is ok', (await db.rpc('drona_apply_targets', { p_card_id: cardId })).data === 'already_decided');

const undone = await db.rpc('drona_undo_targets', { p_card_id: cardId }).setHeader('x-change-source', 'card').setHeader('x-change-card', cardId);
ok('the owner undoes it', undone.data === 'ok', undone.data ?? undone.error?.message);
t = await targets();
ok('the exact four numbers are back', t.daily_calorie_target === 2100 && t.protein_target_g === 150 && t.carb_target_g === 210 && t.fat_target_g === 60, t);
ok('the card is undone', (await service.from('drona_cards').select('status').eq('id', cardId).single()).data?.status === 'undone');
ok('apply and undo cancel in the diary', ((await service.from('plan_changes').select('id').eq('user_id', UID).eq('entity', 'targets').eq('source', 'card')).data?.length ?? 0) === 0);

// A hand edit wins.
await service.from('drona_cards').update({ status: 'pending', decided_at: null }).eq('id', cardId);
await db.from('user_profiles').update({ daily_calorie_target: 2000 }).eq('clerk_user_id', UID);
ok('a card cannot overwrite the user\'s own later edit', (await db.rpc('drona_apply_targets', { p_card_id: cardId })).data === 'moved_on');
ok('the hand edit stands', (await targets()).daily_calorie_target === 2000);

// The gate closes when it should.
await service.from('user_profiles').update({ tier: 'free' }).eq('clerk_user_id', UID);
const dietFree = (await service.rpc('get_drona_diet_facts', { p_user_id: UID, p_as_of: today })).data as any;
ok('a free user is gated out', calorieGate(facts, dietFree).reasons.includes('not_pro'));

for (const uid of [UID, OTHER]) await service.rpc('delete_user_data', { p_user_id: uid });
ok('cleanup', ((await service.from('drona_cards').select('id').eq('user_id', UID)).data?.length ?? 0) === 0);
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
if (fails > 0) process.exitCode = 1;
