// Does Jev separate "log" from "create" on real-looking messages, and where
// does the confidence floor belong?
//
//   deno run --allow-net --allow-env scripts/food-intent/probe.ts
//
// Background: a sibling session probed Jev on the Drona-cards judgment and found
// it "perceives sharply and decides poorly". Single-signal questions separated
// 98% vs 9-13%; a judgment needing three signals weighed together returned
// 10-20% confidence on everything. Their lesson, inherited here: every Jev
// question is a tiny prompt and has to be checked against known answers.
//
// ── The rule under test ────────────────────────────────────────────────────
// CREATE REQUIRES AN EXPLICIT ASK. Describing a food, even in present tense with
// macros, is a log. This is a product decision, and it is what makes the question
// answerable: the first version left it implicit, the two options read as near
// synonyms, and confidence collapsed on exactly the messages a person would also
// argue about. The ambiguity was in the question, not the model.
//
// ── Two sets, and why ──────────────────────────────────────────────────────
// DEV is the original 22 cases, RE-LABELLED under the explicit-ask rule. Their
// results have already been seen, so a number from them is not evidence about
// unseen messages. They are kept because a regression on them is still a
// regression.
//
// HELD_OUT is fresh, written after the criteria wording was fixed and never
// scored before. This is the set the floor is chosen from. The few-shot examples
// inside INTENT_CRITERIA appear in NEITHER set, on purpose.

import { asChoice, askJev, JEV_MODEL } from "../../supabase/functions/ai-coach/jev.ts";
import { INTENT_CRITERIA, INTENT_INSTRUCTIONS } from "../../supabase/functions/ai-coach/foodIntent.ts";

type Label = "log" | "create" | "other";

interface Case {
  text: string;
  want: Label;
  hard?: boolean;
}

// ── DEV: the original 22, re-labelled under the explicit-ask rule ───────────
// Four labels moved, and every one of them moved toward 'log', because each was
// a present-tense description with no instruction to save. That re-labelling is
// the whole point: the model was reading the rule correctly before the rule was
// written down.
const DEV: Case[] = [
  { text: "2 eggs and toast", want: "log" },
  { text: "I had a chicken roll for lunch", want: "log" },
  { text: "just finished a bowl of dal and rice", want: "log" },
  { text: "grabbed a protein bar on the way to the gym", want: "log" },
  { text: "100g paneer, 2 rotis, salad", want: "log" },
  { text: "large cappuccino and a croissant", want: "log" },
  { text: "save my protein shake so I can log it quickly next time", want: "create" },
  { text: "create a meal called Sunday Poha", want: "create" },
  { text: "remember this: my breakfast bowl is 100g oats, a scoop of whey and a banana", want: "create" },
  { text: "add a food called Amma's rajma to my meals", want: "create" },
  { text: "I want to set up my usual post workout shake as a saved meal", want: "create" },
  { text: "chicken roll, about 450 cal", want: "log", hard: true },
  // WAS create. No instruction to save anywhere in it, so it is a log.
  { text: "my protein shake is 180 cal, 30g protein", want: "log", hard: true },
  { text: "I had my usual breakfast bowl, save it too", want: "create", hard: true },
  { text: "dosa 600 cal 20p 80c 20f", want: "log", hard: true },
  { text: "make a note that my office salad is around 320 calories", want: "create", hard: true },
  // WAS create. Describes a recurring dish but never asks for it to be kept.
  { text: "the rajma I make at home comes to roughly 400 a bowl", want: "log", hard: true },
  { text: "had 3 idlis with sambar this morning", want: "log", hard: true },
  { text: "log my breakfast bowl", want: "log", hard: true },
  // WAS create. "add" in a diary means add to today.
  { text: "add my greek yogurt bowl", want: "log", hard: true },
  { text: "set up oats 50g whey 1 scoop banana 1 as a meal I eat most mornings", want: "create", hard: true },
  { text: "two boiled eggs, 140 calories total", want: "log", hard: true },
];

