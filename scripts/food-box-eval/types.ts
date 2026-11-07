// Food box eval: the shapes every case, adapter and grader share.
//
// A case is one message typed into the Nutrition food box (Precise mode), with
// the conversation and the card as they stood when it was sent. The grader
// checks the OUTCOME (the card after, the reply, what was done), never how the
// pipeline got there, so the same case scores today's food bar and the planned
// agent (.planning/precise-food-logger-plan.md) by the same rules.

export type Role = "user" | "drona";

/** One line on a card. Numbers are line totals, not per-100. */
export interface Line {
  name: string;
  quantity?: number;
  unit?: string;
  grams?: number | null;
  kcal: number;
  protein_g?: number;
  carb_g?: number;
  fat_g?: number;
  /** user | label | web | catalog | memory | recipe | estimate | manual (today's catch-all) */
  source?: string;
  meal?: "breakfast" | "lunch" | "dinner" | "snack";
  /** The line's note (ParsedItem.assumption): a recipe line lists its parts. */
  note?: string;
}

/** What the food box did with a message.
 *  log      a new meal card (or new lines) from food named in the message
 *  edit     changed the card that was open
 *  save     saved a meal or food (a save the USER confirmed counts)
 *  answer   replied in words to a question or complaint
 *  restore  brought back an earlier card
 *  look_up  checked a label on the web
 *  ask      asked the user a question back */
export type Action = "log" | "edit" | "save" | "answer" | "restore" | "look_up" | "ask";

/** The actions that change what is on the card. One list, so the grader and
 *  every adapter agree on it: a new card-changing action goes here. */
export const CARD_ACTIONS: readonly Action[] = ["log", "edit", "restore"];

export interface SavedMeal {
  name: string;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
}

/** What an adapter returns for one case. */
export interface Outcome {
  /** The meal card after the message. null = no card on screen. */
  card: Line[] | null;
  /** The sentence shown to the user, if any. */
  reply: string | null;
  actions: Action[];
  savedMeal?: SavedMeal | null;
  /** Live adapter only: what answering this message cost. */
  metrics?: CaseMetrics;
}

/** One message's model calls, counted by the live adapter. */
export interface CaseMetrics {
  /** agent: a later message (FOOD_AGENT_LATER). router_agent: the router
   *  sent it to the agent. parse: the parse answered. */
  route: "agent" | "router_agent" | "parse";
  /** Model turns the food agent used (0 when it did not run). */
  agentTurns: number;
  /** Every model call: router fallback, parses, the agent. Jev not counted. */
  calls: number;
  /** At the model_pricing rows. Through the CLI the token counts are the CLI's. */
  costUsd: number;
  byModel: Record<string, { calls: number; input: number; output: number; cache_read: number; cache_write: number }>;
  /** FOOD_FIRST_GATE=on, first messages: Jev's plain score, where the gate
   *  sent it, and how often the agent took the running parse. */
  gate?: { plain: number | null; to: "parse" | "agent"; parseReused: number };
}

export interface MemoryFood {
  name: string;
  aliases?: string[];
  /** per 100 g */
  per100: { kcal: number; protein_g: number; carb_g: number; fat_g: number };
  source: string;
  lastLogged: string;
  times?: number;
}

export interface DiaryMeal {
  /** 0 = today, 1 = yesterday */
  daysAgo: number;
  meal: "breakfast" | "lunch" | "dinner" | "snack";
  lines: Line[];
}

export interface FoodBoxCase {
  id: string;
  /** Failure class or feature: save, restore, correction, question, choose, copy-day, stated, lookup, pack-size, recipe, region, plain */
  tags: string[];
  /** Where it came from. Owner messages are kept word for word; other users'
   *  messages are reworded and carry no account id. */
  origin: { date: string; who: "owner" | "user" | "synthetic"; note?: string };
  /** The user's region, from their time zone. */
  region?: "india" | "us" | "uk" | null;
  today?: string;
  thread: {
    turns: { role: Role; text: string }[];
    card: Line[] | null;
    /** A question Drona asked that is still open, with the choices it gave. */
    openQuestion?: { question: string; options?: string[] } | null;
    /** Cards from earlier in this thread that are not on screen any more. */
    earlierCards?: { label: string; lines: Line[] }[];
  };
  fixtures?: {
    savedMeals?: (SavedMeal & { items?: Line[] })[];
    memory?: MemoryFood[];
    diary?: DiaryMeal[];
  };
  message: string;
  expect: Expect;
  /** First messages only: the FOOD_FIRST_GATE's right answer, true for a fully
   *  plain food log that asks for nothing else. Read by the gate report, never
   *  by the grader. */
  plain?: boolean;
  /** What today's food box actually served (from parse_traces). Absent for
   *  synthetic cases and for messages with no recording. */
  recorded?: Outcome;
}

/** A closed range. Either end may be null for "no bound". */
export type Range = [number | null, number | null];

export interface LineSpec {
  /** Case-insensitive regex source matched against the line name. */
  match: string;
  kcal?: Range;
  grams?: Range;
  protein_g?: Range;
  /** The line's source must be one of these. */
  source?: string[];
  meal?: Line["meal"];
}

export interface Expect {
  /** Every one of these must be in Outcome.actions. */
  does?: Action[];
  /** None of these may be in Outcome.actions. */
  mustNot?: Action[];
  /** Lines (regex) that must still be on the card. */
  keepLines?: string[];
  /** Lines (regex) that must be gone. */
  removeLines?: string[];
  lines?: LineSpec[];
  /** No two lines with the same name, and no LineSpec matched twice. */
  noDuplicates?: boolean;
  lineCount?: Range;
  totalKcal?: Range;
  /** The card must be exactly what it was before (an answer that edits nothing). */
  cardUnchanged?: boolean;
  reply?: {
    /** Regex sources that must each appear. */
    mustMention?: string[];
    /** Regex sources that must not appear. */
    mustNotSay?: string[];
    /** No "I logged / saved / I'm logging" unless a log, edit or save happened. */
    noFalseClaim?: boolean;
  };
  savedMeal?: { kcal?: Range; proteinMin?: number; nameMatch?: string };
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface Grade {
  id: string;
  pass: boolean;
  checks: CheckResult[];
}
