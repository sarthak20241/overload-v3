// The user's own food memory: foods THIS user logged in the last 10 days answer
// their next log first, so the same person gets the same number every time.
//
// Owner decision 2026-09-27:
//   - per user, never shared; read through the user's own client, so RLS keeps
//     it theirs
//   - last 10 days, as two lists: frequent (logged 2+ times) and recent
//   - a food Jev confidently says IS the line (same food, same preparation)
//     overrides every other source and the web
//   - where an entry may be reused depends on the tier that produced its
//     numbers: precise serves every tier, thorough serves thorough and fast,
//     fast (an accepted Quick guess) serves fast only. Numbers the user typed
//     or picked themselves are theirs and serve every tier. A line we cannot
//     attribute counts as fast, the safe side.
//   - skipped on a follow-up turn: that is where "double check" and "that's
//     wrong" live, and the user is asking us NOT to repeat ourselves
//
// Runtime-agnostic (no Deno globals), like ourSources.ts.

import { askJev, type JevDeps, type JevQuestion } from "./jev.ts";
import { MATCH_LEVELS } from "./preciseMatch.ts";

export type ParseTierName = "fast" | "thorough" | "precise";

export const MEMORY_DAYS = 10;
/** A safety bound on the list, not a relevance cut: Jev only ever sees the
 *  MEMORY_SHORTLIST closest names. An earlier cap of 30 dropped older foods
 *  before the shortlist ran, and an active logger's Precise "raw chicken
 *  breast" from 6 days back never reached Jev (found on live data, 2026-09-27). */
export const MEMORY_MAX_FOODS = 300;
/** Rows Jev scores per line, closest names first. */
export const MEMORY_SHORTLIST = 10;
/** Jev's chance that a remembered food IS this line, needed to serve it. Same
 *  floor as the catalog match (preciseMatch.MATCH_FLOOR). */
export const MEMORY_FLOOR = 0.75;

/** One logged line, as read from meal_entries + meals. */
export interface MemoryEntry {
  food_name: string;
  food_id: string | null;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  grams: number | null;
  quantity: number | null;
  serving_unit: string | null;
  source: string | null;
  logged_via: string | null;
  tier: string | null;
  logged_at: string;
}

/** A remembered food: the newest eligible entry for a name, as per 100 g. */
export interface MemoryFood {
  key: string;
  name: string;
  food_id: string | null;
  per100: { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null };
  /** One unit of what the user logged it in ("1 piece" = 50 g), when it was
   *  not a weight. */
  serving: { label: string; grams: number } | null;
  source: string | null;
  /** The tier this food may serve down to (see level()). */
  level: ParseTierName;
  times: number;
  last_logged_at: string;
}

const RANK: Record<ParseTierName, number> = { fast: 1, thorough: 2, precise: 3 };

/** How high a tier an entry's numbers may serve. */
export function entryLevel(e: Pick<MemoryEntry, "tier" | "source" | "logged_via">): ParseTierName {
  if (e.source === "manual" || e.logged_via === "manual") return "precise";
  if (e.tier === "precise" || e.tier === "thorough" || e.tier === "fast") return e.tier;
  return "fast";
}

/** May a food remembered at `level` answer a parse running in `tier`? */
export function servesTier(level: ParseTierName, tier: ParseTierName): boolean {
  return RANK[level] >= RANK[tier];
}

