// Warm memory for the Precise food agent (.planning/precise-food-logger-plan.md,
// sections 4, 6 and 7): what the agent can reach in one tool call, and the
// little of it that is worth putting in the hot context by code.
//
//   recall_food(name)        the user's own food memory for one name: their
//                            numbers per 100 g, usual amount, how often, when,
//                            where the numbers came from, a dish's parts
//   read_thread(from_seq)    older turns of THIS thread
//   search_threads(query)    the user's other threads still kept (20 days)
//
// Hot, built by code before the agent runs (no model and no Jev call):
//   - matches: memory foods whose NAME is close to words of this message,
//     labelled as a name match that nothing checked
//   - the thread's first message, once it has left the recent turns, and the
//     thread's summary (food_threads.summary) when one was written
//
// Every read is facts only and changes nothing on the card. To put a food on
// the card the agent still calls log_food, add_lines or edit_line, and code
// works the numbers out (plan section 5: the model never types the kcal of a
// line that has a row).
//
// Behind FOOD_WARM_MEMORY (off | on, anything but "on" is off), later-mode
// agent only (FOOD_AGENT_LATER, FOOD_FIRST_GATE). Off changes nothing.
//
// Runtime-agnostic (no Deno globals), so the tests and the eval run it as is.

import type { AnthropicTool } from "./prompt.ts";
import type { CardLine } from "./foodContext.ts";
import type { FoodOrigin, RecipePart } from "../_shared/foodOrigin.ts";
import { buildMemory, MEMORY_DAYS, type MemoryEntry, memoryKey, type ParseTierName } from "./userFoodMemory.ts";
import { searchWords, type ThreadHit, type ThreadTurn, type WarmThread } from "./foodThreads.ts";

export type FoodWarmMemoryMode = "off" | "on";

/** FOOD_WARM_MEMORY: anything but "on" is off. */
export function parseFoodWarmMemoryMode(raw: string | undefined | null): FoodWarmMemoryMode {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}

// ── The user's foods, as the warm reads show them ──────────────────────────

