/**
 * Does the memory catch (_shared/dronaMemory.ts) keep what it should, and
 * nothing else? Live Jev for the gate; the live Anthropic API for the writer,
 * because the writer calls a tool and the Claude CLI cannot test tool calls
 * (owner approved about $0.05, 2026-10-18).
 *
 *   npx tsx scripts/drona-memory/eval.mts                 # tune (40)
 *   GROUP=held npx tsx scripts/drona-memory/eval.mts      # held out (20): run once, at the end
 *   WRITER=0 ...                                          # the gate only (Jev, under a cent)
 *
 * Made-up texts only, never copied from a user, never put into a prompt.
 * A case is right when the gate says yes exactly when a fact is expected, and,
 * on a yes, the writer saves at least one fact in an expected category and
 * nothing when none is expected. Bar: 18 of 20 held out, no fact saved from a
 * "no" text.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { askJev, asNoul } from '../../supabase/functions/ai-coach/jev.ts';
import {
  catchMemory, GATE_YES, MEMORY_GATE, type MemoryFactIn,
} from '../../supabase/functions/_shared/dronaMemory.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

interface Case { text: string; kind?: string; keep?: string[] } // keep: acceptable categories; absent = nothing to keep

const TUNE: Case[] = [
  { text: '2 eggs and toast with butter', kind: 'food_log' },
  { text: "i'm vegetarian, so paneer bhurji and 2 rotis", kind: 'food_log', keep: ['diet'] },
  { text: 'chicken biryani, large plate', kind: 'food_log' },
  { text: 'no milk please, lactose makes me bloated. black coffee', kind: 'food_log', keep: ['diet'] },
  { text: 'protein shake after gym', kind: 'food_log' },
  { text: 'skipped breakfast, night shift this month so i eat at 2am', kind: 'food_log', keep: ['schedule', 'constraint'] },
  { text: 'dal rice and curd', kind: 'food_log' },
  { text: "i don't eat beef or pork. chicken curry and rice", kind: 'food_log', keep: ['diet'] },
  { text: 'allergic to peanuts, so this is almond butter on toast', kind: 'food_log', keep: ['diet'] },
  { text: 'oats with banana', kind: 'food_log' },
  { text: 'fasting on tuesdays, so only fruit today', kind: 'food_log', keep: ['diet', 'schedule'] },
  { text: 'had pizza at a friend\'s birthday', kind: 'food_log' },
  { text: 'i train at home, only dumbbells up to 20 kg', keep: ['equipment'] },
  { text: 'what should i eat before the gym?' },
  { text: 'my left knee had surgery two years ago, i avoid deep squats', keep: ['injury'] },
  { text: 'legs are sore today' },
  { text: 'i can only train 45 minutes on weekdays', keep: ['constraint', 'schedule'] },
  { text: 'thanks coach!' },
  { text: 'i hate running, please never put it in my plan', keep: ['preference'] },
  { text: 'how much protein do i need?' },
  { text: 'i have type 2 diabetes', keep: ['injury', 'other', 'constraint', 'diet'] },
  { text: 'my wife wants to lose weight too' },
  { text: "i'm getting married in march, want to look lean by then", keep: ['goal_context'] },
  { text: 'feeling tired today' },
  { text: 'i work 9 to 6 in an office and train in the evening', keep: ['schedule'] },
  { text: 'can you swap bench press for push ups today?' },
  { text: 'i play cricket every sunday', keep: ['schedule', 'other', 'constraint', 'preference'] },
  { text: 'hit a PR on deadlift, 140 kg!' },
  { text: 'i decided to stop eating sugar for this cut', keep: ['decision', 'diet'] },
  { text: 'what is a good warm up?' },
  { text: 'my gym has no leg press machine', keep: ['equipment'] },
  { text: 'gym was crowded today' },
  { text: 'i prefer machines over free weights, my form is bad', keep: ['preference'] },
  { text: 'weighed 72.4 this morning' },
  { text: 'my lower back flares up with heavy deadlifts', keep: ['injury'] },
  { text: 'skipped gym, was busy' },
  { text: 'i do intermittent fasting, eating window 12 to 8', keep: ['diet', 'schedule'] },
  { text: 'samosa and chai', kind: 'food_log' },
  { text: 'i travel for work every other week', keep: ['schedule', 'constraint'] },
  { text: 'great session today' },
];

const HELD: Case[] = [
  { text: 'jain food only, no onion garlic. jeera rice and dal', kind: 'food_log', keep: ['diet'] },
  { text: 'two parathas with pickle', kind: 'food_log' },
  { text: 'gluten makes me sick, rice noodles today', kind: 'food_log', keep: ['diet'] },
  { text: 'banana and black coffee pre workout', kind: 'food_log' },
  { text: 'i only eat two meals a day, always have', kind: 'food_log', keep: ['diet', 'schedule'] },
  { text: 'masala dosa with chutney', kind: 'food_log' },
  { text: 'my shoulder dislocated last year, overhead press scares me', keep: ['injury'] },
  { text: 'how many sets for chest?' },
  { text: 'i have a resistance band and a pull up bar at home', keep: ['equipment'] },
  { text: 'arms are pumped' },
  { text: 'i want to get strong for the army fitness test in june', keep: ['goal_context'] },
  { text: 'is creatine safe?' },
  { text: 'i hate lunges, swap them out of my plan for good', keep: ['preference', 'decision'] },
  { text: 'slept badly last night' },
  { text: 'i have asthma so long cardio is hard', keep: ['injury', 'constraint', 'other'] },
  { text: 'my brother started going to my gym' },
  { text: 'only free on saturday and sunday mornings to train', keep: ['schedule', 'constraint'] },
  { text: 'new 5k best today' },
  { text: 'i drink a lot on weekends, trying to cut back', keep: ['diet', 'goal_context', 'decision'] },
  { text: 'what time should i train?' },
];

const group = process.env.GROUP === 'held' ? 'held' : 'tune';
const cases = group === 'held' ? HELD : TUNE;
const withWriter = process.env.WRITER !== '0';
const jev = { apiKey: env.JEV_API_KEY ?? '', timeoutMs: 20_000, fetchFn: fetch };

async function run(c: Case) {
  const kind = c.kind ?? 'chat';
  if (!withWriter) {
    const r = await askJev({ text: c.text, written_in: kind }, { lasting: MEMORY_GATE }, jev);
    const gate = r.ok ? asNoul(r.response.answers.lasting) : null;
    return { c, gate, saved: [] as MemoryFactIn[], error: r.ok ? undefined : r.failure };
  }
  const saved: MemoryFactIn[] = [];
  const res = await catchMemory(c.text, kind, {
    jev, anthropicKey: env.ANTHROPIC_API_KEY ?? '', fetchFn: fetch, today: '2026-10-19',
    readMemory: async () => [],
    saveFact: async (f) => { saved.push(f); return 'saved' as const; },
  });
  return { c, gate: res.gate, saved, error: res.outcome === 'failed' ? res.error : undefined };
}

const results: Awaited<ReturnType<typeof run>>[] = [];
for (let i = 0; i < cases.length; i += 5) results.push(...await Promise.all(cases.slice(i, i + 5).map(run)));

let right = 0;
let falseSaves = 0;
for (const x of results) {
  const want = !!x.c.keep;
  const gateYes = x.gate != null && x.gate >= GATE_YES;
  const misses: string[] = [];
  if (x.error) misses.push(`error ${x.error}`);
  if (gateYes !== want) misses.push(`gate ${x.gate?.toFixed(2)} want ${want ? 'yes' : 'no'}`);
  if (withWriter && want && gateYes && !x.saved.some((f) => x.c.keep!.includes(f.category))) {
    misses.push(`writer saved ${JSON.stringify(x.saved.map((f) => f.category))} want one of ${x.c.keep!.join('/')}`);
  }
  if (!want && x.saved.length > 0) { falseSaves++; misses.push(`saved from a "no" text: ${JSON.stringify(x.saved)}`); }
  if (misses.length === 0) right++;
  else console.log(`MISS   "${x.c.text}"\n       ${misses.join('; ')}`);
}
if (withWriter) {
  console.log('\nFacts the writer saved (yes texts):');
  for (const x of results) for (const f of x.saved) console.log(`  ${f.category} / ${f.key}: ${f.value}`);
}
console.log(`\n${group}${withWriter ? '' : ' (gate only)'}: ${right} of ${cases.length} right; facts saved from "no" texts: ${falseSaves}`);
writeFileSync(`${process.env.OUT ?? '/tmp'}/drona-memory-eval-${group}.json`, JSON.stringify(results, null, 1));