export function memoryKey(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const MASS_UNIT = /^(g|gm|gms|gram|grams|kg|ml|mls|l|litre|liter)$/i;
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The foods this parse may use: entries from the window that may serve `tier`,
 * newest entry per name (the numbers the user accepted most recently), frequent
 * foods first, then recent ones, capped. Entries without a weight cannot give a
 * per-100 and are left out.
 */
export function buildMemory(
  entries: MemoryEntry[],
  tier: ParseTierName,
  now: Date = new Date(),
  days = MEMORY_DAYS,
): MemoryFood[] {
  const since = now.getTime() - days * 86_400_000;
  const byKey = new Map<string, { newest: MemoryEntry; times: number }>();
  for (const e of entries) {
    const at = Date.parse(e.logged_at);
    if (!Number.isFinite(at) || at < since) continue;
    if (!e.food_name?.trim() || !(e.grams && e.grams > 0) || !(e.kcal >= 0)) continue;
    if (!servesTier(entryLevel(e), tier)) continue;
    const key = memoryKey(e.food_name);
    if (!key) continue;
    const got = byKey.get(key);
    if (!got) byKey.set(key, { newest: e, times: 1 });
    else {
      got.times++;
      if (Date.parse(e.logged_at) > Date.parse(got.newest.logged_at)) got.newest = e;
    }
  }
  const foods: MemoryFood[] = [...byKey.entries()].map(([key, { newest: e, times }]) => {
    const f = 100 / (e.grams as number);
    const unit = (e.serving_unit ?? "").trim();
    const perUnit = e.quantity && e.quantity > 0 ? (e.grams as number) / e.quantity : null;
    return {
      key,
      name: e.food_name.trim(),
      food_id: e.food_id,
      per100: {
        kcal: r1(e.kcal * f),
        protein_g: r1(e.protein_g * f),
        carb_g: r1(e.carb_g * f),
        fat_g: r1(e.fat_g * f),
        fiber_g: e.fiber_g == null ? null : r1(e.fiber_g * f),
      },
      serving: unit && !MASS_UNIT.test(unit) && perUnit && perUnit > 0 && perUnit <= 2000
        ? { label: unit, grams: r1(perUnit) }
        : null,
      source: e.source,
      level: entryLevel(e),
      times,
      last_logged_at: e.logged_at,
    };
  });
  const newestFirst = (a: MemoryFood, b: MemoryFood) => Date.parse(b.last_logged_at) - Date.parse(a.last_logged_at);
  const frequent = foods.filter((f) => f.times >= 2).sort((a, b) => b.times - a.times || newestFirst(a, b));
  const recent = foods.filter((f) => f.times < 2).sort(newestFirst);
  return [...frequent, ...recent].slice(0, MEMORY_MAX_FOODS);
}

/** Character-trigram similarity, 0..1. Cheap, typo- and order-tolerant. */
function trigrams(s: string): Set<string> {
  const t = `  ${memoryKey(s)} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}
export function nameSimilarity(a: string, b: string): number {
  const x = trigrams(a), y = trigrams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}

/** The foods Jev scores for one line: all of them when few, else the closest
 *  names. Similarity only orders; Jev decides. */
export function shortlist(foods: MemoryFood[], line: string, n = MEMORY_SHORTLIST): MemoryFood[] {
  if (foods.length <= n) return foods;
  return [...foods]
    .map((f) => ({ f, s: nameSimilarity(f.name, line) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.f);
}

const MEMORY_RULE = "the same food prepared the same way. Raw and cooked differ, and so do " +
  "grilled, fried and boiled. When either names a brand, the brand must match. A dish made with " +
  "the food, or a different variant (low fat, sugar-free, flavour), is not it.";

export function memoryQuestions(line: { name: string; brand: string | null }, foods: MemoryFood[]): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  foods.forEach((f, i) => {
    out[`m${i + 1}`] = {
      type: "score",
      instructions:
        `How well does this food the user logged before match food f1 in "foods"? ` +
        `Logged before: ${f.name}. A match must be ${MEMORY_RULE} Word order matters: chocolate milk is not milk chocolate.`,
      criteria: MATCH_LEVELS,
    };
  });
  return out;
}

/** Same energy, within 10% (or 5 kcal for very light foods). */
function sameNumbers(a: MemoryFood, b: MemoryFood): boolean {
  const x = a.per100.kcal, y = b.per100.kcal;
  return Math.abs(x - y) <= Math.max(0.1 * Math.max(x, y), 5);
}

export type MemoryDecision =
  | { food: MemoryFood; confidence: number }
  | { food: null; reason: "no_foods" | "no_answer" | "below_floor"; confidence: number };

/**
 * The food to serve, from Jev's per-row chance of "exactly this food". Below
 * the floor nothing is served. When two rows clear it with different numbers,
 * the one logged most recently wins: that is what the user accepted last, and a
 * fixed rule keeps the answer the same every time.
 */
export function decideMemory(foods: MemoryFood[], scores: Array<number | null>, floor = MEMORY_FLOOR): MemoryDecision {
  if (foods.length === 0) return { food: null, reason: "no_foods", confidence: 0 };
  if (scores.every((s) => s === null)) return { food: null, reason: "no_answer", confidence: 0 };
  const passing = foods
    .map((f, i) => ({ f, p: scores[i] ?? 0 }))
    .filter((x) => x.p >= floor);
  if (passing.length === 0) {
    return { food: null, reason: "below_floor", confidence: Math.max(...scores.map((s) => s ?? 0)) };
  }
  const best = passing.sort((a, b) => b.p - a.p)[0];
  const rivals = passing.filter((x) => x !== best && !sameNumbers(x.f, best.f));
  if (rivals.length === 0) return { food: best.f, confidence: best.p };
  const newest = [best, ...rivals].sort((a, b) => Date.parse(b.f.last_logged_at) - Date.parse(a.f.last_logged_at))[0];
  return { food: newest.f, confidence: newest.p };
}

export interface MemoryMatch {
  food: MemoryFood | null;
  confidence: number;
  trace: Record<string, unknown>;
}

/** Ask Jev whether one of the user's remembered foods is this line. Never
 *  throws; any failure is "no match" and the tier runs as it would have. */
export async function matchMemory(
  jev: JevDeps,
  foods: MemoryFood[],
  line: { name: string; brand: string | null },
): Promise<MemoryMatch> {
  const trace: Record<string, unknown> = { item: line.name, remembered: foods.length };
  try {
    const list = shortlist(foods, line.brand && !memoryKey(line.name).includes(memoryKey(line.brand)) ? `${line.brand} ${line.name}` : line.name);
    trace.shortlist = list.length;
    if (list.length === 0) {
      trace.decision = { match: null, reason: "no_foods" };
      return { food: null, confidence: 0, trace };
    }
    const res = await askJev(
      { foods: [{ id: "f1", name: line.name, brand: line.brand }] },
      memoryQuestions(line, list),
      jev,
    ).catch(() => null);
    const scores = list.map((_, i) => {
      if (!res?.ok) return null;
      const a = res.response.answers[`m${i + 1}`] as { type?: string; probabilities?: Record<string, number> } | undefined;
      return a?.type === "score" ? (a.probabilities?.["2"] ?? 0) : null;
    });
    trace.rows = list.map((f, i) => ({ name: f.name.slice(0, 60), kcal: f.per100.kcal, level: f.level, score: scores[i] === null ? null : Math.round((scores[i] as number) * 100) / 100 }));
    const d = decideMemory(list, scores);
    if (!d.food) {
      trace.decision = { match: null, reason: res && !res.ok ? `jev_${res.failure}` : d.reason, conf: Math.round(d.confidence * 100) / 100 };
      return { food: null, confidence: d.confidence, trace };
    }
    trace.decision = { match: d.food.name.slice(0, 60), kcal: d.food.per100.kcal, level: d.food.level, logged: d.food.last_logged_at.slice(0, 10), conf: Math.round(d.confidence * 100) / 100 };
    return { food: d.food, confidence: d.confidence, trace };
  } catch (e) {
    trace.decision = { match: null, reason: "threw", error: String(e).slice(0, 120) };
    return { food: null, confidence: 0, trace };
  }
}

/** The card's note for a line answered from memory: "Same as you logged on
 *  Sep 26", on the user's own calendar when their zone is known. */
export function memoryNote(food: MemoryFood, timeZone?: string | null): string {
  const d = new Date(food.last_logged_at);
  if (!Number.isFinite(d.getTime())) return "Same as you logged before";
  try {
    const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: timeZone || "UTC" }).format(d);
    return `Same as you logged on ${day}`;
  } catch {
    const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
    return `Same as you logged on ${day}`;
  }
}
