// The food agent: messages in the Nutrition box that need more than one step.
//
//   "save yesterday's oat meal from breakfast as a meal, and log it at lunch"
//
// Plan: .planning/food-agent-plan.md. The shape, and why:
//
// - No written plan. Each turn the model asks for EVERY tool it needs right
//   now, we run them in parallel, it sees all the results and picks the next
//   move. A written plan is output tokens, and output tokens are the latency.
// - At most MAX_TURNS model calls. The last one is told it is the last, and the
//   code does not run a read on it: a turn that still reaches for a read ends
//   the agent with an honest "could not finish", never a sixth call.
// - The agent never produces a nutrition number. parse_food runs the normal
//   parser (Haiku, the user's mode). Diary and saved-meal rows are copied.
// - Every result it can end with is a shape the app already draws: a meal card
//   (log), a save card (create, which can also log in the same tap), or a reply.
//
// Deps are injected so the loop is testable without the network.

import { energyUnitKcal, fitPortionToStated, isWeightLabel, lineAmountNamed, totalNote, userNumbersOnLine } from "./statedNumbers.ts";
import { type FoodOrigin, ORIGIN_RANK, originOf, parseRecipe } from "../_shared/foodOrigin.ts";
import { summarize } from "./foodBarTrace.ts";
import { CARD_MAX_LINES, type CardLine, cardLines, cardMayBeCut, FOOD_TURN_CHARS, FOOD_TURNS_KEPT } from "./foodContext.ts";
import { sonnetSettings } from "../_shared/sonnet.ts";
import {
  type AnthropicTool,
  CREATE_CUSTOM_FOOD_TOOL,
  CREATE_CUSTOM_MEAL_TOOL,
  LIST_LOGGED_MEALS_TOOL,
  LIST_SAVED_MEALS_TOOL,
} from "./prompt.ts";
import type { LabelFound, MealType, ParsedItem, ParseMealResult, ParseStep } from "./parseMeal.ts";
import { unitWeightMatchesGrams } from "./parseMeal.ts";
import type { SavedMealForParse } from "./savedMeals.ts";
import { lineAsItem, type ThreadLine } from "./foodThreads.ts";
import { falseAgentClaim } from "./foodIntent.ts";
import type { ThreadCardLines } from "./foodBar.ts";
import { type FoodRegion, regionalizePrompt } from "./regionRules.ts";
import { BUILD_RECIPE_TOOL, buildRecipe, RECIPE_NOTE, type RecipeAsk, readRecipeAsk, recipeQuestion, rememberedRecipe } from "./recipe.ts";
import {
  type FoodAgentWarm,
  hasOlderTurns,
  memoryMatchesBlock,
  memoryMatchesOf,
  READ_THREAD_TOOL,
  RECALL_FOOD_TOOL,
  type RecallFood,
  RECIPE_MEMORY_NOTE,
  runWarmRead,
  briefly,
  RECIPE_MEMORY_WAIT_MS,
  searchThreadsTool,
  warmNote,
  warmStatus,
  warmThreadText,
} from "./foodWarmMemory.ts";
import type { WarmThread } from "./foodThreads.ts";
import { memoryKey } from "./userFoodMemory.ts";

export const MAX_TURNS = 5;

/** Turns for an agent answering a later message (FOOD_AGENT_LATER=on, owner
 *  decision 2026-11-06). The off path keeps MAX_TURNS, so the switch off
 *  changes nothing. */
export const MAX_TURNS_LATER = 6;

type CallResult = { ok: true; data: any } | { ok: false; status: number; body: string };

export interface FoodAgentDeps {
  model: string;
  callModel(body: Record<string, unknown>): Promise<CallResult>;
  readDiary(input: Record<string, unknown>): Promise<unknown>;
  savedMeals(): Promise<SavedMealForParse[]>;
  /** The normal meal parser, in the user's mode. */
  parseFood(text: string): Promise<ParseMealResult>;
  /** The correction path, run against the card on screen: it rescales from
   *  each line's own numbers, so the agent decides WHAT changes and the code
   *  decides the numbers. `text` is the change in plain words. */
  correctCard?(text: string): Promise<ParseMealResult>;
  /** edit_line (FOOD_AGENT_LATER): the correction path run on ONE card line
   *  (its index in `card`), with the change in plain words. The same lookup
   *  and decide pipeline, scoped to that one item; every other line is copied
   *  by code and never seen by the parse. */
  editLine?(index: number, change: string): Promise<ParseMealResult>;
  /** find_label: one product's printed label off the web (parseMeal.ts
   *  findLabel). Absent: the agent has no find_label tool. */
  findLabel?(product: { name: string; brand: string | null }): Promise<LabelFound | null>;
  /** FOOD_BUILD_RECIPE=on: a later-mode agent gets build_recipe (recipe.ts).
   *  Each part is one parseFood call; code adds the parts up. */
  buildRecipe?: boolean;
  /** An earlier card of this thread, as items, or null when there is none by
   *  that ref (foodThreads.ts). `version` null: the card's latest version.
   *  Present only when the thread store is on and the thread has cards. */
  restoreCard?(ref: string, version: number | null): Promise<{ items: ParsedItem[]; meal_type: MealType | null } | null>;
  /** An earlier card's stored lines (latest version when null), for
   *  copy_lines and read_card. Present with the thread store on and earlier
   *  cards in the thread. */
  threadCard?(ref: string, version: number | null): Promise<ThreadCardLines | null>;
  /** The ref the card on screen has in this thread (C2), when it has one, so
   *  read_card and copy_lines can say "that is the card on screen". */
  threadOnScreenRef?: string | null;
  /** The diary like readDiary, with each line's catalog id and source too
   *  (loggedMeals.ts full), for copy_lines. Absent: no copy from the diary. */
  readDiaryLines?(input: Record<string, unknown>): Promise<unknown>;
  /** One record per copy_lines, read_card and restore_card call (and each
   *  refusal), for the food box trace. Never awaited. */
  onEvent?(e: AgentEvent): void;
  /** A line for the user while the agent works. Never awaited. */
  onStatus?(label: string): void;
  log?(msg: string): void;
  /** FOOD_WARM_MEMORY=on, later-mode runs only (foodWarmMemory.ts): the warm
   *  reads recall_food, read_thread and search_threads, the matches block,
   *  and remembered recipe parts in build_recipe. Absent: none of them. */
  warm?: FoodAgentWarm;
}

export interface FoodAgentInput {
  text: string;
  /** The meal a log lands in when nothing else says: hint, else the clock. */
  defaultMeal: MealType;
  /** The user's own today, e.g. "Tuesday 2026-09-22", so "Monday's lunch" can
   *  become a days_ago. Absent when the client sent no local date. */
  today?: string | null;
  /** The last few turns of this food conversation, oldest first. Without them
   *  "log the same meal in snacks too" has no meal and "yes" has no question:
   *  seen live, both got a blank stare. */
  recentTurns?: { role: "user" | "drona"; text: string }[];
  /** The agent asked the user a question last turn and this text is the
   *  answer. Said again in the opening message, so the answer is read against
   *  the agent's own question even when the app sent no history. */
  answering?: { text: string; question: string } | null;
  /** The meal card on screen, when there is one: parsed, not yet added. The
   *  agent can edit it, add to it, remove from it, save it as a meal, or talk
   *  about it. Its numbers are the user's working copy, never to be re-guessed. */
  card?: CardLine[] | null;
  /** The router's read of the message: which saved meal it names, and how
   *  sure (0-1). One line in the opening message, so the agent can fetch that
   *  one meal with list_saved_meals instead of reading them all. A pointer,
   *  not a verdict: the amount and the day in the message win. Not checked
   *  against the saved list here, unlike the parse's swap offer: the router
   *  picked it from that same list, and the agent must list_saved_meals
   *  before it copies a line anyway, so a stale pick simply comes back empty. */
  savedHint?: { id: string; name: string; confidence: number } | null;
  /** The thread's index line (foodThreads.ts threadIndexLine): the earlier
   *  cards that exist, by ref. With it the agent gets restore_card. */
  threadIndex?: string | null;
  /** FOOD_AGENT_LATER=on: this agent answers a later message of the thread.
   *  The card shows line ids, its tools change one line at a time
   *  (edit_line, remove_lines, add_lines, applied in that order), a reply may
   *  ride along with a change, and the run has MAX_TURNS_LATER turns. */
  later?: boolean;
  /** FOOD_FIRST_GATE=on: this later-mode agent answers the FIRST message of
   *  the thread (the gate said it is not a plain log). No card yet; the parse
   *  of the whole message is already running (FIRST_NOTE). Only with `later`. */
  first?: boolean;
  /** FOOD_REGION_RULES=on and a Precise message: the instructions take this
   *  region's examples (regionRules.ts). Absent: today's instructions. */
  regionRules?: { region: FoodRegion | null };
  /** FOOD_WARM_MEMORY=on with the thread store on: this thread's first
   *  message, summary and turn count (foodThreads.ts warm). Later mode only. */
  warmThread?: WarmThread | null;
}

/** The card for the agent with stable line ids: "[L2] Roti: 2 piece, ...". An
 *  id names the line as the message found it, so a removal never renumbers
 *  what another call in the same turn points at. */
export function cardLinesWithIds(card: CardLine[]): string[] {
  return cardLines(card, { macros: true, sources: true }).map((l) => l.replace(/^(\d+)\.\s/, "[L$1] "));
}

/** "L2", "[L2]", "l2" or 2 to a card index (0-based), or null. */
export function lineIndexOf(raw: unknown, cardLength: number): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim().replace(/^\[?l/i, "").replace(/\]$/, "")) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= cardLength ? n - 1 : null;
}

/** The opening user message: the date, then (when this answers the agent's
 *  question) what was asked, then the user's words. */
export function openingText(
  input: Pick<FoodAgentInput, "text" | "answering" | "card" | "savedHint" | "threadIndex" | "later">,
  days: string | null,
  /** FOOD_WARM_MEMORY: the thread lines and the matches block, each already
   *  in brackets (foodWarmMemory.ts). Absent or null: left out. */
  warm: { thread?: string | null; matches?: string | null } = {},
): string {
  const parts: string[] = [];
  if (days) parts.push(`(${days})`);
  if (input.threadIndex) parts.push(`(${input.threadIndex})`);
  if (warm.thread) parts.push(warm.thread);
  if (input.card?.length) {
    const lines = input.later ? cardLinesWithIds(input.card) : cardLines(input.card, { macros: true });
    parts.push(`(card on screen:\n${lines.join("\n")})`);
  }
  if (warm.matches) parts.push(warm.matches);
  if (input.savedHint) {
    const name = JSON.stringify(input.savedHint.name);
    parts.push(
      `(The app's router read this as naming the user's saved meal ${name}, ${Math.round(input.savedHint.confidence * 100)}% sure. ` +
        `A pointer, not a verdict: check it with list_saved_meals (query ${name}) before copying its lines, ` +
        "and let the amount and the day in the message win.)",
    );
  }
  if (input.answering) {
    parts.push(
      `(This answers your question ${JSON.stringify(input.answering.question)} about the user's message ${JSON.stringify(input.answering.text)}. ` +
        "Finish that request. When it is about food already in the diary, read the diary again and copy the logged lines.)",
    );
  }
  parts.push(input.text);
  return parts.join("\n");
}

export interface AgentTurn {
  turn: number;
  ms: number;
  tools: { name: string; input: unknown }[];
  input_tokens: number | null;
  output_tokens: number | null;
  /** What each read returned, cut short, in the order of `tools`. Absent on
   *  the finishing turn: what a finish did is the agent's outcome. */
  results?: { name: string; summary: string | null }[];
}

/** What the trace keeps of a copy, read or restore (food_bar_traces steps). */
export type AgentEvent =
  | {
    tool: "copy_lines";
    source_kind: "thread" | "diary" | "unknown";
    asked: number;
    copied: number;
    already_on_card: number;
    not_found: number;
    /** The copy finished the agent (every line copied, or the last turn). */
    finished: boolean;
    error: string | null;
  }
  | { tool: "restore_card"; ok: boolean; reason: "restored" | "not_found" | "card_open" | "no_thread" }
  | { tool: "read_card"; found: boolean; on_screen?: boolean }
  | { tool: "find_label"; found: boolean }
  /** FOOD_WARM_MEMORY: build_recipe's wait for remembered parts ran out. */
  | { tool: "recipe_memory"; timed_out: true; waited_ms: number }
  | {
    tool: "card_changes";
    /** Applied (ok) or sent back to the agent (a conflict, an unknown line). */
    ok: boolean;
    edits: number;
    edits_failed: number;
    removed: number;
    added: number;
    error: string | null;
    /** A claim in the agent's line that did not happen, replaced by code. */
    false_claim?: boolean;
    /** Dishes build_recipe put on the card (FOOD_BUILD_RECIPE). */
    recipes?: number;
  };

export type FoodAgentOutcome =
  /** `answered`: a reply rode along with the change, and is the card's line. */
  | { kind: "log"; result: ParseMealResult; turns: AgentTurn[]; answered?: boolean }
  | { kind: "create"; create: { tool: string; input: Record<string, unknown> }; turns: AgentTurn[] }
  | { kind: "reply"; text: string; turns: AgentTurn[] }
  | { kind: "failed"; reason: string; turns: AgentTurn[] };

// ── Tools the agent gets on top of the shared ones ──────────────────────────

const PARSE_FOOD_TOOL: AnthropicTool = {
  name: "parse_food",
  description:
    "Work out the foods and numbers for food described in words, the same way the app does for any meal " +
    "(the user's saved meals and their chosen accuracy mode apply). Returns the lines it would log. " +
    "Use it for food that is NOT already in the diary or in their saved meals. Logs nothing.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: 'The food in plain words, e.g. "2 eggs and a slice of toast".' },
    },
    required: ["text"],
  },
};

const LOG_FOOD_TOOL: AnthropicTool = {
  name: "log_food",
  description:
    "FINISH: log food to TODAY's diary. Give `text` for food to be worked out (it runs parse_food, reusing a " +
    "parse you already did for the same text), and/or `items` to copy lines from a saved meal, or diary lines " +
    "whose amount the user changed (repeat a line with a different meal_type to put the same food in two " +
    "sections). Unchanged lines from the diary or an earlier card go through copy_lines when it is offered. " +
    "Logs to today only.",
  input_schema: {
    type: "object",
    properties: {
      meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"], description: "Where it goes today." },
      text: { type: "string", description: "Food to work out, in plain words." },
      items: {
        type: "array",
        description: "Lines copied from the diary or a saved meal, with their numbers unchanged.",
        items: {
          type: "object",
          properties: {
            food_name: { type: "string" },
            quantity: { type: "number" },
            serving_label: { type: "string" },
            grams: { type: "number" },
            kcal: { type: "number" },
            protein_g: { type: "number" },
            carb_g: { type: "number" },
            fat_g: { type: "number" },
            meal_type: {
              type: "string",
              enum: ["breakfast", "lunch", "dinner", "snack"],
              description: "This line's own section, when one message puts food in more than one (\"the same meal in breakfast and snacks\"). Omit to use meal_type above.",
            },
          },
          required: ["food_name", "kcal"],
        },
      },
      summary: {
        type: "string",
        description: "One short line in a coach's voice about what is being logged. No em dashes.",
      },
    },
    required: ["summary"],
  },
};

const EDIT_CARD_TOOL: AnthropicTool = {
  name: "edit_card",
  description:
    "FINISH: change the meal card on screen. Say the change in plain words, naming the line as the card names it: " +
    "\"make the roti 2\", \"the chana is navratri chana, not boiled\", \"the paneer sabji already has the onion and tomato " +
    "in it, remove the separate Tomato and Onion line\", \"the pooris were small\". The app reworks the numbers from " +
    "each line's own figures; you never do the arithmetic. One call can carry several changes. Lines you do not " +
    "mention stay as they are.",
  input_schema: {
    type: "object",
    properties: {
      change: { type: "string", description: "Every change to make, in plain words, naming each line as the card does." },
      summary: { type: "string", description: "One short line in a coach's voice saying what you changed. No em dashes." },
    },
    required: ["change", "summary"],
  },
};

const REMOVE_CARD_LINES_TOOL: AnthropicTool = {
  name: "remove_card_lines",
  description:
    "FINISH: take lines off the meal card on screen. Give the line numbers from the card as shown. " +
    "Use this when the user says a line should not be there at all; use edit_card when a line should change.",
  input_schema: {
    type: "object",
    properties: {
      lines: { type: "array", items: { type: "integer" }, description: "Card line numbers to remove, 1-based." },
      summary: { type: "string", description: "One short line saying what came off. No em dashes." },
    },
    required: ["lines", "summary"],
  },
};

const SAVE_CARD_AS_MEAL_TOOL: AnthropicTool = {
  name: "save_card_as_meal",
  description:
    "FINISH: offer to save the meal card on screen as a reusable saved meal, with every line copied exactly. " +
    "Use it when the user asks to keep, save, or make a meal of what is on the card. The user taps the card to save. " +
    "It saves the WHOLE card: when they name one dish on it, save that line with create_custom_food instead.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "What to call it, from the user's words or the main foods. Max 80 characters." },
      log_now: { type: "boolean", description: "True when they also ate it now (the card is a meal they are logging), false to only save it." },
      summary: { type: "string", description: "One short line written as an OFFER, never as done. No em dashes." },
    },
    required: ["name", "log_now", "summary"],
  },
};

