/**
 * What the weekly Drona card would say, for every person, with nothing
 * written: the judged week's behaviours and get_drona_facts go through the same
 * decidePick (then the P0 fallback, with the mutes) the card worker calls.
 *
 *   npx tsx scripts/drona-facts/pick-cards-dryrun.mts             # this week's card
 *   CARD_WEEK=2026-10-05 npx tsx scripts/drona-facts/pick-cards-dryrun.mts
 *
 * Read only. Unlike the worker it does not rebuild stale facts first, and it
 * skips the permanent swap (that step writes). Cards already written for
 * CARD_WEEK or later are left out of the cooldown, except that week's calorie
 * check-in (the worker writes it first), so the answer is what the worker
 * would have said on that Monday.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { decideCard, type DronaFacts, signalsFrom } from '../../supabase/functions/_shared/dronaCards.ts';
import { askedLately, decidePick, hushed, mutedTopics, type PickFacts } from '../../supabase/functions/_shared/dronaPick.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const monday = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const cardWeek = process.env.CARD_WEEK ?? monday(new Date());
const judged = new Date(Date.parse(cardWeek + 'T00:00:00Z') - 7 * 86_400_000).toISOString().slice(0, 10);

const { data: behs, error } = await db.from('drona_behaviours')
  .select('user_id, behaviour, priority, card_kind, meta, mutes, detail').eq('week_start', judged);
if (error) throw error;
const users = [...new Set((behs ?? []).map((b) => b.user_id))];
const tally: Record<string, number> = {};
for (const u of users) {
  const { data: facts, error: fErr } = await db.rpc('get_drona_facts', { p_user_id: u, p_as_of: cardWeek, p_week_start: cardWeek });
  if (fErr || !facts) { console.log(`\n${u.slice(0, 13)}  facts failed: ${fErr?.message ?? 'none'}`); continue; }
  // The worker writes the check-in first, so its card this week is on the cooldown too.
  const { data: checkin } = await db.from('drona_cards').select('week_start, kind, topic, status')
    .eq('user_id', u).eq('week_start', cardWeek).eq('slot', 'calories').maybeSingle();
  const f = { ...(facts as DronaFacts), cards: [
    ...(checkin ? [{ ...checkin, status: 'pending' }] : []),
    ...((facts as DronaFacts).cards ?? []).filter((c) => (c.week_start ?? '') < cardWeek),
  ] };
  const pf: PickFacts = { week_start: judged, behaviours: (behs ?? []).filter((b) => b.user_id === u) };
  const newUser = signalsFrom(f).new_user;
  const picked = newUser ? null : decidePick(pf, f);
  const card = picked ?? hushed(decideCard(f, undefined, new Set([...mutedTopics(pf), ...askedLately(f)])), pf);
  const from = picked ? 'pick' : card.kind === 'hold' ? 'hold' : 'P0';
  tally[`${from}:${card.topic}`] = (tally[`${from}:${card.topic}`] ?? 0) + 1;
  const had = pf.behaviours!.map((b) => `${b.behaviour}${b.card_kind === 'steer' ? '(steer)' : ''}`).join(', ');
  console.log(`\n${u.slice(0, 13)}  behaviours: ${had}`);
  if (card.kind === 'hold') { console.log('  -> nothing'); continue; }
  console.log(`  -> [${from} / ${card.kind} / ${card.topic}]  ${card.title}\n     ${card.body}`
    + (card.evidence.length ? `\n     ${card.evidence.map((e) => `${e.label}: ${e.value}`).join(' | ')}` : '')
    + (card.payload.prompt ? `\n     opening line: ${card.payload.prompt}` : ''));
}
console.log(`\nCard week ${cardWeek}, judged week ${judged}: ${users.length} people with behaviours.`);
console.log(Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`).join('\n'));