/** One remembered food with the facts recall_food and the matches block show. */
export interface RecallFood {
  key: string;
  name: string;
  brand: string | null;
  per100: { kcal: number; protein_g: number; carb_g: number; fat_g: number };
  /** The amount the user logs most often in the last MEMORY_DAYS days (the
   *  newest on a tie). Null when no diary line of it is in that window. */
  usual: { grams: number; quantity: number | null; unit: string | null } | null;
  /** One unit of what it was logged in ("1 piece" = 50 g), when not a weight. */
  unit: { label: string; grams: number } | null;
  /** Diary lines of it in the last MEMORY_DAYS days. */
  times: number;
  last_logged_at: string;
  origin: FoodOrigin;
  recipe: RecipePart[] | null;
  aliases: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The user's foods for the warm reads, from the SAME entries the parse's
 * memory loads (index.ts fetchMemoryEntries) and the same buildMemory, so a
 * food's numbers here are the numbers the parse would serve for it. Adds what
 * buildMemory does not keep: the usual amount, the count in the window, the
 * brand.
 */
export function recallFoods(
  entries: MemoryEntry[],
  tier: ParseTierName,
  byOrigin = false,
  now: Date = new Date(),
): RecallFood[] {
  const foods = buildMemory(entries, tier, now, MEMORY_DAYS, byOrigin);
  const since = now.getTime() - MEMORY_DAYS * 86_400_000;
  // Diary lines (not the saved cache rows, which have no amount of their own).
  const lines = new Map<string, MemoryEntry[]>();
  const brands = new Map<string, string>();
  for (const e of entries) {
    const key = memoryKey(e.food_name ?? "");
    if (!key) continue;
    const brand = typeof e.brand === "string" ? e.brand.trim() : "";
    if (brand && !brands.has(key)) brands.set(key, brand.slice(0, 80));
    const at = Date.parse(e.logged_at);
    if (e.persistent || !Number.isFinite(at) || at < since || !(e.grams && e.grams > 0)) continue;
    lines.set(key, [...(lines.get(key) ?? []), e]);
  }
  return foods.map((f) => {
    const mine = lines.get(f.key) ?? [];
    return {
      key: f.key,
      name: f.name,
      brand: brands.get(f.key) ?? null,
      per100: { kcal: f.per100.kcal, protein_g: f.per100.protein_g, carb_g: f.per100.carb_g, fat_g: f.per100.fat_g },
      usual: usualAmount(mine),
      unit: f.serving,
      times: mine.length,
      last_logged_at: f.last_logged_at,
      origin: f.origin ?? "unknown",
      recipe: f.recipe ?? null,
      aliases: f.confirmed_aliases ?? [],
    };
  });
}

/** The weight logged most often (to the gram), the newest line on a tie. */
function usualAmount(lines: MemoryEntry[]): RecallFood["usual"] {
  if (!lines.length) return null;
  const byGrams = new Map<number, { n: number; newest: MemoryEntry }>();
  for (const e of lines) {
    const g = Math.round(e.grams as number);
    const got = byGrams.get(g);
    if (!got) byGrams.set(g, { n: 1, newest: e });
    else {
      got.n++;
      if (Date.parse(e.logged_at) > Date.parse(got.newest.logged_at)) got.newest = e;
    }
  }
  const [grams, best] = [...byGrams].sort((a, b) =>
    b[1].n - a[1].n || Date.parse(b[1].newest.logged_at) - Date.parse(a[1].newest.logged_at)
  )[0];
  const unit = best.newest.serving_unit?.trim() || null;
  return { grams, quantity: best.newest.quantity ?? null, unit };
}

// ── Name similarity ─────────────────────────────────────────────────────────

/** Character trigrams, the same as userFoodMemory's nameSimilarity (padded
 *  memoryKey), computed once per name so a message can be compared with many
 *  foods cheaply. */
function grams3(s: string): Set<string> {
  const t = `  ${memoryKey(s)} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

function jaccard(x: Set<string>, y: Set<string>): number {
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}

/** A food's best similarity to a name, by its name or a confirmed alias. */
function nameScore(f: RecallFood, target: Set<string>): number {
  return Math.max(jaccard(grams3(f.name), target), ...f.aliases.map((a) => jaccard(grams3(a), target)));
}

/**
 * The cutoff for the matches block. Trigram similarity (the memory
 * shortlist's own measure, userFoodMemory nameSimilarity) of 0.6 or more
 * between a remembered name and a run of the message's words: most of the
 * name's letters, in order. "jeera rice" in "100g jeera rice" passes; "rice"
 * against "jeera rice" (0.33) does not. It is a NAME match only, below what
 * Jev checks for identity (MEMORY_FLOOR), which is why the block says so; a
 * looser match is one recall_food call away.
 */
export const MATCH_CUTOFF = 0.6;
/** At most this many matches in the block. */
export const MATCHES_MAX = 3;
/** Longest run of message words compared with a name. */
const MATCH_WINDOW = 6;
/** Words of the message looked at (a long message's first ones). */
const MATCH_WORDS = 60;

/** The message's runs of 1..MATCH_WINDOW words, as trigram sets. */
function windows(text: string): Set<string>[] {
  const words = memoryKey(text).split(" ").filter(Boolean).slice(0, MATCH_WORDS);
  const out: Set<string>[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= MATCH_WINDOW && i + n <= words.length; n++) out.push(grams3(words.slice(i, i + n).join(" ")));
  }
  return out;
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** A remembered amount said plainly, with its calories worked out by code. */
function amountText(f: RecallFood): string {
  if (f.usual) {
    const kcal = Math.round((f.per100.kcal * f.usual.grams) / 100);
    const unit = f.usual.unit && f.usual.quantity && !/^(g|gm|gms|gram|grams|ml)$/i.test(f.usual.unit)
      ? ` (${r1(f.usual.quantity)} ${flat(f.usual.unit)})`
      : "";
    return `usually ${f.usual.grams} g${unit}, ${kcal} kcal at that amount`;
  }
  if (f.unit) return `1 ${flat(f.unit.label)} is ${r1(f.unit.grams)} g, ${Math.round((f.per100.kcal * f.unit.grams) / 100)} kcal`;
  return `${Math.round(f.per100.kcal)} kcal per 100 g`;
}

function dayText(iso: string): string | null {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

/**
 * The matches block for the opening message: the user's remembered foods
 * whose names are close to words of THIS message (MATCH_CUTOFF), best first,
 * at most MATCHES_MAX, each on one line. Facts only: what matched, the usual
 * amount and its calories (code's sum), how often, and which card line has
 * the same name. Null when nothing passes, so the block is left out.
 */
export function matchesBlock(foods: RecallFood[] | null, text: string, card: CardLine[] | null | undefined): string | null {
  if (!foods?.length || !text.trim()) return null;
  const runs = windows(text);
  if (!runs.length) return null;
  const scored = foods
    .map((f) => ({ f, s: Math.max(...runs.map((w) => nameScore(f, w))) }))
    .filter((x) => x.s >= MATCH_CUTOFF)
    .sort((a, b) => b.s - a.s || b.f.times - a.f.times)
    .slice(0, MATCHES_MAX);
  if (!scored.length) return null;
  const lines = scored.map(({ f }) => {
    const target = grams3(f.name);
    const on = (card ?? []).findIndex((l) => jaccard(grams3(l.food_name), target) >= MATCH_CUTOFF);
    const day = dayText(f.last_logged_at);
    const how = f.times > 0
      ? `logged ${f.times} ${f.times === 1 ? "time" : "times"} in the last ${MEMORY_DAYS} days`
      : day ? `last logged ${day}` : null;
    return `- ${JSON.stringify(flat(f.name))}: ${[amountText(f), how, on >= 0 ? `same name as card line L${on + 1}` : null].filter(Boolean).join("; ")}.`;
  });
  return `(Foods in the user's memory whose names match words of this message, a name match only, not checked:\n${lines.join("\n")})`;
}

// ── recall_food ─────────────────────────────────────────────────────────────

export const RECALL_FOOD_TOOL: AnthropicTool = {
  name: "recall_food",
  description:
    "Look up a food in the user's own food memory (foods they logged before) by name. Returns up to 3 foods with " +
    "names like it: their numbers per 100 g, the amount they usually log, how often and when they logged it, where " +
    "its numbers came from, and a dish's parts. Read only: nothing on the card changes. To put one of these foods on " +
    "the card, use log_food, add_lines or edit_line with the user's words; the app works out the numbers.",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", description: "The food or dish, in the user's words." } },
    required: ["name"],
  },
};

/** recall_food calls one message may make. */
export const MAX_RECALL_PER_RUN = 3;
/** A remembered food is returned when its name is at least this close (the
 *  shortlist's trigram measure) or holds every word asked. */
export const RECALL_FLOOR = 0.3;
export const RECALL_MAX = 3;

/** recall_food's answer: facts only. Field names never pair a name with a
 *  bare `kcal`, so the agent's copy check (foodAgent remember) never takes a
 *  per-100 figure for a line it may copy. */
export function recallAnswer(foods: RecallFood[], asked: string): Record<string, unknown> {
  const q = flat(asked).slice(0, 100);
  const target = grams3(q);
  const words = memoryKey(q).split(" ").filter((w) => w.length > 1);
  const hit = foods
    .map((f) => {
      const own = new Set(memoryKey(f.name).split(" "));
      const all = words.length > 0 && words.every((w) => own.has(w));
      return { f, s: nameScore(f, target), all };
    })
    .filter((x) => x.s >= RECALL_FLOOR || x.all)
    .sort((a, b) => b.s - a.s || b.f.times - a.f.times)
    .slice(0, RECALL_MAX);
  if (!hit.length) return { name_asked: q, foods: [], note: "No food in the user's memory has a name like this." };
  return {
    name_asked: q,
    foods: hit.map(({ f, s }) => ({
      name: f.name,
      brand: f.brand,
      name_score: Math.round(s * 100) / 100,
      per_100g: { kcal: f.per100.kcal, protein_g: f.per100.protein_g, carb_g: f.per100.carb_g, fat_g: f.per100.fat_g },
      usual_amount: f.usual ? { grams: f.usual.grams, quantity: f.usual.quantity, unit: f.usual.unit } : null,
      one_unit: f.unit ? { unit: f.unit.label, grams: f.unit.grams } : null,
      [`logged_last_${MEMORY_DAYS}_days`]: f.times,
      last_logged: dayText(f.last_logged_at),
      numbers_from: f.origin,
      ...(f.recipe?.length
        ? { parts: f.recipe.map((p) => ({ part: p.name, grams: p.grams, ...(p.assumed ? { amount_was_assumed: true } : {}) })) }
        : {}),
    })),
    note: "From the user's own past logs, matched by name. Nothing on the card changed.",
  };
}

// ── read_thread and search_threads ──────────────────────────────────────────

export const READ_THREAD_TOOL: AnthropicTool = {
  name: "read_thread",
  description:
    "Read older turns of THIS food conversation that are not in the messages above, by turn number (1 is the first). " +
    "Returns up to 10 turns from `from_seq`, word for word. Read only.",
  input_schema: {
    type: "object",
    properties: { from_seq: { type: "integer", description: "The first turn to read, 1 or more." } },
    required: ["from_seq"],
  },
};

export const SEARCH_THREADS_TOOL: AnthropicTool = {
  name: "search_threads",
  description:
    "Search the user's other food conversations from the last 20 days for food words (\"paneer sabji\"). Returns up to " +
    "5, each with its date, its first message and its card's foods with calories. Read only: to put food from one on the " +
    "card, use the diary (copy_lines) or the user's words.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Food words to look for." } },
    required: ["query"],
  },
};

