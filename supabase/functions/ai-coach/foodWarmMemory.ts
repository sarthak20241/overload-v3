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
// Memory matches (owner decision: Jev matches only): the memory decisions
// the parse of THIS message already made (matchMemory / decideMemory, read
// from the parse's own steps), never a new Jev call and never a name match.
// In every parse_food result, and in a first-message run's opening message
// when that message's parse had already finished as the agent started.
//
// Hot, built by code before the agent runs (no model and no Jev call):
//   - the thread's first message, once it has left the recent turns
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
import type { ParsedItem, ParseMealResult, ParseStep } from "./parseMeal.ts";
import { FOOD_TURN_CHARS } from "./foodContext.ts";
import type { FoodOrigin, RecipePart } from "../_shared/foodOrigin.ts";
import {
  buildMemory,
  MEMORY_DAYS,
  MEMORY_FLOOR,
  type MemoryEntry,
  memoryKey,
  type ParseTierName,
  VARIANT_FLOOR,
} from "./userFoodMemory.ts";
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

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

function dayText(iso: string): string | null {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

// ── Memory matches Jev already decided ──────────────────────────────────────

/**
 * One line's memory decision from a parse that already ran: what the line was
 * looked up as, the remembered food the parse chose (decideMemory, at or over
 * MEMORY_FLOOR, or a confirmed alias), and the near ones Jev scored from
 * VARIANT_FLOOR up to MEMORY_FLOOR that were not chosen. Read from the
 * parse's own `user_memory` steps (userFoodMemory.ts matchMemory's trace,
 * pushed in parseMeal.ts), so no second Jev call is made anywhere.
 */
export interface MemoryFact {
  words: string;
  path: "jev" | "confirmed_alias";
  chosen: { name: string; score: number } | null;
  near: { name: string; score: number }[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The memory decisions in a parse's steps, one per line Jev was asked about
 *  (or a confirmed alias answered). Lines with no chosen and no near food are
 *  left out. */
export function memoryFacts(steps: ParseStep[] | null | undefined): MemoryFact[] {
  const out: MemoryFact[] = [];
  for (const st of steps ?? []) {
    if (st?.tool !== "user_memory") continue;
    const t = (st.result ?? {}) as Record<string, unknown>;
    const words = typeof t.lookup_name === "string" ? t.lookup_name : typeof t.item === "string" ? t.item : "";
    if (!words) continue;
    const d = (t.decision ?? {}) as Record<string, unknown>;
    const chosenName = typeof d.match === "string" && d.match ? d.match : null;
    const chosenScore = num(d.conf);
    const chosen = chosenName ? { name: chosenName, score: chosenScore ?? 1 } : null;
    const rows = Array.isArray(t.rows) ? t.rows as Record<string, unknown>[] : [];
    const near = rows.flatMap((r) => {
      const name = typeof r.name === "string" ? r.name : "";
      const score = num(r.score);
      if (!name || score === null || score < VARIANT_FLOOR || score >= MEMORY_FLOOR) return [];
      if (chosen && memoryKey(name) === memoryKey(chosen.name)) return [];
      return [{ name, score }];
    }).sort((a, b) => b.score - a.score).slice(0, 2);
    if (!chosen && !near.length) continue;
    out.push({ words, path: t.path === "confirmed_alias" ? "confirmed_alias" : "jev", chosen, near });
  }
  return out;
}

/** The parse line a decision was for: the line carrying the chosen food's
 *  name, else the line whose name or the user's words for it are the words
 *  looked up. Null when no line can be told. */
function lineFor(f: MemoryFact, items: ParsedItem[]): number | null {
  const k = (s: string | null | undefined) => (s ? memoryKey(s) : "");
  if (f.chosen) {
    const i = items.findIndex((it) => k(it.food_name) === k(f.chosen!.name));
    if (i >= 0) return i;
  }
  const w = k(f.words);
  const exact = items.findIndex((it) => k(it.said_name) === w || k(it.food_name) === w);
  if (exact >= 0) return exact;
  const loose = items.flatMap((it, i) => {
    const a = k(it.said_name), b = k(it.food_name);
    return (a && (a.includes(w) || w.includes(a))) || (b && (b.includes(w) || w.includes(b))) ? [i] : [];
  });
  return loose.length === 1 ? loose[0] : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A parse's memory decisions for a tool result (parse_food). Field names
 *  never pair a name with `kcal`, so none of it reads as a line to copy. */
export function memoryMatchesOf(r: ParseMealResult | null | undefined): Record<string, unknown>[] {
  const items = r?.parsed?.items ?? [];
  return memoryFacts(r?.steps).map((f) => {
    const i = lineFor(f, items);
    return {
      for_words: f.words,
      line: i === null ? null : items[i].food_name,
      chosen: f.chosen ? { name: f.chosen.name, jev_score: r2(f.chosen.score), ...(f.path === "confirmed_alias" ? { confirmed_alias: true } : {}) } : null,
      near: f.near.map((n) => ({ name: n.name, jev_score: r2(n.score), chosen: false })),
    };
  });
}

/**
 * The memory matches block for the opening message of a first-message run,
 * from the parse of that message once it has finished (never waited for).
 * One line per decision, facts only. Null when the parse made none.
 */
export function memoryMatchesBlock(r: ParseMealResult | null | undefined): string | null {
  const items = r?.parsed?.items ?? [];
  const facts = memoryFacts(r?.steps);
  if (!facts.length) return null;
  const lines = facts.map((f) => {
    const i = lineFor(f, items);
    const on = i === null ? "" : ` (parse line ${JSON.stringify(flat(items[i].food_name))})`;
    const chosen = f.chosen
      ? `chosen ${JSON.stringify(flat(f.chosen.name))}, ${f.path === "confirmed_alias" ? "a name the user confirmed before" : `Jev ${r2(f.chosen.score)}`}`
      : "none chosen";
    const near = f.near.map((n) => `near ${JSON.stringify(flat(n.name))}, Jev ${r2(n.score)}, not used`);
    return `- ${JSON.stringify(flat(f.words))}${on}: ${[chosen, ...near].join("; ")}.`;
  });
  return `(Memory matches the app's check (Jev) already made for the food in this message:\n${lines.join("\n")})`;
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

/** `p`, or null when it takes longer than `ms` or fails. A slow database
 *  never holds the agent past this. */
export async function briefly<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => null), new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long recall_food waits for the user's memory before it says it is not
 *  available. */
export const RECALL_WAIT_MS = 1500;
/** How long build_recipe waits for remembered parts before it builds the
 *  dish without them (as with the switch off). */
export const RECIPE_MEMORY_WAIT_MS = 500;

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
    "Returns up to 10 turns from `from_seq`; a turn may be cut short. Read only.",
  input_schema: {
    type: "object",
    properties: { from_seq: { type: "integer", description: "The first turn to read, 1 or more." } },
    required: ["from_seq"],
  },
};

/** search_threads, naming copy_lines only when the run offers it. */
export function searchThreadsTool(copyLines: boolean): AnthropicTool {
  return {
    name: "search_threads",
    description:
      "Search the user's other food conversations from the last 20 days for food words (\"paneer sabji\"). Returns up to " +
      "5, each with its date, its first message and its card's foods with calories. Read only: to put food from one on " +
      `the card, use ${copyLines ? "the diary (copy_lines) or " : ""}the user's words.`,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Food words to look for." } },
      required: ["query"],
    },
  };
}

export const SEARCH_THREADS_TOOL: AnthropicTool = searchThreadsTool(true);

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
  /** The user's foods, loaded at most once per message, on first use
   *  (memoized by the caller). Absent: no recall_food. */
  memory?(): Promise<RecallFood[]>;
  /** A first-message run: the parse of the message if it has ALREADY
   *  finished, else null. Never awaited, so the agent never waits on it. */
  settledFirstParse?(): ParseMealResult | null;
  /** Memory matches can appear in this request (USER_FOOD_MEMORY and Jev
   *  on): only then are they shown and the agent told about them. */
  matches?: boolean;
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
      const foods = warm.memory ? await briefly(warm.memory(), RECALL_WAIT_MS) : null;
      if (!foods) return { error: "The user's food memory is not available for this message." };
      return recallAnswer(foods, asked);
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

// ── This thread's turns: from memory first ─────────────────────────────────

/** What the request's own load of the thread knows about its turns
 *  (foodThreads.ts load with `turns`). */
export interface StoredTurns {
  lastSeq: number;
  /** The newest stored turn. */
  lastTurn: ThreadTurn | null;
  /** Turn 1's text. */
  firstText: string | null;
}

/**
 * The thread's turns as this request holds them, so a turn already in memory
 * is never read from the database again.
 *
 * The app sends the last FOOD_TURNS_KEPT turns, each cut to FOOD_TURN_CHARS
 * (lib/dietData.ts). They are placed at the thread's newest seqs ONLY when the
 * newest stored turn is the app's last turn (same role, same text up to the
 * cut): a write that has not landed yet, a turn the store never got (a Drona
 * line not stored), or a store short of turns would otherwise put text under
 * the wrong turn number. Unchecked, nothing is placed and the turns are read.
 * Turn 1's text comes with the load. Anything else is read with ONE turnsFrom
 * call for the missing span only, then kept for the rest of the request.
 */
export interface ThreadTurnsMemory {
  /** Turns stored so far, from the request's own load. 0: none or no thread. */
  lastSeq(): Promise<number>;
  /** The thread's first user message: from the load, else one read. */
  first(): Promise<string | null>;
  /** Up to `limit` turns from `fromSeq`, oldest first. Null: not stored. */
  read(fromSeq: number, limit: number): Promise<ThreadTurn[] | null>;
}

/** The app's copy of a turn is the stored one: same role, and the same text
 *  with whitespace collapsed, up to the app's cut. */
export function sameTurn(stored: ThreadTurn, app: { role: "user" | "drona"; text: string }): boolean {
  if (stored.role !== app.role) return false;
  const st = flat(stored.text), a = flat(app.text);
  if (!a) return false;
  if (st === a) return true;
  // The app cut it (FOOD_TURN_CHARS): the stored text starts with the copy.
  return app.text.trim().length >= FOOD_TURN_CHARS && st.startsWith(a);
}

export function threadTurnsMemory(opts: {
  /** The request's load of this thread: its turn facts, or null for no open
   *  thread of this user. */
  stored: Promise<StoredTurns | null>;
  /** The turns the app sent with this message (foodContext recentTurns). */
  recent: { role: "user" | "drona"; text: string }[];
  /** The store read for turns not in memory (FoodThreadStore.turnsFrom). */
  fetch: (fromSeq: number, limit: number) => Promise<ThreadTurn[] | null>;
}): ThreadTurnsMemory {
  const held = new Map<number, ThreadTurn>();
  let seeded: Promise<number> | null = null;
  const lastSeq = () =>
    (seeded ??= opts.stored.catch(() => null).then((st) => {
      const last = st?.lastSeq ?? 0;
      if (!st || !last) return 0;
      if (st.lastTurn) held.set(st.lastTurn.seq, st.lastTurn);
      if (st.firstText !== null) held.set(1, { seq: 1, role: "user", text: st.firstText });
      const app = opts.recent.at(-1);
      // Checked against the newest stored turn before anything is placed.
      if (app && st.lastTurn && st.lastTurn.seq === last && sameTurn(st.lastTurn, app)) {
        const k = Math.min(opts.recent.length, last);
        opts.recent.slice(-k).forEach((t, i) => {
          const seq = last - k + 1 + i;
          if (!held.has(seq)) held.set(seq, { seq, role: t.role, text: t.text });
        });
      }
      return last;
    }));
  const read = async (fromSeq: number, limit: number): Promise<ThreadTurn[] | null> => {
    const last = await lastSeq();
    if (!last) return null;
    const to = Math.min(last, fromSeq + limit - 1);
    const missing: number[] = [];
    for (let s = fromSeq; s <= to; s++) if (!held.has(s)) missing.push(s);
    if (missing.length) {
      const lo = missing[0], hi = missing[missing.length - 1];
      const got = await opts.fetch(lo, hi - lo + 1);
      if (got === null) return null;
      for (const t of got) if (!held.has(t.seq)) held.set(t.seq, t);
    }
    const out: ThreadTurn[] = [];
    for (let s = fromSeq; s <= to; s++) {
      const t = held.get(s);
      if (t) out.push(t);
    }
    return out;
  };
  return {
    lastSeq,
    read,
    async first() {
      const turns = await read(1, 1);
      return turns?.find((t) => t.role === "user")?.text ?? null;
    },
  };
}

/**
 * Whether the first-message line is safe to show. The first message names the
 * meal its card holds; once that card was added (it is in the diary), or when
 * the card on screen is not that first card, the line would point the agent
 * at food already logged or no longer on screen. Shown only when the thread
 * is open, no meal card of it was added, and the card on screen is the
 * thread's first meal card.
 */
export function firstMessageSafe(
  t: { status: "open" | "closed"; cards: { id: string; kind: "meal" | "save"; status: string; created_at: string }[] } | null,
  onScreenCardId: string | null,
): boolean {
  if (!t || t.status !== "open" || !onScreenCardId) return false;
  const meals = t.cards.filter((c) => c.kind === "meal")
    .sort((a, b) => (Date.parse(a.created_at) - Date.parse(b.created_at)) || a.id.localeCompare(b.id));
  if (meals.some((c) => c.status === "added")) return false;
  return meals[0]?.id === onScreenCardId;
}

/** The thread lines' input (WarmThread) from the turns memory: null when the
 *  thread has no stored turns. `showFirst` false leaves the first message out
 *  (firstMessageSafe) and reads nothing for it. */
export async function warmThreadFrom(mem: ThreadTurnsMemory, showFirst = true): Promise<WarmThread | null> {
  const turns = await mem.lastSeq();
  if (!turns) return null;
  return { first: showFirst ? await mem.first() : null, turns };
}

/** read_thread is worth offering: the thread has turns the messages do not. */
export function hasOlderTurns(
  warm: WarmThread | null | undefined,
  recentTurns: { role: "user" | "drona"; text: string }[] | undefined,
  text?: string,
): boolean {
  return !!warm && warm.turns > storedRecentCount(recentTurns, text);
}

/**
 * How many of the app's recent turns are stored turns. The app copies its
 * turns BEFORE it adds the message being sent (app/(app)/nutrition.tsx
 * `const turns = turnsRef.current.slice(); pushTurn('user', t)`), so the
 * message in flight is not among them and every recent turn is a stored one.
 * A client that did send it as its last turn would make the count one too
 * high, so a last user turn that IS this message is not counted.
 */
export function storedRecentCount(recentTurns: { role: "user" | "drona"; text: string }[] | undefined, text?: string): number {
  const turns = recentTurns ?? [];
  const last = turns.at(-1);
  const inFlight = !!text && last?.role === "user" && flat(last.text) === flat(text);
  return turns.length - (inFlight ? 1 : 0);
}

/**
 * The thread lines for the opening message: the first message once it is no
 * longer in the recent turns, and (with
 * read_thread) how many older turns there are. Null when there is nothing.
 */
export function warmThreadText(
  warm: WarmThread | null | undefined,
  recentTurns: { role: "user" | "drona"; text: string }[] | undefined,
  canReadThread: boolean,
  /** The message being answered (storedRecentCount). */
  text?: string,
): string | null {
  if (!warm) return null;
  const parts: string[] = [];
  if (warm.first && !inRecent(warm.first, recentTurns)) {
    parts.push(`First message of this thread: ${JSON.stringify(flat(warm.first).slice(0, QUOTE_CHARS))}`);
  }
  const kept = storedRecentCount(recentTurns, text);
  if (canReadThread && warm.turns > kept) {
    parts.push(
      `This thread has ${warm.turns} earlier turns; the messages above carry the last ${kept}. read_thread reads the ` +
        "older ones by turn number, from 1.",
    );
  }
  return parts.length ? `(${parts.join("\n")})` : null;
}

/** Said to the agent, naming only the warm tools this run has. */
export function warmNote(tools: { recall: boolean; readThread: boolean; searchThreads: boolean; matches: boolean }): string | null {
  const s = [
    tools.recall
      ? "recall_food shows what the user's own food memory holds for a food: their numbers per 100 g, the amount they " +
        "usually log, how often and when, where the numbers came from, and a dish's parts. It changes nothing on the " +
        "card."
      : null,
    tools.matches
      ? "Memory matches, in a parse_food result or the opening message, are what the app's check (Jev) already decided " +
        "for that food against the user's own foods: a chosen one is the remembered food the parse used for that line; " +
        "a near one scored below what the parse needs, and was not used."
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
