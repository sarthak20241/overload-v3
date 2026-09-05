/**
 * "Just log it": the server writes the diary itself.
 *
 * In review mode the parse comes back to the app and the user taps Add. In this
 * mode send IS the commit: the user typed, hit send, and may have closed the
 * app already. So the parse keeps running after the client hangs up, and on a
 * good result the SERVER writes meals + meal_entries with the user's own JWT
 * (RLS holds; nothing here runs as admin).
 *
 * Structural like parseMeal.ts: no supabase-js types. index.ts adapts the real
 * client to `AutoLogStore`; the tests hand in a fake.
 *
 * Idempotency. The client keeps a pending list and may re-send the SAME
 * client_id after a network drop. Two guards:
 *   1. Every entry this send writes carries `meal_entries.client_id`. A retry
 *      looks those up first and replays them as "logged" instead of writing
 *      again. This is the guard that matters when the section's meal row
 *      already existed (the second auto-log of the day into Lunch).
 *   2. Every MEAL row this send creates carries a per-section id derived from
 *      client_id (`sectionClientId`), and meals(user_id, client_id) is unique
 *      (0047). One send can create two sections ("eggs for breakfast, dal at
 *      lunch"), and the index allows one row per id, so the raw client_id
 *      cannot go on both. The derivation is deterministic, so a concurrent
 *      duplicate send collides at the index and recovers the winner's row.
 */
import { implausibleLine, type MealType, type ParsedItem } from "./parseMeal.ts";

export type AutoLogSkip = "declined" | "implausible" | "write_error";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export interface AutoLogRequest {
  /** True only when the client asked AND supplied a uuid client_id. Without
   *  the id there is no idempotency key, so the request is treated as review
   *  mode rather than logging something a retry could double. */
  autoLog: boolean;
  clientId: string | null;
  /** The diary day the entries land on, YYYY-MM-DD in the user's zone. The
   *  composer works on past days too, so this is `log_date` when sent and the
   *  request's `local_date` otherwise. */
  logDate: string | null;
  /** JS getTimezoneOffset semantics: minutes to ADD to local time to reach
   *  UTC (IST is -330). Turns logDate into a UTC window for the meals lookup. */
  tzOffsetMin: number;
}

export function readAutoLogRequest(
  body: Record<string, unknown>,
  localDate: string | null,
): AutoLogRequest {
  const clientId = isUuid(body.client_id) ? body.client_id.toLowerCase() : null;
  const rawLogDate = body.log_date;
  const logDate = typeof rawLogDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawLogDate)
    ? rawLogDate
    : localDate;
  const rawTz = body.tz_offset_min;
  const tzOffsetMin = typeof rawTz === "number" && Number.isFinite(rawTz) && Math.abs(rawTz) <= 16 * 60
    ? Math.round(rawTz)
    : 0;
  return {
    autoLog: body.auto_log === true && clientId !== null,
    clientId,
    logDate,
    tzOffsetMin,
  };
}

/**
 * The stream's cancellation policy.
 *
 * Review mode: the client hanging up aborts the model calls, because nobody
 * will see the result and the tokens would be spent for no one. Just log it:
 * the client hanging up is EXPECTED (they closed the app trusting it), so
 * cancel() is a no-op and the parse runs through to the diary write. Scoped to
 * the flag only; review mode keeps abort-on-cancel exactly as before.
 */
export function parseAbortFor(detached: boolean): { signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel() {
      if (!detached) controller.abort();
    },
  };
}

// ── Sections ─────────────────────────────────────────────────────────────────

export interface AutoLogSection {
  meal_type: MealType;
  items: ParsedItem[];
}

/** Group lines by the section the parser stamped on them, first-seen order.
 *  A line without one (older build, proposal) takes the meal-level fallback,
 *  the same rule lib/dietData's sectionsOf applies on the client. */
export function groupIntoSections(items: ParsedItem[], fallback: MealType): AutoLogSection[] {
  const out: AutoLogSection[] = [];
  for (const it of items) {
    const m = it.meal_type ?? fallback;
    const sec = out.find((s) => s.meal_type === m);
    if (sec) sec.items.push(it);
    else out.push({ meal_type: m, items: [it] });
  }
  return out;
}