export const MAX_READ_THREAD_PER_RUN = 3;
export const MAX_SEARCH_THREADS_PER_RUN = 2;
export const READ_THREAD_TURNS = 10;
export const SEARCH_THREADS_HITS = 5;
/** Days a thread is kept (migration 20261106120000 food_threads_retention). */
export const THREAD_KEPT_DAYS = 20;

/** The cut every quoted message takes in the hot context. */
export const QUOTE_CHARS = 400;

/** What the agent's warm tools need from the request (foodBar.ts builds it). */
export interface FoodAgentWarm {
  /** The user's foods, loaded at most once per message (memoized by the
   *  caller). Absent: no recall_food and no matches block. */
  memory?(): Promise<RecallFood[]>;
  /** Up to `limit` turns of this thread from `fromSeq`. Null: not stored. */
  readThread?(fromSeq: number, limit: number): Promise<ThreadTurn[] | null>;
  /** The user's other kept threads holding these words. */
  searchThreads?(words: string[], limit: number): Promise<ThreadHit[]>;
}

/** read_thread's answer. */
export function readThreadAnswer(turns: ThreadTurn[] | null, fromSeq: number): Record<string, unknown> {
  if (turns === null) return { error: "This conversation is not stored, so there are no older turns to read." };
  if (!turns.length) return { from_seq: fromSeq, turns: [], note: `No turns from ${fromSeq} on.` };
  return { from_seq: fromSeq, turns: turns.map((t) => ({ seq: t.seq, role: t.role, text: flat(t.text).slice(0, 1000) })) };
}