const RESTORE_CARD_TOOL: AnthropicTool = {
  name: "restore_card",
  description:
    "FINISH: bring back an earlier card of this conversation as the meal card on screen, with its lines and numbers " +
    "exactly as they were. Name it by its ref from the thread index (C1, C2, ...). Use it when the user wants a card " +
    "back that is no longer on screen. It replaces whatever card is on screen now.",
  input_schema: {
    type: "object",
    properties: {
      card: { type: "string", description: "The card's ref from the thread index, e.g. C1." },
      version: { type: "integer", description: "An earlier version of that card. Omit for its latest version." },
      summary: { type: "string", description: "One short line saying which card is back. No em dashes." },
    },
    required: ["card", "summary"],
  },
};

const COPY_LINES_TOOL: AnthropicTool = {
  name: "copy_lines",
  description:
    "Put foods on the meal card from ONE source, with the numbers and source copied by the app exactly as stored: " +
    "an earlier card of this conversation (source.card, its ref from the thread index, e.g. C1) or a meal in the " +
    "diary (source.days_ago or source.date, with source.meal_type). Name the lines by their line id from the index " +
    "or read_card (L2), or by their name as the diary shows it; omit `lines` for every line of that source. It only " +
    "adds: lines already on the card stay exactly as they are. With no card on screen it makes the card. When every " +
    "line is copied this finishes. Otherwise nothing is added and you get each line's result: already_on_card (that " +
    "food is on the card now) or not_found.",
  input_schema: {
    type: "object",
    properties: {
      source: {
        type: "object",
        description: "Where the lines come from: { card, version? } or { days_ago | date, meal_type }.",
        properties: {
          card: { type: "string", description: "An earlier card's ref from the thread index, e.g. C1." },
          version: { type: "integer", description: "An older version of that card. Omit for its latest." },
          days_ago: { type: "integer", description: "Diary day: 0 today, 1 yesterday." },
          date: { type: "string", description: "Diary day as YYYY-MM-DD, instead of days_ago." },
          meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"], description: "The diary meal." },
        },
      },
      lines: { type: "array", items: { type: "string" }, description: "Line ids (L2) or diary food names. Omit for all lines." },
      meal_type: {
        type: "string",
        enum: ["breakfast", "lunch", "dinner", "snack"],
        description: "Where the copied lines go today. Omit: the card's meal, else the meal of the hour.",
      },
      add_again: {
        type: "boolean",
        description: "True only after the user chose to add a second portion of a food already on the card.",
      },
    },
    // No summary: the app writes the line the user reads from what it copied.
    required: ["source"],
  },
};

const READ_CARD_TOOL: AnthropicTool = {
  name: "read_card",
  description:
    "Read an earlier card of this conversation by its ref (C1): its lines with line ids and numbers. Give `version` " +
    "to read an older version of it. Logs nothing.",
  input_schema: {
    type: "object",
    properties: {
      card: { type: "string", description: "The card's ref, e.g. C1." },
      version: { type: "integer", description: "An older version. Omit for its latest." },
    },
    required: ["card"],
  },
};

const REPLY_TOOL: AnthropicTool = {
  name: "reply",
  description:
    "FINISH: say something to the user instead of logging or saving: an answer, or ONE short question when " +
    "you cannot tell what they meant (for example two different breakfasts could be the one they mean). " +
    "Never claim anything was saved or logged.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string", description: "One to three short sentences. No em dashes." } },
    required: ["text"],
  },
};

// ── Later messages (FOOD_AGENT_LATER): the card changes one line at a time ──

const EDIT_LINE_TOOL: AnthropicTool = {
  name: "edit_line",
  description:
    "Change ONE line of the card on screen: its amount, size, preparation, which food it is, or a number the user gave " +
    "for it. Name the line by its id ([L2] is \"L2\") and say the change in plain words (\"2 pieces\", \"it was navratri " +
    "chana\", \"the user says it is 150 kcal\"). The app works out that one line again from its own figures; every other " +
    "line stays exactly as it is, and you never do the arithmetic. One call per line.",
  input_schema: {
    type: "object",
    properties: {
      line_id: { type: "string", description: "The line's id from the card, e.g. L2." },
      change: { type: "string", description: "The change to this one line, in plain words." },
      use_label: {
        type: "boolean",
        description: "true to set this line from the label find_label returned for it, for the amount the line already has.",
      },
      summary: { type: "string", description: "One short line in a coach's voice saying what changed. No em dashes." },
    },
    required: ["line_id", "change"],
  },
};

const FIND_LABEL_TOOL: AnthropicTool = {
  name: "find_label",
  description:
    "Look up a packaged food's printed nutrition label online (the brand's own site first). Name a card line by its id, " +
    "or give the product (brand and name) for food not on the card. Returns the label per 100 g and its printed serving, " +
    "and for a card line, that line worked out from the label by the app. Nothing on the card changes until you call " +
    "edit_line on the line with use_label true. Quote only numbers this tool returns.",
  input_schema: {
    type: "object",
    properties: {
      line_id: { type: "string", description: "The card line to check, e.g. L1." },
      product: { type: "string", description: "Brand and product name, for food not on the card." },
    },
  },
};

const REMOVE_LINES_TOOL: AnthropicTool = {
  name: "remove_lines",
  description:
    "Take lines off the card on screen, by their ids. Only for a line that should not be there at all (use edit_line " +
    "when a line should change). A line leaves the card only through this tool.",
  input_schema: {
    type: "object",
    properties: {
      line_ids: { type: "array", items: { type: "string" }, description: "Line ids from the card, e.g. [\"L3\"]." },
      summary: { type: "string", description: "One short line saying what came off. No em dashes." },
    },
    required: ["line_ids"],
  },
};

const ADD_LINES_TOOL: AnthropicTool = {
  name: "add_lines",
  description:
    "Add food that is not on the card yet. Give `text` for food to be worked out (it runs parse_food, reusing a parse " +
    "you already did for the same text), and/or `items` to copy lines from a saved meal with their numbers unchanged. " +
    "Food from the diary or an earlier card goes through copy_lines instead.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Food to work out, in plain words." },
      items: LOG_FOOD_TOOL.input_schema.properties.items,
      meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"], description: "Omit for the card's own meal." },
      summary: { type: "string", description: "One short line saying what was added. No em dashes." },
    },
  },
};

/** The card changes a later-message agent can make. All of one turn's changes
 *  apply together, in a fixed order: edits, removals, additions. */
const CARD_CHANGE_TOOLS = new Set([EDIT_LINE_TOOL.name, REMOVE_LINES_TOOL.name, ADD_LINES_TOOL.name]);

const CARD_TOOLS: AnthropicTool[] = [EDIT_CARD_TOOL, REMOVE_CARD_LINES_TOOL, SAVE_CARD_AS_MEAL_TOOL];
const READ_TOOLS = new Set([LIST_LOGGED_MEALS_TOOL.name, LIST_SAVED_MEALS_TOOL.name, PARSE_FOOD_TOOL.name, READ_CARD_TOOL.name, FIND_LABEL_TOOL.name]);
const FINISH_TOOLS = new Set([
  CREATE_CUSTOM_FOOD_TOOL.name, CREATE_CUSTOM_MEAL_TOOL.name, LOG_FOOD_TOOL.name, REPLY_TOOL.name,
  EDIT_CARD_TOOL.name, REMOVE_CARD_LINES_TOOL.name, SAVE_CARD_AS_MEAL_TOOL.name, RESTORE_CARD_TOOL.name,
]);

/** The tools for this run: the card tools only when a card is on screen, so a
 *  first-shot message cannot "edit" nothing. A card that may be cut at the cap
 *  gets no card tools either: editing, removing from, or saving a card the
 *  agent cannot see all of would drop the lines past the cap (cardMayBeCut).
 *  copy_lines when it has a source (the diary, or the thread's earlier cards),
 *  read_card with earlier cards, restore_card only with no card on screen. */
export function toolsFor(
  card: CardLine[] | null | undefined,
  canRestore = false,
  copy: { thread?: boolean; diary?: boolean } = {},
): AnthropicTool[] {
  const out = card?.length && !cardMayBeCut(card) ? [...FOOD_AGENT_TOOLS, ...CARD_TOOLS] : [...FOOD_AGENT_TOOLS];
  if (copy.thread || copy.diary) out.push(COPY_LINES_TOOL);
  if (copy.thread) out.push(READ_CARD_TOOL);
  if (canRestore) out.push(RESTORE_CARD_TOOL);
  return out;
}

/** Said to the agent when a card is on screen: what it is and what to do with it. */
export const CARD_NOTE =
  "A meal card is on screen, not yet added to the diary. Its lines are numbered in `card`. These numbers are the user's " +
  "working copy: never re-guess them. What the user says about the card: a change to a line (amount, size, preparation, " +
  "which food it is) is edit_card; a line that should not be there is remove_card_lines; food not on the card yet is " +
  "log_food with the new food only, and it is added beside the card; a request to keep or save the card as a meal is " +
  "save_card_as_meal; a question or complaint about a line, with nothing to change, is reply, and the reply must speak to " +
  "what they asked using the card's numbers (how a figure was reached, why a line is there), never a canned breakdown. " +
  "When the user says a dish already contains something listed as a separate line, that is remove_card_lines for the " +
  "separate line, and edit_card only if the dish's own line must change too. " +
  "The card has its own Add button, and that tap is what puts it in the diary. When the user wants the card logged or " +
  "back, it is right there: reply, saying it is on screen and Add puts it in. save_card_as_meal is only for an explicit " +
  "ask to keep the card as a reusable meal.";

export const FOOD_AGENT_TOOLS: AnthropicTool[] = [
  LIST_LOGGED_MEALS_TOOL,
  LIST_SAVED_MEALS_TOOL,
  PARSE_FOOD_TOOL,
  CREATE_CUSTOM_MEAL_TOOL,
  CREATE_CUSTOM_FOOD_TOOL,
  LOG_FOOD_TOOL,
  REPLY_TOOL,
];

export const FOOD_AGENT_SYSTEM =
  "You are Coach Drona inside the food logging box of a fitness app. The user's message needs more than one step. " +
  "Work in turns. In each turn call EVERY tool you need right now, all together in that one turn, because they run " +
  "at the same time: for example read the diary and list saved meals together. After you see the results, either " +
  "call more tools or finish.\n" +
  "Finish with exactly one of: create_custom_meal or create_custom_food (a save card the user taps; set log_now true " +
  "and meal_type when they also want it logged today, so one tap saves and logs), log_food (log to today), or reply.\n" +
  "Numbers: never invent them. Copy lines from the diary or a saved meal exactly, with estimated false (in the " +
  "create tools each line's food_name goes in `name`). For food " +
  "that is in neither, use parse_food and copy what it returns.\n" +
  "When they point at food they logged, read that day first. If they name a whole meal (\"yesterday's breakfast\", " +
  "\"Monday's lunch\"), copy EVERY food in it. If they name one dish inside a meal, copy only the foods that make up " +
  "that dish: from tea, sugar, biscuits and poha, \"the chai\" is the tea and sugar. A dish name is one dish even " +
  "when they also say which meal it was in: \"the chai I had at breakfast\" is still only the tea and sugar. " +
  "Apply any change they asked for " +
  "(half the rice, without the naan) to the copied lines. If you cannot tell which foods they mean, or nothing " +
  "matches, reply with one short question.\n" +
  "A card's summary is an offer the user has not tapped: never say saved or logged. No em dashes anywhere.\n" +
  "Act only through the tools. Every turn calls at least one; to talk to the user, use reply. Plain text with no tool " +
  "call ends the work without an answer.\n" +
  "Never repeat your previous reply word for word. If the user says you did not answer, answer the specific thing they asked.\n" +
  "When the user says they already saved or logged something, that is done: never offer that same save or log again. " +
  "Do what they ask for next.";

/** The tools for a later message (FOOD_AGENT_LATER). With a whole card on
 *  screen: the one-line tools (edit_line, remove_lines, add_lines) in place
 *  of edit_card, remove_card_lines and log_food, plus save_card_as_meal. With
 *  no card: today's tools (log_food makes the card). A card cut at the cap
 *  never reaches this agent (laterMessageGoesToAgent). */
export function toolsForLater(
  card: CardLine[] | null | undefined,
  canRestore = false,
  copy: { thread?: boolean; diary?: boolean } = {},
  label = false,
): AnthropicTool[] {
  const whole = !!card?.length && !cardMayBeCut(card);
  const out = whole
    ? [
      ...FOOD_AGENT_TOOLS.filter((t) => t.name !== LOG_FOOD_TOOL.name),
      EDIT_LINE_TOOL, REMOVE_LINES_TOOL, ADD_LINES_TOOL, SAVE_CARD_AS_MEAL_TOOL,
    ]
    : [...FOOD_AGENT_TOOLS];
  if (copy.thread || copy.diary) out.push(COPY_LINES_TOOL);
  if (copy.thread) out.push(READ_CARD_TOOL);
  if (canRestore) out.push(RESTORE_CARD_TOOL);
  if (label) out.push(FIND_LABEL_TOOL);
  return out;
}

/** find_label calls one message may make: each is a web lookup. */
export const MAX_FIND_LABEL_PER_RUN = 2;

/** Said to a later-message agent that has find_label (deps.findLabel). */
export const LABEL_NOTE =
  "You can look up a packaged food's printed label online with find_label. When the user asks you to look up or check " +
  "a label, or doubts a packaged food's numbers, call it. On a card line, put the label on the line with edit_line, " +
  "use_label true: the app works out the line from the label for the amount on the card, keeping the user's name for " +
  "the food. A line whose source names the user's numbers (\"the user's numbers\" or \"the user said\") keeps those " +
  "numbers: the label gives the rest and the weight. " +
  "When find_label finds no label, say so and keep the line as it is. Each card line ends with where its " +
  "numbers came from: a line \"from web\" was already looked up on that site, and find_label looks again.";

/** The later-message agent's instructions. The lessons of today's routes
 *  (plan section 9b) live here as rules, beside the code checks that back
 *  them (claims, bare acks, the one-line card changes). */
export const FOOD_AGENT_SYSTEM_LATER =
  "You are Coach Drona inside the food logging box of a fitness app. You answer every message after the first one in " +
  "this food conversation: you put food on the meal card, change the card, save meals, bring back earlier cards, and " +
  "answer questions. Work in turns. In each turn call EVERY tool you need right now, all together in that one turn, " +
  "because they run at the same time. After you see the results, either call more tools or finish.\n" +
  "Finish with: a card change (edit_line, remove_lines, add_lines or copy_lines, with a card on screen), log_food (no " +
  "card on screen: it makes the card), a save card (save_card_as_meal, create_custom_meal or create_custom_food, which " +
  "the user taps), restore_card, or reply. reply can go in the SAME turn as a card change or log_food: then both " +
  "happen, and your reply is the line the user reads under the card.\n" +
  "Numbers: never invent them. Copy lines from the diary or a saved meal exactly, with estimated false (in the create " +
  "tools each line's food_name goes in `name`). For food that is in neither, use parse_food, add_lines or log_food, " +
  "and the app works the numbers out. Give those tools the user's own words for the food, adding only the choice they " +
  "made: their words carry their numbers and amounts, and a rewrite can lose them.\n" +
  "When they point at food they logged, read that day first. If they name a whole meal, copy EVERY food in it. If " +
  "they name one dish inside a meal, copy only the foods that make up that dish: from tea, sugar, biscuits and poha, " +
  "\"the chai\" is the tea and sugar, even when they also say which meal it was in. Apply any change they asked for " +
  "to the copied lines. If you cannot tell which foods they mean, or nothing matches, reply with one short question.\n" +
  "Rules from real use:\n" +
  "- Food the user says they had always goes on the card, even when the same message asks a question or reads like " +
  "chat. Answer the question too, with reply in the same turn. When you are unsure what they meant, put the food on " +
  "the card and say in a few words what you assumed. Losing a meal they meant to record is the worst outcome.\n" +
  "- A save needs an explicit ask to save, keep or remember something as a reusable meal or food for later. Food " +
  "names, numbers, the present tense, a question about saving, thanks, or a complaint are not a save. Without that " +
  "ask never call save_card_as_meal, create_custom_meal or create_custom_food.\n" +
  "- When the user turns down their saved meal for a food (\"not my saved one\", \"estimate it fresh\"), never use a " +
  "saved meal's lines for it: work it out again (edit_line on its line, or add_lines).\n" +
  "- When the opening message says this answers your question, the answer finishes that waiting meal: put ALL of its " +
  "food on the card, with the choice they made. When they leave the choice to you, take the first option you offered " +
  "(else the most usual one) and say which you took.\n" +
  "- A number the user gives for a food (from a menu, a label, \"it was about 150 cal\") wins over every source. Put it " +
  "on that food's line in the same turn (edit_line, or add_lines for a new food), never ask whether they meant it.\n" +
  "- Which date a weekday was is written at the top of the message: use those days_ago, never your own arithmetic.\n" +
  "- The card reaches the diary only when the user taps its Add button, and a save card only when they tap it. Never " +
  "say anything was logged or saved. A summary is a line about the card, never a promise.\n" +
  "Act only through the tools. Every turn calls at least one; to talk to the user, use reply. No em dashes anywhere.\n" +
  "Never repeat your previous reply word for word. If the user says you did not answer, answer the specific thing they asked.\n" +
  "When the user says they already saved or logged something, that is done: never offer that same save or log again. " +
  "Do what they ask for next.";

/** The later-message instructions for the FIRST message of a thread
 *  (FOOD_FIRST_GATE): the same rules, with the opening sentence saying which
 *  message this is. FOOD_AGENT_SYSTEM_LATER itself is unchanged. */
export const FOOD_AGENT_SYSTEM_FIRST = FOOD_AGENT_SYSTEM_LATER.replace(
  "You answer every message after the first one in this food conversation:",
  "You answer the first message of this food conversation, one that needs more than a plain log:",
);

/** Said to a first-message agent (FOOD_FIRST_GATE): the parse of the whole
 *  message started with it, so logging the message's food costs no wait. */