// ── HELD OUT: written after the wording was fixed, never scored ────────────
// Weighted toward the boundary the rule draws: present-tense descriptions with
// numbers that are NOT saves, and saves phrased in ways the few-shot does not use.
const HELD_OUT: Case[] = [
  // Plain logs.
  { text: "three scrambled eggs and a black coffee", want: "log" },
  { text: "ate a shawarma on the way home", want: "log" },
  { text: "250ml milk and 4 dates", want: "log" },
  { text: "leftover biryani for lunch", want: "log" },

  // Descriptions with numbers, no instruction to save. The rule says log.
  { text: "my morning smoothie comes to about 300 calories", want: "log", hard: true },
  { text: "the protein bar I eat is 20g protein", want: "log", hard: true },
  { text: "a plate of my mum's pulao is roughly 500", want: "log", hard: true },
  { text: "this sandwich has 400 cal 25p 40c 12f", want: "log", hard: true },
  { text: "lunch today was around 700 calories", want: "log", hard: true },

  // Explicit saves, phrased away from the few-shot wording.
  { text: "keep this one in my meals please", want: "create", hard: true },
  { text: "I want a saved entry for my gym day breakfast", want: "create", hard: true },
  { text: "store this as a food I can pick later", want: "create", hard: true },
  { text: "make a reusable meal out of 60g oats and 250ml milk", want: "create", hard: true },
  { text: "put my office salad into my meals list", want: "create", hard: true },

  // Both in one message. The save is the new instruction, so create.
  { text: "two rotis and sabzi, and keep that as a meal", want: "create", hard: true },
  { text: "logged my shake already, can you also save it for next time", want: "create", hard: true },

  // Verbs that look like saving but are not, in a diary.
  { text: "add 2 bananas", want: "log", hard: true },
  { text: "put down a coffee for me", want: "log", hard: true },
  { text: "note that I had a samosa", want: "log", hard: true },

  // Terse, no verb at all.
  { text: "idli sambar x3", want: "log" },
  { text: "protein shake", want: "log" },

  // A question, not an instruction. Still not a save.
  // WAS log, when there was nowhere else to put a question. A question names
  // no food the user ATE, so under three boxes it is other.
  { text: "how many calories in my usual breakfast bowl", want: "other", hard: true },

  // Naming a dish without asking for anything.
  // WAS log, same reason: naming a dish is not reporting eating it.
  { text: "we call it Sunday poha at home", want: "other", hard: true },

  // Explicit create with a recipe attached.
  { text: "create a meal: 100g chicken, 150g rice, 1 tsp oil", want: "create", hard: true },
];