/** The safety valve. Trust mode is for ordinary meals, not for the one the
 *  parser itself doubts: any line that trips implausibleLine (163 g of protein
 *  in two lattes) sends the WHOLE meal back to the review card. Returns the
 *  reason, or null when every line is fine to log. */
export function autoLogBlocker(items: ParsedItem[]): string | null {
  for (const it of items) {
    const bad = implausibleLine(it);
    if (bad) return `${it.food_name}: ${bad}`;
  }
  return null;
}

// ── Per-section idempotency ids ──────────────────────────────────────────────

const SECTION_CODE: Record<MealType, string> = {
  breakfast: "a0",
  lunch: "a1",
  dinner: "a2",
  snack: "a3",
};

/** The client_id a created meal row carries for one section of a send: the
 *  send's uuid with its last two hex digits replaced by a per-section code.
 *  120 random bits remain, so collisions are not a practical concern, and the
 *  client can recompute the same four ids to tell "this send created that
 *  meal" from "it landed in a meal that already existed". */
export function sectionClientId(clientId: string, mealType: MealType): string {
  const id = clientId.toLowerCase();
  return id.slice(0, -2) + SECTION_CODE[mealType];
}

export function sectionClientIds(clientId: string): string[] {
  return (Object.keys(SECTION_CODE) as MealType[]).map((m) => sectionClientId(clientId, m));
}

// ── Day window ───────────────────────────────────────────────────────────────

/** The user's calendar day as a UTC window, plus the logged_at a NEW meal row
 *  gets: now for today (keep the real time), local noon for any other day so
 *  the row lands squarely inside the window. Mirrors lib/dietData's dayRange +
 *  loggedAtFor, which the client's own writes use. */
export function dayWindow(
  logDate: string,
  tzOffsetMin: number,
  nowMs: number = Date.now(),
): { start: string; end: string; loggedAt: string } {
  const [y, m, d] = logDate.split("-").map(Number);
  const offsetMs = tzOffsetMin * 60_000;
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) + offsetMs;
  const endMs = Date.UTC(y, m - 1, d, 23, 59, 59, 999) + offsetMs;
  const isToday = nowMs >= startMs && nowMs <= endMs;
  const loggedAtMs = isToday ? nowMs : Date.UTC(y, m - 1, d, 12, 0, 0, 0) + offsetMs;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    loggedAt: new Date(loggedAtMs).toISOString(),
  };
}

// ── The write ────────────────────────────────────────────────────────────────

export interface AutoLogEntryRow {
  meal_id: string;
  food_id: string | null;
  food_name: string;
  quantity: number;
  serving_unit: string;
  grams_logged: number;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  sugar_g: null;
  sat_fat_g: null;
  sodium_mg: null;
  position: number;
  logged_via: "ai_auto";
  source: ParsedItem["source"];
  client_id: string;
}

/** What the write needs from the database. index.ts adapts the user-scoped
 *  supabase-js client; the tests use an in-memory fake. */
export interface AutoLogStore {
  /** Entries an earlier attempt of this send already wrote. */
  entriesByClientId(clientId: string): Promise<{ id: string; meal_id: string }[]>;
  mealsById(ids: string[]): Promise<{ id: string; meal_type: MealType; client_id: string | null }[]>;
  /** An existing meal of this type inside the day window, if any. */
  findMeal(mealType: MealType, startIso: string, endIso: string): Promise<string | null>;
  /** `conflict` is the unique-index violation on (user_id, client_id). */
  createMeal(
    row: { meal_type: MealType; logged_at: string; client_id: string },
  ): Promise<{ id: string } | { conflict: true } | { error: string }>;
  mealByClientId(clientId: string): Promise<string | null>;
  countEntries(mealId: string): Promise<number>;
  insertEntries(rows: AutoLogEntryRow[]): Promise<{ ids: string[] } | { error: string }>;
  deleteEntries(ids: string[]): Promise<void>;
  deleteMealIfEmpty(mealId: string): Promise<void>;
}

export interface LoggedSection {
  meal_type: MealType;
  meal_id: string;
  entry_ids: string[];
  /** This send created the meal row, so Undo may remove it once empty. */
  created_meal: boolean;
}

