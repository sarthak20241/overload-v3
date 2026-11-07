// Food box threads: the server's durable copy of one food box conversation.
// Plan: .planning/precise-food-logger-plan.md, sections 3 and 4 (step 1b).
// Tables: supabase/migrations/20261106120000_food_threads.sql.
//
// The app keeps the hot copy (the open card, the recent turns) and sends it
// with each message, as before. This is the safe copy: every turn, and every
// version of every card, so a card can be brought back after it left the
// screen. The ids are the app's own (a uuid it makes when a thread or a card
// starts), so the app never waits on the server to learn them, and a card's
// next version is always base_version + 1.
//
// FOOD_THREADS:
//   off     nothing is read or written (default)
//   shadow  each message is written after the answer is sent. Nothing is read
//           and nothing a user sees changes.
//   on      also read: the agent sees the thread's index line (each earlier
//           card's foods by line id) and gets copy_lines (add lines from an
//           earlier card to the card on screen) and read_card; with NO card
//           on screen also restore_card. A message beside no card goes to
//           the agent when the thread has earlier cards.
//
// A thread ends when its card is added (owner decision), so "bring back that
// card" reaches only cards of the thread still open: after Add, the added
// card is in the diary (copy_lines reads the diary too), and a new thread
// has no earlier cards.

import type { FoodBarThread } from "./foodBar.ts";
import type { CardLine } from "./foodContext.ts";
import type { MealType, ParsedItem } from "./parseMeal.ts";
import { parseRecipe, type RecipePart } from "../_shared/foodOrigin.ts";

export type FoodThreadsMode = "off" | "shadow" | "on";

export function parseFoodThreadsMode(v: string | undefined | null): FoodThreadsMode {
  const m = (v ?? "").trim().toLowerCase();
  return m === "shadow" || m === "on" ? m : "off";
}

/** A thread with no message for this long is closed (owner decision). */
export const THREAD_IDLE_MS = 30 * 60_000;

/** The server's slack on top: the APP decides when 30 minutes are up (it
 *  starts a new thread id), so a message the app still sends on a thread a
 *  little past the line, by network time or clock drift, is the same chat. */
export const THREAD_IDLE_GRACE_MS = 5 * 60_000;

/** One card line as stored. `line_id` is stable across the card's versions. */
export interface ThreadLine {
  line_id: string;
  name: string;
  said_name?: string | null;
  grams: number | null;
  quantity: number | null;
  unit: string | null;
  kcal: number;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  fiber_g?: number | null;
  source?: string | null;
  /** The catalog row (food_id), so a restored line keeps its link. */
  source_ref?: string | null;
  confidence?: string | null;
  note?: string | null;
  meal_type?: MealType | null;
  /** A dish built from its parts (source "recipe"): its parts, so a restored
   *  or copied line still has them (food_card_lines.recipe). */
  recipe?: RecipePart[] | null;
}

export interface StoredCard {
  id: string;
  kind: "meal" | "save";
  version: number;
  status: "open" | "added" | "discarded" | "replaced";
  meal_type: MealType | null;
  created_at: string;
  /** The current version's lines. */
  lines: ThreadLine[];
  /** The highest line number any version used (food_cards.max_line_no). */
  max_line_no?: number;
  /** The newest version that HAS lines in food_card_lines, and those lines.
   *  The same as version/lines unless the current version is empty (the
   *  card was cleared on screen): then the version before it. Null: no
   *  version of this card has lines. The index names only these versions,
   *  so it never points at a version with nothing in it. */
  last_version?: number | null;
  last_lines?: ThreadLine[];
}

export interface StoredThread {
  id: string;
  user_id: string;
  status: "open" | "closed";
  last_at: string;
  /** Highest turn seq written so far (0 for none). */
  last_seq: number;
  cards: StoredCard[];
}

/** What the app says about its thread with a message (body.thread). */
export interface ThreadRequest {
  id: string;
  /** The meal card on screen, and the version the app's copy started from. */
  card_id: string | null;
  base_version: number | null;
  /** A save card the server drafts this turn gets this id. */
  next_card_id: string | null;
  /** A thread the app ended (its card was added), to close on the server. */
  closed: { id: string; why: "added" | "replaced" } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** body.thread, checked. Null when absent or malformed: then nothing is stored. */
export function readThreadRequest(v: unknown): ThreadRequest | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !UUID.test(o.id)) return null;
  const id = (x: unknown) => (typeof x === "string" && UUID.test(x) ? x : null);
  // Capped: a card changes a few dozen times at most, and a huge value would
  // overflow the integer column.
  const base = typeof o.base_version === "number" && Number.isInteger(o.base_version) && o.base_version >= 1 && o.base_version <= 100_000
    ? o.base_version : null;
  const c = o.closed as Record<string, unknown> | undefined;
  const closed = c && id(c.id) && (c.why === "added" || c.why === "replaced") ? { id: c.id as string, why: c.why as "added" | "replaced" } : null;
  return { id: o.id, card_id: id(o.card_id), base_version: id(o.card_id) ? base : null, next_card_id: id(o.next_card_id), closed };
}

