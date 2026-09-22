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

import {
  asChoice,
  askJev,
  type JevCriterion,
  type JevDeps,
  type JevQuestion,
  type JevResult,
} from "./jev.ts";

/** The intents we route on TODAY.
 *
 *  'other' is everything that is neither eating nor saving: a greeting, a
 *  question about the app, small talk. It exists because the two-box version
 *  had to put "hey" SOMEWHERE, and it put it in 'log' at 100% confidence.
 *  Confident because 'create' was clearly wrong, not because 'log' was right.
 *  A Choice with no honest home for a message will still answer, and will
 *  sound sure doing it.
 *
 *  'improvise' (build me something from what I have) and 'challenge' (push back
 *  on what I logged) are still coming. They stay out until the downstream code
 *  can handle them: an option with nowhere to go is a route to nowhere. */
export type FoodIntent = "log" | "create" | "other";

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
  /** The user's own saved food this message names, when Jev was sure enough.
   *  Null when they have none saved, when nothing matched, or when the match was
   *  not confident enough to outrank the pipeline. */
  savedMatch: SavedMealMatch | null;
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
    not_for:
      "Messages that explicitly ask to save, create, or remember a food or meal for future use. " +
      "Also not for messages that report no eating at all, such as a greeting or a question about the app.",
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
  other: {
    what:
      "The user is not reporting anything they ate or drank, and is not asking for anything to be saved. " +
      "Greetings, thanks, small talk, and questions about the app or about nutrition in general all belong here.",
    not_for:
      "Any message that reports eating or drinking. That holds even when no specific food or dish is named, " +
      "and even when the report comes alongside a greeting. \"hi, had two eggs\" is a log, not this.",
    examples: [
      "good morning",
      "thanks, that helps",
      "what can you do",
      "is rice bad for cutting",
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
    "If the message reports eating or drinking and does not explicitly ask to save anything, the answer is log. " +
    "If it reports no eating at all, the answer is other.",
};

/**
 * How much the router is allowed to do.
 *
 * 'shadow' exists because a decision layer earns trust on real traffic before it
 * gets to change anything. The floor in this file was measured on 46 messages I
 * wrote; shadow is how it meets messages people actually type.
 */
export type FoodIntentMode = "off" | "shadow" | "on";

/** Parse an env string into a mode. Anything unrecognised is 'shadow', not an
 *  error and not 'on': a typo in a secret must never be the thing that starts
 *  diverting people's meals. */
export function parseFoodIntentMode(raw: string | undefined): FoodIntentMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "off" || v === "on" || v === "shadow" ? v : "shadow";
}

/**
 * Is this turn worth asking about at all?
 *
 * Two reasons not to, and the second is the interesting one. A CORRECTION turn
 * (a parsed meal already on screen, "no, the other one", "make it two") is
 * neither logging nor creating. It is editing. Routing it as either would be
 * wrong in both directions, and asking would spend a call to receive a
 * meaningless answer.
 */
export function shouldRouteFoodIntent(mode: FoodIntentMode, isCorrection: boolean): boolean {
  if (mode === "off") return false;
  if (isCorrection) return false;
  return true;
}

/** One of the user's saved foods or meals, reduced to what a match needs. The
 *  macros ride along because they are what the match is FOR: a hit means we log
 *  the user's own numbers instead of re-estimating them. */
export interface SavedMealSummary {
  id: string;
  name: string;
  kcal: number;
  protein_g?: number | null;
  item_count?: number;
}

export interface SavedMealMatch {
  id: string;
  name: string;
  confidence: number;
}

/** The option key meaning "none of their saved meals". TypeSafe's guidance is
 *  explicit that a Choice needs a no-match outcome when nothing may fit, and
 *  without one the model is forced to name a meal for "two eggs and toast". */
export const NO_SAVED_MATCH = "__none__";

/**
 * The bar for letting a saved meal REPLACE what the pipeline would have worked
 * out on its own.
 *
 * Higher than the intent floor on purpose, and the asymmetry is the point.
 * Getting the intent wrong shows someone a card they dismiss. Getting this wrong
 * logs the wrong food with the wrong numbers, silently, under a name they
 * recognise. Wrong in a way that looks right is the worst kind, so this one has
 * to be nearly sure.
 *
 * Unmeasured: unlike JEV_INTENT_FLOOR there is no probe behind this number yet,
 * because it needs a real user's real saved meals to mean anything. It runs in
 * shadow first for exactly that reason. Treat 0.8 as deliberately cautious
 * rather than as calibrated.
 */