export const FIRST_NOTE =
  "No card is on screen yet. The app already started working out the food in the user's message as they wrote it: " +
  "log_food or parse_food with `text` set to the user's whole message, word for word, gets that result at once. When " +
  "you log the food the message names, pass the whole message that way. Write other text only for food that is not " +
  "in the message as written, or when only part of its food should be logged. When the user also asks about that " +
  "food's numbers, call parse_food first, then log_food and reply together, the reply using the numbers it returned.";

/** Said to a later-message agent when a card is on screen. */
export const CARD_NOTE_LATER =
  "A meal card is on screen, not yet added to the diary. Each line has an id: [L1], [L2], ... Its numbers are the " +
  "user's working copy: never re-guess them. Change it one line at a time:\n" +
  "- edit_line: one line changes (amount, size, preparation, which food it is, a number the user gives for it). Only " +
  "that line is worked out again.\n" +
  "- remove_lines: a line the user says they did not have, or that should not be there at all. When a dish already " +
  "contains a food that is also listed on its own line, remove the separate line. When a request could mean taking a " +
  "line off or changing it back, keep the line: change it, or ask.\n" +
  "- add_lines: food that is not on the card yet, even when it went into a dish that is on the card. Give it only the " +
  "new food, never a dish already on the card. edit_line only changes what a line already is. More of a food that is " +
  "already on the card (another roti, a second egg) is edit_line on its line with the new total, never add_lines.\n" +
  "Every line you do not name stays exactly as it is. Make all the changes a message needs in ONE turn, together: they " +
  "apply in a fixed order (edits, then removals, then additions). Never give one line two changes in the same turn. " +
  "A question or complaint about the card with nothing to change is reply, using the card's own numbers (how a figure " +
  "was reached, why a line is there), never a canned breakdown. A bare ok or thanks accepts the card as it is. The card " +
  "has its own Add button: when the user wants it logged, reply that Add puts it in. save_card_as_meal only on an " +
  "explicit ask to keep the card as a reusable meal.";

/** The last-turn note for a later-message agent, naming only what it has. */
export function lastTurnNoteLater(cardOnScreen: boolean, restore: boolean, copy: boolean, recipe = false): string {
  return [
    "This is your LAST turn. You must finish now with",
    cardOnScreen
      ? "a card change (edit_line, remove_lines, add_lines), save_card_as_meal, create_custom_meal, create_custom_food, or reply."
      : "log_food, create_custom_meal, create_custom_food, or reply.",
    copy ? "You may also finish with copy_lines." : null,
    restore ? "You may also finish with restore_card." : null,
    recipe ? "You may also finish with build_recipe." : null,
    "Do not call any read.",
  ].filter(Boolean).join(" ");
}

/** Said to the agent when copy_lines is offered (after CARD_NOTE, which it
 *  refines: food from the diary or an earlier card is a copy, not log_food). */
export const COPY_NOTE =
  "Food the user logged before, or food from an earlier card of this conversation, goes on the card with copy_lines: " +
  "the app copies each line's numbers and source exactly, so you never retype them. Use log_food items only for " +
  "saved-meal lines or for an amount they asked to change. copy_lines only adds. When it reports a food " +
  "already_on_card, ask one short question with two choices: add a second portion, or skip. Call copy_lines with " +
  "add_again true only after they choose to add it. When it reports not_found, read the source first (read_card or " +
  "the diary) and use the line ids or names it shows.";

const LAST_TURN_BASE =
  "This is your LAST turn. You must finish now with create_custom_meal, create_custom_food, log_food, reply, or (with a " +
  "card on screen) edit_card, remove_card_lines or save_card_as_meal.";
const LAST_TURN_END = "Do not call any other tool.";

/** The last-turn note, naming copy_lines and restore_card only when they are
 *  offered, so a run without a tool is never told of it. */
export function lastTurnNote(restore: boolean, copy: boolean): string {
  return [
    LAST_TURN_BASE,
    copy ? "You may also finish with copy_lines." : null,
    restore ? "With no card on screen you may also finish with restore_card." : null,
    LAST_TURN_END,
  ].filter(Boolean).join(" ");
}

export const LAST_TURN_NOTE: string = lastTurnNote(false, false);

/** The last-turn note when restore_card is offered. */
export const LAST_TURN_NOTE_RESTORE: string = lastTurnNote(true, false);

/** What follows the index line in the opening message: which thread tools
 *  this run has. With a card on screen restore_card is not one of them. */
export function threadToolsNote(canRestore: boolean): string {
  return canRestore
    ? "copy_lines adds foods from one of these cards (or makes a new card from them); restore_card brings one back " +
      "whole as the card on screen; read_card shows a card's numbers or an older version."
    : "A card is on screen, so restore_card is not available: copy_lines adds foods from one of these cards to it, " +
      "and read_card shows a card's numbers or an older version.";
}

// ── Status lines ────────────────────────────────────────────────────────────

const MEAL_WORD: Record<string, string> = { breakfast: "breakfast", lunch: "lunch", dinner: "dinner", snack: "snacks" };

export function statusFor(name: string, input: Record<string, unknown>): string | null {
  if (name === LIST_LOGGED_MEALS_TOOL.name) {
    const d = typeof input.days_ago === "number" ? input.days_ago : null;
    const meal = typeof input.meal_type === "string" ? MEAL_WORD[input.meal_type] ?? null : null;
    const what = meal ?? "logs";
    if (typeof input.date === "string") return `Checking your ${what} from that day`;
    if (d !== null && d >= 2) return `Checking your ${what} from ${d} days ago`;
    return `Checking ${d === 1 ? "yesterday's" : "today's"} ${what}`;
  }
  if (name === LIST_SAVED_MEALS_TOOL.name) return "Looking through your saved meals";
  if (name === PARSE_FOOD_TOOL.name) {
    const t = typeof input.text === "string" ? input.text.trim() : "";
    return t ? `Working out ${t.length > 40 ? `${t.slice(0, 40)}...` : t}` : "Working out the food";
  }
  if (name === CREATE_CUSTOM_MEAL_TOOL.name || name === CREATE_CUSTOM_FOOD_TOOL.name) return "Building your meal";
  if (name === LOG_FOOD_TOOL.name) return "Getting it ready to log";
  if (name === EDIT_CARD_TOOL.name) return "Reworking the card";
  if (name === REMOVE_CARD_LINES_TOOL.name) return "Taking that off the card";
  if (name === SAVE_CARD_AS_MEAL_TOOL.name) return "Building your meal";
  if (name === RESTORE_CARD_TOOL.name) return "Bringing that card back";
  if (name === COPY_LINES_TOOL.name) return "Copying that over";
  if (name === READ_CARD_TOOL.name) return "Checking that card";
  if (name === FIND_LABEL_TOOL.name) return "Looking up the label";
  if (name === BUILD_RECIPE_TOOL.name) return "Adding up the dish";
  return warmStatus(name);
}

// ── History ─────────────────────────────────────────────────────────────────

/** How many earlier turns travel with a message: FOOD_TURNS_KEPT, the same
 *  cap readFoodContext puts on `recent_turns` before this sees them, so the
 *  agent, the router and the parse all read the same conversation. */
const MAX_TURNS_SENT = FOOD_TURNS_KEPT;
const TURN_MAX_CHARS = FOOD_TURN_CHARS;

/**
 * The conversation as Messages-API turns, oldest first, with `text` last.
 *
 * Used by the agent AND by the food bar's plain reply and create calls: all
 * three were sending the newest message alone, so a bar that had just drawn a
 * card answered "log the same meal in snacks too" with "you haven't told me
 * what meal to log". Drona's turns come back as `assistant` so the model reads
 * them as its own words, not as something the user said.
 */
export function historyMessages(
  turns: { role: "user" | "drona"; text: string }[] | undefined,
  text: string,
): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of (turns ?? []).slice(-MAX_TURNS_SENT)) {
    const body = (t.text ?? "").trim().slice(0, TURN_MAX_CHARS);
    if (!body) continue;
    const role = t.role === "drona" ? "assistant" as const : "user" as const;
    // The API rejects two turns in a row from the same side, and a history that
    // starts with the assistant. Fold a repeat into the turn before it.
    if (out.length === 0 && role === "assistant") continue;
    if (out.length > 0 && out[out.length - 1].role === role) {
      out[out.length - 1].content += `\n${body}`;
      continue;
    }
    out.push({ role, content: body });
  }
  // The new message is the user speaking; fold it in if they spoke last too.
  if (out.length > 0 && out[out.length - 1].role === "user") {
    out[out.length - 1].content += `\n${text}`;
  } else {
    out.push({ role: "user", content: text });
  }
  return out;
}

// ── Dates ───────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Today is Thursday 2026-09-24. days_ago 1 = Wednesday 2026-09-23, ..." for
 *  the last week. Which date "Monday" was is arithmetic, and arithmetic is
 *  code's job: left to the model, "same lunch as Monday" read the wrong day
 *  in one probe run out of three. Null when `today` carries no date. */
export function recentDays(today: string): string | null {
  const m = today.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  if (Number.isNaN(base)) return null;
  const label = (n: number) => {
    const d = new Date(base - n * 86_400_000);
    return `${WEEKDAYS[d.getUTCDay()]} ${d.toISOString().slice(0, 10)}`;
  };
  const past = [1, 2, 3, 4, 5, 6, 7].map((n) => `days_ago ${n} = ${label(n)}`).join(", ");
  return `Today is ${label(0)}. ${past}.`;
}

// ── The loop ────────────────────────────────────────────────────────────────

interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export async function runFoodAgent(input: FoodAgentInput, deps: FoodAgentDeps): Promise<FoodAgentOutcome> {
  // Lines copy_lines took that wait for the agent's finish. Whatever the run
  // ends in, they are served (withStaged): food the user named is never
  // dropped because other work came in the same turn ("log wins every tie").
  const staged: Staged = { items: [], dup: [], miss: [] };
  const out = await agentLoop(input, deps, staged);
  return withStaged(out, staged, input);
}