export function threadIsOpen(t: Pick<StoredThread, "status" | "last_at">, nowMs: number): boolean {
  return t.status === "open" && nowMs - Date.parse(t.last_at) < THREAD_IDLE_MS + THREAD_IDLE_GRACE_MS;
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Give the next version's lines their ids. A line that is the same food as a
 * line of the version before keeps that line's id; every other line gets a
 * new one, above the highest id the card has used. So an edit keeps [L2] as
 * L2, a removal never renumbers what is left, and an added line is new.
 * Same food means the same name (brackets dropped): a rename gets a new id,
 * the same as a removal and an addition. Two lines with one name keep their
 * ids in order.
 */
export function withLineIds<T extends { name: string }>(prev: ThreadLine[] | null, next: T[], usedUpTo = 0): (T & { line_id: string })[] {
  const taken = new Set<string>();
  const free = new Map<string, string[]>();
  // `usedUpTo`: the highest id the card ever had, so a new line never takes
  // the id of one that was removed.
  let max = usedUpTo;
  // Two passes: the exact name first ("Rice (cooked)" keeps its own id when
  // "Rice (raw)" is also on the card), then the name without its brackets
  // ("Rice (cooked)" edited to "Rice (cooked, 150 g)").
  const exact = new Map<string, string[]>();
  const full = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const l of prev ?? []) {
    const n = Number(l.line_id.replace(/^L/, ""));
    if (Number.isFinite(n)) max = Math.max(max, n);
    const k = nameKey(l.name);
    free.set(k, [...(free.get(k) ?? []), l.line_id]);
    const e = full(l.name);
    exact.set(e, [...(exact.get(e) ?? []), l.line_id]);
  }
  const ids: (string | undefined)[] = next.map((l) => {
    const keep = exact.get(full(l.name))?.find((id) => !taken.has(id));
    if (keep) taken.add(keep);
    return keep;
  });
  return next.map((l, i) => {
    const keep = ids[i] ?? free.get(nameKey(l.name))?.find((id) => !taken.has(id));
    const line_id = keep ?? `L${++max}`;
    taken.add(line_id);
    return { ...l, line_id };
  });
}

/** The highest line number among these lines ("L7" is 7). */
export function maxLineNo(lines: ThreadLine[] | null | undefined): number {
  return Math.max(0, ...(lines ?? []).map((l) => Number(l.line_id.replace(/^L/, ""))).filter(Number.isFinite));
}

export function itemsAsLines(items: ParsedItem[], prev: ThreadLine[] | null, usedUpTo = 0): ThreadLine[] {
  return withLineIds(prev, items.map((i) => ({
    name: i.food_name,
    said_name: i.said_name ?? null,
    grams: i.grams ?? null,
    quantity: i.quantity ?? null,
    unit: i.serving_label ?? null,
    kcal: Math.round(i.kcal),
    protein_g: i.protein_g ?? null,
    carb_g: i.carb_g ?? null,
    fat_g: i.fat_g ?? null,
    fiber_g: i.fiber_g ?? null,
    source: i.source ?? null,
    source_ref: i.food_id ?? null,
    confidence: i.confidence ?? null,
    note: i.assumption ?? null,
    meal_type: i.meal_type ?? null,
    recipe: i.source === "recipe" ? parseRecipe(i.recipe) : null,
  })), usedUpTo);
}

/** The app's card (previous_items as CardLine) as stored lines, for a thread
 *  that has no copy of it yet. */
export function cardAsLines(card: CardLine[], prev: ThreadLine[] | null = null, usedUpTo = 0): ThreadLine[] {
  return withLineIds(prev, card.map((l) => ({
    name: l.food_name,
    said_name: l.said_name ?? null,
    grams: l.grams ?? null,
    quantity: l.quantity ?? null,
    unit: l.serving_label ?? null,
    kcal: Math.round(l.kcal),
    protein_g: l.protein_g ?? null,
    carb_g: l.carb_g ?? null,
    fat_g: l.fat_g ?? null,
    fiber_g: l.fiber_g ?? null,
    source: l.source ?? null,
    source_ref: l.food_id ?? null,
    confidence: l.confidence ?? null,
    note: l.assumption ?? null,
    meal_type: l.meal_type ?? null,
    recipe: l.source === "recipe" ? parseRecipe(l.recipe) : null,
  })), usedUpTo);
}

/** A stored line back as a parsed item. Stored numbers come back as they
 *  were (kcal was stored rounded); a macro or weight the line never had comes
 *  back as 0, which is ParsedItem's shape for "none". A line written from a
 *  parse always has them. */
export function lineAsItem(l: ThreadLine, mealDefault: MealType): ParsedItem {
  const src = l.source;
  return {
    food_id: l.source_ref ?? null,
    food_name: l.name,
    quantity: l.quantity ?? 1,
    serving_label: l.unit ?? "serving",
    grams: l.grams ?? 0,
    kcal: Math.round(l.kcal),
    protein_g: l.protein_g ?? 0,
    carb_g: l.carb_g ?? 0,
    fat_g: l.fat_g ?? 0,
    fiber_g: l.fiber_g ?? null,
    source: src === "catalog" || src === "off" || src === "fatsecret" || src === "web" || src === "estimate" || src === "recipe"
      ? src
      : "manual",
    assumption: l.note ?? null,
    confidence: l.confidence === "high" || l.confidence === "low" ? l.confidence : "medium",
    meal_type: l.meal_type ?? mealDefault,
    ...(l.said_name ? { said_name: l.said_name } : {}),
    // Parts only on a recipe line: a line that is something else now would
    // carry parts that no longer add up to it.
    ...(src === "recipe" && l.recipe?.length ? { recipe: l.recipe } : {}),
  };
}