export const SAVED_MATCH_FLOOR = 0.8;

/** Cap on how many saved meals go into one question. The API allows 255 options
 *  and the jaggedness page warns accuracy falls as the state fills with
 *  irrelevant detail, so this is about the second limit, not the first. Newest
 *  first, which is the order listSavedMeals already returns. */
const MAX_SAVED_OPTIONS = 60;

export interface FoodIntentDeps {
  /** The user's saved foods and meals. When non-empty, the SAME Jev call that
   *  routes the intent also asks which of these the message names, because
   *  questions are evaluated in parallel against one state and the state is only
   *  charged once. A second call would pay for the message twice to learn two
   *  things about it. */
  savedMeals?: SavedMealSummary[];
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

/** Build the saved-meal Choice, plus the map from option key back to row id.
 *
 *  Keyed by NAME rather than id because the key is what the model matches on:
 *  "m7" carries no meaning, and a rubric that has to explain which id is which
 *  is a hop of indirection the jaggedness page says costs accuracy. Duplicate
 *  names get a suffix so the map stays one-to-one. */
function savedMealQuestion(
  saved: SavedMealSummary[],
): { question: JevQuestion; byKey: Map<string, SavedMealSummary> } | null {
  if (saved.length === 0) return null;

  const byKey = new Map<string, SavedMealSummary>();
  const criteria: Record<string, JevCriterion> = {
    [NO_SAVED_MATCH]: {
      what: "The message does not name any of the saved foods below.",
      note: "This is the normal answer. Most messages are ordinary food, not one of their saved entries.",
    },
  };

  for (const m of saved.slice(0, MAX_SAVED_OPTIONS)) {
    const base = m.name.trim().slice(0, 60) || "Saved meal";
    let key = base;
    for (let n = 2; byKey.has(key); n++) key = `${base} (${n})`;
    byKey.set(key, m);
    criteria[key] = {
      what: `The user's own saved entry "${m.name}", ${Math.round(m.kcal)} kcal` +
        (m.item_count && m.item_count > 1 ? `, ${m.item_count} items` : ""),
      matches_when: "The message names this food or meal, by this name or an obvious short form of it.",
    };
  }

  return {
    question: {
      type: "choice",
      instructions: {
        question: "Which of the user's saved foods does this message name, if any?",
        focus:
          "Match on the FOOD being named, not on whether they want it saved or logged. " +
          "Only pick a saved entry when the message is clearly about that same food. " +
          "A food that merely resembles a saved one is not a match: prefer __none__ whenever there is real doubt.",
      },
      criteria,
    },
    byKey,
  };
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
  return v === "log" || v === "create" || v === "other";
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
    return { intent: "log", source: "default", confidence: null, note: "empty text", savedMatch: null };
  }

  const state = trimForState(trimmed);
  let savedMatch: SavedMealMatch | null = null;