async function agentLoop(input: FoodAgentInput, deps: FoodAgentDeps, staged: Staged): Promise<FoodAgentOutcome> {
  const turns: AgentTurn[] = [];
  // restore_card only with both halves (the index the agent reads refs from,
  // and the store that answers them), and only with NO card on screen: a
  // restore replaces the card whole, so it must never land on lines the
  // user is still working on.
  const cardOnScreen = !!input.card?.length;
  const canRestore = !!input.threadIndex && !!deps.restoreCard && !cardOnScreen;
  // copy_lines and read_card from the thread: the index the agent reads refs
  // from, and the store that answers them. Beside a card too (it only adds).
  const canCopyThread = !!input.threadIndex && !!deps.threadCard;
  const canCopyDiary = !!deps.readDiaryLines;
  const canCopy = canCopyThread || canCopyDiary;
  // An undated `today` still goes in as written rather than being dropped.
  const days = input.today ? recentDays(input.today) ?? `Today is ${input.today}.` : null;
  // The index goes in only with the tools it names: restore_card (no card on
  // screen) or copy_lines from the thread.
  const indexLine = canRestore || canCopyThread
    ? `${input.threadIndex} ${canCopyThread ? threadToolsNote(canRestore) : "restore_card brings one back as the card on screen."}`
    : null;
  // A later message (FOOD_AGENT_LATER): its own instructions, one-line card
  // tools, and one more turn. Everything else in the loop is shared.
  const later = !!input.later;
  // FOOD_WARM_MEMORY (foodWarmMemory.ts), later mode only: the warm reads and
  // the hot lines code builds for them. Without deps.warm every one of these
  // is false or null, so the prompt, the tools and the loop are as before.
  const warm = later ? deps.warm : undefined;
  const canRecall = !!warm?.memory;
  // read_thread only when the thread has turns the messages above do not.
  const canReadThread = !!warm?.readThread && hasOlderTurns(input.warmThread, input.recentTurns, input.text);
  const canSearch = !!warm?.searchThreads;
  const warmTools = [
    ...(canRecall ? [RECALL_FOOD_TOOL] : []),
    ...(canReadThread ? [READ_THREAD_TOOL] : []),
    ...(canSearch ? [searchThreadsTool(canCopy)] : []),
  ];
  const warmNames = new Set(warmTools.map((t) => t.name));
  const isRead = (name: string) => READ_TOOLS.has(name) || warmNames.has(name);
  // Memory matches Jev already decided (owner: Jev matches only). In the
  // opening message only for a first-message run whose parse has ALREADY
  // finished: it is peeked at, never awaited, so the agent starts no later
  // than before. Every parse_food result carries them too (runRead).
  // Only where matches can appear at all (USER_FOOD_MEMORY and Jev on).
  const canMatch = !!warm?.matches;
  const settled = canMatch && later && !!input.first && !cardOnScreen ? warm?.settledFirstParse?.() ?? null : null;
  const warmText = warm
    ? { thread: warmThreadText(input.warmThread, input.recentTurns, canReadThread, input.text), matches: memoryMatchesBlock(settled) }
    : {};
  const messages: unknown[] = historyMessages(input.recentTurns, openingText({ ...input, threadIndex: indexLine }, days, warmText));
  const lineTools = later && cardOnScreen && !cardMayBeCut(input.card);
  // A first message (FOOD_FIRST_GATE) is a later-mode run with no card: its
  // own opening sentence and the note about the parse already running.
  const first = later && !!input.first && !cardOnScreen;
  // find_label: a later message beside a card the agent can edit line by line
  // (use_label lands through edit_line), when the deploy has a web lookup.
  const canLabel = later && lineTools && !!deps.findLabel;
  // build_recipe (FOOD_BUILD_RECIPE): a later-mode run, beside a whole card
  // or with none (a first message). A cut card never reaches later mode.
  const canRecipe = later && !!deps.buildRecipe && (lineTools || !cardOnScreen);
  // Said only for the warm tools this run has; null with the switch off.
  const warmSaid = warm ? warmNote({ recall: canRecall, readThread: canReadThread, searchThreads: canSearch, matches: canMatch }) : null;
  const recipeMemory = canRecipe && canRecall ? RECIPE_MEMORY_NOTE : null;
  const systemToday = first
    ? [FOOD_AGENT_SYSTEM_FIRST, FIRST_NOTE, canCopy ? COPY_NOTE : null, canRecipe ? RECIPE_NOTE : null, recipeMemory, warmSaid]
      .filter(Boolean).join("\n")
    : later
    ? [
      FOOD_AGENT_SYSTEM_LATER, lineTools ? CARD_NOTE_LATER : cardOnScreen ? CARD_NOTE : null, canCopy ? COPY_NOTE : null,
      canLabel ? LABEL_NOTE : null, canRecipe ? RECIPE_NOTE : null, recipeMemory, warmSaid,
    ].filter(Boolean).join("\n")
    : [FOOD_AGENT_SYSTEM, cardOnScreen ? CARD_NOTE : null, canCopy ? COPY_NOTE : null].filter(Boolean).join("\n");
  const system = input.regionRules ? regionalizePrompt("agent", systemToday, input.regionRules.region) : systemToday;
  const tools = later
    ? [
      ...toolsForLater(input.card, canRestore, { thread: canCopyThread, diary: canCopyDiary }, canLabel),
      ...(canRecipe ? [BUILD_RECIPE_TOOL] : []),
      ...warmTools,
    ]
    : toolsFor(input.card, canRestore, { thread: canCopyThread, diary: canCopyDiary });
  const maxTurns = later ? MAX_TURNS_LATER : MAX_TURNS;
  // Every food line a read returned, by name, with the calories it carried.
  // A line the agent says it COPIED is checked against this: the model is told
  // never to invent numbers, and this is how the code knows whether it did.
  const seen: Seen = new Map();
  // parse_food results by text, so log_food on the same text does not pay twice.
  const parses = new Map<string, ParseMealResult>();
  const parse = async (text: string) => {
    const key = text.trim().toLowerCase();
    const hit = parses.get(key);
    if (hit) return hit;
    const r = await deps.parseFood(text);
    parses.set(key, r);
    remember(seen, r.parsed?.items ?? []);
    return r;
  };
  // Each card line find_label worked out from a label, by card index: what
  // edit_line with use_label puts on the card.
  const labelLines = new Map<number, ParsedItem>();
  const labelCalls = { n: 0 };
  // Warm read calls this run, per tool (foodWarmMemory WARM_CAPS).
  const warmCalls = new Map<string, number>();
  // The foods on the card for copy_lines' duplicate check: the card as sent,
  // plus every line already staged in this run.
  const onCard = onCardOf(input.card ?? []);

  // A later message's words with no tool are sent back once with a nudge, so
  // food the user named is not lost to a plain-words answer (see below).
  let nudged = false;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const last = turn === maxTurns;
    const t0 = Date.now();
    // The last-turn note is appended as a system message, never added to the
    // system prompt: changing the system prompt mid-loop would edit history the
    // model already answered (and break the prompt cache).
    // A copy, so the note can never leak into a later turn's history.
    const note = later ? lastTurnNoteLater(lineTools, canRestore, canCopy, canRecipe) : lastTurnNote(canRestore, canCopy);
    const sent = last ? [...messages, { role: "system", content: note }] : messages;
    const res = await deps.callModel({
      model: deps.model,
      // 2000 under Sonnet 4.6; ~30% up for Sonnet 5.5's tokenizer.
      max_tokens: 2600,
      system,
      tools,
      // Always a tool: free text would be a reply that skipped the reply tool's
      // rules, and it would end the loop without saying so. Sonnet 5.5 rejects
      // a forced tool_choice, so the system prompt says it and the code below
      // fails a text-only turn as before.
      ...sonnetSettings(deps.model),
      messages: sent,
    });
    if (!res.ok) return { kind: "failed", reason: `http_${res.status}`, turns };

    const blocks = (res.data?.content ?? []) as Record<string, unknown>[];
    const uses = blocks.filter((b) => b?.type === "tool_use") as unknown as ToolUse[];
    // One model call, one turn: index.ts stamps turn i at call i's end
    // (startFoodAgent callEnds). A failed call returns above, before a turn.
    const thisTurn: AgentTurn = {
      turn,
      ms: Date.now() - t0,
      tools: uses.map((u) => ({ name: u.name, input: u.input })),
      input_tokens: res.data?.usage?.input_tokens ?? null,
      output_tokens: res.data?.usage?.output_tokens ?? null,
    };
    turns.push(thisTurn);
    if (uses.length === 0) {
      // A later message: words with no tool call are still an answer. They
      // get the reply tool's checks in code (no claimed log or save, no em
      // dash, the length cap), so a plain answer is not lost to a missing
      // tool call. Beside a card that failure used to cost the user the answer.
      const words = later
        ? clean(blocks.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join(" "))
        : "";
      // The first time, with turns left: asked to use its tools, so a food
      // request ends in a card (log_food) and a question in reply. After that,
      // or on the last turn, the words are the answer.
      if (words && !last && !nudged) {
        nudged = true;
        messages.push(
          { role: "assistant", content: blocks },
          { role: "user", content: "Please use your tools: plain words do not reach the user. Food the user had goes on the card (log_food, or add_lines beside a card); to talk, use reply." },
        );
        continue;
      }
      if (words) return checkedLater({ kind: "reply", text: words, turns }, input, "");
      return { kind: "failed", reason: "no_tool_call", turns };
    }

    // restore_card with a card on screen is refused HERE, not only by leaving
    // it out of the tools: a model can name a tool it was not offered, and a
    // restore replaces the card whole. The agent hears why and can copy
    // lines instead; on the last turn the run ends.
    const refused = new Set(uses.filter((u) => u.name === RESTORE_CARD_TOOL.name && cardOnScreen));
    for (const _ of refused) deps.onEvent?.({ tool: "restore_card", ok: false, reason: "card_open" });

    // A later message (FOOD_AGENT_LATER): the turn's card changes are planned
    // together and checked before anything runs. A conflict (one line, two
    // changes) or an unknown line id sends every change back to the agent with
    // the reason, and none of them is applied. A plan that passes is applied
    // line by line: an edit whose parse fails leaves its own line as it was,
    // the others land, and the card's line names the one that did not. log_food beside a card is an
    // addition here, so it lands in the same fixed order.
    // build_recipe is a card change too: beside a card, and with no card
    // when the turn builds a dish (the dish and any log_food in the turn make
    // the card together, in the same fixed order).
    const isRecipe = (u: ToolUse) => canRecipe && u.name === BUILD_RECIPE_TOOL.name;
    const recipeNoCard = canRecipe && !cardOnScreen && uses.some(isRecipe);
    const changes = later && (lineTools || recipeNoCard)
      ? uses.filter((u) => CARD_CHANGE_TOOLS.has(u.name) || u.name === LOG_FOOD_TOOL.name || isRecipe(u))
      : [];
    const replyUse = later ? uses.find((u) => u.name === REPLY_TOOL.name) : undefined;
    let plan: CardPlan | null = null;
    const rejected = new Map<ToolUse, string>();
    if (changes.length) {
      const p = planCardChanges(input.card ?? [], changes, uses.some((u) => u.name === RESTORE_CARD_TOOL.name), recipeNoCard);
      if (p.ok) plan = p;
      else {
        for (const u of changes) rejected.set(u, p.error);
        // Every other finish in the turn waits too (a save, a restore): it is
        // told why, never reported as an unknown tool.
        for (const u of uses) if (LATER_FINISHES.has(u.name) && !rejected.has(u)) rejected.set(u, p.error);
        if (replyUse) rejected.set(replyUse, "Not sent: the card changes in this turn were refused, so nothing happened. Fix them first.");
        deps.onEvent?.({ tool: "card_changes", ok: false, edits: 0, edits_failed: 0, removed: 0, added: 0, error: p.error });
      }
    }
    // A later message that reads data in the same turn as it finishes: the
    // finish waits. Its reads run, and every change, log, save or reply in the
    // turn goes back unapplied, so a copy the agent meant to make from what it
    // reads is not lost to an addition that ended the run first. Not on the
    // last turn: there the reads never run, and the finish stands.
    // The warm reads (recall_food, read_thread, search_threads) never hold:
    // they are read only, and nothing they return can change a card change
    // the turn already asked for, so the turn applies as if they were absent.
    if (later && !last && uses.some((u) => HOLD_READS.has(u.name))) {
      const held = uses.filter((u) => !isRead(u.name) && u.name !== COPY_LINES_TOOL.name && !refused.has(u) && !rejected.has(u));
      for (const u of held) {
        rejected.set(u, "Not applied yet: this turn also reads data. Look at what the reads return, then send every change, " +
          "log, save or reply together in your next turn.");
      }
      if (held.length) plan = null;
    }
    // A finish ends the agent even when reads came with it: the model has
    // decided, and running reads it will never see is cost with no reader.
    // Later messages pick in a fixed order (the card changes, then a log, a
    // save or a restore, then a reply), so a reply sent beside a log never
    // drops the food: log wins every tie, and the reply becomes its line.
    let finish = !later
      ? uses.find((u) => FINISH_TOOLS.has(u.name) && !refused.has(u))
      : plan
      ? changes[0]
      : rejected.size
      ? undefined
      : uses.find((u) => LATER_FINISHES.has(u.name) && !refused.has(u)) ?? replyUse;
    // A later message: a save card needs the user to have asked for a save,
    // in their words (plan 9b, "create needs an explicit ask"). The agent is
    // told and does what was asked instead; on the last turn the run ends and
    // the card stays as it was.
    if (later && finish && SAVE_TOOLS.has(finish.name) && !userAskedToSave(input)) {
      if (last) return { kind: "failed", reason: "save_not_asked", turns };
      for (const u of uses) {
        if (!isRead(u.name) && u.name !== COPY_LINES_TOOL.name && !refused.has(u) && !rejected.has(u)) {
          rejected.set(u, "Not done: the user did not ask to save anything, so no save card. Do what they asked: change the " +
            "card, add the food, or reply.");
        }
      }
      plan = null;
      finish = undefined;
    }
    const copies = uses.filter((u) => u.name === COPY_LINES_TOOL.name);
    if (!finish) {
      const unknown = uses.find((u) => !isRead(u.name) && u.name !== COPY_LINES_TOOL.name && !refused.has(u) && !rejected.has(u));
      if (unknown) return { kind: "failed", reason: `unknown_tool_${unknown.name}`, turns };
    }

    // copy_lines. The sources are read at once; then the lines are sorted in
    // call order against the run's on-card set (a copy for this turn, so a
    // copy that does not land leaves no trace in it).
    const copyRuns = new Map<ToolUse, CopyRun>();
    if (copies.length) {
      for (const u of copies) {
        const label = statusFor(u.name, u.input ?? {});
        if (label) deps.onStatus?.(label);
      }
      const sources = await Promise.all(copies.map((u) => loadCopySource(u.input ?? {}, deps)));
      const turnSet: OnCard = { keys: new Set(onCard.keys), ids: new Set(onCard.ids) };
      const runs = sources.map((src, i) => classifyCopy(src, copies[i].input ?? {}, input, turnSet));
      copies.forEach((u, i) => copyRuns.set(u, runs[i]));
      const whole = runs.every((r) => !r.error && r.results.length > 0 && r.results.every((x) => x.status === "copied"));
      // When the copied lines land:
      //  - beside a finish in this turn: they join that finish, and the lines
      //    that did not copy are named in the card's line (the agent never
      //    sees these results);
      //  - every line copied: they land now. Alone in the turn, that is the
      //    finish; beside reads, the agent goes on and they join its finish;
      //  - the last turn: whatever copied lands, the rest is named;
      //  - otherwise nothing lands, and the agent sees each line's result.
      const lands = !!finish || whole || (last && runs.some((r) => r.items.length > 0));
      for (const r of runs) deps.onEvent?.(copyEvent(r, lands && r.items.length > 0));
      if (lands) {
        stage(staged, runs, onCard, { nameTheRest: !!finish || !whole });
        if (!finish && (uses.every((u) => u.name === COPY_LINES_TOOL.name) || last)) return { kind: "failed", reason: "copy_staged_only", turns };
      }
    }

    if (finish) {
      const label = statusFor(finish.name, finish.input ?? {});
      if (label) deps.onStatus?.(label);
      const replyText = replyUse && replyUse !== finish ? clean(typeof replyUse.input?.text === "string" ? replyUse.input.text : "") : "";
      if (plan) {
        const out = await applyCardChanges(plan, input, { ...deps, warm }, parse, seen, turns, replyText, staged.items, labelLines);
        // A save asked for in the same turn as card changes: the changes win,
        // and the user is told the save has not happened (a save card cannot
        // ride with a changed meal card).
        // Only when the user asked to save: a save the agent reached for on
        // its own is simply not made, and not mentioned.
        if (!uses.some((u) => SAVE_TOOLS.has(u.name)) || !userAskedToSave(input)) return out;
        const note = "Ask me to save it once the card looks right.";
        if (out.kind === "log" && out.result.parsed) {
          return { ...out, result: { ...out.result, parsed: { ...out.result.parsed, drona_line: `${out.result.parsed.drona_line} ${note}`.trim() } } };
        }
        return out.kind === "reply" ? { ...out, text: `${out.text} ${note}` } : out;
      }
      if (finish.name === RESTORE_CARD_TOOL.name && !canRestore) {
        deps.onEvent?.({ tool: "restore_card", ok: false, reason: "no_thread" });
        return { kind: "failed", reason: "restore_without_thread", turns };
      }
      // A later message whose log finds no food is sent back while turns are
      // left, so the agent can try the user's own words or answer, instead of
      // the food being lost to a failed run.
      const noFood = later && !last && finish.name === LOG_FOOD_TOOL.name ? await logFindsNoFood(finish, parse) : null;
      if (!noFood) {
        const out = await finishWith(finish, input, parse, turns, seen, deps);
        return later ? checkedLater(out, input, replyText) : out;
      }
      thisTurn.results = uses.map((u) => ({ name: u.name, summary: u === finish ? noFood : "not run" }));
      messages.push({ role: "assistant", content: blocks }, {
        role: "user",
        content: uses.map((u) => ({
          type: "tool_result",
          tool_use_id: u.id,
          content: JSON.stringify(u === finish ? { error: noFood } : { error: "Not done: the log in this turn found no food, so nothing was sent." }),
        })),
      });
      continue;
    }
    if (last) {
      if (rejected.size) return { kind: "failed", reason: "card_changes_rejected", turns };
      if (refused.size) return { kind: "failed", reason: "restore_card_open", turns };
      if (copies.length) return { kind: "failed", reason: "copy_nothing_copied", turns };
      return { kind: "failed", reason: "read_on_last_turn", turns };
    }

    for (const u of uses) {
      if (copyRuns.has(u) || refused.has(u) || rejected.has(u)) continue;
      const label = statusFor(u.name, u.input ?? {});
      if (label) deps.onStatus?.(label);
    }
    const outs: unknown[] = [];
    const results = await Promise.all(uses.map(async (u, i) => {
      const run = copyRuns.get(u);
      const out = run
        ? copyResultForAgent(run, staged.items.length > 0 && run.items.every((i) => staged.items.includes(i)) && run.items.length > 0)
        : rejected.has(u)
        ? { error: rejected.get(u) }
        : refused.has(u)
        ? {
          error: "A card is on screen, and restore_card would replace it, so it is not available now. To put foods " +
            "from that earlier card on this one, use copy_lines.",
        }
        : warmNames.has(u.name)
        ? await runWarmRead(u.name, u.input ?? {}, warm!, warmCalls)
        : await runRead(u, deps, parse, { card: input.card ?? [], labelLines, calls: labelCalls, memoryMatches: canMatch });
      outs[i] = out;
      if (!run && !refused.has(u) && !rejected.has(u)) remember(seen, out);
      return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) };
    }));
    thisTurn.results = uses.map((u, i) => ({ name: u.name, summary: summarize(outs[i]) }));
    messages.push({ role: "assistant", content: blocks }, { role: "user", content: results });
  }
  // Unreachable: the last turn always returns. Kept so a future edit to the
  // loop cannot fall off the end silently.
  return { kind: "failed", reason: "turns_exhausted", turns };
}

async function runRead(
  u: ToolUse,
  deps: FoodAgentDeps,
  parse: (text: string) => Promise<ParseMealResult>,
  ctx: { card: CardLine[]; labelLines: Map<number, ParsedItem>; calls: { n: number }; memoryMatches?: boolean } = { card: [], labelLines: new Map(), calls: { n: 0 } },
): Promise<unknown> {
  try {
    if (u.name === FIND_LABEL_TOOL.name) return await runFindLabel(u.input ?? {}, deps, ctx);
    if (u.name === LIST_LOGGED_MEALS_TOOL.name) return await deps.readDiary(u.input ?? {});
    if (u.name === READ_CARD_TOOL.name) {
      const ref = typeof u.input?.card === "string" ? u.input.card.trim().toUpperCase() : "";
      const version = Number.isInteger(u.input?.version) && (u.input.version as number) >= 1 ? u.input.version as number : null;
      if (ref && deps.threadOnScreenRef && ref === deps.threadOnScreenRef) {
        deps.onEvent?.({ tool: "read_card", found: false, on_screen: true });
        return { error: `${ref} is the card on screen now: its lines are the card shown above, not an earlier card.` };
      }
      const got = ref && deps.threadCard ? await deps.threadCard(ref, version) : null;
      deps.onEvent?.({ tool: "read_card", found: !!got });
      if (!got) return { error: `No card ${ref || "(no ref)"}${version ? ` version ${version}` : ""} in this conversation.` };
      return {
        card: got.ref,
        version: got.version,
        latest_version: got.latest_version,
        meal_type: got.meal_type,
        lines: got.lines.map((l) => ({
          line_id: l.line_id, food_name: l.name, quantity: l.quantity, serving_label: l.unit, grams: l.grams,
          kcal: l.kcal, protein_g: l.protein_g, carb_g: l.carb_g, fat_g: l.fat_g,
        })),
      };
    }
    if (u.name === LIST_SAVED_MEALS_TOOL.name) {
      const q = typeof u.input?.query === "string" ? u.input.query.trim().toLowerCase() : "";
      const all = await deps.savedMeals();
      const rows = q ? all.filter((m) => m.name.toLowerCase().includes(q)) : all;
      return rows.slice(0, 40).map((m) => ({
        name: m.name,
        kind: m.kind,
        kcal: Math.round(m.kcal),
        items: m.items.map((i) => ({
          food_name: i.food_name, quantity: i.quantity, serving_label: i.serving_unit, grams: i.grams,
          kcal: i.kcal, protein_g: i.protein_g, carb_g: i.carb_g, fat_g: i.fat_g,
        })),
      }));
    }
    if (u.name === PARSE_FOOD_TOOL.name) {
      const text = typeof u.input?.text === "string" ? u.input.text : "";
      if (!text.trim()) return { error: "text is required" };
      const r = await parse(text);
      if (!r.parsed) return { nothing_to_log: r.declined?.message ?? "no food found" };
      // FOOD_WARM_MEMORY: the memory decisions this parse already made.
      const matches = ctx.memoryMatches ? memoryMatchesOf(r) : [];
      return {
        meal_type: r.parsed.meal_type,
        items: r.parsed.items.map((i) => ({
          food_name: i.food_name, quantity: i.quantity, serving_label: i.serving_label, grams: i.grams,
          kcal: i.kcal, protein_g: i.protein_g, carb_g: i.carb_g, fat_g: i.fat_g,
        })),
        ...(matches.length ? { memory_matches: matches } : {}),
      };
    }
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
  return { error: "unknown tool" };
}

type Seen = Map<string, Set<number>>;
/** The origin of each line the reads returned, by name and calories. */
const seenOrigins = new WeakMap<Seen, Map<string, FoodOrigin>>();

function seenOrigin(seen: Seen, name: string, kcal: number): FoodOrigin {
  return seenOrigins.get(seen)?.get(`${foodKey(name)}|${Math.round(kcal)}`) ?? "unknown";
}

/** Walk a read result and file every food line in it (anything with a name and
 *  a calorie count), whatever shape the result has. */
function remember(seen: Seen, v: unknown, depth = 0): void {
  if (depth > 6 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) remember(seen, x, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  const name = typeof o.food_name === "string" ? o.food_name : typeof o.name === "string" ? o.name : null;
  if (name && typeof o.kcal === "number") {
    const k = foodKey(name);
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k)!.add(Math.round(o.kcal));
    if ("origin" in o || "source" in o) {
      // Keyed by name and calories: two diary lines that share both but not
      // their origin collide. The lower origin wins then, so a copy is never
      // trusted more than the least trusted line it may have come from.
      if (!seenOrigins.has(seen)) seenOrigins.set(seen, new Map());
      const byKey = seenOrigins.get(seen)!;
      const key = `${k}|${Math.round(o.kcal)}`;
      const next = originOf(o);
      const had = byKey.get(key);
      if (!had || ORIGIN_RANK[next] < ORIGIN_RANK[had]) byKey.set(key, next);
    }
  }
  for (const x of Object.values(o)) remember(seen, x, depth + 1);
}

function foodKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Where a line's numbers came from, judged against what the reads returned. */
function provenance(seen: Seen, name: string, kcal: number): "copied" | "changed" | "unseen" {
  const k = seen.get(foodKey(name));
  if (!k) return "unseen";
  return k.has(Math.round(kcal)) ? "copied" : "changed";
}

/** The create tools call an ingredient `name`, the reads call it `food_name`.
 *  Accept either, and mark any line the reads cannot vouch for as estimated so
 *  the card flags it for the user to check before saving. */
function checkedCreateInput(input: Record<string, unknown>, seen: Seen): Record<string, unknown> {
  if (!Array.isArray(input.items)) return input;
  const items = input.items.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const o = { ...(raw as Record<string, unknown>) };
    if (typeof o.name !== "string" && typeof o.food_name === "string") o.name = o.food_name;
    delete o.food_name;
    const kcal = num(o.kcal);
    if (typeof o.name === "string" && kcal !== null && provenance(seen, o.name, kcal) !== "copied") o.estimated = true;
    return o;
  });
  return { ...input, items };
}