/** search_threads' answer. Card lines are text, never a {name, kcal} pair:
 *  they are not lines the agent may copy (copy_lines reads the diary). */
export function searchThreadsAnswer(hits: ThreadHit[], query: string): Record<string, unknown> {
  if (!hits.length) return { query, threads: [], note: `No other conversation in the last ${THREAD_KEPT_DAYS} days has these words.` };
  return {
    query,
    threads: hits.map((h) => ({ date: h.date, first_message: h.first ? flat(h.first).slice(0, 200) : null, card_foods: h.lines.slice(0, 12) })),
  };
}

/** The calls one message may make per warm tool; past it, a refusal. */
export const WARM_CAPS: Record<string, number> = {
  [RECALL_FOOD_TOOL.name]: MAX_RECALL_PER_RUN,
  [READ_THREAD_TOOL.name]: MAX_READ_THREAD_PER_RUN,
  [SEARCH_THREADS_TOOL.name]: MAX_SEARCH_THREADS_PER_RUN,
};

/**
 * Run one warm read. Never throws: a failure is an error the agent reads.
 * `calls` counts this run's calls per tool (WARM_CAPS).
 */
export async function runWarmRead(
  name: string,
  input: Record<string, unknown>,
  warm: FoodAgentWarm,
  calls: Map<string, number>,
): Promise<unknown> {
  const cap = WARM_CAPS[name];
  if (cap === undefined) return { error: "unknown tool" };
  const n = (calls.get(name) ?? 0) + 1;
  calls.set(name, n);
  if (n > cap) return { error: `${name} was already called ${cap} times for this message. Use what it returned.` };
  try {
    if (name === RECALL_FOOD_TOOL.name) {
      const asked = typeof input.name === "string" ? input.name.trim() : "";
      if (!asked) return { error: "recall_food needs a food name." };
      if (!warm.memory) return { error: "The user's food memory is not available for this message." };
      return recallAnswer(await warm.memory(), asked);
    }
    if (name === READ_THREAD_TOOL.name) {
      const from = typeof input.from_seq === "number" ? input.from_seq : Number(input.from_seq);
      if (!Number.isInteger(from) || from < 1) return { error: "read_thread needs from_seq, a turn number of 1 or more." };
      if (!warm.readThread) return { error: "This conversation is not stored, so there are no older turns to read." };
      return readThreadAnswer(await warm.readThread(from, READ_THREAD_TURNS), from);
    }
    const query = typeof input.query === "string" ? flat(input.query).slice(0, 100) : "";
    const words = searchWords(query);
    if (!words.length) return { error: "search_threads needs food words of 3 letters or more." };
    if (!warm.searchThreads) return { error: "Earlier conversations are not available for this message." };
    return searchThreadsAnswer(await warm.searchThreads(words, SEARCH_THREADS_HITS), query);
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

/** The status line while a warm read runs. */
export function warmStatus(name: string): string | null {
  if (name === RECALL_FOOD_TOOL.name) return "Checking your usual foods";
  if (name === READ_THREAD_TOOL.name) return "Reading back this chat";
  if (name === SEARCH_THREADS_TOOL.name) return "Looking through your earlier chats";
  return null;
}

// ── The hot context ─────────────────────────────────────────────────────────

/** Is `first` one of the user turns the agent already has? The app cuts each
 *  turn (FOOD_TURN_CHARS), so a cut turn that starts the same is it. */
function inRecent(first: string, turns: { role: "user" | "drona"; text: string }[] | undefined): boolean {
  const f = flat(first).toLowerCase();
  return (turns ?? []).some((t) => {
    if (t.role !== "user") return false;
    const x = flat(t.text).toLowerCase();
    return !!x && (x === f || f.startsWith(x));
  });
}

/** read_thread is worth offering: the thread has turns the messages do not. */
export function hasOlderTurns(warm: WarmThread | null | undefined, recentTurns: unknown[] | undefined): boolean {
  return !!warm && warm.turns > (recentTurns?.length ?? 0);
}

/**
 * The thread lines for the opening message: the first message once it is no
 * longer in the recent turns, the summary when one was written, and (with
 * read_thread) how many older turns there are. Null when there is nothing.
 */
export function warmThreadText(
  warm: WarmThread | null | undefined,
  recentTurns: { role: "user" | "drona"; text: string }[] | undefined,
  canReadThread: boolean,
): string | null {
  if (!warm) return null;
  const parts: string[] = [];
  if (warm.first && !inRecent(warm.first, recentTurns)) {
    parts.push(`First message of this thread: ${JSON.stringify(flat(warm.first).slice(0, QUOTE_CHARS))}`);
  }
  if (warm.summary) parts.push(`Summary of the earlier turns, facts the user stated: ${flat(warm.summary).slice(0, 400)}`);
  const kept = recentTurns?.length ?? 0;
  if (canReadThread && warm.turns > kept) {
    parts.push(
      `This thread has ${warm.turns} earlier turns; the messages above carry the last ${kept}. read_thread reads the ` +
        "older ones by turn number, from 1.",
    );
  }
  return parts.length ? `(${parts.join("\n")})` : null;
}

/** Said to the agent, naming only the warm tools this run has. */
export function warmNote(tools: { recall: boolean; readThread: boolean; searchThreads: boolean }): string | null {
  const s = [
    tools.recall
      ? "recall_food shows what the user's own food memory holds for a food: their numbers per 100 g, the amount they " +
        "usually log, how often and when, where the numbers came from, and a dish's parts. It changes nothing on the " +
        "card. Foods listed in the opening message as name matches were matched by name only: use one only when the " +
        "user's words say it is that food."
      : null,
    tools.readThread ? "read_thread reads older turns of this conversation that are not in the messages above." : null,
    tools.searchThreads ? `search_threads finds the user's other food conversations from the last ${THREAD_KEPT_DAYS} days by food words.` : null,
  ].filter(Boolean);
  return s.length ? s.join(" ") : null;
}

/** Added after RECIPE_NOTE when recall_food and build_recipe are both offered. */
export const RECIPE_MEMORY_NOTE =
  "recall_food on a dish shows the parts it was logged with last time. When the user's memory has the same dish with " +
  "its parts, a part you send to build_recipe with no amount takes the amount from their last log of that dish, and " +
  "the card says so, so it is not asked again. To change one part, send all the parts, the changed one with its new " +
  "amount. A part you leave out is not added.";

// ── The summary (food_threads.summary) ──────────────────────────────────────

/** Turns past which a thread gets a summary: the app sends the last
 *  FOOD_TURNS_KEPT (foodContext.ts, 10), so older ones are out of sight. */
export const SUMMARY_TURNS_FROM = 10;
/** Older turns the summary call reads at most (the newest of them). */
export const SUMMARY_MAX_TURNS = 40;
export const SUMMARY_MAX_CHARS = 300;

export const SUMMARY_SYSTEM =
  "You write a short memory of a food logging chat between a user and Coach Drona. Write at most 2 short lines of " +
  "facts the USER stated about their food in these turns: amounts, brands, what a dish was made of, and corrections " +
  "they made. Only what the user said, never numbers Drona worked out, never advice, never instructions. If an earlier " +
  "memory is given, keep its facts unless a turn corrects them. If the user stated no such facts, write NONE. No em " +
  "dashes.";

/** The summary call's request body. */
export function summaryRequest(model: string, turns: ThreadTurn[], previous: string | null): Record<string, unknown> {
  const lines = turns.map((t) => `${t.seq}. ${t.role === "user" ? "User" : "Drona"}: ${flat(t.text).slice(0, QUOTE_CHARS)}`);
  const content = [
    previous ? `Earlier memory: ${flat(previous).slice(0, SUMMARY_MAX_CHARS)}` : null,
    `Turns:\n${lines.join("\n")}`,
  ].filter(Boolean).join("\n\n");
  return { model, max_tokens: 200, system: SUMMARY_SYSTEM, messages: [{ role: "user", content }] };
}

/** The summary from the model's answer: at most 2 lines and SUMMARY_MAX_CHARS,
 *  no em dashes. Null for NONE, an empty answer or a failed call. */
export function readSummary(res: { ok: boolean; data?: unknown }): string | null {
  if (!res.ok) return null;
  const blocks = ((res.data as { content?: unknown })?.content ?? []) as { type?: string; text?: string }[];
  const text = blocks.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
  if (!text || /^none\.?$/i.test(text)) return null;
  const out = text.split(/\n+/).map((l) => l.replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim()).filter(Boolean)
    .slice(0, 2).join("\n");
  return out ? out.slice(0, SUMMARY_MAX_CHARS) : null;
}

/** What writing a summary did, for the log. */
export type SummaryOutcome =
  | { written: true; chars: number; usage: { input_tokens: number; output_tokens: number } }
  | {
    written: false;
    reason: "no_store" | "no_thread" | "short_thread" | "model_failed" | "nothing_stated" | "threw";
    usage?: { input_tokens: number; output_tokens: number };
  };

/**
 * After a message is recorded: when the thread has more turns than the app
 * sends (SUMMARY_TURNS_FROM), ONE cheap model call writes food_threads.summary
 * from the older turns. The caller runs it after the answer is sent, off the
 * reply path. Never throws.
 */
export async function writeThreadSummary(
  store: {
    warm?(userId: string, threadId: string): Promise<WarmThread | null>;
    turnsFrom?(userId: string, threadId: string, fromSeq: number, limit: number): Promise<ThreadTurn[] | null>;
    setSummary?(userId: string, threadId: string, summary: string | null): Promise<void>;
  },
  userId: string,
  threadId: string,
  model: string,
  call: (body: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown }>,
): Promise<SummaryOutcome> {
  try {
    if (!store.warm || !store.turnsFrom || !store.setSummary) return { written: false, reason: "no_store" };
    const w = await store.warm(userId, threadId);
    if (!w) return { written: false, reason: "no_thread" };
    if (w.turns <= SUMMARY_TURNS_FROM) return { written: false, reason: "short_thread" };
    const lastOld = w.turns - SUMMARY_TURNS_FROM;
    const from = Math.max(1, lastOld - SUMMARY_MAX_TURNS + 1);
    const turns = ((await store.turnsFrom(userId, threadId, from, SUMMARY_MAX_TURNS)) ?? []).filter((t) => t.seq <= lastOld);
    if (!turns.length) return { written: false, reason: "short_thread" };
    const res = await call(summaryRequest(model, turns, w.summary));
    const u = (res.data as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage;
    const usage = { input_tokens: u?.input_tokens ?? 0, output_tokens: u?.output_tokens ?? 0 };
    if (!res.ok) return { written: false, reason: "model_failed", usage };
    const summary = readSummary(res);
    if (!summary) return { written: false, reason: "nothing_stated", usage };
    await store.setSummary(userId, threadId, summary);
    return { written: true, chars: summary.length, usage };
  } catch {
    return { written: false, reason: "threw" };
  }
}
