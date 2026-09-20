// What does the user actually want done with this food text?
//
// Until now there was one answer: log it. Every message typed into the food bar
// went into the parse pipeline, so "save my protein shake for next time" was
// logged as a shake the user had not eaten. The two jobs need telling apart
// before either runs, and that is this module's whole responsibility.
//
// The ladder, most trustworthy first:
//   1. JEV      a Choice over a closed set with a calibrated confidence. This is
//               textbook System One: no arithmetic, no generation, a handful of
//               options. Accepted only above a threshold.
//   2. MODEL    a small Claude classification, injected by the caller. Covers
//               "no Jev key configured", "Jev is rate limited", and "Jev
//               answered but was not sure enough".
//   3. DEFAULT  'log'. Today's behaviour, and the safe one: a create read as a
//               log shows the user a card they can dismiss, while a log read as
//               a create loses the meal they were trying to record.
//
// Every step is allowed to be absent. No key, no model hook, both failing: the
// ladder still terminates at 'log' and the feature degrades to exactly what
// shipped before it existed.
//
// Runtime-agnostic like its siblings: deps injected, no Deno globals, so the
// eval harness drives the production path rather than a copy of it.

import { asChoice, askJev, type JevDeps, type JevResult } from "./jev.ts";

/** The intents we route on TODAY.
 *
 *  'improvise' (build me something from what I have) and 'challenge' (push back
 *  on what I logged) are coming, and the Choice criteria below are written so
 *  adding them is one more option plus one more branch, not a rewrite. They are
 *  deliberately NOT here yet: an option the downstream code cannot handle is a
 *  route to nowhere, and a half-wired intent is worse than an absent one. */
export type FoodIntent = "log" | "create";

/** Where the answer came from. Carried so the logs can show the ladder working,
 *  and so a regression in routing can be attributed to a step rather than
 *  guessed at. */
export type FoodIntentSource = "jev" | "model" | "default";

export interface FoodIntentDecision {
  intent: FoodIntent;
  source: FoodIntentSource;
  /** 0-1 from Jev. Null from the model step (Claude does not give a calibrated
   *  number, and pretending otherwise by mapping "high" to 0.9 would put a made
   *  up figure into the same field as a measured one) and from the default. */
  confidence: number | null;
  /** Why we ended up here, for logs. Never shown to a user. */
  note: string;
}

/**
 * The confidence floor for acting on Jev's answer.
 *
 * MEASURED: scripts/food-intent/probe.ts, jev-1.13.0, 2026-09-20.
 *
 *   held out (24 fresh cases)   24/24, 18/18 on the hard ones
 *   dev (22 re-labelled)        21/22
 *   combined                    45/46
 *
 *   confidence when RIGHT   min 49%
 *   confidence when WRONG   max 25%   (one case, "add my greek yogurt bowl")
 *
 * Those SEPARATE, so anything in (0.25, 0.49] accepts every right answer and
 * rejects the wrong one. 0.4 sits inside that band with room on both sides.
 *
 * This floor came DOWN from 0.9, and the reason is worth keeping. 0.9 was
 * compensating for a badly posed question: the first criteria left "create
 * requires an explicit ask" implicit, the two options read as near synonyms, and
 * confidence collapsed on messages a person would also argue about. Four of the
 * labels were simply wrong. Writing the rule down and adding few-shot examples
 * fixed the question, and a fixed question needed a LOWER bar, not a higher one.
 * Reach for the wording before reaching for the threshold.
 *
 * Note how little this floor now does: on 46 cases nothing wrong ever scored
 * above 25%. That is the finding, not the number. A well-posed question makes
 * Jev right when it is confident and honest when it is not, which is the whole
 * promise of a calibrated model and the reason the model step below stays cheap.
 *
 * Limits, stated not buried. 46 cases is still a small sample, and both sets are
 * messages I wrote rather than real traffic. And this is calibrated against
 * jev-1.13.0: re-run the probe before moving JEV_MODEL, because a threshold is
 * owed to one version's distribution and nothing else.
 */
export const JEV_INTENT_FLOOR = 0.4;

/** Options for the Choice. Keys are what comes back, so they are the intent
 *  names themselves and no mapping table can drift out of sync.
 *
 *  Structured rather than prose, which is TypeSafe's own documented way to
 *  sharpen a boundary: `what` the option covers, `not_for` what it does not,
 *  and `examples` of each. The examples are FEW-SHOT and are deliberately not
 *  drawn from any probe case, so a measurement stays a measurement.
 *
 *  The rule they encode is the product decision, and it is what makes this
 *  question answerable at all: CREATE REQUIRES AN EXPLICIT ASK. Describing a
 *  food, even in the present tense, even with macros attached, is a log. The
 *  first version of this left that implicit and the two options read as near
 *  synonyms, so the model's confidence collapsed on exactly the messages a
 *  person would also argue about. The ambiguity was ours, not the model's. */
/** Exported ONLY so the probe measures what ships. A probe holding its own
 *  copy of the wording measures a copy. */