async function finishWith(
  u: ToolUse,
  input: FoodAgentInput,
  parse: (text: string) => Promise<ParseMealResult>,
  turns: AgentTurn[],
  seen: Seen,
  deps: Pick<FoodAgentDeps, "correctCard" | "restoreCard" | "onEvent"> = {},
): Promise<FoodAgentOutcome> {
  const args = u.input ?? {};
  if (u.name === RESTORE_CARD_TOOL.name) {
    // A card on screen: never replaced (runFoodAgent refuses before this; the
    // same rule here, where the restore would act).
    if (input.card?.length) {
      deps.onEvent?.({ tool: "restore_card", ok: false, reason: "card_open" });
      return { kind: "failed", reason: "restore_card_open", turns };
    }
    const ref = typeof args.card === "string" ? args.card.trim().toUpperCase() : "";
    const version = Number.isInteger(args.version) && (args.version as number) >= 1 ? args.version as number : null;
    const got = ref && deps.restoreCard ? await deps.restoreCard(ref, version) : null;
    deps.onEvent?.({ tool: "restore_card", ok: !!got?.items.length, reason: got?.items.length ? "restored" : "not_found" });
    if (!got || got.items.length === 0) return { kind: "failed", reason: "restore_not_found", turns };
    const summary = clean(typeof args.summary === "string" ? args.summary : "");
    // No model or lookup ran for the restore itself: the agent's own tokens
    // are logged by its caller (logUsage), so zero here is the true cost.
    const emptyUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
    // The card comes back whole, numbers unchanged, and takes the place of
    // whatever is on screen (corrects_previous: the app replaces, not appends).
    return {
      kind: "log",
      result: {
        parsed: {
          meal_type: got.meal_type ?? got.items[0]?.meal_type ?? input.defaultMeal,
          items: got.items,
          drona_line: summary || "Here it is again.",
          corrects_previous: true,
        },
        declined: null,
        usage: emptyUsage,
        tool_calls: ["food_agent", "restore_card"],
        steps: [],
        iterations: turns.length,
      },
      turns,
    };
  }
  if (u.name === REPLY_TOOL.name) {
    const text = clean(typeof args.text === "string" ? args.text : "");
    return text ? { kind: "reply", text, turns } : { kind: "failed", reason: "empty_reply", turns };
  }
  const card = input.card ?? [];
  // The card tools act on the card, so a card that may be cut at the cap
  // refuses them HERE too, not only in toolsFor: a model can name a tool it
  // was not offered, and the refusal has to sit where the tool would act.
  if (cardMayBeCut(card) && (u.name === EDIT_CARD_TOOL.name || u.name === REMOVE_CARD_LINES_TOOL.name || u.name === SAVE_CARD_AS_MEAL_TOOL.name)) {
    return { kind: "failed", reason: "card_may_be_cut", turns };
  }
  if (u.name === EDIT_CARD_TOOL.name) {
    const change = typeof args.change === "string" ? args.change.trim() : "";
    if (!change || !card.length) return { kind: "failed", reason: "edit_without_card", turns };
    if (!deps.correctCard) return { kind: "failed", reason: "no_correct_card", turns };
    const r = await deps.correctCard(change);
    if (!r.parsed || r.parsed.items.length === 0) return { kind: "failed", reason: "edit_produced_nothing", turns };
    const summary = clean(typeof args.summary === "string" ? args.summary : "");
    return {
      kind: "log",
      result: { ...r, parsed: { ...r.parsed, corrects_previous: true, drona_line: summary || r.parsed.drona_line }, tool_calls: ["food_agent", ...r.tool_calls] },
      turns,
    };
  }
  if (u.name === REMOVE_CARD_LINES_TOOL.name) {
    if (!card.length) return { kind: "failed", reason: "remove_without_card", turns };
    const asked = Array.isArray(args.lines) ? args.lines : [];
    // Deduped: [2, 2] names one line, so the summary names it once and
    // "skipped" counts only numbers the card does not have.
    const nums = [...new Set(asked.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= card.length))];
    if (nums.length === 0) return { kind: "failed", reason: "remove_no_lines", turns };
    // A line number the card does not have is a model slip. The valid ones go,
    // but the summary must not claim a removal that did not happen: the user
    // reads that line, so it says what really came off.
    const skipped = new Set(asked).size - nums.length;
    const drop = new Set(nums.map((n) => n - 1));
    const kept = card.filter((_, i) => !drop.has(i));
    const removedNames = nums.map((n) => card[n - 1].food_name).join(", ");
    const summary = skipped > 0
      ? `Took off ${removedNames}.`
      : clean(typeof args.summary === "string" ? args.summary : "");
    const emptyUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
    if (kept.length === 0) {
      // Nothing left: the card is cleared, the way removing the last line with
      // the X button clears it. A meal with zero items is an error to the app
      // (lib/dietData.ts), so it must never be sent as one.
      return {
        kind: "log",
        result: {
          parsed: null,
          declined: { message: summary || "Taken off. Nothing left on this one.", cleared: true },
          usage: emptyUsage, tool_calls: ["food_agent", "remove_card_lines"], steps: [], iterations: turns.length,
        },
        turns,
      };
    }
    // The kept lines go back as they were: a correction replaces the card.
    // The card's own section leads; the default is only for a line without one.
    const meal: MealType = kept[0]?.meal_type ?? input.defaultMeal;
    return {
      kind: "log",
      result: {
        parsed: {
          meal_type: meal,
          items: kept.map((l) => cardLineAsItem(l, input.defaultMeal)),
          drona_line: summary || "Taken off.",
          corrects_previous: true,
        },
        declined: null,
        usage: emptyUsage,
        tool_calls: ["food_agent", "remove_card_lines"],
        steps: [],
        iterations: turns.length,
      },
      turns,
    };
  }
  if (u.name === SAVE_CARD_AS_MEAL_TOOL.name) {
    if (!card.length) return { kind: "failed", reason: "save_without_card", turns };
    const name = clean(typeof args.name === "string" ? args.name : "").slice(0, 80) || "My meal";
    const summary = clean(typeof args.summary === "string" ? args.summary : "");
    // A line the parse only estimated is saved as estimated, so the save card
    // flags it for a look before it becomes "the user's own numbers". The
    // card's lines are what the reads vouch for here, so `seen` learns them
    // first and the same validator the agent's other saves use runs on top.
    remember(seen, card.map((l) => ({ food_name: l.food_name, kcal: l.kcal })));
    // Not `input`: that is finishWith's own parameter, and a shadow here is a trap.
    const createInput = checkedCreateInput({
      name,
      items: card.map((l) => ({
        name: l.food_name, quantity: l.quantity, serving_label: l.serving_label, grams: l.grams,
        kcal: Math.round(l.kcal), protein_g: l.protein_g ?? 0, carb_g: l.carb_g ?? 0, fat_g: l.fat_g ?? 0,
        estimated: l.source === "estimate" || l.source === "web",
      })),
      log_now: args.log_now === true,
      summary: summary || `${name}, ${card.length} items. Want it in My Meals?`,
    }, seen);
    return { kind: "create", create: { tool: CREATE_CUSTOM_MEAL_TOOL.name, input: createInput }, turns };
  }
  if (u.name === CREATE_CUSTOM_MEAL_TOOL.name || u.name === CREATE_CUSTOM_FOOD_TOOL.name) {
    // A save drafted from card lines takes those lines' macros, not only their
    // calories: live 2026-11-05 the agent saved "this paneer sabji" from the
    // card as 150 kcal and 0 g of everything else. The card lines are what the
    // user is looking at, so they count as read for the estimate check too.
    if (card.length) {
      remember(seen, card.map((l) => ({ food_name: l.food_name, kcal: l.kcal })));
      // A save line fillFromCard matches to a card line ("Paneer sabji" to
      // "Paneer sabji (60 g paneer, oil)") is read under its own name too, so
      // the estimate check below agrees with the copy.
      for (const raw of Array.isArray(args.items) ? args.items : []) {
        const o = (raw ?? {}) as Record<string, unknown>;
        const nm = o.name ?? o.food_name;
        const line = cardLineFor(nm, o.kcal, card);
        if (line && typeof nm === "string") remember(seen, [{ food_name: nm, kcal: line.kcal }]);
      }
    }
    return { kind: "create", create: { tool: u.name, input: checkedCreateInput(fillFromCard(u.name, args, card), seen) }, turns };
  }
  // log_food
  const meal: MealType = isMeal(args.meal_type) ? args.meal_type : input.defaultMeal;
  const copied = Array.isArray(args.items) ? args.items.flatMap((r) => copiedLine(r, meal, seen)) : [];
  let parsedLines: ParsedItem[] = [];
  let usage: ParseMealResult["usage"] = {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0,
  };
  const steps: ParseStep[] = [];
  let tier: ParseMealResult["tier"];
  if (typeof args.text === "string" && args.text.trim()) {
    const r = await parse(args.text);
    usage = r.usage;
    tier = r.tier;
    steps.push(...r.steps);
    parsedLines = (r.parsed?.items ?? []).map((i) => ({ ...i, meal_type: meal }));
  }
  const items = [...copied, ...parsedLines];
  if (items.length === 0) return { kind: "failed", reason: "log_with_no_items", turns };
  const summary = clean(typeof args.summary === "string" ? args.summary : "");
  return {
    kind: "log",
    result: {
      parsed: { meal_type: meal, items, drona_line: summary || "Here it is, ready to log.", corrects_previous: false },
      declined: null,
      usage,
      tool_calls: ["food_agent"],
      steps,
      iterations: turns.length,
      tier,
    },
    turns,
  };
}

// ── Later messages: one-line card changes, applied in a fixed order ────────

/** A log_food that only names text, and the parse of that text found no food:
 *  the reason the agent reads. Null when it found food or carries items. The
 *  parse is cached by text, so finishWith does not pay for it again. */
async function logFindsNoFood(u: ToolUse, parse: (text: string) => Promise<ParseMealResult>): Promise<string | null> {
  const text = typeof u.input?.text === "string" ? u.input.text.trim() : "";
  if (!text || (Array.isArray(u.input?.items) && u.input.items.length > 0)) return null;
  try {
    const r = await parse(text);
    if (r.parsed?.items.length) return null;
  } catch { /* the same as nothing found */ }
  return `No food was found in "${text.slice(0, 120)}". Nothing was logged. Pass the user's own words for the food, ` +
    "or ask them one short question with reply.";
}

/** The tools that end in a save card. */
const SAVE_TOOLS = new Set([SAVE_CARD_AS_MEAL_TOOL.name, CREATE_CUSTOM_MEAL_TOOL.name, CREATE_CUSTOM_FOOD_TOOL.name]);

/** A word that asks to save or keep something for later. */
// "save" is an ask with any object ("save it", "save breakfast") or none
// ("please save"), except the everyday phrases that save something else
// ("save the day", "save time", "save calories"). "saving" counts only with a
// pronoun ("saving it"): "saving calories" is not an ask, nor is "it saves".
const SAVE_ASK = /\b(?:save\b(?!\s+(?:the day|time|money|calories|cals|kcal|energy|room|space|up|on|me|us)\b)|saving (?:it|this|that|these|them)\b|(?:to|in|into) my meals|as a (?:saved )?meal|make (?:it|this|that) (?:a|my) meal|(?:keep|remember) (?:it|this|that) (?:as|for))\b/gi;