// ── HELD OUT 2: the three-way boundary, fresh ─────────────────────────────
// Written after the 'other' criteria were fixed and never scored. The few-shot
// examples in INTENT_CRITERIA ("good morning", "thanks, that helps", "what can
// you do", "is rice bad for cutting") appear nowhere here. The traps are
// greetings WITH food, which must stay logs, and food words inside questions,
// which must not become logs.
const HELD_OUT_2: Case[] = [
  // plain other
  { text: "hey", want: "other" },
  { text: "hello drona", want: "other" },
  { text: "ok cool", want: "other" },
  { text: "who are you", want: "other" },
  { text: "can you log food for me", want: "other", hard: true },
  { text: "do you have tools to create meals", want: "other", hard: true },
  { text: "how much protein should i eat", want: "other", hard: true },
  { text: "is paneer good for protein", want: "other", hard: true },
  { text: "why is my weight not dropping", want: "other", hard: true },
  { text: "you there?", want: "other" },

  // greeting plus food: the food wins, it is a log
  { text: "hi, had two eggs", want: "log", hard: true },
  { text: "morning! oats and coffee", want: "log", hard: true },
  { text: "hey just ate a sandwich", want: "log", hard: true },
  { text: "thanks, also had a banana", want: "log", hard: true },

  // plain logs, so a shifted boundary shows up here
  { text: "chicken biryani for lunch", want: "log" },
  { text: "3 rotis and dal", want: "log" },

  // creates, so a shifted boundary shows up here too
  { text: "save my overnight oats as a meal", want: "create", hard: true },
  { text: "create a food called gym shake, 250 cal", want: "create", hard: true },
];

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`.padStart(4);
}

interface Outcome {
  right: number;
  total: number;
  hardRight: number;
  hardTotal: number;
  rightConf: number[];
  wrongConf: number[];
  rows: string[];
  tokens: number;
  ms: number;
}

async function runSet(name: string, cases: Case[], apiKey: string): Promise<Outcome> {
  const o: Outcome = {
    right: 0, total: cases.length, hardRight: 0, hardTotal: 0,
    rightConf: [], wrongConf: [], rows: [], tokens: 0, ms: 0,
  };

  for (const c of cases) {
    const t0 = Date.now();
    const res = await askJev(
      { message: c.text },
      { intent: { type: "choice", instructions: INTENT_INSTRUCTIONS, criteria: INTENT_CRITERIA } },
      { apiKey, timeoutMs: 15_000 },
    );
    o.ms += Date.now() - t0;

    if (!res.ok) { o.rows.push(`FAIL ${res.failure} ${c.text.slice(0, 44)}`); continue; }
    o.tokens += res.response.usage.input_tokens;

    const ch = asChoice(res.response.answers.intent);
    if (!ch) { o.rows.push(`SHAPE ${c.text.slice(0, 44)}`); continue; }

    const ok = ch.choice === c.want;
    if (ok) { o.right++; o.rightConf.push(ch.confidence); } else { o.wrongConf.push(ch.confidence); }
    if (c.hard) { o.hardTotal++; if (ok) o.hardRight++; }

    o.rows.push(
      `${ok ? "  " : "XX"} want=${c.want.padEnd(6)} got=${ch.choice.padEnd(6)} ` +
        `conf=${pct(ch.confidence)} ${c.hard ? "[hard] " : "       "}${c.text.slice(0, 46)}`,
    );
  }
  return o;
}

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const min = (a: number[]) => a.length ? Math.min(...a) : NaN;
const max = (a: number[]) => a.length ? Math.max(...a) : NaN;

function report(name: string, o: Outcome) {
  console.log(`\n══════ ${name} ══════`);
  for (const r of o.rows) console.log(r);
  console.log(`\n  correct ${o.right}/${o.total}   hard ${o.hardRight}/${o.hardTotal}`);
  console.log(`  conf when RIGHT  mean ${pct(mean(o.rightConf))}  min ${pct(min(o.rightConf))}`);
  console.log(`  conf when WRONG  mean ${pct(mean(o.wrongConf))}  max ${pct(max(o.wrongConf))}`);
  const gap = min(o.rightConf) - max(o.wrongConf);
  console.log(
    o.wrongConf.length === 0
      ? "  no wrong answers, so any floor at or below the right-min is clean"
      : gap > 0
      ? `  SEPARATED: every wrong answer sits below every right one (gap ${pct(gap)})`
      : `  OVERLAP: a wrong answer outranks a right one, so no floor is clean`,
  );
  console.log(`  ${Math.round(o.tokens / o.total)} tok/call, ${Math.round(o.ms / o.total)}ms/call`);
}

/** What a given floor would actually do: how many answers it lets through, and
 *  how many of those were right. Precision on the accepted set is the number
 *  that matters, because the rejected ones go to a better judge anyway. */
function sweep(o: Outcome) {
  console.log("\n  floor  accepted  correct  sent to Claude");
  for (const f of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const accRight = o.rightConf.filter((c) => c >= f).length;
    const accWrong = o.wrongConf.filter((c) => c >= f).length;
    const acc = accRight + accWrong;
    console.log(
      `  ${f.toFixed(2)}   ${String(acc).padStart(8)}  ${String(accRight).padStart(7)}  ${
        String(o.total - acc).padStart(14)
      }`,
    );
  }
}

async function main() {
  const apiKey = Deno.env.get("JEV_API_KEY") ?? "";
  if (!apiKey) { console.error("JEV_API_KEY is not set."); Deno.exit(1); }

  console.log(`model ${JEV_MODEL}`);
  const dev = await runSet("DEV", DEV, apiKey);
  const held = await runSet("HELD_OUT", HELD_OUT, apiKey);
  const held2 = await runSet("HELD_OUT_2", HELD_OUT_2, apiKey);

  report("DEV (seen, re-labelled)", dev);
  report("HELD OUT (seen last run, 2 labels moved to other)", held);
  report("HELD OUT 2 (three-way boundary, never scored)", held2);

  console.log("\n══════ floor sweep, HELD OUT 2 ══════");
  sweep(held2);

  const all: Outcome = {
    right: dev.right + held.right + held2.right, total: dev.total + held.total + held2.total,
    hardRight: dev.hardRight + held.hardRight + held2.hardRight,
    hardTotal: dev.hardTotal + held.hardTotal + held2.hardTotal,
    rightConf: [...dev.rightConf, ...held.rightConf, ...held2.rightConf],
    wrongConf: [...dev.wrongConf, ...held.wrongConf, ...held2.wrongConf],
    rows: [], tokens: dev.tokens + held.tokens + held2.tokens, ms: dev.ms + held.ms + held2.ms,
  };
  console.log("\n══════ floor sweep, ALL SETS ══════");
  sweep(all);
  console.log(`\ncombined ${all.right}/${all.total}`);
  console.log(`$${((all.tokens / 1_000_000) * 0.042).toFixed(6)} for this whole run`);
}

await main();
