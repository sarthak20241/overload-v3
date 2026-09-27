// Precise, our sources first: Jev decides WHAT KIND of food a line is and
// WHICH of our own rows (if any) is that exact food, so the web is only paid
// for when nothing we hold is the same food.
//
// Measured before this existed: 23 of 27 Precise web lookups were plain foods
// whose web answer equalled the USDA row already in `foods` (almonds 579, pear
// 57, kiwi 61, chia 486, walnuts 654). The web cost money and added nothing.
//
// Split of work, the same one every Jev use in this repo follows:
//   - Search (code) is RECALL: loose on purpose, top candidates by name.
//   - Jev is JUDGEMENT: "what kind of food is this?", "is this row the same
//     food?". It never sees a number, because it is not a calculator.
//   - Code is the GATE: a confidence floor, a brand check and per-kind rules
//     decide whether Jev's pick is served. A miss costs one web lookup; a false
//     match serves the wrong food with a confident badge, so the gate leans to
//     the miss.
//
// Runtime-agnostic (no Deno globals, no URL imports) so the eval in
// scripts/precise-match drives this exact file.
//
// NOTHING FROM scripts/precise-match/cases.ts MAY APPEAR IN THE POLICY TEXT
// BELOW. The examples here are deliberately different foods; the eval stays
// held-out (feedback: no eval-overfit prompts).

import type { JevChoiceAnswer, JevQuestion } from "./jev.ts";

export type FoodKind = "plain" | "packaged" | "restaurant" | "dish";
export const FOOD_KINDS: FoodKind[] = ["plain", "packaged", "restaurant", "dish"];

/** The line as the split step extracted it. */
export interface MatchItem {
  name: string;
  brand: string | null;
}

/** One row our search returned. `source` is the foods.source value, or
 *  "precise" for a Precise cache row. */
export interface MatchCandidate {
  id: string;
  name: string;
  brand: string | null;
  source: string;
  /** Per 100 g. Never shown to Jev; code uses them to tell whether two rows Jev
   *  split its confidence between are the same answer (see decideMatch). */
  kcal?: number | null;
  protein_g?: number | null;
}

// ── State: every food of the meal in one request ────────────────────────────
//
// Jev answers every question in a request against one state, and adding
// questions barely moves its latency, so a whole meal goes in one call: foods
// are keyed f1..fN and each question names its food.

export function foodKey(i: number): string {
  return `f${i + 1}`;
}

export function mealState(items: MatchItem[]): { foods: Array<{ id: string; name: string; brand: string | null }> } {
  return { foods: items.map((it, i) => ({ id: foodKey(i), name: it.name, brand: it.brand })) };
}

const foodRef = (key: string) => `food ${key} in "foods"`;

// ── Question 1: what kind of food ───────────────────────────────────────────

export function kindQuestion(key: string): JevQuestion {
  return {
    type: "choice",
    instructions:
      `What kind of food is ${foodRef(key)}? Judge by what the words name, not by how healthy it is. ` +
      "A brand or product line makes it packaged, even for a simple food. A named restaurant, " +
      "chain or cafe makes it restaurant. Made food with neither is a dish.",
    criteria: {
      plain: "One ingredient with no brand, raw or simply cooked. Examples: an apple, almonds, " +
        "boiled white rice, a grilled chicken breast, chia seeds, milk.",
      packaged: "A branded product sold in a pack with a nutrition label; a brand or product line " +
        "is named. Examples: Britannia Good Day, Amul butter, Kellogg's corn flakes.",
      restaurant: "An item from a named restaurant, chain or cafe. Examples: a Subway six-inch, " +
        "a Starbucks latte, a KFC zinger.",
      dish: "Food made from a recipe, with no brand or restaurant named: home cooking or street " +
        "food. Examples: dal tadka, poha, aloo paratha, pav bhaji.",
    },
  };
}

// ── Question 2: which of our rows is the same food ──────────────────────────

export const NO_MATCH = "none";