/** A no in front of the ask ("don't save", "no need to save"): not an ask. */
const NEGATED = /\b(?:don['’]?t|do not|no need to|not|never|didn['’]?t|won['’]?t|stop|without|nope)\b[\w\s'’]*$/i;

/** Where one part of a sentence ends: a no before it says nothing about a
 *  save after it ("not sure, but save it", "nope, save it anyway"). */
const CLAUSE_END = /[,.;:!?]|\bbut\b|\bthough\b|\banyway\b|\bplease\b|\bgo ahead\b/gi;

/** "don't forget to", "never forget to": a no that asks. */
const DONT_FORGET = /\b(?:don['’]?t|do not|never)\s+forget\b[\w\s'’]{0,40}$/i;

/** An ask to save in this text: a save word, not negated. Past tense
 *  ("already saved") is not in the pattern, and neither is a bare "my meals". */
function asksToSave(text: string): boolean {
  for (const m of text.matchAll(SAVE_ASK)) {
    const at = m.index ?? 0;
    // "do not forget to (please go ahead and) save it" asks; "don't save it"
    // does not.
    if (DONT_FORGET.test(text.slice(Math.max(0, at - 60), at))) return true;
    // A no counts only in the save's own part of the sentence, however long
    // that part is ("do not under any circumstances ... save it").
    const ends = [...text.slice(0, at).matchAll(CLAUSE_END)];
    const from = ends.length ? (ends.at(-1)!.index ?? 0) + ends.at(-1)![0].length : 0;
    if (!NEGATED.test(text.slice(from, at))) return true;
  }
  return false;
}

/** Did the user ask for a save? In this message, or in their message just
 *  before it when Drona then asked them something ("save it" -> "save it as
 *  Dinner?" -> "yes"). Not any earlier turn: one "save" early in a thread does
 *  not leave the gate open for the rest of it. "keep" and "remember" count only
 *  as "keep it as / for": "keep the rice" is not a save. */
export function userAskedToSave(input: Pick<FoodAgentInput, "text" | "recentTurns">): boolean {
  if (asksToSave(input.text)) return true;
  const turns = input.recentTurns ?? [];
  const last = turns.at(-1);
  const before = turns.at(-2);
  return last?.role === "drona" && /\?\s*$/.test(last.text.trim()) && before?.role === "user" && asksToSave(before.text);
}

/** Reads whose results a later-message agent acts on: a finish in the same
 *  turn waits for them. parse_food is not one (its result is reused). */
const HOLD_READS = new Set([LIST_LOGGED_MEALS_TOOL.name, LIST_SAVED_MEALS_TOOL.name, READ_CARD_TOOL.name, FIND_LABEL_TOOL.name]);

/** What ends a later-message run other than a card change (or a reply). */
const LATER_FINISHES = new Set([
  LOG_FOOD_TOOL.name, CREATE_CUSTOM_MEAL_TOOL.name, CREATE_CUSTOM_FOOD_TOOL.name, SAVE_CARD_AS_MEAL_TOOL.name, RESTORE_CARD_TOOL.name,
]);

/** Most edits plus additions one turn may carry (each one is a parse). */
export const MAX_CARD_WORK_PER_TURN = 8;

/** One turn's card changes, checked and in the order they apply. */
export interface CardPlan {
  ok: true;
  edits: { index: number; change: string; useLabel?: boolean }[];
  /** Card indexes, each once, in card order. */
  removes: number[];
  adds: { text: string | null; items: unknown[]; meal: MealType | null }[];
  /** The agent's own summaries, in call order. */
  summaries: string[];
  /** build_recipe dishes (FOOD_BUILD_RECIPE): `index` the card line the dish
   *  replaces, or null to add it. */
  recipes?: { index: number | null; ask: RecipeAsk; meal: MealType | null }[];
}

/**
 * Check one turn's card changes before anything runs (plan section 7). Every
 * line is named by its id on the card as the message found it. Refused, with
 * the reason the agent reads: a line id the card does not have, an edit with no
 * change, a line with two changes (two edits, or an edit and a removal), an
 * addition with nothing in it, or a restore in the same turn (a restore
 * replaces the whole card).
 */
export function planCardChanges(
  card: CardLine[],
  uses: { name: string; input: Record<string, unknown> }[],
  restoreInTurn = false,
  /** No card on screen, and the turn builds a dish: additions make the card. */
  emptyCardOk = false,
): CardPlan | { ok: false; error: string } {
  const tail = " Nothing was changed. Send the changes again, one change per line.";
  const fail = (why: string) => ({ ok: false as const, error: `${why}${tail}` });
  if (restoreInTurn) return fail("restore_card replaces the whole card, so it cannot share a turn with line changes. Choose one.");
  if (!card.length && !emptyCardOk) return fail("No card is on screen to change. Use log_food.");
  if (!card.length && uses.some((u) => u.name === EDIT_LINE_TOOL.name || u.name === REMOVE_LINES_TOOL.name)) {
    return fail("No card is on screen yet, so edit_line and remove_lines have no line to change. Use build_recipe and log_food.");
  }
  const ids = `The card's lines are L1 to L${card.length}.`;
  const edits: CardPlan["edits"] = [];
  const removes = new Set<number>();
  const adds: CardPlan["adds"] = [];
  const summaries: string[] = [];
  const recipes: NonNullable<CardPlan["recipes"]> = [];
  for (const u of uses) {
    const a = u.input ?? {};
    if (typeof a.summary === "string" && a.summary.trim()) summaries.push(a.summary.trim());
    if (u.name === BUILD_RECIPE_TOOL.name) {
      const ask = readRecipeAsk(a);
      if ("error" in ask) return fail(ask.error);
      let index: number | null = null;
      if (a.line_id !== undefined && a.line_id !== null && a.line_id !== "") {
        if (!card.length) return fail("No card is on screen yet, so build_recipe has no line to replace. Leave out line_id to add the dish.");
        index = lineIndexOf(a.line_id, card.length);
        if (index === null) return fail(`build_recipe names ${JSON.stringify(a.line_id)}, which is not on the card. ${ids}`);
      }
      recipes.push({ index, ask, meal: isMeal(a.meal_type) ? a.meal_type : null });
    } else if (u.name === EDIT_LINE_TOOL.name) {
      const i = lineIndexOf(a.line_id, card.length);
      if (i === null) return fail(`edit_line names ${JSON.stringify(a.line_id ?? null)}, which is not on the card. ${ids}`);
      const change = typeof a.change === "string" ? a.change.trim() : "";
      if (!change) return fail(`edit_line on L${i + 1} says no change.`);
      edits.push({ index: i, change: change.slice(0, 400), ...(a.use_label === true ? { useLabel: true } : {}) });
    } else if (u.name === REMOVE_LINES_TOOL.name) {
      const asked = Array.isArray(a.line_ids) ? a.line_ids : [];
      if (!asked.length) return fail("remove_lines names no line.");
      for (const raw of asked) {
        const i = lineIndexOf(raw, card.length);
        if (i === null) return fail(`remove_lines names ${JSON.stringify(raw)}, which is not on the card. ${ids}`);
        removes.add(i);
      }
    } else {
      // add_lines, or log_food beside a card: the same addition.
      const text = typeof a.text === "string" && a.text.trim() ? a.text.trim() : null;
      const items = Array.isArray(a.items) ? a.items : [];
      if (!text && !items.length) return fail(`${u.name} has no text and no items.`);
      adds.push({ text, items, meal: isMeal(a.meal_type) ? a.meal_type : null });
    }
  }
  // Each edit and each addition is a whole parse (lookups, maybe the web), all
  // run at once: a turn may hold at most this many. Removals cost nothing.
  // Each part of a dish is one parse, so it counts too.
  const parts = recipes.reduce((n, r) => n + r.ask.parts.length, 0);
  if (edits.length + adds.length + parts > MAX_CARD_WORK_PER_TURN) {
    return fail(
      parts
        ? `${edits.length + adds.length} edits and additions and ${parts} dish parts in one turn; at most ${MAX_CARD_WORK_PER_TURN} in all.`
        : `${edits.length + adds.length} edits and additions in one turn; at most ${MAX_CARD_WORK_PER_TURN}.`,
    );
  }
  const count = new Map<number, number>();
  for (const e of edits) count.set(e.index, (count.get(e.index) ?? 0) + 1);
  for (const r of recipes) if (r.index !== null) count.set(r.index, (count.get(r.index) ?? 0) + 1);
  for (const i of removes) count.set(i, (count.get(i) ?? 0) + 1);
  const twice = [...count].filter(([, n]) => n > 1).map(([i]) => `L${i + 1}`).sort();
  if (twice.length) return fail(`${twice.join(", ")} ${twice.length === 1 ? "has" : "have"} two changes in one turn.`);
  return { ok: true, edits, removes: [...removes].sort((a, b) => a - b), adds, summaries, ...(recipes.length ? { recipes } : {}) };
}

/** The card after one turn's changes: every line the agent did not name is
 *  the card line exactly as it was, an edited line takes its new numbers in
 *  its own place and section, a removed line is gone, and additions go last.
 *  This IS the correction guard: no line leaves except through `removes`. */
export function buildChangedCard(
  card: CardLine[],
  removes: ReadonlySet<number>,
  edited: ReadonlyMap<number, ParsedItem>,
  added: ParsedItem[],
  mealDefault: MealType,
): ParsedItem[] {
  const kept: ParsedItem[] = [];
  card.forEach((l, i) => {
    if (removes.has(i)) return;
    const e = edited.get(i);
    kept.push(e ? { ...e, meal_type: l.meal_type ?? e.meal_type ?? mealDefault } : cardLineAsItem(l, mealDefault));
  });
  return [...kept, ...added];
}

/** The one line an edit_line parse stands for. The parse ran on that line
 *  alone, so it is nearly always one item; when it returns more, the one that
 *  is the same food is taken (else the first), and nothing else joins the card:
 *  new food goes through add_lines. */
export function pickEditedLine(original: CardLine, r: ParseMealResult | null): ParsedItem | null {
  const items = r?.parsed?.items ?? [];
  if (items.length <= 1) return items[0] ?? null;
  const key = sameFoodKey(original.said_name ?? original.food_name);
  const own = sameFoodKey(original.food_name);
  // Several items and none is this food: no guess. The edit fails, the line
  // stays as it was, and the card's line says so.
  return items.find((i) => {
    const k = sameFoodKey(i.food_name);
    return k === key || k === own || k.includes(own) || own.includes(k);
  }) ?? null;
}

/** A change asking for the food's numbers to be checked or looked up again. */
const RELOOKUP_RE = /\b(check(ed|ing)? (it )?again|re-?check|look (it |them )?up|search again|(numbers?|values?|macros?|nutrition) (are |is |look |looks |seem |seems )?(wrong|off|incorrect))\b/i;

/** Words too small or too common to name a food. */
const FILLER_WORDS = new Set(["the", "and", "with", "of", "a", "an", "in", "for", "per", "from", "to", "or", "made"]);
const nameWords = (x: string) =>
  x.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !FILLER_WORDS.has(w));

/**
 * An edit keeps the food the user named unless the change names another.
 *
 * Live, 2026-11-07: "2 slices of Health Factory protein bread, 242 kcal is too
 * high" went to the correction path, which swapped in a catalog "Zero Maida
 * Protein Bread": the brand was gone and the protein fell. The change asked for
 * an amount, not another product. So when the edited line's name has lost words
 * of the user's name for it, and the change names no new food, the swap was the
 * search's, not the user's: the line keeps its name, and its own numbers per
 * gram, scaled to the new weight. Without its own numbers (no grams or no kcal
 * on the line) the edit stands, and so does a line of numbers the user stated.
 */
export function keepLineIdentity(original: CardLine, edited: ParsedItem, change: string): ParsedItem {
  // Numbers the user stated (source manual) are theirs, whatever the name: a
  // stated number wins over every source.
  if (edited.source === "manual") return edited;
  // Amount edits only: the weight changed. "Those numbers are wrong, check
  // again" at the same weight is a re-lookup, and its new row stands.
  if (!(original.grams > 0) || Math.abs(edited.grams - original.grams) <= Math.max(1, original.grams * 0.05)) return edited;
  // A change that asks for the numbers to be looked up again, or says they are
  // wrong, wants a new row, whatever the weight.
  if (RELOOKUP_RE.test(change)) return edited;
  const has = (set: Set<string>, w: string) => set.has(w) || set.has(`${w}s`) || set.has(w.replace(/s$/, ""));
  const before = new Set([...nameWords(original.food_name), ...nameWords(original.said_name ?? "")]);
  const said = new Set(nameWords(change));
  // The change names the new food ("it was the zero maida one"): it stands.
  if (nameWords(edited.food_name).some((w) => !has(before, w) && has(said, w))) return edited;
  // The user's own words for the food are gone ("Health Factory protein bread"
  // to a plain "Protein Bread"): the search swapped it. "Roti" to "Whole Wheat
  // Roti" keeps them and stands.
  const now = new Set(nameWords(edited.food_name));
  const lost = nameWords(original.said_name ?? original.food_name).filter((w) => !has(now, w));
  if (!lost.length) return edited;
  if (!(original.grams > 0) || typeof original.kcal !== "number" || !(edited.grams > 0)) return edited;
  const f = edited.grams / original.grams;
  const scale = (v: number | undefined) => Math.round((v ?? 0) * f * 10) / 10;
  return {
    ...edited,
    food_id: original.food_id ?? null,
    food_name: original.food_name,
    ...(original.said_name ? { said_name: original.said_name } : {}),
    // The original line's site, never the swapped row's: its numbers are the
    // original's, so a catalog line must not read "from web: <site>".
    source_site: original.source_site,
    kcal: scale(original.kcal),
    protein_g: scale(original.protein_g),
    carb_g: scale(original.carb_g),
    fat_g: scale(original.fat_g),
    fiber_g: typeof original.fiber_g === "number" ? scale(original.fiber_g) : null,
    source: original.source ?? edited.source,
    assumption: original.assumption ?? null,
  };
}

const MASS_LABELS = new Set(["g", "gm", "gms", "gram", "grams", "ml"]);
const singular = (w: string) => (w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/**
 * A card line worked out from a label find_label returned. The model does no
 * arithmetic: the line keeps its name (the user's brand and product), its
 * quantity and its unit, and takes its weight from the label when the unit is
 * the label's piece ("2 x slice" with a label piece of "1 slice", 25 g: 50 g);
 * a weight line keeps its grams; any other line keeps its weight. Every macro
 * is the label's per-100 at that weight.
 */
export function lineFromLabel(line: CardLine, label: LabelFound, mealDefault: MealType): ParsedItem {
  const unit = line.serving_label.trim().toLowerCase();
  const unitNoun = singular(unit.replace(/\(.*\)/, "").trim().split(/\s+/).pop() ?? "");
  const pieceNoun = label.piece ? singular(label.piece.label.toLowerCase().replace(/\(.*\)/, "").trim().split(/\s+/).pop() ?? "") : "";
  let grams = line.grams;
  let servingLabel = line.serving_label;
  if (MASS_LABELS.has(unit) && line.quantity > 0) {
    grams = line.quantity;
  } else if (label.piece && pieceNoun && unitNoun === pieceNoun && line.quantity > 0) {
    grams = line.quantity * label.piece.grams;
    servingLabel = `${pieceNoun} (${Math.round(label.piece.grams * 10) / 10} ${label.base_unit})`;
  }
  const f = grams / 100;
  const r1 = (v: number) => Math.round(v * f * 10) / 10;
  const item: ParsedItem = {
    food_id: null,
    food_name: line.food_name,
    ...(line.said_name ? { said_name: line.said_name } : {}),
    quantity: line.quantity,
    serving_label: servingLabel,
    grams: Math.round(grams * 10) / 10,
    kcal: r1(label.per_100.kcal),
    protein_g: r1(label.per_100.protein_g),
    carb_g: r1(label.per_100.carb_g),
    fat_g: r1(label.per_100.fat_g),
    fiber_g: label.per_100.fiber_g === null ? null : r1(label.per_100.fiber_g),
    source: "web",
    assumption: "From the label online",
    ...(label.site ? { source_site: label.site } : {}),
    confidence: label.verified ? "high" : "medium",
    meal_type: line.meal_type ?? mealDefault,
  };
  // The user's own numbers on the line (an earlier "150 cals of atta bread")
  // stay theirs: the label gives the food's density and the macros they did
  // not give, and the weight follows (fitPortionToStated). A line whose amount
  // was read as energy ("150 x kcal") was never an amount.
  const mine = userNumbersOnLine(line);
  if (mine) {
    const priced = energyUnitKcal(line.quantity, line.serving_label) !== null
      ? { ...item, quantity: 1, serving_label: "serving" }
      : item;
    // A weight on a line carrying the user's numbers is the one an earlier fit
    // worked out from them (a typed weight gives per-100 numbers, which read
    // back as none here), so the new label's density may move it.
    const fitted = fitPortionToStated(priced, mine, lineAmountNamed(line) && !isWeightLabel(line.serving_label));
    const r = (v: number) => Math.round(v * 10) / 10;
    return {
      ...fitted,
      kcal: r(fitted.kcal), protein_g: r(fitted.protein_g), carb_g: r(fitted.carb_g), fat_g: r(fitted.fat_g),
      fiber_g: fitted.fiber_g === null ? null : r(fitted.fiber_g),
      source: "manual",
      origin: "user_typed",
      assumption: `${totalNote(mine, "line")} (the rest from the label online)`,
    };
  }
  // A unit that prints its own weight ("slice (25 g)") weighs quantity x it.
  return unitWeightMatchesGrams(item);
}

/** find_label for the agent: the label, and for a card line, the line from it. */
async function runFindLabel(
  input: Record<string, unknown>,
  deps: FoodAgentDeps,
  ctx: { card: CardLine[]; labelLines: Map<number, ParsedItem>; calls: { n: number } },
): Promise<unknown> {
  if (!deps.findLabel) return { error: "find_label is not available here." };
  // Each call is a web lookup: a few per run at most.
  if (ctx.calls.n >= MAX_FIND_LABEL_PER_RUN) {
    return { error: `find_label already ran ${MAX_FIND_LABEL_PER_RUN} times this message. Use what it returned, or reply.` };
  }
  ctx.calls.n++;
  const index = input.line_id === undefined ? null : lineIndexOf(input.line_id, ctx.card.length);
  if (input.line_id !== undefined && index === null) {
    return { error: `find_label names ${JSON.stringify(input.line_id)}, which is not on the card. The card's lines are L1 to L${ctx.card.length}.` };
  }
  const line = index === null ? null : ctx.card[index];
  const product = line ? line.said_name?.trim() || line.food_name : typeof input.product === "string" ? input.product.trim() : "";
  if (!product) return { error: "Name a card line (line_id) or a product." };
  const label = await deps.findLabel({ name: product, brand: null });
  deps.onEvent?.({ tool: "find_label", found: !!label });
  if (!label) return { found: false, product, note: `No label found online for ${product}.` };
  const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  const out: Record<string, unknown> = {
    found: true,
    product: label.name,
    per_100: {
      unit: label.base_unit, kcal: r1(label.per_100.kcal), protein_g: r1(label.per_100.protein_g),
      carb_g: r1(label.per_100.carb_g), fat_g: r1(label.per_100.fat_g),
    },
    serving_printed: label.serving ? `${label.serving.label}, ${r1(label.serving.grams)} ${label.base_unit}` : null,
    one_piece: label.piece ? `${label.piece.label}, ${r1(label.piece.grams)} ${label.base_unit}` : null,
    agreed_by_two_sources: label.verified,
    ...(line ? {} : { note: "To put a label on a card line, call find_label with that line_id." }),
  };
  if (line && index !== null) {
    const item = lineFromLabel(line, label, line.meal_type ?? "snack");
    ctx.labelLines.set(index, item);
    out.line_from_label = {
      line_id: `L${index + 1}`, food_name: item.food_name, quantity: item.quantity, serving_label: item.serving_label,
      grams: item.grams, kcal: item.kcal, protein_g: item.protein_g, carb_g: item.carb_g, fat_g: item.fat_g,
      to_apply: `edit_line on L${index + 1} with use_label true`,
    };
  }
  return out;
}

const EMPTY_USAGE = (): ParseMealResult["usage"] => ({
  input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0,
});

function addUsage(a: ParseMealResult["usage"], b: ParseMealResult["usage"] | undefined): void {
  if (!b) return;
  a.input_tokens += b.input_tokens ?? 0;
  a.output_tokens += b.output_tokens ?? 0;
  a.cache_creation_input_tokens += b.cache_creation_input_tokens ?? 0;
  a.cache_read_input_tokens += b.cache_read_input_tokens ?? 0;
  a.web_search_requests += b.web_search_requests ?? 0;
  if (b.tavily_credits) a.tavily_credits = (a.tavily_credits ?? 0) + b.tavily_credits;
}

/** Apply a checked plan: edits (each line worked out again on its own, in
 *  parallel), then removals, then additions. The line the user reads is the
 *  agent's own words only when nothing failed and they claim nothing that did
 *  not happen; otherwise code writes it from what really changed. */
async function applyCardChanges(
  plan: CardPlan,
  input: FoodAgentInput,
  deps: Pick<FoodAgentDeps, "editLine" | "onEvent" | "warm">,
  parse: (text: string) => Promise<ParseMealResult>,
  seen: Seen,
  turns: AgentTurn[],
  replyText: string,
  /** Lines copy_lines took earlier in the run. withStaged appends them to
   *  this result, so they count as on the card and against its size. */
  stagedItems: ParsedItem[] = [],
  /** Card lines find_label worked out from a label (use_label). */
  labelLines: ReadonlyMap<number, ParsedItem> = new Map(),
): Promise<FoodAgentOutcome> {
  const card = input.card ?? [];
  const meal: MealType = card[0]?.meal_type ?? input.defaultMeal;
  const [editsOut, addsOut, recipesOut] = await Promise.all([
    Promise.all(plan.edits.map(async (e) => {
      // The label find_label returned for this line: no parse, the line is
      // the one code worked out. No label for it: the edit fails, the line stays.
      if (e.useLabel) {
        const l = labelLines.get(e.index);
        return { e, r: null, item: l && l.food_name === card[e.index].food_name ? l : null };
      }
      let r: ParseMealResult | null = null;
      try {
        r = deps.editLine ? await deps.editLine(e.index, e.change) : null;
      } catch {
        r = null;
      }
      const picked = pickEditedLine(card[e.index], r);
      return { e, r, item: picked ? keepLineIdentity(card[e.index], picked, e.change) : null };
    })),
    Promise.all(plan.adds.map(async (a) => {
      const m = a.meal ?? meal;
      const copied = a.items.flatMap((raw) => copiedLine(raw, m, seen));
      let r: ParseMealResult | null = null;
      if (a.text) {
        try {
          r = await parse(a.text);
        } catch {
          r = null;
        }
      }
      const parsed = (r?.parsed?.items ?? []).map((i) => ({ ...i, meal_type: m }));
      return { a, r, items: [...copied, ...parsed] };
    })),
    // build_recipe: one parse per part through the same `parse`, summed in
    // code (recipe.ts). A dish on a card line keeps that line's section.
    Promise.all((plan.recipes ?? []).map(async (x) => {
      const m = x.meal ?? (x.index !== null ? card[x.index].meal_type : null) ?? meal;
      // FOOD_WARM_MEMORY: the same dish in the user's memory lends its
      // remembered amounts to parts sent with none (recipe.ts buildRecipe).
      // Waited for briefly: a slow load builds the dish as the switch off would,
      // and the trace says the wait ran out.
      let foods: RecallFood[] | null = null;
      if (deps.warm?.memory) {
        let landed = false;
        foods = await briefly(deps.warm.memory().finally(() => { landed = true; }), RECIPE_MEMORY_WAIT_MS);
        if (!landed) deps.onEvent?.({ tool: "recipe_memory", timed_out: true, waited_ms: RECIPE_MEMORY_WAIT_MS });
      }
      const b = await buildRecipe(x.ask, m, parse, rememberedRecipe(foods, x.ask.name, memoryKey));
      return { x, ...b };
    })),
  ]);
  const edited = new Map<number, ParsedItem>();
  for (const x of editsOut) if (x.item) edited.set(x.e.index, x.item);
  for (const x of recipesOut) if (x.item && x.x.index !== null) edited.set(x.x.index, x.item);
  const recipeAdds = recipesOut.flatMap((x) => (x.item && x.x.index === null ? [x.item] : []));
  const removes = new Set(plan.removes);
  // An addition never puts a second copy of a food that stays on the card
  // (an edit changes the line; a second portion is a copy_lines add_again or
  // an edit). It is left off and named.
  const staying = card.flatMap((l, i) => removes.has(i) ? [] : [edited.get(i) ?? { food_name: l.food_name, food_id: l.food_id ?? null }]);
  const keys = new Set(staying.map((l) => sameFoodKey(l.food_name)));
  const ids = new Set(staying.map((l) => l.food_id).filter((x): x is string => !!x));
  for (const s of stagedItems) {
    keys.add(sameFoodKey(s.food_name));
    if (s.food_id) ids.add(s.food_id);
  }
  const dupAdds: string[] = [];
  const added = [...recipeAdds, ...addsOut.flatMap((x) => x.items)].filter((i) => {
    const key = sameFoodKey(i.food_name);
    const dup = keys.has(key) || (!!i.food_id && ids.has(i.food_id));
    if (dup) dupAdds.push(i.food_name);
    else {
      // Two additions of one food in the same turn: the second is a copy too.
      keys.add(key);
      if (i.food_id) ids.add(i.food_id);
    }
    return !dup;
  });
  // The card holds CARD_MAX_LINES lines: the app sends back no more, so a line
  // past them would be lost on the next correction. Additions that do not fit
  // are left off and named; every line already on the card stays.
  const room = Math.max(0, CARD_MAX_LINES - (card.length - removes.size) - stagedItems.length);
  const overflow = added.splice(room).map((i) => i.food_name);
  // The same meal the result says, so a line with no section of its own
  // lands where the card is.
  const items = buildChangedCard(card, removes, edited, added, meal);

  const failedEdits = editsOut.filter((x) => !x.item).map((x) => card[x.e.index].food_name);
  const failedAdds = addsOut.filter((x) => x.a.text && x.items.length === 0).map((x) => x.a.text!);
  const failedRecipes = recipesOut.filter((x) => !x.item).map((x) => ({ name: x.x.ask.name, missing: x.missing, errored: x.errored, onLine: x.x.index !== null }));
  const missingParts = recipesOut.filter((x) => x.item && x.missing.length).map((x) => `${names(x.missing)} in ${x.x.ask.name}`);
  const changed = edited.size + removes.size + added.length > 0;
  // The ONE question about amounts the user did not give (recipe.ts): code
  // writes it, only for dishes that landed, never twice in a thread.
  const builtDishes = recipesOut.flatMap((x) => (x.item && (x.x.index !== null ? edited.get(x.x.index) === x.item : added.includes(x.item)) ? [x.item] : []));
  const question = recipeQuestion(builtDishes, card, input.recentTurns) ?? "";
  const codeLine = [
    edited.size ? `Updated ${names([...edited.values()].map((i) => i.food_name))}.` : null,
    removes.size ? `Took off ${names(plan.removes.map((i) => card[i].food_name))}.` : null,
    added.length ? `Added ${names(added.map((i) => i.food_name))}.` : null,
    failedEdits.length ? `I could not change ${names(failedEdits)}, so ${failedEdits.length === 1 ? "it is" : "they are"} as before.` : null,
    failedAdds.length ? `I could not work out ${names(failedAdds.map((t) => `"${t.slice(0, 60)}"`))}.` : null,
    ...failedRecipes.map((f) =>
      // A rebuild of a card line that failed leaves that line as it was.
      // A lookup that failed is not a food that does not exist: said apart.
      `I could not ${recipeMissText(f.missing, f.errored)}, so ${f.name} ${f.onLine ? "is as before" : "is not on the card"}.`
    ),
    missingParts.length ? `I could not find ${missingParts.join("; ")}, so it is left out.` : null,
    dupAdds.length ? `${names(dupAdds)} ${dupAdds.length === 1 ? "is" : "are"} already on the card, so I did not add ${dupAdds.length === 1 ? "it" : "them"} again.` : null,
    overflow.length ? `The card holds ${CARD_MAX_LINES} foods, so I left off ${names(overflow)}. Add this card first, then send ${overflow.length === 1 ? "it" : "them"}.` : null,
  ].filter(Boolean).join(" ");
  // The agent's words: its reply, else its one summary. Several summaries
  // joined read as a run-on, so then code writes the line from what changed.
  const agentText = replyText || (plan.summaries.length === 1 ? clean(plan.summaries[0]) : "");
  const falseClaim = !!agentText && falseAgentClaim(agentText, { cardChanged: changed });
  // A failed edit or addition: code writes the line, since the agent's words
  // may describe a change that did not happen. A food left off as a copy or
  // for room is only a notice: it goes after the agent's own words, so a
  // reply that answers a question is kept.
  // Words that name a food the code left off (a duplicate, or no room) would
  // tell the user it was added: then code writes the line too.
  const leftKeys = [...dupAdds, ...overflow].map((n) => sameFoodKey(n)).filter(Boolean);
  const said = sameFoodKey(agentText);
  const namesLeftOff = leftKeys.some((k) => ` ${said} `.includes(` ${k} `));
  const useAgent = !!agentText && !falseClaim && !failedEdits.length && !failedAdds.length && !failedRecipes.length &&
    !missingParts.length && !namesLeftOff;
  const notice = [
    dupAdds.length ? `${names(dupAdds)} ${dupAdds.length === 1 ? "is" : "are"} already on the card, so I did not add ${dupAdds.length === 1 ? "it" : "them"} again.` : null,
    overflow.length ? `The card holds ${CARD_MAX_LINES} foods, so I left off ${names(overflow)}. Add this card first, then send ${overflow.length === 1 ? "it" : "them"}.` : null,
  ].filter(Boolean).join(" ");
  const line = (useAgent ? [agentText, notice, question] : [codeLine, question]).filter(Boolean).join(" ");
  const answered = !!replyText && useAgent;
  deps.onEvent?.({
    tool: "card_changes", ok: true, edits: edited.size, edits_failed: failedEdits.length, removed: removes.size,
    added: added.length, error: null, ...(falseClaim ? { false_claim: true } : {}),
    ...(recipesOut.length ? { recipes: builtDishes.length } : {}),
  });

  // Nothing could be done: the card stays as it was, and the user is told why.
  if (!changed) return { kind: "reply", text: line || "I could not change the card, so it is as it was.", turns };

  const usage = EMPTY_USAGE();
  const steps: ParseStep[] = [];
  let tier: ParseMealResult["tier"];
  for (const r of [...editsOut.map((x) => x.r), ...addsOut.map((x) => x.r), ...recipesOut.flatMap((x) => x.results)]) {
    if (!r) continue;
    addUsage(usage, r.usage);
    steps.push(...(r.steps ?? []));
    tier ??= r.tier;
  }
  const toolCalls = ["food_agent", ...new Set([
    ...(plan.edits.length ? ["edit_line"] : []), ...(plan.removes.length ? ["remove_lines"] : []), ...(plan.adds.length ? ["add_lines"] : []),
    ...(plan.recipes?.length ? ["build_recipe"] : []),
  ])];
  if (items.length === 0) {
    // Every line came off and nothing was added: the card is cleared, the way
    // the X on its last line clears it (an empty meal is an error to the app).
    return {
      kind: "log",
      result: {
        parsed: null, declined: { message: line || "Taken off. Nothing left on this one.", cleared: true },
        usage, tool_calls: toolCalls, steps, iterations: turns.length, tier,
      },
      turns,
      ...(answered ? { answered: true } : {}),
    };
  }
  return {
    kind: "log",
    result: {
      // The whole card, replacing the one on screen.
      // With no card on screen (a first message that built a dish) this is a
      // new card, not a replacement.
      parsed: { meal_type: meal, items, drona_line: line || "Here is the card.", corrects_previous: card.length > 0 },
      declined: null,
      usage,
      tool_calls: toolCalls,
      steps,
      iterations: turns.length,
      tier,
    },
    turns,
    ...(answered ? { answered: true } : {}),
  };
}

/** The parts a dish could not use: those not found, and those whose lookup
 *  failed (a timeout is not a food that does not exist). */
function recipeMissText(missing: string[], errored: string[]): string {
  const notFound = missing.filter((m) => !errored.includes(m));
  const parts = [
    notFound.length ? `find ${names(notFound)}` : null,
    errored.length ? `look up ${names(errored)} just now` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", and could not ") : "find its parts";
}

/** What the user is told when a later-message line claimed a log or a save
 *  that did not happen. */
function honestLine(cardOnScreen: boolean): string {
  return cardOnScreen
    ? "Nothing is in your diary yet: the card is on screen, and its Add button puts it in."
    : "Nothing is in your diary yet. Tell me what you had and I will put it on a card.";
}

/**
 * A later-message finish other than a card change, checked: a reply that rode
 * along with a log becomes its line, and a line that claims a log or a save
 * (or a change that did not happen) is replaced by one code writes.
 */
export function checkedLater(out: FoodAgentOutcome, input: Pick<FoodAgentInput, "card">, replyText: string): FoodAgentOutcome {
  const cardOnScreen = !!input.card?.length;
  if (out.kind === "reply") {
    return falseAgentClaim(out.text, { cardChanged: false }) ? { ...out, text: honestLine(cardOnScreen) } : out;
  }
  if (out.kind === "create") {
    const s = typeof out.create.input.summary === "string" ? out.create.input.summary : "";
    if (!s || !falseAgentClaim(s, { cardChanged: false })) return out;
    const name = typeof out.create.input.name === "string" ? out.create.input.name : "this";
    return { ...out, create: { ...out.create, input: { ...out.create.input, summary: `${name}. Want it in My Meals?` } } };
  }
  if (out.kind !== "log") return out;
  const p = out.result.parsed;
  if (!p) return out;
  const replyOk = !!replyText && !falseAgentClaim(replyText, { cardChanged: true });
  const own = p.drona_line && !falseAgentClaim(p.drona_line, { cardChanged: true }) ? p.drona_line : `${names(p.items.map((i) => i.food_name))}, ready to add.`;
  return {
    ...out,
    result: { ...out.result, parsed: { ...p, drona_line: replyOk ? replyText : own } },
    ...(replyOk ? { answered: true } : {}),
  };
}

// ── copy_lines ──────────────────────────────────────────────────────────────

type CopyStatus = "copied" | "already_on_card" | "not_found";

export interface CopyRun {
  kind: "thread" | "diary" | "unknown";
  /** "C1 v2" or "diary 2026-11-05 lunch", for the agent. */
  label: string;
  results: { line: string; name: string | null; status: CopyStatus }[];
  /** The copied lines, numbers and source as stored. */
  items: ParsedItem[];
  error: string | null;
}

/** One line of a source, with how to make it a card line. */
interface SourceLine {
  id: string | null;
  name: string;
  food_id: string | null;
  item: (meal: MealType) => ParsedItem;
}

/** A food name for "same food": lowercase words, bracketed detail dropped
 *  ("Paneer sabji (60 g paneer, oil)" is paneer sabji). */
function sameFoodKey(name: string): string {
  const words = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return words(name.replace(/\([^)]*\)/g, " ")) || words(name);
}

/** The lines asked for, in order: a line id (L2) first, then the exact name,
 *  then the name without its brackets. Each source line is picked once. An
 *  empty ask is every line. */
export function pickLines(source: { id: string | null; name: string }[], asked: string[]): { line: string; index: number | null }[] {
  if (asked.length === 0) return source.map((l, i) => ({ line: l.id ?? l.name, index: i }));
  const used = new Set<number>();
  const words = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const find = (test: (l: { id: string | null; name: string }) => boolean) => {
    const i = source.findIndex((l, j) => !used.has(j) && test(l));
    return i >= 0 ? i : null;
  };
  const out: { line: string; index: number | null }[] = [];
  for (const raw of asked) {
    const a = raw.trim();
    if (!a) continue;
    // The same line named twice ("L2", "L2") is one line.
    const dup = out.find((o) => o.index !== null && words(o.line) === words(a));
    if (dup) continue;
    const i = find((l) => !!l.id && l.id.toUpperCase() === a.toUpperCase()) ??
      find((l) => words(l.name) === words(a)) ??
      find((l) => sameFoodKey(l.name) === sameFoodKey(a));
    if (i !== null) used.add(i);
    out.push({ line: a, index: i });
  }
  return out;
}

function threadSourceLine(l: ThreadLine): SourceLine {
  return { id: l.line_id, name: l.name, food_id: l.source_ref ?? null, item: (meal) => ({ ...lineAsItem(l, meal), meal_type: meal }) };
}

/** A diary line (loggedMeals.ts, full) as a card line: every number and the
 *  source as the diary holds them. A diary line with no source was logged by
 *  hand (meal_entries.source is null for the manual picker): "manual".
 *  A source we do not know is never relabelled "manual" (the user's own
 *  number): it is "estimate", with a note naming what the diary said, so the
 *  card asks for a look. Not kept raw: meal_entries_source_check (0114)
 *  allows only the six known values, so an auto-log of a raw unknown value
 *  would fail, and the app reads any other value as "estimate" anyway
 *  (lib/dietData.ts). A line with no grams stays at 0 = no weight known: the
 *  app and the auto-log both write that as grams_logged null (0069). */
export function diarySourceLine(r: Record<string, unknown>): SourceLine | null {
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const kcal = typeof r.kcal === "number" && Number.isFinite(r.kcal) ? r.kcal : null;
  if (!name || kcal === null) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const src = r.source;
  // "recipe": a dish built from its parts (recipe.ts). It keeps that source
  // and its parts, so a copied dish is still explained and can be rebuilt.
  const known = src === "catalog" || src === "off" || src === "fatsecret" || src === "web" || src === "estimate" || src === "manual" ||
    src === "recipe";
  const recipe = src === "recipe" ? parseRecipe(r.recipe) : null;
  const unknownSource = src !== null && src !== undefined && !known;
  const source: ParsedItem["source"] = known ? src : unknownSource ? "estimate" : "manual";
  const food_id = typeof r.food_id === "string" ? r.food_id : null;
  return {
    id: null,
    name,
    food_id,
    item: (meal) => ({
      food_id,
      food_name: name,
      quantity: n(r.quantity) ?? 1,
      serving_label: typeof r.serving_unit === "string" && r.serving_unit ? r.serving_unit : "serving",
      grams: n(r.grams) ?? 0,
      kcal: Math.round(kcal),
      protein_g: n(r.protein_g) ?? 0,
      carb_g: n(r.carb_g) ?? 0,
      fat_g: n(r.fat_g) ?? 0,
      fiber_g: n(r.fiber_g),
      source,
      // A copy keeps the origin the diary line had; "manual" alone is not
      // the user's own numbers.
      origin: originOf({ origin: r.origin, source: unknownSource ? "estimate" : src, food_id }),
      copied_from: "diary" as const,
      assumption: unknownSource ? `Copied from your diary, where its source reads "${String(src).slice(0, 40)}". Check this one.` : null,
      confidence: unknownSource ? "medium" : "high",
      meal_type: meal,
      ...(recipe ? { recipe } : {}),
    }),
  };
}

/** The foods on the card for the duplicate check, by food key and catalog id.
 *  Every line a copy takes joins it, so a second copy_lines in the same turn
 *  (or a later turn of the run) is caught as already_on_card. The lines of one
 *  source in one call are copied together. */
export interface OnCard {
  keys: Set<string>;
  ids: Set<string>;
}

export function onCardOf(card: CardLine[]): OnCard {
  return {
    keys: new Set(card.map((l) => sameFoodKey(l.food_name))),
    ids: new Set(card.map((l) => l.food_id).filter((x): x is string => !!x)),
  };
}

/** A copy's source, read: its lines, or why there are none. */
export interface CopySource {
  kind: CopyRun["kind"];
  label: string;
  lines: SourceLine[];
  error: string | null;
}

/** Read one copy_lines call's source. Never throws: a bad source is an error. */
export async function loadCopySource(
  args: Record<string, unknown>,
  deps: Pick<FoodAgentDeps, "threadCard" | "readDiaryLines" | "threadOnScreenRef">,
): Promise<CopySource> {
  const src = (args.source && typeof args.source === "object" ? args.source : {}) as Record<string, unknown>;
  const asked = Array.isArray(args.lines) ? args.lines.filter((x): x is string => typeof x === "string") : [];
  const fail = (kind: CopyRun["kind"], error: string): CopySource => ({ kind, label: "", lines: [], error });
  let kind: CopyRun["kind"] = "unknown";
  try {
    if (typeof src.card === "string" && src.card.trim()) {
      kind = "thread";
      const ref = src.card.trim().toUpperCase();
      const version = Number.isInteger(src.version) && (src.version as number) >= 1 ? src.version as number : null;
      if (deps.threadOnScreenRef && ref === deps.threadOnScreenRef) {
        return fail(kind, `${ref} is the card on screen now, so there is nothing to copy onto it. Copy from an earlier card, or change this one.`);
      }
      if (!deps.threadCard) return fail(kind, "There are no earlier cards in this conversation to copy from.");
      const got = await deps.threadCard(ref, version);
      if (!got) return fail(kind, `No card ${ref}${version ? ` version ${version}` : ""} in this conversation.`);
      return { kind, label: `${got.ref} v${got.version}`, lines: got.lines.map(threadSourceLine), error: null };
    }
    if (typeof src.days_ago === "number" || typeof src.date === "string") {
      kind = "diary";
      if (!deps.readDiaryLines) return fail(kind, "The diary cannot be copied from here.");
      const meal = isMeal(src.meal_type) ? src.meal_type : null;
      if (!meal && asked.length === 0) return fail(kind, "Say which meal (source.meal_type), or name the lines.");
      const q: Record<string, unknown> = { ...(typeof src.date === "string" ? { date: src.date } : { days_ago: src.days_ago }), ...(meal ? { meal_type: meal } : {}) };
      const day = await deps.readDiaryLines(q) as { error?: string; date?: string; meals?: { items?: Record<string, unknown>[] }[] };
      if (!day || day.error) return fail(kind, day?.error ?? "The diary read failed.");
      const label = `diary ${day.date ?? ""} ${meal ?? ""}`.replace(/\s+/g, " ").trim();
      const lines = (day.meals ?? []).flatMap((m) => m.items ?? []).map(diarySourceLine).filter((l): l is SourceLine => !!l);
      if (lines.length === 0) return fail(kind, `Nothing is logged for ${label.replace(/^diary /, "")}.`);
      return { kind, label, lines, error: null };
    }
    return fail(kind, "source needs a card ref (card), or a diary day (days_ago or date) with meal_type.");
  } catch (e) {
    return fail(kind, `The read failed: ${String(e).slice(0, 120)}`);
  }
}

/** Sort one call's lines into copied / already_on_card / not_found, against
 *  the on-card set (the card, lines staged earlier in the run, and other
 *  copies earlier in this turn), then add this call's copied lines to it.
 *  Synchronous, and run in call order, so the result does not depend on
 *  which source read came back first. */
export function classifyCopy(source: CopySource, args: Record<string, unknown>, input: FoodAgentInput, onCard: OnCard): CopyRun {
  if (source.error) return { kind: source.kind, label: source.label, results: [], items: [], error: source.error };
  const asked = Array.isArray(args.lines) ? args.lines.filter((x): x is string => typeof x === "string") : [];
  // Where the copies go: the user's word, the card's meal, the hour's meal.
  const meal: MealType = isMeal(args.meal_type) ? args.meal_type : input.card?.[0]?.meal_type ?? input.defaultMeal;
  const again = args.add_again === true;
  const results: CopyRun["results"] = [];
  const items: ParsedItem[] = [];
  const took: SourceLine[] = [];
  for (const p of pickLines(source.lines, asked)) {
    if (p.index === null) {
      results.push({ line: p.line, name: null, status: "not_found" });
      continue;
    }
    const l = source.lines[p.index];
    const key = sameFoodKey(l.name);
    const there = onCard.keys.has(key) || (!!l.food_id && onCard.ids.has(l.food_id));
    if (there && !again) {
      results.push({ line: p.line, name: l.name, status: "already_on_card" });
      continue;
    }
    results.push({ line: p.line, name: l.name, status: "copied" });
    items.push(l.item(meal));
    took.push(l);
  }
  // Added only now: the lines of ONE source are copied together (a meal with
  // two roti rows keeps both), while a later copy in the turn sees them.
  for (const l of took) {
    onCard.keys.add(sameFoodKey(l.name));
    if (l.food_id) onCard.ids.add(l.food_id);
  }
  return { kind: source.kind, label: source.label, results, items, error: null };
}

/** One copy_lines call on its own (the card as it is). */
export async function runCopy(
  args: Record<string, unknown>,
  input: FoodAgentInput,
  deps: Pick<FoodAgentDeps, "threadCard" | "readDiaryLines" | "threadOnScreenRef">,
  onCard: OnCard = onCardOf(input.card ?? []),
): Promise<CopyRun> {
  return classifyCopy(await loadCopySource(args, deps), args, input, onCard);
}

function copyEvent(r: CopyRun, finished: boolean): AgentEvent {
  const count = (s: CopyStatus) => r.results.filter((x) => x.status === s).length;
  return {
    tool: "copy_lines",
    source_kind: r.kind,
    asked: r.results.length,
    copied: count("copied"),
    already_on_card: count("already_on_card"),
    not_found: count("not_found"),
    finished,
    error: r.error,
  };
}

/** What a copy says to the agent when the run goes on. `landed`: its lines
 *  are on the card now (they go in with the agent's finish). */
function copyResultForAgent(r: CopyRun, landed = false): unknown {
  if (r.error) return { error: r.error };
  if (landed) {
    return {
      source: r.label,
      results: r.results.map((x) => ({ line: x.line, ...(x.name ? { food_name: x.name } : {}), status: x.status })),
      note: "These lines are on the card now and go in with your finish. Do not copy them again.",
    };
  }
  return {
    source: r.label,
    // "copied" here only means it could be: nothing from this turn was added.
    results: r.results.map((x) => ({ line: x.line, ...(x.name ? { food_name: x.name } : {}), status: x.status === "copied" ? "would_copy" : x.status })),
    note: "Nothing was added. Call copy_lines again with only the lines to add (add_again true for a food the user " +
      "chose to add a second portion of), or reply.",
  };
}

const names = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** Lines copy_lines took, waiting for the run's finish, and the names of the
 *  lines that did not copy when the agent will not see why. */
interface Staged {
  items: ParsedItem[];
  dup: string[];
  miss: string[];
}

/** Stage what these copies took, and add it to the run's on-card set. */
function stage(staged: Staged, runs: CopyRun[], onCard: OnCard, o: { nameTheRest: boolean }): void {
  for (const r of runs) {
    for (const i of r.items) {
      staged.items.push(i);
      onCard.keys.add(sameFoodKey(i.food_name));
      if (i.food_id) onCard.ids.add(i.food_id);
    }
    if (!o.nameTheRest) continue;
    staged.dup.push(...r.results.filter((x) => x.status === "already_on_card").map((x) => x.name ?? x.line));
    staged.miss.push(...r.results.filter((x) => x.status === "not_found").map((x) => x.line));
  }
}

/** The line the user reads about the staged lines, built HERE from the lines
 *  really copied, never from the model's own words, so the card can never
 *  claim a line that was not added. `beside`: other new lines come with them. */
function stagedLine(staged: Staged, input: FoodAgentInput, beside: boolean): string {
  const what = names(staged.items.map((i) => i.food_name));
  const lead = !staged.items.length ? null
    : beside ? `Also put ${what} on the card.`
    : input.card?.length ? `Put ${what} on the card.`
    : `${what}, ready to add.`;
  return [
    lead,
    staged.dup.length ? `${names(staged.dup)} ${staged.dup.length === 1 ? "is" : "are"} already on the card: add a second portion, or skip?` : null,
    staged.miss.length ? `I could not find ${names(staged.miss)} there.` : null,
  ].filter(Boolean).join(" ");
}

const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };

/**
 * The run's outcome with its staged copies in it. Lines a copy took are never
 * dropped, whatever the run ended in:
 *  - a meal (log_food, edit_card, remove_card_lines, restore): they join its
 *    lines (after an edit or a removal the result replaces the card, so the
 *    copies ride on top of it);
 *  - the card cleared, a reply, a save card, or a failure: they are the card,
 *    and the reply (or the cleared line) is said beside them. A save card
 *    cannot carry them, so the user is told to ask for the save again.
 */
export function withStaged(out: FoodAgentOutcome, staged: Staged, input: FoodAgentInput): FoodAgentOutcome {
  if (!staged.items.length && !staged.dup.length && !staged.miss.length) return out;
  const turns = out.turns;
  // The card holds CARD_MAX_LINES lines (the app sends back no more, so a line
  // past them is lost on the next correction). `base` is what the card holds
  // before the copies: copies that do not fit are left off and named.
  const fit = (base: number): { items: ParsedItem[]; note: string | null } => {
    const room = Math.max(0, CARD_MAX_LINES - base);
    if (staged.items.length <= room) return { items: staged.items, note: null };
    const left = staged.items.slice(room).map((i) => i.food_name);
    return {
      items: staged.items.slice(0, room),
      note: `The card holds ${CARD_MAX_LINES} foods, so I left off ${names(left)}. Add this card first, then send ${left.length === 1 ? "it" : "them"}.`,
    };
  };
  const asCard = (extra: (string | null)[], corrects: boolean, tools: string[]): FoodAgentOutcome => {
    // The copies alone replace the card, or sit beside the card on screen.
    const f = fit(corrects ? 0 : input.card?.length ?? 0);
    // None fit (the card on screen is full): the card stays as it is, and the
    // user is told plainly. Never a meal card with no lines.
    if (!f.items.length) {
      return { kind: "reply", text: [f.note, ...extra].filter((x) => x && x.trim()).join(" "), turns };
    }
    return {
      kind: "log",
      result: {
        parsed: {
          meal_type: staged.items[0]?.meal_type ?? input.card?.[0]?.meal_type ?? input.defaultMeal,
          items: f.items,
          drona_line: [stagedLine({ ...staged, items: f.items }, input, false), f.note, ...extra].filter((x) => x && x.trim()).join(" "),
          corrects_previous: corrects,
        },
        declined: null,
        usage: NO_USAGE,
        tool_calls: ["food_agent", ...tools, "copy_lines"],
        steps: [],
        iterations: turns.length,
      },
      turns,
    };
  };
  if (out.kind === "log" && out.result.parsed) {
    const p = out.result.parsed;
    // A result that replaces the card is the whole card; one that is added
    // beside it sits on top of the card on screen.
    const f = fit(p.corrects_previous ? p.items.length : (input.card?.length ?? 0) + p.items.length);
    return {
      ...out,
      result: {
        ...out.result,
        parsed: {
          ...p,
          items: [...p.items, ...f.items],
          drona_line: [p.drona_line, stagedLine({ ...staged, items: f.items }, input, p.items.length > 0), f.note].filter((x) => x && x.trim()).join(" "),
        },
        tool_calls: out.result.tool_calls.includes("copy_lines") ? out.result.tool_calls : [...out.result.tool_calls, "copy_lines"],
      },
    };
  }
  if (!staged.items.length) return out;
  // Every line of the card was taken off: the card is the copies alone.
  if (out.kind === "log") return asCard([out.result.declined?.message ?? null], true, out.result.tool_calls.filter((t) => t !== "food_agent"));
  if (out.kind === "reply") return asCard([out.text], false, ["reply"]);
  if (out.kind === "create") return asCard(["Ask me to save it again once this is on the card."], false, []);
  return asCard([], false, []);
}

