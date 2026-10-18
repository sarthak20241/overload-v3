/**
 * Do the word questions (_shared/dronaWords.ts QUESTIONS) separate texts we
 * know the answer to? Live Jev API, about $0.0001 a text.
 *
 *   npx tsx scripts/drona-words/eval.mts              # the tuning set (40)
 *   GROUP=held npx tsx scripts/drona-words/eval.mts   # the held-out set (20): run once, at the end
 *   GROUP=held2 ...                                    # 10 more, written after the wording changed
 *
 * Every text here is MADE UP, none copied from a user, and none of them goes
 * into a prompt (feedback: no eval-overfit prompts). The held-out set is never
 * used to tune; after any change it inspires, write new held-out texts.
 *
 * A case is right when all four yes/no answers are right (a yes is a score of
 * YES or more) and each "which" is right where the label has one.
 * Bar (plan): 18 of 20 held-out cases, and no false "pain now" anywhere.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { askJev } from '../../supabase/functions/ai-coach/jev.ts';
import { QUESTIONS, questionKey, readText, stateFor, type WordText, YES } from '../../supabase/functions/_shared/dronaWords.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

interface Case {
  text: string;
  earlier?: string[];
  kind?: string;
  pain?: string; // area when "pain now"
  life?: string; // reason when a life reason
  trained?: true;
  ask?: string;  // change kind when asking for a change
}

const TUNE: Case[] = [
  { text: 'my left knee hurts when i squat', pain: 'knee' },
  { text: 'legs are so sore after yesterday lol' },
  { text: 'tweaked my lower back deadlifting today', pain: 'back', trained: true },
  { text: 'my shoulder injury from last year is fine now' },
  { text: 'my wife has a bad back, any exercises for her?' },
  { text: 'elbow pain on curls, it has been a week', pain: 'elbow_or_wrist' },
  { text: 'travelling to delhi till sunday, wont be able to train', life: 'travel' },
  { text: 'had fever all week, couldnt do anything', life: 'illness' },
  { text: 'exams this week, no time for gym', life: 'work_or_study' },
  { text: "sister's wedding this week, skipped everything", life: 'family_or_event' },
  { text: 'the plan is too boring, skipped tuesday' },
  { text: 'will hit the gym tomorrow morning' },
  { text: 'done with push day 💪', trained: true },
  { text: 'just finished a 5k run', trained: true },
  { text: 'can we make my plan 4 days a week instead of 5', ask: 'training_days' },
  { text: 'please swap bench press for dumbbell press', ask: 'exercises' },
  { text: 'i want to change my target weight to 70', ask: 'goal_or_weight' },
  { text: 'can you increase my calories a bit, always hungry', ask: 'calories' },
  { text: 'how do i do a romanian deadlift properly' },
  { text: 'thanks coach!' },
  { text: 'what should i eat before the gym' },
  { text: 'remove lunges from my leg day please, hate them', ask: 'exercises' },
  { text: 'is my progress good this month?' },
  { text: 'had 2 slices of pizza at a party' },
  { text: 'aaj gym nahi gaya, office mein bahut kaam tha', life: 'work_or_study' },
  { text: 'ghutne mein dard ho raha hai squats pe', pain: 'knee' },
  { text: 'my plan has too many exercises, can you cut some', ask: 'exercises' },
  { text: 'twisted my ankle playing football last week, still swollen', pain: 'ankle_or_foot' },
  { text: 'hip pinches in deep squats', pain: 'hip' },
  { text: 'and my knee is killing me now', earlier: ['did legs today'], pain: 'knee' },
  { text: 'sick with a cold, skipping the gym this week', life: 'illness' },
  { text: "gym was closed for diwali so i didn't go", life: 'family_or_event' },
  { text: 'did my workout but forgot to log it', trained: true },
  { text: 'trained chest at home today, no gym', trained: true },
  { text: 'lower my protein target, its too much', ask: 'calories' },
  { text: 'change my goal to strength', ask: 'goal_or_weight' },
  { text: 'how much should i bench by now?' },
  { text: 'my legs are sore, is that normal?' },
  { text: 'wrist hurts on push ups', pain: 'elbow_or_wrist' },
  { text: 'felt great today, no complaints', kind: 'workout_note' },
];

const HELD: Case[] = [
  { text: 'my right shoulder clicks and hurts on overhead press', pain: 'shoulder' },
  { text: 'quads destroyed after leg day haha' },
  { text: 'back pain is gone finally' },
  { text: 'out of town for a family function, missed all sessions', life: 'family_or_event' },
  { text: "food poisoning since monday, couldn't train", life: 'illness' },
  { text: 'office deadlines, barely slept, skipped gym twice', life: 'work_or_study' },
  { text: 'finished pull day, felt strong', trained: true },
  { text: 'planning to run tomorrow evening' },
  { text: 'can i train 3 days instead of 4?', ask: 'training_days' },
  { text: 'replace squats with leg press please', ask: 'exercises' },
  { text: 'set my calories to 2000', ask: 'calories' },
  { text: "what's a good warm up for bench?" },
  { text: 'aaj chest kiya, mast workout tha', trained: true },
  { text: 'kamar mein dard hai deadlift ke baad', pain: 'back' },
  { text: "brother's wedding, no gym this week", life: 'family_or_event' },
  { text: 'my goal is now to lose 5 kg, update it', ask: 'goal_or_weight' },
  { text: 'great session today, hit a PR on squat', trained: true },
  { text: 'my friend hurt his knee at the gym' },
  { text: 'can you make my sessions shorter, only have 45 min', ask: 'training_days' },
  { text: 'heel pain when i run', pain: 'ankle_or_foot' },
];

/**
 * Written AFTER the "lasting change" wording (inspired by a real dry-run text,
 * not by HELD), so this set had never been seen by any question when first run.
 */
