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
 * MEASURED, not guessed: scripts/food-intent/probe.ts, 22 labelled messages
 * against jev-1.13.0 on 2026-09-20.
 *
 *   confidence when RIGHT   mean 90%, min 35%
 *   confidence when WRONG   mean 47%, max 87%
 *
 * Those overlap, so no floor makes Jev correct. What a floor can do is catch the
 * cases where it is guessing, and here the guessing is honest: the low-confidence
 * answers were the genuinely ambiguous messages ("I had my usual breakfast bowl,
 * save it too" at 37%, "add my greek yogurt bowl" at 17%) that a person would
 * also hesitate on. That is calibration working.
 *
 * 0.9 rather than something looser because of ONE case: "my protein shake is 180
 * cal, 30g protein" went to log at 87% confident, which is wrong and which any
 * floor below 0.88 waves through. At 0.9 the 16 accepted answers were 16 right,
 * and the 6 rejected are the muddy ones the model step exists for.
 *
 * Two honest limits. 22 cases is a small sample, so this is a measured starting
 * point rather than a proven optimum. And it is calibrated against jev-1.13.0
 * specifically: re-run the probe before moving JEV_MODEL, because a threshold is
 * owed to one version's distribution and nothing else.
 */
export const JEV_INTENT_FLOOR = 0.9;

/** Options for the Choice. Keys are what comes back, so they are the intent
 *  names themselves and no mapping table can drift out of sync.
 *
 *  Written the way the jaggedness page asks for: jev-1.13 "answers the question
 *  you wrote, not the one you meant", so each rubric states the exact condition
 *  and names the boundary case rather than gesturing at it. The tense rule is
 *  spelled out because it is the single strongest signal in this decision and
 *  leaving it implicit made the two options read as near-synonyms. */
const INTENT_CRITERIA: Record<FoodIntent, string> = {
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
};

const INTENT_INSTRUCTIONS =
  "The state is a message the user typed into a food tracking app. " +
  "Decide whether they are recording food they ate, or defining a food to save for later use. " +
  "Judge only what this message asks for. Do not consider whether the food sounds healthy, whether the numbers are plausible, or what they should do next.";

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