/** A name for matching a save line to a card line: lowercase, words only,
 *  bracketed text dropped ("Paneer sabji (60 g paneer, oil)" is paneer sabji). */
function lineKey(name: string): string {
  const words = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return words(name.replace(/\([^)]*\)/g, " ")) || words(name);
}

/** The card line a save line is a copy of: the same calories (to the kcal)
 *  and the same food by name, one name the start of the other. Null when no
 *  line fits, or when two do. Loose on purpose ("Rice" fits "Rice (cooked)"):
 *  the kcal match and the one-hit rule are what keep it on the right line,
 *  and a miss only leaves the model's own figures. */
export function cardLineFor(name: unknown, kcal: unknown, card: CardLine[]): CardLine | null {
  const k = num(kcal);
  if (typeof name !== "string" || k === null) return null;
  const key = lineKey(name);
  if (key.length < 3) return null;
  const hits = card.filter((l) => {
    if (Math.abs(Math.round(l.kcal) - Math.round(k)) > 1) return false;
    const lk = lineKey(l.food_name);
    return lk === key || lk.startsWith(`${key} `) || key.startsWith(`${lk} `);
  });
  return hits.length === 1 ? hits[0] : null;
}

const MACROS = ["protein_g", "carb_g", "fat_g"] as const;

/**
 * Copy the card's macros onto a save drafted from card lines. The model reads
 * the card as names and calories, and the create tools leave macros optional,
 * so a save from the card could carry the calories alone. Code copies them
 * instead, the same way it copies them for save_card_as_meal. A line the card
 * itself only estimated stays marked as estimated.
 */
export function fillFromCard(tool: string, input: Record<string, unknown>, card: CardLine[]): Record<string, unknown> {
  if (!card.length) return input;
  const guessed = (l: CardLine) => l.source === "estimate" || l.source === "web";
  if (tool === CREATE_CUSTOM_FOOD_TOOL.name) {
    const line = cardLineFor(input.name, input.kcal, card);
    if (!line) return input;
    const out: Record<string, unknown> = { ...input };
    // Only the macros the card line HAS. A line with none for a field leaves
    // the model's own figure (and its estimate mark) alone, never a 0 g.
    const copied = MACROS.filter((m) => typeof line[m] === "number");
    for (const m of copied) out[m] = line[m];
    // The line matched on kcal too, so kcal is the card's figure, not a guess:
    // the same rule the meal branch applies to a whole line.
    const est = Array.isArray(input.estimated) ? input.estimated.filter((f) => f !== "kcal" && !(copied as readonly unknown[]).includes(f)) : [];
    out.estimated = guessed(line) ? [...new Set([...est, "kcal", ...copied])] : est;
    return out;
  }
  if (!Array.isArray(input.items)) return input;
  const items = input.items.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const o = { ...(raw as Record<string, unknown>) };
    const line = cardLineFor(o.name ?? o.food_name, o.kcal, card);
    if (!line) return o;
    const copied = MACROS.filter((m) => typeof line[m] === "number");
    for (const m of copied) o[m] = line[m];
    // The card line decides, the same rule as the food branch: a copy of a
    // catalog line is not the model's guess. A meal line has ONE `estimated`
    // flag (a food has a list of fields), so it is dropped only when the card
    // gave every macro; a figure still from the model keeps the line marked.
    if (guessed(line)) o.estimated = true;
    else if (copied.length === MACROS.length) delete o.estimated;
    return o;
  });
  return { ...input, items };
}

/** A card line back as a parsed item, exactly as it was: numbers, section,
 *  confidence and note all carried, nothing re-stamped. The user's working copy. */
function cardLineAsItem(l: CardLine, mealDefault: MealType): ParsedItem {
  const recipe = parseRecipe(l.recipe);
  return {
    food_id: l.food_id ?? null,
    food_name: l.food_name,
    quantity: l.quantity,
    serving_label: l.serving_label,
    grams: l.grams,
    kcal: Math.round(l.kcal),
    protein_g: l.protein_g ?? 0,
    carb_g: l.carb_g ?? 0,
    fat_g: l.fat_g ?? 0,
    fiber_g: l.fiber_g ?? null,
    source: l.source ?? "manual",
    assumption: l.assumption ?? null,
    confidence: l.confidence ?? "medium",
    meal_type: l.meal_type ?? mealDefault,
    ...(l.said_name ? { said_name: l.said_name } : {}),
    ...(l.source_site ? { source_site: l.source_site } : {}),
    origin: originOf(l),
    ...(l.copied_from ? { copied_from: l.copied_from } : {}),
    ...(recipe ? { recipe } : {}),
  };
}

function copiedLine(raw: unknown, mealDefault: MealType, seen: Seen): ParsedItem[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const rawName = typeof o.food_name === "string" ? o.food_name : typeof o.name === "string" ? o.name : "";
  const name = rawName.trim().slice(0, 120);
  const kcal = num(o.kcal);
  if (!name || kcal === null) return [];
  // Only a line the reads returned with these exact calories is the user's own
  // number. A changed one ("half the rice") is the agent's arithmetic, and one
  // the reads never showed is a guess: both go on the card as something to check.
  const from = provenance(seen, name, kcal);
  const was = seen.get(foodKey(name));
  // One message can fill two sections: the line's own meal wins over the
  // message-level one ("the same meal in breakfast and snacks").
  const meal: MealType = isMeal(o.meal_type) ? o.meal_type : mealDefault;
  return [{
    food_id: null,
    food_name: name,
    quantity: num(o.quantity) ?? 1,
    serving_label: typeof o.serving_label === "string" && o.serving_label.trim() ? o.serving_label.trim() : "serving",
    grams: num(o.grams) ?? 0,
    kcal: Math.round(kcal),
    protein_g: num(o.protein_g) ?? 0,
    carb_g: num(o.carb_g) ?? 0,
    fat_g: num(o.fat_g) ?? 0,
    fiber_g: null,
    ...(from === "copied"
      ? {
        source: "manual" as const, assumption: null, confidence: "high" as const,
        // The diary line's own origin, not the user's: a copy keeps it.
        origin: seenOrigin(seen, name, kcal), copied_from: "diary" as const,
      }
      : from === "changed"
      ? {
        source: "manual" as const,
        // The agent's arithmetic on a logged line: a guess until checked.
        origin: "guess" as const, copied_from: "diary" as const,
        // The same food can appear on two days with different numbers: cite
        // the one closest to the new value, the likeliest one it came from.
        assumption: `Adjusted from ${[...was!].sort((a, b) => Math.abs(a - kcal) - Math.abs(b - kcal))[0]} kcal in your log.`,
        confidence: "medium" as const,
      }
      : { source: "estimate" as const, assumption: "Not found in your logs, so check this one.", confidence: "low" as const }),
    meal_type: meal,
  }];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function isMeal(v: unknown): v is MealType {
  return v === "breakfast" || v === "lunch" || v === "dinner" || v === "snack";
}

function clean(s: string): string {
  return s.trim().replace(/\s*—\s*/g, ", ").slice(0, 600);
}