/** The version of a card the index and the tools show: the current one, or,
 *  for a card cleared on screen, the newest version that still has lines.
 *  Null when no version has lines. */
export function shownOf(c: StoredCard): { version: number; lines: ThreadLine[] } | null {
  if (c.lines.length) return { version: c.version, lines: c.lines };
  if (c.last_version != null && c.last_lines?.length) return { version: c.last_version, lines: c.last_lines };
  return null;
}

/** Short refs for the model: C1, C2, ... in the order the cards were made.
 *  Only meal cards with a version that has lines: a save card is not a meal
 *  to bring back, and a card that was brought back lives on as its copy
 *  ('replaced'). */
export function cardRefs(t: StoredThread): Map<string, StoredCard> {
  // Numbered over EVERY meal card in the order made, then filtered: a card
  // that is replaced or emptied keeps its number, so C2 means the same card
  // in every message of the thread, including ones quoted in earlier turns.
  // Ties on created_at (two cards in one instant) break on id, so the order
  // is the same on every load.
  const meals = t.cards.filter((c) => c.kind === "meal")
    .sort((a, b) => (Date.parse(a.created_at) - Date.parse(b.created_at)) || a.id.localeCompare(b.id));
  // A card emptied on screen (every line taken off) stays listed while an
  // earlier version has lines: "bring back the lunch I just cleared" brings
  // back its last lines (threadForAgent restore).
  return new Map(
    meals.map((c, i) => [`C${i + 1}`, c] as const).filter(([, c]) => c.status !== "replaced" && shownOf(c) !== null),
  );
}

/** The index line's budget (owner, 2026-11-06). The newest earlier card lists
 *  every food; the others at most INDEX_NAMES_PER_CARD each; at most
 *  INDEX_MAX_CARDS cards, and INDEX_MAX_NAMES names in all. */
export const INDEX_MAX_CARDS = 3;
export const INDEX_NAMES_PER_CARD = 8;
export const INDEX_MAX_NAMES = 40;

/** A line's name for the index: the name with its bracketed detail dropped
 *  ("Paneer sabji (60 g paneer, oil)" is "Paneer sabji"), so the index holds
 *  names only, never a number. */
function indexName(name: string): string {
  return name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").replace(/[\s,;]+$/, "").trim() || name.trim();
}

export interface ThreadIndex {
  /** The line for the hot context. */
  text: string;
  /** For the trace: the line's size, and how much of the thread it shows. */
  chars: number;
  names: number;
  cards_listed: number;
  cards_total: number;
}

/**
 * The thread's index for the hot context (plan section 4): the earlier cards
 * by ref, each with its foods as line ids and names, newest first, within the
 * budget above. Names only: the numbers stay in the store, and the tools
 * (copy_lines, restore_card, read_card) fetch them. An older version of a card
 * is reached through those tools, never listed here. Null when there is
 * nothing beyond the card on screen.
 */
export function threadIndex(t: StoredThread | null, onScreenCardId: string | null): ThreadIndex | null {
  if (!t) return null;
  const others = [...cardRefs(t)].filter(([, c]) => c.id !== onScreenCardId);
  if (others.length === 0) return null;
  const listed = others.slice(-INDEX_MAX_CARDS).reverse();
  let budget = INDEX_MAX_NAMES;
  let names = 0;
  const desc = listed.map(([ref, c], i) => {
    const shown = shownOf(c)!;
    const what = `${c.meal_type ?? "meal"} card${c.lines.length === 0 ? " (cleared on screen)" : ""}`;
    // The newest card: all its foods, up to the overall cap. The rest: a few.
    const take = Math.max(0, Math.min(i === 0 ? budget : INDEX_NAMES_PER_CARD, budget, shown.lines.length));
    budget -= take;
    names += take;
    const foods = shown.lines.slice(0, take).map((l) => `${l.line_id} ${indexName(l.name)}`);
    const more = shown.lines.length - take;
    if (more > 0) foods.push(`+${more} more`);
    return `[${ref} v${shown.version}] ${what}: ${foods.join(", ")}`;
  });
  const hidden = others.length - listed.length;
  const text = `index: earlier cards in this thread, newest first: ${desc.join("; ")}.` +
    (hidden > 0 ? ` ${hidden} older ${hidden === 1 ? "card" : "cards"} not listed (read_card C1, C2, ...).` : "");
  return { text, chars: text.length, names, cards_listed: listed.length, cards_total: others.length };
}

/** The index line alone (threadIndex's text), or null. */
export function threadIndexLine(t: StoredThread | null, onScreenCardId: string | null): string | null {
  return threadIndex(t, onScreenCardId)?.text ?? null;
}

// ── The store ────────────────────────────────────────────────────────────────