  // ── Step 1: Jev ───────────────────────────────────────────────────────────
  if (deps.jev?.apiKey) {
    // BOTH questions in one call. They are independent and evaluated in
    // parallel against the same state, which is charged once, so the saved-meal
    // match is very nearly free on top of the routing we already wanted.
    const savedQ = savedMealQuestion(deps.savedMeals ?? []);
    const questions: Record<string, JevQuestion> = {
      intent: { type: "choice", instructions: INTENT_INSTRUCTIONS, criteria: INTENT_CRITERIA },
    };
    if (savedQ) questions.saved = savedQ.question;

    let res: JevResult;
    try {
      res = await askJev({ message: state }, questions, deps.jev);
    } catch (e) {
      // askJev is documented never to throw; this catch exists so a future
      // change to it can never take a meal log down with it.
      res = { ok: false, failure: "http_error", detail: String(e).slice(0, 120) };
    }

    if (res.ok) {
      // Read the saved match first: it is useful whatever the intent turns out
      // to be, and it survives the intent falling through to the model step.
      if (savedQ) {
        const sc = asChoice(res.response.answers.saved);
        if (sc && sc.choice !== NO_SAVED_MATCH) {
          const row = savedQ.byKey.get(sc.choice);
          if (row && sc.confidence >= SAVED_MATCH_FLOOR) {
            savedMatch = { id: row.id, name: row.name, confidence: sc.confidence };
            deps.log?.(`[food_intent] saved="${row.name}" conf=${sc.confidence.toFixed(2)}`);
          } else if (row) {
            deps.log?.(
              `[food_intent] saved "${row.name}" @ ${sc.confidence.toFixed(2)} below ${SAVED_MATCH_FLOOR}, ignored`,
            );
          }
        }
      }

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
            savedMatch,
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
        return { intent: guess, source: "model", confidence: null, note: "model fallback", savedMatch };
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
  return { intent: "log", source: "default", confidence: null, note: "no router available", savedMatch };
}

// ── Policy: what the food bar actually DOES ─────────────────────────────────
//
// routeFoodIntent is perception: what does this message look like. This is the
// decision, kept apart on purpose. A calibrated guess is a good input and a bad
// boss. The measured failures are what shaped these rules:
//
//   "lunch today was around 700 calories"   Jev: other @ 76%   truth: log
//   "add my greek yogurt bowl"              Jev: create @ 64%  truth: log
//
// Both are the DANGEROUS direction. A log read as other means Drona chats back
// instead of recording the meal. A log read as create turns "I ate this" into a
// save prompt. So neither gets to act on Jev's word alone.

/** What the food bar does with a message. 'reply' is Drona answering in words,
 *  for a greeting or a question, instead of the canned "tell me what you ate". */
export type FoodAction = "log" | "create" | "reply";

/**
 * The bar for letting 'create' pull a message out of the parse.
 *
 * Above JEV_INTENT_FLOOR on purpose. The one false create measured sat at 64%
 * and every clear create the probe offered ("save my overnight oats as a meal",
 * "create a food called gym shake") landed at 99-100%. Below this, a create
 * verdict is treated as a log, which is the safe miss: the parse shows the meal
 * and nothing is saved that the user did not ask for.
 */
export const CREATE_ACTION_FLOOR = 0.7;

export interface FoodActionInputs {
  /** The router's verdict. Null when it did not run (mode off, a correction). */
  decision: FoodIntentDecision | null;
  mode: FoodIntentMode;
  /** Did the parse find anything to log? The parse is the ground truth for
   *  "is there food in this message": it is the thing actually built to answer
   *  that, and it has already run by the time this is decided. */
  parseFoundFood: boolean;
  /** Does this CLIENT know how to render a create? Builds already in testers'
   *  hands do not, and sending them a payload they cannot draw would dead-end
   *  the food bar, the exact failure 0088's `state: 'free'` caused a day before
   *  the client understood it. Old clients keep today's behaviour. */
  clientSupportsCreate: boolean;
}

/**
 * Decide what the food bar does. Pure, so every rule below is pinned by a test
 * rather than by hoping nobody reorders the ifs in index.ts.
 *
 * The shape of it: 'log' is the default and wins every tie, because it is what
 * shipped and because losing a meal the user sat down to record is the worst
 * outcome available here. Anything else has to earn its way past it.
 */
export function decideFoodAction(i: FoodActionInputs): FoodAction {
  // Not live, or nothing to go on: exactly today's behaviour.
  if (i.mode !== "on" || !i.decision) return "log";

  const { intent, confidence, source } = i.decision;

  if (intent === "create") {
    if (!i.clientSupportsCreate) return "log";
    // Only a CONFIDENT Jev answer may divert. The model rung has no calibrated
    // number to clear this bar with, and the default rung is a guess by
    // definition, so neither of them gets to turn a meal into a save prompt.
    if (source !== "jev" || confidence === null || confidence < CREATE_ACTION_FLOOR) return "log";
    return "create";
  }

  if (intent === "other") {
    // Jev thinks there is no eating here. The parse is the one that would
    // know, so it gets the veto: if it found food, this is a log and Jev was
    // wrong. A wrong 'other' can therefore never cost anyone a meal. It can
    // only turn a decline into a better answer.
    return i.parseFoundFood ? "log" : "reply";
  }

  return "log";
}

// ── What happened after the decision ─────────────────────────────────────────
//
// A 'reply' or a 'create' is a second model call, and until this existed its
// output reached the user and nowhere else. Asked "what did Drona tell them",
// the trace could only offer the parse's own decline, which the user never saw
// whenever a reply replaced it. These readers turn the raw call into the value
// the food bar serves AND the record the trace keeps, in one place, so the two
// cannot drift apart.

/** callAnthropic's result, restated here so this module stays import-free of
 *  index.ts and can be tested on its own. */
export type AnthropicCallResult =
  | { ok: true; data: any }
  | { ok: false; status: number; body: string };

/** Everything the follow-up call did, for parse_traces. */
export interface FoodFollowup {
  kind: "reply" | "create";
  ok: boolean;
  ms: number;
  /** Set when the call failed: the HTTP status (504 for our own timeout). */
  http_status: number | null;
  error: string | null;
  stop_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** reply: the model's text BEFORE cleanup. */
  raw_text: string | null;
  /** reply: the exact sentence the user was shown. Null means nothing was
   *  shown and the bar fell back to the log path. */
  shown_text: string | null;
  /** create: which tool the model picked, and the card it drafted. */
  tool: string | null;
  draft: Record<string, unknown> | null;
}

const ERROR_BODY_MAX = 300;
const REPLY_MAX_CHARS = 400;

function baseFollowup(kind: FoodFollowup["kind"], res: AnthropicCallResult, ms: number): FoodFollowup {
  const usage = res.ok ? res.data?.usage : null;
  return {
    kind,
    ok: false,
    ms,
    http_status: res.ok ? null : res.status,
    error: res.ok ? null : String(res.body ?? "").slice(0, ERROR_BODY_MAX),
    stop_reason: res.ok ? (res.data?.stop_reason ?? null) : null,
    input_tokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : null,
    output_tokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
    raw_text: null,
    shown_text: null,
    tool: null,
    draft: null,
  };
}

/** The follow-up that never ran because there was no API key. */
export function skippedFollowup(kind: FoodFollowup["kind"]): FoodFollowup {
  return { ...baseFollowup(kind, { ok: false, status: 0, body: "" }, 0), http_status: null, error: "no_api_key" };
}

/** Read the reply call. `reply` is what the food bar shows, or null to fall
 *  back to the log path. */
export function readReplyResult(
  res: AnthropicCallResult,
  ms: number,
): { reply: string | null; followup: FoodFollowup } {
  const followup = baseFollowup("reply", res, ms);
  if (!res.ok) return { reply: null, followup };
  const raw = ((res.data?.content ?? []) as { type?: string; text?: string }[])
    .filter((b) => b?.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const cleaned = raw
    .trim()
    // A stray em dash reads as machine-written. Belt on top of the prompt.
    .replace(/\s*—\s*/g, ", ");
  const reply = cleaned.length > 0 ? cleaned.slice(0, REPLY_MAX_CHARS) : null;
  return {
    reply,
    followup: {
      ...followup,
      ok: reply !== null,
      error: reply === null ? "empty_reply" : null,
      raw_text: raw,
      shown_text: reply,
    },
  };
}

const CREATE_TOOLS = new Set(["create_custom_food", "create_custom_meal"]);

/** Read the create-draft call. `create` is the card the food bar shows, or
 *  null to fall back to the log path. */
export function readDraftResult(
  res: AnthropicCallResult,
  ms: number,
): { create: { tool: string; input: Record<string, unknown> } | null; followup: FoodFollowup } {
  const followup = baseFollowup("create", res, ms);
  if (!res.ok) return { create: null, followup };
  const block = ((res.data?.content ?? []) as { type?: string; name?: string; input?: unknown }[])
    .find((b) => b?.type === "tool_use");
  const tool = block?.name ? String(block.name) : null;
  const input = (block?.input ?? null) as Record<string, unknown> | null;
  if (!tool || !CREATE_TOOLS.has(tool)) {
    return { create: null, followup: { ...followup, tool, draft: input, error: tool ? "wrong_tool" : "no_tool_call" } };
  }
  const create = { tool, input: input ?? {} };
  return { create, followup: { ...followup, ok: true, tool, draft: create.input } };
}