const MATCH_RULE: Record<FoodKind, string> = {
  plain: "the same food in the same state. Raw and cooked are different (raw rice is not cooked " +
    "rice). A dish made with this food, a flavoured or processed version, or a different food " +
    "is not it.",
  packaged: "the same product: the same brand, the same product and the same variant (flavour, " +
    "fat level, sugar-free). A generic food of the same type is not it, and another brand is " +
    "not it (Amul Gold milk is not Amul Taaza milk).",
  restaurant: "the same item from the same restaurant or chain, and the same size when a size " +
    "is given. The same kind of dish from somewhere else is not it.",
  dish: "the same dish. A different dish that shares an ingredient is not it (dal is not dal " +
    "makhani), and a single ingredient of the dish is not it.",
};

function describe(c: MatchCandidate): string {
  const brand = c.brand ? `brand ${c.brand}` : "no brand";
  return `${c.name} (${brand}, from ${c.source})`;
}

/** Candidates are keyed c1..cN in the order given. */
export function matchQuestion(key: string, kind: FoodKind, candidates: MatchCandidate[]): JevQuestion {
  const criteria: Record<string, string> = {};
  candidates.forEach((c, i) => { criteria[`c${i + 1}`] = describe(c); });
  criteria[NO_MATCH] = "None of the candidates is exactly this food.";
  return {
    type: "choice",
    instructions:
      `Which candidate is exactly ${foodRef(key)}? It must be ${MATCH_RULE[kind]} ` +
      "Word order matters: chocolate milk is not milk chocolate. Answer none when unsure.",
    criteria,
  };
}

// ── The gate ────────────────────────────────────────────────────────────────

/** Jev's pick must reach this to be served. A starting point for the eval to
 *  tune: every wrong Jev answer seen in this repo sat at or below 0.49. */
export const MATCH_FLOOR = 0.75;

/** Sources that are lab tables or our own curated rows: allowed to answer a
 *  plain food with no web lookup (owner decision 2026-09-26). */
export const REFERENCE_SOURCES = new Set(["usda", "cofid", "ciqual", "curated", "web_verified", "precise"]);

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Same brand, allowing "Amul" vs "Amul Dairy", a brand written inside the
 *  item's name ("Pintola rice cake" with no brand field), and a brand written
 *  inside the ROW's name: Open Food Facts files Maggi under brand "Nestle" with
 *  "Nestle Maggi Masala Noodles" as the name, and USDA's chain rows carry no
 *  brand at all ("Whopper (Burger King)"). */
export function sameBrand(item: MatchItem, c: MatchCandidate): boolean {
  const cb = norm(c.brand);
  const ib = norm(item.brand);
  const cn = norm(c.name);
  if (ib && cn.includes(ib)) return true;
  if (!cb) return false;
  if (ib) return ib.includes(cb) || cb.includes(ib);
  return norm(item.name).includes(cb);
}

export type MatchDecision =
  | { match: MatchCandidate; confidence: number }
  | {
    match: null;
    reason: "no_answer" | "none" | "below_floor" | "unknown_pick" | "brand" | "kind" | "uncorroborated";
    confidence: number;
  };

/** Rows the public types in. One can carry a pack's per-SERVING numbers in the
 *  per-100 g columns and still add up (Lay's "classic salted chips" at 100 kcal
 *  with 1.3 / 9.4 / 6.3 g: an 18 g serving), so its own numbers cannot expose
 *  it. Such a row is served only when another candidate gives the same
 *  numbers; lab tables and our own checked rows need no second opinion. */
export const CROWD_SOURCES = new Set(["off"]);

/** Two rows are the same ANSWER when their numbers agree: kcal within 10% and
 *  protein within 2 g or 20%. Jev spreads its confidence across rows that are
 *  equally right ("Banana" 89 and "Banana, raw" 97 drew 0.44 and the rest), so
 *  a floor on the single top pick misses foods it had right; a floor on the
 *  group of rows that give the same numbers does not. A row with different
 *  numbers (brown rice cooked with butter, 11% higher) never joins the group,
 *  so a split with it stays a low-confidence miss. Arithmetic, so code. */