export interface FoodThreadStore {
  /** The thread with each card's current lines, or null (missing, or not this user's). */
  load(userId: string, threadId: string): Promise<StoredThread | null>;
  /** Create the thread with the app's id when it does not exist yet. False
   *  when the id is taken by another user's thread. */
  ensure(userId: string, threadId: string): Promise<boolean>;
  addTurns(threadId: string, fromSeq: number, turns: { role: "user" | "drona"; text: string }[], clientId: string | null): Promise<void>;
  /** A new card (the app's id) with its first lines as `version` (1 for a new
   *  card; the app's own version when adopting a card the server never saw). */
  createCard(threadId: string, cardId: string, kind: "meal" | "save", lines: ThreadLine[], clientId: string | null, mealType: MealType | null, version?: number): Promise<void>;
  /** The one conditional write: version base + 1, only if the card is at base
   *  or behind it (food_card_write). An older base writes nothing.
   *  Idempotency rides on clientId alone: food_card_write skips a write whose
   *  p_client_id equals the card's last_client_id. A NULL p_client_id has no
   *  such guard (NULL never equals NULL), so a retried write with no id lands
   *  a second version. Every caller here passes the send's id; index.ts skips
   *  the whole thread write when a send has none. */
  writeCard(cardId: string, base: number, lines: ThreadLine[], clientId: string | null, status?: StoredCard["status"], mealType?: MealType | null): Promise<{ version: number; written: boolean; retry?: boolean }>;
  cardAt(cardId: string, version: number): Promise<ThreadLine[] | null>;
  /** Close one of THIS user's threads. Another user's id changes nothing. */
  close(userId: string, threadId: string, why: "added" | "idle" | "replaced"): Promise<void>;
  /** Mark a card of this thread (a restored card's source becomes 'replaced'). */
  setCardStatus(threadId: string, cardId: string, status: StoredCard["status"]): Promise<void>;
  touch(threadId: string): Promise<void>;
}

type Db = {
  // deno-lint-ignore no-explicit-any
  from(t: string): any;
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): any;
};

const num = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

export function rowAsLine(r: Record<string, unknown>): ThreadLine {
  return {
    line_id: String(r.line_id),
    name: String(r.name ?? ""),
    said_name: typeof r.said_name === "string" ? r.said_name : null,
    grams: num(r.grams),
    quantity: num(r.quantity),
    unit: typeof r.unit === "string" ? r.unit : null,
    kcal: num(r.kcal) ?? 0,
    protein_g: num(r.protein_g),
    carb_g: num(r.carb_g),
    fat_g: num(r.fat_g),
    fiber_g: num(r.fiber_g),
    source: typeof r.source === "string" ? r.source : null,
    source_ref: typeof r.source_ref === "string" ? r.source_ref : null,
    confidence: typeof r.confidence === "string" ? r.confidence : null,
    note: typeof r.note === "string" ? r.note : null,
    meal_type: typeof r.meal_type === "string" ? r.meal_type as MealType : null,
    // Absent on a row written before 20261108120000, or not a recipe: null.
    recipe: parseRecipe(r.recipe),
  };
}