export type AutoLogWrite =
  | { logged: { sections: LoggedSection[] }; replayed: boolean }
  | { error: string };

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Port of lib/dietData's logParsedMeal: group by section, find-or-create each
 * section's meal row on the diary day, batch-insert that section's lines with
 * the parser's FINAL macros. Sections are written in sequence and a failure
 * part-way undoes what already landed, so the day never ends up with
 * breakfast logged and lunch missing from a message that named both.
 */
export async function writeAutoLog(
  store: AutoLogStore,
  args: {
    clientId: string;
    items: ParsedItem[];
    fallbackMeal: MealType;
    logDate: string;
    tzOffsetMin: number;
    nowMs?: number;
  },
): Promise<AutoLogWrite> {
  const clientId = args.clientId.toLowerCase();
  const createdIds = new Set(sectionClientIds(clientId));

  // Retry of a send that already landed: hand back what is there.
  const prior = await store.entriesByClientId(clientId);
  if (prior.length > 0) {
    return { logged: { sections: await replay(store, prior, createdIds) }, replayed: true };
  }

  const { start, end, loggedAt } = dayWindow(args.logDate, args.tzOffsetMin, args.nowMs);
  const done: LoggedSection[] = [];

  const rollback = async () => {
    for (const s of done) {
      if (s.entry_ids.length > 0) await store.deleteEntries(s.entry_ids);
      if (s.created_meal) await store.deleteMealIfEmpty(s.meal_id);
    }
  };

  for (const section of groupIntoSections(args.items, args.fallbackMeal)) {
    let mealId = await store.findMeal(section.meal_type, start, end);
    let createdMeal = false;
    if (!mealId) {
      const sid = sectionClientId(clientId, section.meal_type);
      const created = await store.createMeal({ meal_type: section.meal_type, logged_at: loggedAt, client_id: sid });
      if ("conflict" in created) {
        // A concurrent attempt of this same send got there first. Its entries
        // are the truth now (or will be in a moment): do not write a second
        // copy on top. Undo our own partial work and replay theirs.
        await rollback();
        const theirs = await store.entriesByClientId(clientId);
        return { logged: { sections: await replay(store, theirs, createdIds) }, replayed: true };
      }
      if ("error" in created) {
        await rollback();
        return { error: created.error };
      }
      mealId = created.id;
      createdMeal = true;
    }

    const base = await store.countEntries(mealId);
    const rows: AutoLogEntryRow[] = section.items.map((it, idx) => ({
      meal_id: mealId as string,
      food_id: it.food_id,
      food_name: it.food_name,
      quantity: it.quantity,
      serving_unit: it.serving_label,
      grams_logged: r1(it.grams),
      kcal: r0(it.kcal),
      protein_g: r1(it.protein_g),
      carb_g: r1(it.carb_g),
      fat_g: r1(it.fat_g),
      // The parser returns fiber per line; sugar/sat_fat/sodium are not parsed,
      // so they stay null (nullable as of 0069), same as the client's write.
      fiber_g: it.fiber_g == null ? null : r1(it.fiber_g),
      sugar_g: null,
      sat_fat_g: null,
      sodium_mg: null,
      position: base + idx,
      logged_via: "ai_auto",
      source: it.source,
      client_id: clientId,
    }));
    const inserted = await store.insertEntries(rows);
    if ("error" in inserted) {
      if (createdMeal) await store.deleteMealIfEmpty(mealId);
      await rollback();
      return { error: inserted.error };
    }
    done.push({ meal_type: section.meal_type, meal_id: mealId, entry_ids: inserted.ids, created_meal: createdMeal });
  }

  return { logged: { sections: done }, replayed: false };
}

/** Rebuild the sections of an earlier attempt from its entries. */
async function replay(
  store: AutoLogStore,
  entries: { id: string; meal_id: string }[],
  createdIds: Set<string>,
): Promise<LoggedSection[]> {
  const byMeal = new Map<string, string[]>();
  for (const e of entries) {
    const list = byMeal.get(e.meal_id) ?? [];
    list.push(e.id);
    byMeal.set(e.meal_id, list);
  }
  const meals = await store.mealsById([...byMeal.keys()]);
  return meals.map((m) => ({
    meal_type: m.meal_type,
    meal_id: m.id,
    entry_ids: byMeal.get(m.id) ?? [],
    created_meal: m.client_id !== null && createdIds.has(m.client_id.toLowerCase()),
  }));
}