export const INTENT_CRITERIA: Record<FoodIntent, Record<string, unknown>> = {
  log: {
    what:
      "The user is telling the app about food, and has NOT explicitly asked for it to be saved as a reusable entry. " +
      "This is the default: a message about food is a log unless it contains an instruction to save or create.",
    not_for: "Messages that explicitly ask to save, create, or remember a food or meal for future use.",
    examples: [
      "a bowl of poha and chai",
      "half a pizza, maybe 600 calories",
      "had two parathas with curd",
      "my usual shake, 180 cal and 30g protein",
      "chicken 200g, rice 1 cup",
    ],
  },
  create: {
    what:
      "The user has EXPLICITLY asked for a food or meal to be saved, created, or remembered as a reusable entry they can log again later. " +
      "There must be an instruction to that effect in the message. The words vary (save, create, remember, make a meal, add to my meals, set up) but the instruction itself is always present.",
    not_for:
      "Merely describing a food, naming a dish, or giving its calories and macros. Numbers and present tense are NOT a request to save. " +
      "If you have to infer that they probably want it kept, they did not ask, and this is not the option.",
    examples: [
      "create this as a new meal called Desk Lunch",
      "save this combination as a meal for later",
      "remember my evening shake so I can reuse it",
      "add a new food called Nani's khichdi",
    ],
  },
};

export const INTENT_INSTRUCTIONS = {
  question:
    "The state is a message the user typed into a food tracking app. Which option does it match?",
  focus:
    "Decide on the INSTRUCTION in the message, not on the food it describes. " +
    "Ignore whether the food sounds healthy, whether the numbers look plausible, and what the user should do next.",
  default_rule:
    "When the message does not explicitly ask to save or create something, the answer is log.",
};

export interface FoodIntentDeps {
  /** Present when a TYPESAFE_API_KEY is configured. Absent means step 1 of the
   *  ladder simply does not exist, which is a supported state, not an error. */
  jev?: JevDeps;
  /**
   * Step 2. The caller owns the model call because this module must not know
   * about Anthropic: parseMeal.ts keeps the same boundary, and it is what lets
   * the harness swap a stub in. Return null for "I could not decide either",
   * which drops to the default rather than inventing an answer.
   */
  classify?(text: string): Promise<FoodIntent | null>;
  log?: (msg: string) => void;
}

/** Longest message we will send. The jaggedness page is explicit that accuracy
 *  falls as the state fills with detail unrelated to the decision, and nothing
 *  past the first couple of sentences changes whether this is a log or a save.
 *  Trimming is also what keeps a pasted recipe from eating the context budget. */
const MAX_STATE_CHARS = 1200;

function trimForState(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= MAX_STATE_CHARS ? t : `${t.slice(0, MAX_STATE_CHARS)}...`;
}

function isIntent(v: unknown): v is FoodIntent {
  return v === "log" || v === "create";
}

/**
 * Decide what to do with a food message. Never throws, never returns null:
 * something always comes back, and the worst case is the behaviour that shipped
 * before this module existed.
 */
export async function routeFoodIntent(
  text: string,
  deps: FoodIntentDeps = {},
): Promise<FoodIntentDecision> {
  const trimmed = text.trim();
  // Nothing to judge. Not worth a call in either direction, and 'log' is where
  // an empty string already went.
  if (!trimmed) {
    return { intent: "log", source: "default", confidence: null, note: "empty text" };
  }

  const state = trimForState(trimmed);

  // ── Step 1: Jev ───────────────────────────────────────────────────────────
  if (deps.jev?.apiKey) {
    let res: JevResult;
    try {
      res = await askJev(
        { message: state },
        {
          intent: { type: "choice", instructions: INTENT_INSTRUCTIONS, criteria: INTENT_CRITERIA },
        },
        deps.jev,
      );
    } catch (e) {
      // askJev is documented never to throw; this catch exists so a future
      // change to it can never take a meal log down with it.
      res = { ok: false, failure: "http_error", detail: String(e).slice(0, 120) };
    }

    if (res.ok) {
      const choice = asChoice(res.response.answers.intent);
      if (choice && isIntent(choice.choice)) {
        if (choice.confidence >= JEV_INTENT_FLOOR) {
          deps.log?.(
            `[food_intent] jev=${choice.choice} conf=${choice.confidence.toFixed(2)} model=${res.response.model}`,
          );
          return {
            intent: choice.choice,
            source: "jev",
            confidence: choice.confidence,
            note: `jev ${res.response.model}`,
          };
        }
        deps.log?.(
          `[food_intent] jev unsure (${choice.choice} @ ${choice.confidence.toFixed(2)} < ${JEV_INTENT_FLOOR}), falling through`,
        );
      } else {
        deps.log?.("[food_intent] jev returned an unusable answer, falling through");
      }
    } else {
      deps.log?.(`[food_intent] jev ${res.failure}: ${res.detail}`);
    }
  }

  // ── Step 2: the model ─────────────────────────────────────────────────────
  if (deps.classify) {
    try {
      const guess = await deps.classify(state);
      if (isIntent(guess)) {
        deps.log?.(`[food_intent] model=${guess}`);
        return { intent: guess, source: "model", confidence: null, note: "model fallback" };
      }
    } catch (e) {
      deps.log?.(`[food_intent] model classify threw: ${String(e).slice(0, 120)}`);
    }
  }

  // ── Step 3: the floor ─────────────────────────────────────────────────────
  // 'log' on purpose. Getting this wrong in the create direction costs the user
  // a card they dismiss; getting it wrong in the log direction loses the meal
  // they sat down to record.
  deps.log?.("[food_intent] defaulted to log");
  return { intent: "log", source: "default", confidence: null, note: "no router available" };
}