/** The tables, through the service-role client (no client can reach them). */
export function supabaseThreadStore(admin: Db): FoodThreadStore {
  return {
    async load(userId, threadId) {
      const { data: t, error } = await admin.from("food_threads").select("id, user_id, status, last_at").eq("id", threadId).maybeSingle();
      if (error || !t || t.user_id !== userId) return null;
      const [{ data: cards, error: cardsErr }, { data: seq, error: seqErr }] = await Promise.all([
        admin.from("food_cards").select("id, kind, version, status, meal_type, created_at, max_line_no").eq("thread_id", threadId).order("created_at"),
        admin.from("food_thread_turns").select("seq").eq("thread_id", threadId).order("seq", { ascending: false }).limit(1),
      ]);
      // Thrown, never read as "no cards" or "no turns": either would lose a
      // card write or a restore (the same rule as the lines read below).
      if (cardsErr) throw new Error(`food_cards: ${cardsErr.message}`);
      if (seqErr) throw new Error(`food_thread_turns: ${seqErr.message}`);
      const list = (cards ?? []) as Record<string, unknown>[];
      // Each card's CURRENT version only. Reading every version and filtering
      // here would hit PostgREST's 1000-row cap on a long thread and drop
      // lines silently.
      let lines: Record<string, unknown>[] = [];
      if (list.length) {
        const res = await admin.from("food_card_lines").select("*")
          .or(list.map((c) => `and(card_id.eq.${c.id},version.eq.${Number(c.version)})`).join(","))
          .order("line_no");
        // Thrown, never read as empty: empty cards drop out of the index and
        // restore would say "not found" for a card that is there.
        if (res.error) throw new Error(`food_card_lines: ${res.error.message}`);
        lines = (res.data ?? []) as Record<string, unknown>[];
      }
      const current = (c: Record<string, unknown>) =>
        lines.filter((l) => l.card_id === c.id && Number(l.version) === Number(c.version)).map(rowAsLine);
      // A card whose current version has no lines (cleared on screen): its
      // newest version that does, so the index names a version that exists.
      // One small read per such card; cleared cards are rare.
      const last = new Map<string, { version: number; lines: ThreadLine[] }>();
      await Promise.all(list.filter((c) => c.kind === "meal" && Number(c.version) > 1 && current(c).length === 0).map(async (c) => {
        const res = await admin.from("food_card_lines").select("*").eq("card_id", c.id).lt("version", Number(c.version))
          .order("version", { ascending: false }).order("line_no").limit(200);
        if (res.error) throw new Error(`food_card_lines: ${res.error.message}`);
        const rows = (res.data ?? []) as Record<string, unknown>[];
        if (!rows.length) return;
        const v = Number(rows[0].version);
        last.set(String(c.id), { version: v, lines: rows.filter((r) => Number(r.version) === v).map(rowAsLine) });
      }));
      return {
        id: String(t.id),
        user_id: String(t.user_id),
        status: t.status === "closed" ? "closed" : "open",
        last_at: String(t.last_at),
        last_seq: Number((seq ?? [])[0]?.seq ?? 0),
        cards: list.map((c) => {
          const now = current(c);
          const prev = last.get(String(c.id));
          return {
            id: String(c.id),
            kind: c.kind === "save" ? "save" as const : "meal" as const,
            version: Number(c.version),
            status: (["open", "added", "discarded", "replaced"].includes(String(c.status)) ? c.status : "open") as StoredCard["status"],
            meal_type: (typeof c.meal_type === "string" ? c.meal_type : null) as MealType | null,
            created_at: String(c.created_at),
            max_line_no: Number(c.max_line_no ?? 0),
            lines: now,
            last_version: now.length ? Number(c.version) : prev?.version ?? null,
            last_lines: now.length ? now : prev?.lines ?? [],
          };
        }),
      };
    },
    async ensure(userId, threadId) {
      // Look first: after a thread's first message the row exists, and an
      // insert would fail on every later message.
      const { data } = await admin.from("food_threads").select("user_id").eq("id", threadId).maybeSingle();
      if (data) return data.user_id === userId;
      const ins = await admin.from("food_threads").insert({ id: threadId, user_id: userId }).select("id");
      if (!ins.error) return true;
      // Two first messages raced: the other one made it.
      const again = await admin.from("food_threads").select("user_id").eq("id", threadId).maybeSingle();
      return again.data?.user_id === userId;
    },
    async addTurns(threadId, fromSeq, turns, clientId) {
      const rowsFrom = (seq: number) => turns.filter((t) => t.text.trim()).map((t, i) => ({
        thread_id: threadId, seq: seq + i, role: t.role, text: t.text.slice(0, 4000), client_id: clientId,
      }));
      const rows = rowsFrom(fromSeq);
      // A retried send (same client id) adds its turns once.
      if (clientId && rows.length) {
        const { data: seen } = await admin.from("food_thread_turns").select("seq").eq("thread_id", threadId).eq("client_id", clientId).limit(1);
        if (seen?.length) {
          await admin.from("food_threads").update({ last_at: new Date().toISOString() }).eq("id", threadId);
          return;
        }
      }
      if (rows.length) {
        let { error } = await admin.from("food_thread_turns").insert(rows);
        // Two quick messages read the same last seq: the second one's seqs
        // are taken. Read the newest seq again and try once more.
        // The same send racing itself: its turns are already in. Done.
        if (error?.code === "23505" && clientId && /uq_food_thread_turns_client/.test(`${error.message} ${error.details ?? ""}`)) return;
        if (error?.code === "23505") {
          const { data } = await admin.from("food_thread_turns").select("seq").eq("thread_id", threadId).order("seq", { ascending: false }).limit(1);
          ({ error } = await admin.from("food_thread_turns").insert(rowsFrom(Number(data?.[0]?.seq ?? 0) + 1)));
        }
        if (error) throw new Error(`food_thread_turns: ${error.message}`);
      }
      await admin.from("food_threads").update({ last_at: new Date().toISOString() }).eq("id", threadId);
    },
    async createCard(threadId, cardId, kind, lines, clientId, mealType, version = 1) {
      const { error } = await admin.rpc("food_card_create", {
        p_card_id: cardId, p_thread_id: threadId, p_kind: kind, p_lines: lines, p_client_id: clientId, p_meal_type: mealType, p_version: version,
      });
      if (!error) return;
      // A retried send making the same card again: it is already in THIS
      // thread, so the work is done. Any other clash is a real failure.
      if (error.code === "23505") {
        const { data } = await admin.from("food_cards").select("thread_id").eq("id", cardId).maybeSingle();
        if (data?.thread_id === threadId) return;
      }
      throw new Error(`food_card_create: ${error.message}`);
    },
    async writeCard(cardId, base, lines, clientId, status, mealType) {
      const { data, error } = await admin.rpc("food_card_write", {
        p_card_id: cardId, p_base_version: base, p_lines: lines, p_client_id: clientId, p_status: status ?? null,
        p_meal_type: mealType ?? null,
      });
      if (error) throw new Error(`food_card_write: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as { out_version?: number; out_written?: boolean; out_retry?: boolean } | null;
      if (!row || typeof row.out_version !== "number") console.log(`[food_threads] food_card_write returned no row for card ${cardId}`);
      return { version: Number(row?.out_version ?? base), written: row?.out_written === true, retry: row?.out_retry === true };
    },
    async cardAt(cardId, version) {
      const { data, error } = await admin.from("food_card_lines").select("*").eq("card_id", cardId).eq("version", version).order("line_no");
      if (error || !data?.length) return null;
      return (data as Record<string, unknown>[]).map(rowAsLine);
    },
    async close(userId, threadId, why) {
      await admin.from("food_threads").update({ status: "closed", closed_why: why })
        .eq("id", threadId).eq("user_id", userId).eq("status", "open");
    },
    async touch(threadId) {
      await admin.from("food_threads").update({ last_at: new Date().toISOString() }).eq("id", threadId);
    },
    async setCardStatus(threadId, cardId, status) {
      await admin.from("food_cards").update({ status, updated_at: new Date().toISOString() }).eq("id", cardId).eq("thread_id", threadId);
    },
  };
}

// ── One message, written ────────────────────────────────────────────────────

/** What the box served for a message, reduced to what the thread keeps. */
export type ServedForThread =
  | { kind: "meal"; items: ParsedItem[]; corrects: boolean }
  | { kind: "save"; name: string; lines: ThreadLine[] }
  | { kind: "reply" }
  | { kind: "cleared" };

/**
 * Write one message to its thread: the two turns, then the card change, as one
 * conditional write on top of the app's base version. Never throws: a failed
 * write (a clash on a card id, a stale base, a database error) is logged and
 * returns ok false. It runs after the answer is sent (index.ts keepAlive), so
 * it can never turn a food answer into an error.
 *
 * `card` is the app's copy of the card on screen (previous_items). When the
 * server has no copy of that card yet (the thread is new to it, or shadow
 * started mid-thread), the app's copy is stored as the base first.
 */
export async function recordThreadMessage(store: FoodThreadStore, args: {
  userId: string;
  req: ThreadRequest;
  clientId: string | null;
  userText: string;
  dronaText: string | null;
  card: CardLine[];
  served: ServedForThread;
  mealType: MealType | null;
  /** This answer brought back that card (restore_card): the copy on screen
   *  takes its place, so the source is marked 'replaced'. */
  restoredFrom?: string | null;
  nowMs?: number;
  log?: (m: string) => void;
}): Promise<{ ok: boolean; card_version: number | null }> {
  const log = args.log ?? (() => {});
  const { req } = args;
  try {
    if (req.closed && req.closed.id !== req.id) await store.close(args.userId, req.closed.id, req.closed.why);
    if (!(await store.ensure(args.userId, req.id))) {
      log(`[food_threads] thread ${req.id} is not this user's; nothing written`);
      return { ok: false, card_version: null };
    }
    const t = await store.load(args.userId, req.id);
    if (!t) return { ok: false, card_version: null };
    // No close on idle here: the app owns the 30-minute rule (it starts a new
    // thread id), so a message on this id is still this chat. Closing it would
    // shut restore off for the rest of a chat the app is still in. A thread
    // the app left behind just stops getting messages, and reads treat it as
    // closed (threadIsOpen).
    // A failed turn write is logged and the card is still written: the card
    // is the part a user can lose.
    await store.addTurns(t.id, t.last_seq + 1, [
      { role: "user", text: args.userText },
      ...(args.dronaText ? [{ role: "drona" as const, text: args.dronaText }] : []),
    ], args.clientId).catch((e) => log(`[food_threads] turns not written: ${String(e).slice(0, 160)}`));

    const onScreen = req.card_id ? t.cards.find((c) => c.id === req.card_id) ?? null : null;
    // The app's card is stored as the base, at the app's own version, when
    // the server has none of it. Both sides then count from the same number.
    // When the server has it, the app's copy is still the base lines: the
    // user can change lines on the card (edit, remove) with no message, so
    // the copy the app sent is the newer one. Ids carry over by name. When
    // the server is BEHIND the app's count (a missed write), the write below
    // lands at the app's count (food_card_write allows a base ahead).
    // An empty card from the app is an empty base (every line was taken off
    // on screen), never a fall back to the server's older lines.
    let base = onScreen && req.card_id
      ? {
        ...onScreen,
        version: Math.max(onScreen.version, req.base_version ?? 0),
        lines: cardAsLines(args.card, onScreen.lines, Math.max(maxLineNo(onScreen.lines), onScreen.max_line_no ?? 0)),
      }
      : onScreen;
    if (req.card_id && !onScreen && args.card.length) {
      const v = req.base_version ?? 1;
      await store.createCard(t.id, req.card_id, "meal", cardAsLines(args.card), null, args.mealType, v);
      base = { id: req.card_id, kind: "meal", version: v, status: "open", meal_type: args.mealType, created_at: new Date().toISOString(), lines: cardAsLines(args.card) };
    }

    const s = args.served;
    if (s.kind === "save") {
      if (req.next_card_id) await store.createCard(t.id, req.next_card_id, "save", s.lines, args.clientId, null);
      return { ok: true, card_version: base?.version ?? null };
    }
    if (s.kind === "reply") return { ok: true, card_version: base?.version ?? null };
    if (s.kind === "cleared") {
      if (base) {
        let w = await store.writeCard(base.id, req.base_version ?? base.version, [], args.clientId, "discarded");
        // Same rule as a meal: an older base is written on top, once.
        if (!w.written && !w.retry && w.version > (req.base_version ?? 0)) {
          w = await store.writeCard(base.id, w.version, [], args.clientId, "discarded");
        }
        return { ok: w.written || !!w.retry, card_version: w.version };
      }
      return { ok: true, card_version: null };
    }
    // A meal: new lines join the card, a correction replaces it.
    if (base) {
      const used = Math.max(maxLineNo(base.lines), maxLineNo(onScreen?.lines), onScreen?.max_line_no ?? 0);
      // New lines joining the card: the card's own lines stay exactly as
      // stored (an unknown macro stays unknown, ids unchanged), and the new
      // ones get new ids above every id the card used. A correction rebuilds
      // the card, keeping ids by name.
      const lines = s.corrects
        ? itemsAsLines(s.items, base.lines, used)
        : [...base.lines, ...itemsAsLines(s.items, null, used)];
      let w = await store.writeCard(base.id, req.base_version ?? base.version, lines, args.clientId, undefined, args.mealType);
      // A base older than the server's: another write got there first (a
      // second device, or an answer the app never counted). The app's card is
      // what the user sees, so it is written on top of the server's version,
      // once. Every older version is kept, so nothing is lost, and the copy
      // never silently stops moving. A retried send is not rewritten.
      // Known cost: the server's count then runs ahead of the app's, so each
      // later message takes this path too and the numbers stay apart. The
      // model names cards by ref (C1) and asks for the latest version, so
      // that does not change what restore brings back. Sending the server's
      // version back to the app needs the read before the answer, which only
      // FOOD_THREADS=on does; it goes with turning that on.
      if (!w.written && !w.retry && w.version > (req.base_version ?? 0)) {
        log(`[food_threads] card ${base.id} base ${req.base_version} behind the server (${w.version}); written on top`);
        w = await store.writeCard(base.id, w.version, lines, args.clientId, undefined, args.mealType);
      }
      if (!w.written && !w.retry) log(`[food_threads] card ${base.id} not written (server at ${w.version})`);
      // A restore onto a card still named on screen (emptied there): the
      // restored lines are now this card, so the source is marked too.
      if ((w.written || w.retry) && args.restoredFrom && args.restoredFrom !== base.id) {
        await store.setCardStatus(t.id, args.restoredFrom, "replaced")
          .catch((e) => log(`[food_threads] restored card not marked: ${String(e).slice(0, 120)}`));
      }
      // A deduplicated retry is fine, not a failure.
      return { ok: w.written || !!w.retry, card_version: w.version };
    }
    if (req.next_card_id) {
      await store.createCard(t.id, req.next_card_id, "meal", itemsAsLines(s.items, null), args.clientId, args.mealType);
      // A restore's source is marked only once its copy is saved, so a
      // failed write never leaves the thread with neither.
      if (args.restoredFrom) {
        await store.setCardStatus(t.id, args.restoredFrom, "replaced")
          .catch((e) => log(`[food_threads] restored card not marked: ${String(e).slice(0, 120)}`));
      }
      return { ok: true, card_version: 1 };
    }
    return { ok: true, card_version: null };
  } catch (e) {
    log(`[food_threads] write failed: ${String(e).slice(0, 200)}`);
    return { ok: false, card_version: null };
  }
}

// ── In memory: the same rules, for tests and the eval ────────────────────────

/** A FoodThreadStore in memory, with the database's one conditional write
 *  rule (food_card_write). Used by foodThreads.test.ts and the food box eval. */
export function memoryThreadStore(): FoodThreadStore & { dump(): { threads: Map<string, { user_id: string; status: string; last_at: string; turns: { seq: number; role: string; text: string; client_id?: string | null }[] }>; cards: Map<string, { thread_id: string; kind: "meal" | "save"; version: number; status: StoredCard["status"]; meal_type: MealType | null; created_at: string; last_client_id: string | null; max_line_no: number; versions: Map<number, ThreadLine[]> }> } } {
  const threads = new Map<string, { user_id: string; status: string; last_at: string; turns: { seq: number; role: string; text: string; client_id?: string | null }[] }>();
  const cards = new Map<string, { thread_id: string; kind: "meal" | "save"; version: number; status: StoredCard["status"]; meal_type: MealType | null; created_at: string; last_client_id: string | null; max_line_no: number; versions: Map<number, ThreadLine[]> }>();
  let tick = 0;
  const stamp = () => new Date(Date.now() + tick++).toISOString();
  const write = (cardId: string, base: number, lines: ThreadLine[], clientId: string | null, status?: StoredCard["status"], mealType?: MealType | null) => {
    const c = cards.get(cardId);
    if (!c) return { version: 0, written: false };
    if (clientId !== null && c.last_client_id === clientId) return { version: c.version, written: false, retry: true };
    if (c.version > base) return { version: c.version, written: false, retry: false };
    c.version = base + 1;
    c.last_client_id = clientId;
    if (status) c.status = status;
    if (mealType) c.meal_type = mealType;
    c.versions.set(c.version, lines.map((l) => ({ ...l })));
    c.max_line_no = Math.max(c.max_line_no, maxLineNo(lines));
    return { version: c.version, written: true };
  };
  return {
    dump: () => ({ threads, cards }),
    async load(userId, threadId) {
      const t = threads.get(threadId);
      if (!t || t.user_id !== userId) return null;
      return {
        id: threadId,
        user_id: t.user_id,
        status: t.status === "closed" ? "closed" : "open",
        last_at: t.last_at,
        last_seq: t.turns.at(-1)?.seq ?? 0,
        cards: [...cards].filter(([, c]) => c.thread_id === threadId).map(([id, c]) => {
          // The newest version with lines, the same as the database read.
          const withLines = [...c.versions].filter(([, ls]) => ls.length > 0).sort((a, b) => b[0] - a[0])[0];
          return {
            id, kind: c.kind, version: c.version, status: c.status, meal_type: c.meal_type, created_at: c.created_at, max_line_no: c.max_line_no,
            lines: (c.versions.get(c.version) ?? []).map((l) => ({ ...l })),
            last_version: withLines?.[0] ?? null,
            last_lines: (withLines?.[1] ?? []).map((l) => ({ ...l })),
          };
        }),
      };
    },
    async ensure(userId, threadId) {
      const t = threads.get(threadId);
      if (t) return t.user_id === userId;
      threads.set(threadId, { user_id: userId, status: "open", last_at: stamp(), turns: [] });
      return true;
    },
    async addTurns(threadId, fromSeq, turns, clientId) {
      const t = threads.get(threadId);
      if (!t) throw new Error("no thread");
      if (clientId && t.turns.some((y) => y.client_id === clientId)) {
        t.last_at = stamp();
        return;
      }
      turns.filter((x) => x.text.trim()).forEach((x, i) => {
        if (t.turns.some((y) => y.seq === fromSeq + i)) throw new Error("duplicate seq");
        t.turns.push({ seq: fromSeq + i, role: x.role, text: x.text, client_id: clientId });
      });
      t.last_at = stamp();
    },
    async createCard(threadId, cardId, kind, lines, clientId, mealType, version = 1) {
      if (cards.has(cardId)) {
        if (cards.get(cardId)!.thread_id === threadId) return; // a retry: already made
        throw new Error("duplicate card id");
      }
      const start = Math.max(version, 1) - 1;
      cards.set(cardId, { thread_id: threadId, kind, version: start, status: "open", meal_type: mealType, created_at: stamp(), last_client_id: null, max_line_no: 0, versions: new Map() });
      write(cardId, start, lines, clientId);
    },
    async writeCard(cardId, base, lines, clientId, status, mealType) {
      return write(cardId, base, lines, clientId, status, mealType);
    },
    async cardAt(cardId, version) {
      const v = cards.get(cardId)?.versions.get(version);
      return v ? v.map((l) => ({ ...l })) : null;
    },
    async close(userId, threadId, _why) {
      const t = threads.get(threadId);
      if (t && t.user_id === userId) t.status = "closed";
    },
    async touch(threadId) {
      const t = threads.get(threadId);
      if (t) t.last_at = stamp();
    },
    async setCardStatus(threadId, cardId, status) {
      const c = cards.get(cardId);
      if (c && c.thread_id === threadId) c.status = status;
    },
  };
}

// ── What the agent gets (FOOD_THREADS=on) ───────────────────────────────────

/** The thread as the agent sees it: the index line, and the earlier cards'
 *  lines for copy_lines, read_card and restore_card. Null when there is no
 *  open thread or nothing beyond the card on screen. */
export async function threadForAgent(
  store: FoodThreadStore,
  userId: string,
  req: ThreadRequest,
  nowMs = Date.now(),
): Promise<FoodBarThread | null> {
  const t = await store.load(userId, req.id).catch(() => null);
  // A thread the nightly job closed, or one idle past the line: no earlier
  // cards. The message is still written to it (recordThreadMessage).
  if (!t || !threadIsOpen(t, nowMs)) return null;
  const idx = threadIndex(t, req.card_id);
  if (!idx) return null;
  const refs = cardRefs(t);
  // The card on screen is not an earlier card: copying it onto itself, or
  // restoring it over itself, is never what was meant.
  const lines = async (ref: string, version: number | null) => {
    const c = refs.get(ref.trim().toUpperCase());
    if (!c || c.id === req.card_id) return null;
    const shown = shownOf(c);
    if (!shown) return null;
    const v = version ?? shown.version;
    const got = v === shown.version ? shown.lines : v === c.version ? c.lines : await store.cardAt(c.id, v);
    if (!got?.length) return null;
    return { id: c.id, ref: ref.trim().toUpperCase(), version: v, latest_version: shown.version, meal_type: c.meal_type, lines: got.map((l) => ({ ...l })) };
  };
  const out: FoodBarThread = {
    index: idx.text,
    indexStats: { chars: idx.chars, names: idx.names, cards_listed: idx.cards_listed, cards_total: idx.cards_total },
    restoredFrom: null,
    onScreenRef: [...refs].find(([, c]) => c.id === req.card_id)?.[0] ?? null,
    lines,
    restore: async (ref, version) => {
      const got = await lines(ref, version);
      if (!got) return null;
      // Only a restore that brings lines back marks its source.
      out.restoredFrom = got.id;
      const meal = got.meal_type ?? got.lines[0]?.meal_type ?? "snack";
      return { items: got.lines.map((l) => lineAsItem(l, meal)), meal_type: got.meal_type };
    },
  };
  return out;
}

/** What the box served, for recordThreadMessage. `create` is the save card's
 *  tool input (create_custom_food or create_custom_meal). */
export function servedForThread(o: {
  action: "log" | "reply" | "create" | "agent";
  create?: { tool: string; input: Record<string, unknown> } | null;
  parsed?: { items: ParsedItem[]; corrects_previous?: boolean } | null;
  cleared?: boolean;
}): ServedForThread {
  if (o.action === "create" && o.create) {
    const i = o.create.input;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const name = typeof i.name === "string" ? i.name : "Saved meal";
    const raw = Array.isArray(i.items) ? i.items as Record<string, unknown>[] : [i];
    return {
      kind: "save",
      name,
      lines: withLineIds(null, raw.map((r) => ({
        name: typeof r.name === "string" ? r.name : name,
        grams: n(r.grams), quantity: n(r.quantity) ?? 1, unit: typeof r.serving_label === "string" ? r.serving_label : "serving",
        kcal: n(r.kcal) ?? 0, protein_g: n(r.protein_g), carb_g: n(r.carb_g), fat_g: n(r.fat_g),
        source: r.estimated === true ? "estimate" : null,
      }))),
    };
  }
  if (o.action === "reply") return { kind: "reply" };
  if (o.parsed?.items.length) return { kind: "meal", items: o.parsed.items, corrects: !!o.parsed.corrects_previous };
  return o.cleared ? { kind: "cleared" } : { kind: "reply" };
}