const HELD2: Case[] = [
  { text: 'what weight should i use for squats tomorrow?' },
  { text: 'can you move my leg day from monday to tuesday for good', ask: 'training_days' },
  { text: 'i only want to train 3 days from now on', ask: 'training_days' },
  { text: 'is it ok if i skip abs today?' },
  { text: 'please drop the cardio from my program', ask: 'exercises' },
  { text: 'my knee hurts, should i skip squats today?', pain: 'knee' },
  { text: 'update my target weight to 65 kg', ask: 'goal_or_weight' },
  { text: "what's the best rep range for growth?" },
  { text: 'switched gyms, no leg press here anymore, replace it in my plan', ask: 'exercises' },
  { text: 'felt dizzy and sick after training, skipping tomorrow', life: 'illness', trained: true },
];

const group = process.env.GROUP === 'held' ? 'held' : process.env.GROUP === 'held2' ? 'held2' : 'tune';
const cases = group === 'held' ? HELD : group === 'held2' ? HELD2 : TUNE;
const deps = { apiKey: env.JEV_API_KEY ?? '', timeoutMs: 20_000, fetchFn: fetch };

const questions = Object.fromEntries(Object.entries(QUESTIONS).map(([q, v]) => [questionKey(0, q), v]));

async function run(c: Case, i: number) {
  const day = '2026-10-14';
  const earlier = (c.earlier ?? []).map((t, j) => ({ id: `e${j}`, kind: 'chat_message', day, text: t } as WordText));
  const t: WordText = { id: `c${i}`, kind: c.kind ?? 'chat_message', day, text: c.text };
  const all = [...earlier, t];
  const res = await askJev(stateFor(t, all), questions, deps);
  if (!res.ok) return { c, error: `${res.failure}: ${res.detail}` };
  const r = readText(t, 0, res.response.answers as Record<string, unknown>);
  const yes = (v: number | null) => v != null && v >= YES;
  const misses: string[] = [];
  const check = (name: string, got: number | null, want: boolean) => {
    if (yes(got) !== want) misses.push(`${name}: ${got?.toFixed(2)} want ${want ? 'yes' : 'no'}`);
  };
  check('pain', r.pain, !!c.pain);
  check('life', r.life, !!c.life);
  check('trained', r.trained, !!c.trained);
  check('ask', r.ask, !!c.ask);
  if (c.pain && r.area !== c.pain) misses.push(`area: ${r.area} want ${c.pain}`);
  if (c.life && r.reason !== c.life) misses.push(`reason: ${r.reason} want ${c.life}`);
  if (c.ask && r.change !== c.ask) misses.push(`change: ${r.change} want ${c.ask}`);
  const falsePain = !c.pain && yes(r.pain);
  return { c, r, misses, falsePain, unsure: [r.pain, r.life, r.trained, r.ask].filter((v) => v != null && v > 0.25 && v < YES).length };
}

const results: Awaited<ReturnType<typeof run>>[] = [];
for (let i = 0; i < cases.length; i += 5) {
  results.push(...await Promise.all(cases.slice(i, i + 5).map((c, j) => run(c, i + j))));
}

let right = 0;
let falsePain = 0;
for (const x of results) {
  if ('error' in x) { console.log(`ERROR  ${x.c.text}: ${x.error}`); continue; }
  if (x.falsePain) falsePain++;
  if (x.misses.length === 0) right++;
  else console.log(`MISS   "${x.c.text}"\n       ${x.misses.join('; ')}`);
}
console.log(`\n${group}: ${right} of ${cases.length} right; false "pain now": ${falsePain}; texts with an unsure answer: ${results.filter((x) => !('error' in x) && x.unsure > 0).length}`);
writeFileSync(`${process.env.OUT ?? '/tmp'}/drona-words-eval-${group}.json`, JSON.stringify(results, null, 1));
