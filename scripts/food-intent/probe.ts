// Phase 0 for the food-intent router: does Jev actually separate "log" from
// "create" on real-looking messages, and where does the confidence floor belong?
//
//   deno run --allow-net --allow-env scripts/food-intent/probe.ts
//
// Context for why this exists: a sibling session probed Jev on the Drona-cards
// judgment and found it "perceives sharply and decides poorly" - single-signal
// questions separated 98% vs 9-13%, while a judgment needing three signals
// weighed together returned 10-20% confidence on everything. Their conclusion,
// which this inherits, is that every Jev question is a tiny prompt and has to be
// checked against known answers before anyone trusts it.
//
// "Log or create" is a single-signal read, so it SHOULD be on the good side of
// that line. Should is not measured.
//
// HELD OUT: the criteria wording in foodIntent.ts was written and committed
// before these cases existed and is not edited to fit them. If it turns out to
// need changing, these cases are burned and the next run needs fresh ones.

import { asChoice, asNoul, askJev, JEV_MODEL, type JevQuestion } from "../../supabase/functions/ai-coach/jev.ts";

type Label = "log" | "create";

interface Case {
  text: string;
  want: Label;
  /** Hard cases are the ones the floor has to survive, so they are reported
   *  separately from the easy ones that any approach would get. */
  hard?: boolean;
  why?: string;
}

// Messages a real person might type into the food bar. Weighted toward the
// middle, because the ends are not where a threshold earns its keep.
const CASES: Case[] = [
  // ── plainly logging ───────────────────────────────────────────────────────
  { text: "2 eggs and toast", want: "log", why: "bare list, no verb" },
  { text: "I had a chicken roll for lunch", want: "log" },
  { text: "just finished a bowl of dal and rice", want: "log" },
  { text: "grabbed a protein bar on the way to the gym", want: "log" },
  { text: "100g paneer, 2 rotis, salad", want: "log", why: "quantities only" },
  { text: "large cappuccino and a croissant", want: "log" },

  // ── plainly creating ──────────────────────────────────────────────────────
  { text: "save my protein shake so I can log it quickly next time", want: "create" },
  { text: "create a meal called Sunday Poha", want: "create" },
  { text: "remember this: my breakfast bowl is 100g oats, a scoop of whey and a banana", want: "create" },
  { text: "add a food called Amma's rajma to my meals", want: "create" },
  { text: "I want to set up my usual post workout shake as a saved meal", want: "create" },

  // ── the hard middle ───────────────────────────────────────────────────────
  {
    text: "chicken roll, about 450 cal",
    want: "log",
    hard: true,
    why: "numbers present but it is still a report of eating",
  },
  {
    text: "my protein shake is 180 cal, 30g protein",
    want: "create",
    hard: true,
    why: "present tense definition, 'is' not 'had'",
  },
  {
    text: "I had my usual breakfast bowl, save it too",
    want: "create",
    hard: true,
    why: "both intents in one line; the save is the new instruction",
  },
  {
    text: "dosa 600 cal 20p 80c 20f",
    want: "log",
    hard: true,
    why: "terse macros with no save word reads as a log",
  },
  {
    text: "make a note that my office salad is around 320 calories",
    want: "create",
    hard: true,
    why: "'make a note' is a save, not an eating report",
  },
  {
    text: "the rajma I make at home comes to roughly 400 a bowl",
    want: "create",
    hard: true,
    why: "defines a recurring dish, present habitual tense",
  },
  {
    text: "had 3 idlis with sambar this morning",
    want: "log",
    hard: true,
    why: "time reference anchors it to an actual meal",
  },
  {
    text: "log my breakfast bowl",
    want: "log",
    hard: true,
    why: "explicit verb 'log', even though it names a saved meal",
  },
  {
    text: "add my greek yogurt bowl",
    want: "log",
    hard: true,
    why: "'add' is ambiguous but in a diary it means add to today",
  },
  {
    text: "set up oats 50g whey 1 scoop banana 1 as a meal I eat most mornings",
    want: "create",
    hard: true,
    why: "recipe plus 'set up' plus habitual framing",
  },
  {
    text: "two boiled eggs, 140 calories total",
    want: "log",
    hard: true,
    why: "a total for one sitting, not a definition",
  },
];

// The Choice the router actually ships, imported in spirit: duplicated here so
// the probe can compare it against a Noul phrasing of the same judgment without
// the router needing to know about the experiment.
const CHOICE: JevQuestion = {
  type: "choice",
  instructions:
    "The state is a message the user typed into a food tracking app. " +
    "Decide whether they are recording food they ate, or defining a food to save for later use. " +
    "Judge only what this message asks for. Do not consider whether the food sounds healthy, whether the numbers are plausible, or what they should do next.",
  criteria: {
    log:
      "The user is recording food they have ALREADY eaten or are eating now, and wants it added to today's diary. " +
      "Past tense is the strongest signal: 'I had', 'just ate', 'finished', 'grabbed'. " +
      "A bare list of foods with no verb is also this, because describing food with no other request means they ate it. " +
      "Choose this when they mention a quantity of something they consumed, even if they also give calories.",
    create:
      "The user wants a food or meal SAVED as a reusable entry for future use, and is not reporting having eaten it now. " +
      "The signals are an explicit request to keep it ('save this', 'remember', 'add to my meals', 'create a meal', 'make a food called'), " +
      "or defining a named dish by its recipe or ingredients for later. " +
      "Choose this even when they also give calories and macros, because the numbers are the definition of the food, not a record of a meal.",
  },
};