export function sameNumbers(a: MatchCandidate, b: MatchCandidate): boolean {
  if (a.id === b.id) return true;
  const ka = a.kcal ?? null, kb = b.kcal ?? null;
  if (ka === null || kb === null) return false;
  if (Math.abs(ka - kb) > 0.10 * Math.max(ka, kb, 1)) return false;
  const pa = a.protein_g ?? null, pb = b.protein_g ?? null;
  if (pa === null || pb === null) return true;
  return Math.abs(pa - pb) <= Math.max(2, 0.2 * Math.max(pa, pb));
}

/** Why the gate refuses a row, or null when it may be served. */
function gateReason(kind: FoodKind, item: MatchItem, c: MatchCandidate): "brand" | "kind" | null {
  if (norm(item.brand) && !sameBrand(item, c)) return "brand";
  if (kind === "plain" && (c.brand || !REFERENCE_SOURCES.has(c.source))) return "kind";
  if ((kind === "packaged" || kind === "restaurant") && !sameBrand(item, c)) return "brand";
  return null;
}

/**
 * Whether Jev's answer is served, and which row. Code has the last word:
 *   1. Jev's top option is none: no match.
 *   2. The rows that give the same numbers as Jev's top pick form one answer;
 *      their probabilities add up, and that sum must reach the floor.
 *   3. The row served is the most probable row in that group that passes the
 *      gate: plain food takes only an unbranded reference row (a lab table or
 *      our curated rows), packaged / restaurant need the same brand or chain,
 *      and a branded line never takes another brand's row. So Jev picking an
 *      Open Food Facts "Curd" still serves the curated "Curd / Dahi" beside it.
 *   4. A crowd-sourced row (Open Food Facts) needs another candidate that gives
 *      the same numbers, or it is not served (see CROWD_SOURCES).
 */
export function decideMatch(
  kind: FoodKind,
  item: MatchItem,
  candidates: MatchCandidate[],
  answer: JevChoiceAnswer | null,
  floor = MATCH_FLOOR,
): MatchDecision {
  if (!answer) return { match: null, reason: "no_answer", confidence: 0 };
  if (answer.choice === NO_MATCH) return { match: null, reason: "none", confidence: answer.confidence };
  const idxOf = (key: string) => Number(key.replace(/^c/, "")) - 1;
  const top = candidates[idxOf(answer.choice)];
  if (!top) return { match: null, reason: "unknown_pick", confidence: answer.confidence };

  const prob = (i: number) => answer.probabilities?.[`c${i + 1}`] ?? (i === idxOf(answer.choice) ? answer.confidence : 0);
  const group = candidates
    .map((c, i) => ({ c, p: prob(i) }))
    .filter((x) => sameNumbers(x.c, top));
  const confidence = Math.min(1, group.reduce((sum, x) => sum + x.p, 0));
  if (confidence < floor) return { match: null, reason: "below_floor", confidence };

  const served = group
    .filter((x) => gateReason(kind, item, x.c) === null)
    .sort((a, b) => b.p - a.p)[0];
  if (!served) return { match: null, reason: gateReason(kind, item, top) ?? "kind", confidence };
  if (CROWD_SOURCES.has(served.c.source) && !candidates.some((c) => c.id !== served.c.id && sameNumbers(c, served.c))) {
    return { match: null, reason: "uncorroborated", confidence };
  }
  return { match: served.c, confidence };
}

/** Jev's kind answer, or null below the floor (the caller then treats the
 *  line as packaged, the kind that never takes a reference row, so an unsure
 *  kind can only cost a web lookup, never a wrong match). */
export const KIND_FLOOR = 0.6;
export function decideKind(answer: JevChoiceAnswer | null, floor = KIND_FLOOR): FoodKind | null {
  if (!answer || answer.confidence < floor) return null;
  return (FOOD_KINDS as string[]).includes(answer.choice) ? (answer.choice as FoodKind) : null;
}
