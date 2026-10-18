/**
 * What the word step would find, and which weekly card would follow, for every
 * person who wrote something in the judged week. Nothing is written: the Jev
 * answers are NOT stored, no card is made. Messages are never printed, only
 * the signals and the card Drona would say.
 *
 *   CARD_WEEK=2026-10-12 npx tsx scripts/drona-facts/words-dryrun.mts
 *
 * Use a PAST Monday: get_drona_word_facts rebuilds the facts when asked about
 * a day the daily job has not reached. Calls the live Jev API (about $0.0001 a text).
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { askJev } from '../../supabase/functions/ai-coach/jev.ts';
import { type DronaFacts, decideCard, signalsFrom } from '../../supabase/functions/_shared/dronaCards.ts';
import { askedLately, decidePick, hushed, mutedTopics, type PickFacts } from '../../supabase/functions/_shared/dronaPick.ts';
import {
  chooseTexts, QUESTIONS, questionKey, readText, stateFor, type WordFacts, wordBehaviours, wordSignals,
} from '../../supabase/functions/_shared/dronaWords.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const cardWeek = process.env.CARD_WEEK;
if (!cardWeek || cardWeek >= new Date().toISOString().slice(0, 10)) throw new Error('CARD_WEEK must be a past Monday');
const judged = new Date(Date.parse(cardWeek + 'T00:00:00Z') - 7 * 86_400_000).toISOString().slice(0, 10);
const judgedEnd = new Date(Date.parse(cardWeek + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);

const { data: writers, error } = await db.from('drona_word_facts').select('user_id')
  .gte('day', judged).lte('day', judgedEnd);
if (error) throw error;
const users = [...new Set((writers ?? []).map((w) => w.user_id))];
const questions = Object.fromEntries(Object.entries(QUESTIONS).map(([q, v]) => [questionKey(0, q), v]));
const deps = { apiKey: env.JEV_API_KEY ?? '', timeoutMs: 20_000, fetchFn: fetch };
const tally: Record<string, number> = {};

for (const u of users) {
  const { data: wf, error: wErr } = await db.rpc('get_drona_word_facts', { p_user_id: u, p_as_of: cardWeek });
  if (wErr || !wf) { console.log(`${u.slice(0, 13)}  word facts failed: ${wErr?.message}`); continue; }
  const f = wf as WordFacts;
  const texts = chooseTexts(f);
  const answers = await Promise.all(texts.map((t) => askJev(stateFor(t, texts), questions, deps)));
  if (answers.some((a) => !a.ok)) { console.log(`${u.slice(0, 13)}  Jev failed`); continue; }
  const readings = texts.map((t, i) => readText(t, 0, (answers[i] as { ok: true; response: { answers: Record<string, unknown> } }).response.answers));
  const signals = wordSignals(f, readings);
  const fired = signals.filter((s) => s.fired);

  const { data: facts } = await db.rpc('get_drona_facts', { p_user_id: u, p_as_of: cardWeek, p_week_start: cardWeek });
  const df = { ...(facts as DronaFacts), cards: ((facts as DronaFacts)?.cards ?? []).filter((c) => (c.week_start ?? '') < cardWeek) };
  const { data: behs } = await db.from('drona_behaviours').select('behaviour, priority, card_kind, meta, mutes, detail')
    .eq('user_id', u).eq('week_start', judged);
  const all: PickFacts = { week_start: judged, behaviours: [...(behs ?? []), ...wordBehaviours(signals)] };
  const newUser = signalsFrom(df).new_user;
  const hurt = decidePick({ ...all, behaviours: all.behaviours!.filter((r) => r.behaviour === 'hurting' || r.meta) }, df);
  const picked = hurt ?? (newUser ? null : decidePick(all, df));
  const card = picked ?? hushed(decideCard(df, undefined, new Set([...mutedTopics(all), ...askedLately(df)])), all);
  const key = `${picked ? 'pick' : card.kind === 'hold' ? 'hold' : 'P0'}:${card.topic}`;
  tally[key] = (tally[key] ?? 0) + 1;
  console.log(`\n${u.slice(0, 13)}  ${texts.length} texts; word signals: ${fired.map((s) => s.signal).join(', ') || 'none'}`
    + `; unsure: ${readings.filter((r) => [r.pain, r.life, r.trained, r.ask].some((v) => v != null && v > 0.25 && v < 0.75)).length}`);
  for (const s of fired) console.log(`    ${s.signal}: ${JSON.stringify({ ...s.detail, source: undefined })}`);
  console.log(card.kind === 'hold' ? '  -> nothing' : `  -> [${key} / ${card.kind}] ${card.title}\n     ${card.body}`);
}
console.log(`\nCard week ${cardWeek}, judged ${judged}: ${users.length} people wrote something.`);
console.log(Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`).join('\n'));
