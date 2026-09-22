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

import {
  type AnthropicTool,
  CREATE_CUSTOM_FOOD_TOOL,
  CREATE_CUSTOM_MEAL_TOOL,
  LIST_LOGGED_MEALS_TOOL,
  LIST_SAVED_MEALS_TOOL,
} from "./prompt.ts";
import type { MealType, ParsedItem, ParseMealResult, ParseStep } from "./parseMeal.ts";
import type { SavedMealForParse } from "./savedMeals.ts";

export const MAX_TURNS = 5;

type CallResult = { ok: true; data: any } | { ok: false; status: number; body: string };

export interface FoodAgentDeps {
  model: string;
  callModel(body: Record<string, unknown>): Promise<CallResult>;
  readDiary(input: Record<string, unknown>): Promise<unknown>;
  savedMeals(): Promise<SavedMealForParse[]>;
  /** The normal meal parser, in the user's mode. */
  parseFood(text: string): Promise<ParseMealResult>;
  /** A line for the user while the agent works. Never awaited. */
  onStatus?(label: string): void;
  log?(msg: string): void;
}

export interface FoodAgentInput {
  text: string;
  /** The meal a log lands in when nothing else says: hint, else the clock. */
  defaultMeal: MealType;
  /** The user's own today, e.g. "Tuesday 2026-09-22", so "Monday's lunch" can
   *  become a days_ago. Absent when the client sent no local date. */
  today?: string | null;
}

export interface AgentTurn {
  turn: number;
  ms: number;
  tools: { name: string; input: unknown }[];
  input_tokens: number | null;
  output_tokens: number | null;
}

export type FoodAgentOutcome =
  | { kind: "log"; result: ParseMealResult; turns: AgentTurn[] }
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
    "parse you already did for the same text), and/or `items` to copy lines exactly as they are from the diary " +
    "or a saved meal. Logs to today only.",
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

const READ_TOOLS = new Set([LIST_LOGGED_MEALS_TOOL.name, LIST_SAVED_MEALS_TOOL.name, PARSE_FOOD_TOOL.name]);
const FINISH_TOOLS = new Set([CREATE_CUSTOM_FOOD_TOOL.name, CREATE_CUSTOM_MEAL_TOOL.name, LOG_FOOD_TOOL.name, REPLY_TOOL.name]);

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
  "A card's summary is an offer the user has not tapped: never say saved or logged. No em dashes anywhere.";

export const LAST_TURN_NOTE =
  "\n\nThis is your LAST turn. You must finish now with create_custom_meal, create_custom_food, log_food or reply. " +
  "Do not call any other tool.";

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
  return null;
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
  const turns: AgentTurn[] = [];
  const days = input.today ? recentDays(input.today) : null;
  const messages: unknown[] = [{
    role: "user",
    content: days ? `(${days})\n${input.text}` : input.text,
  }];
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

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const last = turn === MAX_TURNS;
    const t0 = Date.now();
    const res = await deps.callModel({
      model: deps.model,
      max_tokens: 2000,
      system: FOOD_AGENT_SYSTEM + (last ? LAST_TURN_NOTE : ""),
      tools: FOOD_AGENT_TOOLS,
      // Always a tool: free text would be a reply that skipped the reply tool's
      // rules, and it would end the loop without saying so.
      tool_choice: { type: "any" },
      messages,
    });
    if (!res.ok) return { kind: "failed", reason: `http_${res.status}`, turns };

    const blocks = (res.data?.content ?? []) as Record<string, unknown>[];
    const uses = blocks.filter((b) => b?.type === "tool_use") as unknown as ToolUse[];
    turns.push({
      turn,
      ms: Date.now() - t0,
      tools: uses.map((u) => ({ name: u.name, input: u.input })),
      input_tokens: res.data?.usage?.input_tokens ?? null,
      output_tokens: res.data?.usage?.output_tokens ?? null,
    });
    if (uses.length === 0) return { kind: "failed", reason: "no_tool_call", turns };

    // A finish ends the agent even when reads came with it: the model has
    // decided, and running reads it will never see is cost with no reader.
    const finish = uses.find((u) => FINISH_TOOLS.has(u.name));
    if (finish) {
      const label = statusFor(finish.name, finish.input ?? {});
      if (label) deps.onStatus?.(label);
      return await finishWith(finish, input, parse, turns, seen);
    }
    const unknown = uses.find((u) => !READ_TOOLS.has(u.name));
    if (unknown) return { kind: "failed", reason: `unknown_tool_${unknown.name}`, turns };
    if (last) return { kind: "failed", reason: "read_on_last_turn", turns };

    for (const u of uses) {
      const label = statusFor(u.name, u.input ?? {});
      if (label) deps.onStatus?.(label);
    }
    const results = await Promise.all(uses.map(async (u) => {
      const out = await runRead(u, deps, parse);
      remember(seen, out);
      return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) };
    }));
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
): Promise<unknown> {
  try {
    if (u.name === LIST_LOGGED_MEALS_TOOL.name) return await deps.readDiary(u.input ?? {});
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
      return {
        meal_type: r.parsed.meal_type,
        items: r.parsed.items.map((i) => ({
          food_name: i.food_name, quantity: i.quantity, serving_label: i.serving_label, grams: i.grams,
          kcal: i.kcal, protein_g: i.protein_g, carb_g: i.carb_g, fat_g: i.fat_g,
        })),
      };
    }
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
  return { error: "unknown tool" };
}

type Seen = Map<string, Set<number>>;

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
): Promise<FoodAgentOutcome> {
  const args = u.input ?? {};
  if (u.name === REPLY_TOOL.name) {
    const text = clean(typeof args.text === "string" ? args.text : "");
    return text ? { kind: "reply", text, turns } : { kind: "failed", reason: "empty_reply", turns };
  }
  if (u.name === CREATE_CUSTOM_MEAL_TOOL.name || u.name === CREATE_CUSTOM_FOOD_TOOL.name) {
    return { kind: "create", create: { tool: u.name, input: checkedCreateInput(args, seen) }, turns };
  }
  // log_food
  const meal: MealType = isMeal(args.meal_type) ? args.meal_type : input.defaultMeal;
  const copied = Array.isArray(args.items) ? args.items.flatMap((r) => copiedLine(r, meal, seen)) : [];
  let parsedLines: ParsedItem[] = [];
  let usage: ParseMealResult["usage"] = {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0,
  };
  const steps: ParseStep[] = [];
  if (typeof args.text === "string" && args.text.trim()) {
    const r = await parse(args.text);
    usage = r.usage;
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
    },
    turns,
  };
}

function copiedLine(raw: unknown, meal: MealType, seen: Seen): ParsedItem[] {
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
      ? { source: "manual" as const, assumption: null, confidence: "high" as const }
      : from === "changed"
      ? {
        source: "manual" as const,
        assumption: `Adjusted from ${[...was!][0]} kcal in your log.`,
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