// The same judgment as a yes/no. Their probe found single-signal Nouls separated
// far better than Choices, and the jaggedness page warns the two are NOT
// comparable, so this is measured rather than assumed.
const NOUL: JevQuestion = {
  type: "noul",
  instructions:
    "The state is a message the user typed into a food tracking app. " +
    "The user is asking to SAVE a food or meal as a reusable entry for later, rather than recording something they have just eaten.",
  criteria: {
    true: "They want it kept for future use: 'save this', 'remember', 'create a meal', 'add a food called', or they are defining a named dish by its ingredients.",
    false: "They are reporting food they ate or are eating now, including a bare list of foods with no other request.",
  },
};

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`.padStart(4);
}

async function main() {
  const apiKey = Deno.env.get("JEV_API_KEY") ?? "";
  if (!apiKey) {
    console.error("JEV_API_KEY is not set. Export it and re-run.");
    Deno.exit(1);
  }

  const deps = { apiKey, timeoutMs: 15_000 };
  console.log(`model ${JEV_MODEL}, ${CASES.length} cases\n`);

  let choiceRight = 0, noulRight = 0, hardTotal = 0, choiceHardRight = 0, noulHardRight = 0;
  let totalIn = 0, totalMs = 0;
  // Confidence of the CORRECT answers and of the WRONG ones, kept apart: a floor
  // is only useful if wrong answers are less confident than right ones.
  const rightConf: number[] = [], wrongConf: number[] = [];
  const rows: string[] = [];

  for (const c of CASES) {
    const t0 = Date.now();
    // Both questions in ONE call. They are independent, evaluated in parallel
    // against the same state, and the state is only charged once.
    const res = await askJev({ message: c.text }, { intent: CHOICE, wants_save: NOUL }, deps);
    const ms = Date.now() - t0;
    totalMs += ms;

    if (!res.ok) {
      rows.push(`FAIL  ${res.failure.padEnd(16)} ${c.text.slice(0, 50)}`);
      continue;
    }
    totalIn += res.response.usage.input_tokens;

    const ch = asChoice(res.response.answers.intent);
    const nl = asNoul(res.response.answers.wants_save);
    if (!ch || nl === null) {
      rows.push(`SHAPE ${c.text.slice(0, 50)}`);
      continue;
    }

    const choiceOk = ch.choice === c.want;
    // 0.5 is the natural midpoint for a yes/no; the real cut is chosen below
    // from the spread, not assumed here.
    const noulSaysCreate = nl > 0.5;
    const noulOk = (noulSaysCreate ? "create" : "log") === c.want;

    if (choiceOk) { choiceRight++; rightConf.push(ch.confidence); } else { wrongConf.push(ch.confidence); }
    if (noulOk) noulRight++;
    if (c.hard) {
      hardTotal++;
      if (choiceOk) choiceHardRight++;
      if (noulOk) noulHardRight++;
    }

    rows.push(
      `${choiceOk ? "  " : "XX"} ${noulOk ? "  " : "xx"} ` +
        `want=${c.want.padEnd(6)} choice=${ch.choice.padEnd(6)} conf=${pct(ch.confidence)} ` +
        `noul=${pct(nl)} ${ms}ms ${c.hard ? "[hard] " : ""}${c.text.slice(0, 44)}`,
    );
  }

  console.log("XX = Choice wrong, xx = Noul wrong\n");
  for (const r of rows) console.log(r);

  const n = CASES.length;
  const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
  const min = (a: number[]) => a.length ? Math.min(...a) : NaN;
  const max = (a: number[]) => a.length ? Math.max(...a) : NaN;

  console.log(`\nChoice  ${choiceRight}/${n}   hard ${choiceHardRight}/${hardTotal}`);
  console.log(`Noul    ${noulRight}/${n}   hard ${noulHardRight}/${hardTotal}`);
  console.log(`\nconfidence when RIGHT: mean ${pct(mean(rightConf))} min ${pct(min(rightConf))}`);
  console.log(`confidence when WRONG: mean ${pct(mean(wrongConf))} max ${pct(max(wrongConf))}`);
  console.log(
    `\nA floor is only worth having if the wrong answers sit below it. ` +
      `Wrong max ${pct(max(wrongConf))} vs right min ${pct(min(rightConf))}.`,
  );
  console.log(`\n${Math.round(totalIn / n)} input tokens/call avg, ${Math.round(totalMs / n)}ms avg`);
  console.log(`$${((totalIn / 1_000_000) * 0.042).toFixed(6)} for this whole run`);
}

await main();
