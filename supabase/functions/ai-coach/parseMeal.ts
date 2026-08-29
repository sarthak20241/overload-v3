// parse_meal mode: free-text food logging ("oats yogabar 50g and milk 500 ml")
// parsed into catalog-grounded meal entries. Kept separate from index.ts and
// runtime-agnostic (dependencies injected; no Deno globals, no jsr:/https:
// imports) so the eval harness in scripts/parse-meal-eval/ can drive the exact
// production pipeline from Node against real catalog data. Relative imports of
// pure-TS siblings are fine - both Deno and tsx resolve them - and the
// injected-deps rule is what actually keeps this file portable.
//
// Architecture: extract -> resolve -> decide.
//   1. EXTRACT  one fast model call, no tools: segment the text into items
//               ({name, brand, quantity, unit, prep}), or decline non-food.
//   2. RESOLVE  pure code, all items in parallel: catalog search (trigram +
//               semantic fallback via deps.searchFoods), then live Open Food
//               Facts on a miss (backfilled into `foods`, source 'off', so
//               the catalog compounds with usage). Spoon anchors (1 tbsp =
//               cup/16) are synthesized here, in code.
//   3. DECIDE   one model call with candidates inline: pick per item,
//               convert to grams, emit log_meal. Server web_search remains
//               available for named products neither lookup has (capped);
//               model estimate is the flagged last resort (food_id null).
//
// The model only MATCHES candidates and converts quantities; macros for
// catalog/off rows are recomputed server-side (verifyItems) and every line
// passes the deterministic guardrails (density clamp, Atwater, prep-state),
// so catalog-backed numbers are never model-invented.

import { nearWord } from "./textMatch.ts";
import { parseFastGrammar } from "./fastGrammar.ts";
import { brandIsIdentity, firstAcceptable } from "./acceptCandidate.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

/** Prefix for candidate ids that name NO row in `foods`. FatSecret rows cannot
 *  be persisted (their terms allow serving a request, not replicating the DB),
 *  but decide selects candidates BY id, so they still need to be addressable.
 *  These ids are resolved from the in-memory candidate map and stripped before
 *  anything reaches meal_entries, whose food_id is a real uuid FK. */
export const EPHEMERAL_ID_PREFIX = "fs:";

export function isEphemeralId(id: string | null): boolean {
  return !!id && id.startsWith(EPHEMERAL_ID_PREFIX);
}

export interface ServingOption {
  label: string;
  grams: number;
  is_default?: boolean;
}

// Candidate returned by both catalog search and the OFF lookup. Per-100
// basis matches the foods table (kcal/macros are per 100 base units).
export interface CandidateFood {
  food_id: string | null;
  name: string;
  brand: string | null;
  base_unit: "g" | "ml";
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  servings: ServingOption[];
  // 'fatsecret' rows are NOT persisted (their terms allow serving a request,
  // not replicating the DB), so those candidates carry food_id null and their
  // per-100 numbers travel with them. See fatsecret.ts.
  source: "catalog" | "off" | "fatsecret";
}

export interface ParsedItem {
  food_id: string | null;
  food_name: string;
  quantity: number;
  serving_label: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  // 'manual' never originates here: it comes back from the client when the user
  // corrected a line in the review card, and must round-trip intact.
  source: "catalog" | "off" | "fatsecret" | "web" | "estimate" | "manual";
  assumption: string | null;
  confidence: "high" | "medium" | "low";
}

// One entry in the agent's tool-call trail, captured for observability + eval.
// `input` is the tool's args; `result` is a compact summary of what it returned.
export interface ParseStep {
  iter: number;
  tool: string;
  input?: unknown;
  result?: unknown;
}

export interface ParseMealResult {
  parsed: {
    meal_type: MealType;
    items: ParsedItem[];
    drona_line: string;
    /** True when these items are a corrected version of the meal the client
     *  sent as `previousItems` and should REPLACE it. False (the default) means
     *  they are new food, so a client showing a pending meal appends them. */
    corrects_previous?: boolean;
  } | null;
  // Set when the model declined (non-food input) instead of logging.
  //
  // `cleared` marks the ONE decline that is not a refusal: the user removed the
  // last remaining line, so there is nothing left to log. The client must drop
  // the card rather than keep it, which is what it does for every other decline
  // (a decline normally means unlogged work would be lost).
  declined: { message: string; cleared?: boolean } | null;
  /** A researched alternative the user should CHOOSE, not receive silently.
   *  Set when a web lookup materially disagrees with what is on screen -
   *  usually a different variant of the same product. The client offers it as
   *  "use these / keep mine"; applying it costs no further round trip. */
  proposal?: { items: ParsedItem[]; note: string } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    web_search_requests: number;
  };
  tool_calls: string[];
  // The full tool-call trail (search_foods / lookup_packaged_food / web_search /
  // log_meal) with args + result summaries, plus how many loop turns it took.
  steps: ParseStep[];
  iterations: number;
}

export interface RecentFoodContext {
  food_name: string;
  quantity: number;
  serving_unit: string;
  /** How many times in the window. Absent on the recency fallback (a new user
   *  with too little history to rank by frequency). */
  times?: number;
}

/** A line from the meal still under review on the client, sent back with a
 *  follow-up so "make it a small one" can re-target it. */
export interface PreviousItem {
  food_id: string | null;
  food_name: string;
  quantity: number;
  serving_label: string;
  grams: number;
  // The line's current macros. Carried so an untouched line can be handed back
  // EXACTLY as it was: correction paths replace the whole meal, so anything we
  // cannot reconstruct would be silently deleted.
  kcal?: number;
  protein_g?: number;
  carb_g?: number;
  fat_g?: number;
  fiber_g?: number | null;
  source?: ParsedItem["source"];
  assumption?: string | null;
  confidence?: ParsedItem["confidence"];
}

/** An untouched previous line, rebuilt verbatim. */
function previousAsParsedItem(p: PreviousItem): ParsedItem {
  return {
    food_id: p.food_id,
    food_name: p.food_name,
    quantity: p.quantity,
    serving_label: p.serving_label,
    grams: p.grams,
    kcal: p.kcal ?? 0,
    protein_g: p.protein_g ?? 0,
    carb_g: p.carb_g ?? 0,
    fat_g: p.fat_g ?? 0,
    fiber_g: p.fiber_g ?? null,
    source: p.source ?? "estimate",
    assumption: p.assumption ?? null,
    confidence: p.confidence ?? "medium",
  };
}

/**
 * The correction contract. A correction REPLACES the meal on screen with the
 * list it returns, so a set of invariants must hold for every previous line the
 * user did not explicitly re-target (its name is not in `replacedNames`):
 *
 *   1. It must still be present.            -> keepUncoveredPrevious
 *   2. Its provenance must survive.         -> preserveManual (source, note)
 *   3. Its hand-entered numbers must survive, rescaled to any new amount.
 *                                           -> preserveManual (macros)
 *
 * A line the user DID re-target may change freely (identity, amount, numbers):
 * that is the correction they asked for. These helpers enforce the invariants
 * for everything else, because the model and the fast path are only *asked* to
 * preserve them - a prompt instruction, not something we can trust per turn.
 */

/**
 * Invariant 1: a corrected meal still contains everything it replaces. Any
 * previous line not represented in the result is appended back, unchanged.
 */
export function keepUncoveredPrevious(
  items: ParsedItem[],
  previous: PreviousItem[],
  replaced?: Set<string>,
): ParsedItem[] {
  if (previous.length === 0) return items;
  const covered = (p: PreviousItem) =>
    // A line the user explicitly re-targeted is REPLACED, not missing. Without
    // this, "actually paneer not tofu" logs both: the new paneer line never
    // word-overlaps "tofu", so the guard below reads the tofu line as dropped
    // and helpfully restores it. The guard exists to stop data loss; on an
    // identity swap it would otherwise cause data duplication.
    replaced?.has(p.food_name.toLowerCase()) ||
    items.some((it) =>
      (p.food_id && it.food_id === p.food_id) || wordsOverlap(it.food_name, p.food_name)
    );
  const missing = previous.filter((p) => !covered(p)).map(previousAsParsedItem);
  return missing.length > 0 ? [...items, ...missing] : items;
}

/**
 * Invariants 2 & 3: a hand-edited (manual) line keeps its numbers and its
 * provenance across a correction. When a correction falls through to the full
 * pipeline, decide relists the manual line from the catalog - recomputed macros,
 * source "catalog" - discarding what the user typed. For every previous manual
 * line the user did NOT re-target, restore its source/note and rescale ITS
 * macros to the line's new grams (so "make it two" doubles the user's numbers,
 * not the catalog's). A re-targeted manual line is left as decide returned it.
 */
export function preserveManual(
  items: ParsedItem[],
  previous: PreviousItem[],
  replaced?: Set<string>,
): ParsedItem[] {
  const manuals = previous.filter((p) =>
    p.source === "manual" && !replaced?.has(p.food_name.toLowerCase()) && p.grams > 0 && typeof p.kcal === "number"
  );
  if (manuals.length === 0) return items;
  return items.map((it) => {
    const m = manuals.find((p) =>
      (p.food_id && it.food_id === p.food_id) || wordsOverlap(it.food_name, p.food_name)
    );
    if (!m) return it;
    const s = it.grams > 0 ? it.grams / m.grams : 1;
    return {
      ...it,
      kcal: round1((m.kcal ?? 0) * s),
      protein_g: round1((m.protein_g ?? 0) * s),
      carb_g: round1((m.carb_g ?? 0) * s),
      fat_g: round1((m.fat_g ?? 0) * s),
      fiber_g: typeof m.fiber_g === "number" ? round1(m.fiber_g * s) : it.fiber_g,
      source: "manual",
      assumption: m.assumption ?? it.assumption,
      confidence: m.confidence ?? "high",
    };
  });
}

/**
 * Guarantee every food the user named reaches the log.
 *
 * Decide writes a fresh item list and the server only checks it is non-empty,
 * so decide can drop one of several foods ("2 roti, dal, and a glass of milk"
 * comes back without the milk) and still succeed - the user sees a short meal
 * with no error. For any extracted item not represented in decide's output, we
 * append a best-effort line built from the candidate we had already resolved
 * for it, marked as a low-confidence estimate. That makes the food VISIBLE and
 * flagged rather than silently missing, and because it is an estimate the web
 * refine (phase 2) will then try to ground it.
 */
export function reconcileExtracted(
  items: ParsedItem[],
  resolved: ResolvedItem[],
  candidatePer100: Map<string, Per100>,
): ParsedItem[] {
  if (resolved.length === 0) return items;
  const represented = (r: ResolvedItem): boolean => {
    const candIds = new Set(r.candidates.map((c) => c.food_id).filter(Boolean) as string[]);
    return items.some((it) =>
      (it.food_id && candIds.has(it.food_id)) || wordsOverlap(it.food_name, r.name)
    );
  };
  const missing = resolved.filter((r) => !represented(r)).map((r) => fallbackFromResolved(r, candidatePer100));
  return missing.length > 0 ? [...items, ...missing] : items;
}

// ── P3: code fill (skip the decide call when we are sure) ───────────────────
//
// decide is the single most expensive step in a parse (2.2s of a 7.8s meal,
// measured 2026-08-22). For "100g paneer" or "2 eggs" it adds nothing a
// deterministic function cannot do: the reranked top candidate IS the answer
// and the quantity is unambiguous. This gate decides when that is true.
//
// WHY topScore AND NOT margin. The obvious gate is "the winner beat the
// runner-up by a lot". Real traffic says otherwise: margins are tiny (0.016
// and 0.012 on the first live parse) precisely BECAUSE the top candidates are
// near-duplicates of the same food ("Egg, whole, raw" vs "Egg (Whole)"), where
// picking either is correct. A small margin there is harmless. What actually
// signals "we found the right food" is the absolute relevance of the winner,
// which was 0.83 and 0.93 on that same parse.
const SKIP_DECIDE_MIN_TOP_SCORE = 0.75;

/** Units we can convert without asking a model. */
const MASS_UNITS = new Set([
  "g", "gram", "grams", "gm", "gms",
  "ml", "millilitre", "milliliter", "millilitres", "milliliters",
]);

/** Every metric amount in a label - "100 g", "100g", "(11 g)" - built from
 *  MASS_UNITS so the two can never drift apart. Longest spelling first, so
 *  "gram" is not half-eaten by "g". */
const MASS_AMOUNT_RE = new RegExp(
  `\\d+(?:\\.\\d+)?\\s*(?:${[...MASS_UNITS].sort((a, b) => b.length - a.length).join("|")})\\b`,
  "gi",
);

/** Words that name no PIECE. "serving" is the very unit we are trying to
 *  resolve, so a label built only from these plus a metric amount tells us
 *  nothing the user's own word did not. */
const GENERIC_PORTION_WORDS = new Set([
  "serving", "servings", "portion", "portions", "per", "of", "approx", "about", "1", "one",
]);

/**
 * True for a serving that states a BASIS, not a portion.
 *
 * Two shapes, and neither can answer "how much is ONE of these?":
 *   - a bare metric amount:      "100 g", "100g", "per 100 ml", "30 g"
 *   - the per-100 basis dressed  "1 serving (100 g)", "per serving - 100 g"
 *     up as a generic serving
 *
 * Every candidate source injects one. The catalog carries a per-100 basis row,
 * FatSecret v4 adds an explicit "100 g" serving (serving_id 0) to branded foods
 * on purpose (see fatsecret.ts), and OFF passes contributor free text straight
 * through as the label, which is where the dressed-up shape comes from.
 *
 * The first shape is a pure text test, so "30 g" is caught as readily as
 * "100 g". The second is gated on exactly 100 g, because a named amount that is
 * NOT the per-100 basis is a real pack portion: "1 serving (30 g)" on a protein
 * bar means one bar, and refusing it would lose a measured weight.
 */
export function isBasisServing(sv: ServingOption): boolean {
  const words = sv.label.toLowerCase()
    .replace(MASS_AMOUNT_RE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // Nothing survived the amount: the label WAS the amount.
  if (words.length === 0) return true;
  return sv.grams === 100 && words.every((w) => GENERIC_PORTION_WORDS.has(w));
}

/** Grams for one unit of what the user said, or null when it needs judgment. */
export function gramsPerUnit(unit: string, cand: CandidateFood): { grams: number; label: string } | null {
  const u = unit.trim().toLowerCase();
  if (MASS_UNITS.has(u)) return { grams: 1, label: cand.base_unit === "ml" ? "ml" : "g" };
  // A serving anchor whose label mentions the user's word ("1 large" for
  // "large", "1 scoop (30 g)" for "scoop").
  //
  // A BASIS serving can never be that anchor, even when the words line up. The
  // user's count word is often "serving" (the grammar emits it for every
  // counted noun, see fastGrammar SHAPE 5), and "1 serving (100 g)" contains
  // it - so without this the per-100 basis matched here and the whole
  // piece-count guard below was bypassed.
  if (u) {
    const hit = cand.servings.find((sv) =>
      sv.grams > 0 && !isBasisServing(sv) && sv.label.toLowerCase().includes(u)
    );
    if (hit) return { grams: hit.grams, label: hit.label };
  }
  // A bare count ("2 eggs", "1 bar", "2 oreo biscuits" - the grammar and the
  // extract call both emit "serving" for a counted noun) resolves against the
  // row's own default, but ONLY against a serving that describes one PIECE.
  //
  // Multiplying a bare mass label by the count is the I-class bug reproduced in
  // production on 2026-08-28: "2 oreo biscuits and 1 amul cheese slice" logged
  // 200 g / 966 kcal and 100 g / 316 kcal against a true ~22 g / ~105 kcal and
  // ~20 g / ~63 kcal, because both rows carry "100 g" and nothing else. Smart
  // never hits this - buildDecideSystemPrompt spells the household weights out
  // ("2 biscuits is ~15-20 g, never 90") - and Fast skips decide entirely, so
  // the refusal here IS Fast's version of that knowledge: the caller drops to
  // the model's own est_total_g, which the fused extract call already returned
  // for exactly this reason.
  //
  // Filtering rather than rejecting also fixes the ordering: a row carrying
  // both "1 cookie (11 g)" and a default "100 g" now picks the cookie.
  if (!u || u === "serving" || u === "servings" || u === "piece" || u === "pieces") {
    const portions = cand.servings.filter((sv) => sv.grams > 0 && !isBasisServing(sv));
    const def = portions.find((sv) => sv.is_default) ?? portions[0];
    if (def) return { grams: def.grams, label: def.label };
  }
  return null;
}

export interface CodeFillOutcome {
  items: ParsedItem[];
  /** Why the gate refused, for the trace. Empty when it filled everything. */
  blockedBy: string | null;
}

/**
 * Build the meal from resolved candidates with NO model call, or refuse.
 *
 * All-or-nothing on purpose: decide emits the whole meal in one shot, so a
 * per-item mix would mean merging two sources of truth for one card. A mixed
 * meal ("2 eggs and a bhakarwadi") still pays for decide; splitting that is a
 * follow-up, not a v1 risk worth taking.
 */
export function codeFillItems(
  resolved: ResolvedItem[],
  candidatePer100: Map<string, Per100>,
): CodeFillOutcome {
  if (resolved.length === 0) return { items: [], blockedBy: "no items" };
  const out: ParsedItem[] = [];
  for (const r of resolved) {
    const top = r.candidates[0];
    if (!top || !top.food_id) return { items: [], blockedBy: `ungrounded: ${r.name}` };
    const per = candidatePer100.get(top.food_id);
    if (!per) return { items: [], blockedBy: `no per-100: ${r.name}` };
    const score = r.rerankTopScore;
    if (score === undefined) return { items: [], blockedBy: `no rerank score: ${r.name}` };
    if (score < SKIP_DECIDE_MIN_TOP_SCORE) {
      return { items: [], blockedBy: `weak match ${score.toFixed(2)}: ${r.name}` };
    }
    const per1 = gramsPerUnit(r.unit, top);
    if (!per1) return { items: [], blockedBy: `unresolvable unit "${r.unit}": ${r.name}` };
    const qty = r.quantity > 0 ? r.quantity : 1;
    const grams = round1(per1.grams * qty);
    if (!(grams > 0)) return { items: [], blockedBy: `zero grams: ${r.name}` };
    const f = grams / 100;
    out.push({
      food_id: top.food_id,
      // The USER'S phrase, not top.name. verifyItems overwrites this with the
      // row's real name for display, but first it runs variantClash and
      // unhonouredGrade against it - and those compare what was SAID to what
      // the row IS. Filling in the row's own name made both guards diff a
      // string against itself, so they always returned null and the entire
      // wrong-variant defence (the low-fat-paneer / egg-yolk class) was dead on
      // this path. The rerank topScore gate does not cover it: a reranker
      // happily scores "Milky Mist Paneer" over 0.75 for "low fat paneer",
      // since two of three words match. prep is included because prep states
      // ("roasted", "boiled") are themselves a variant group.
      food_name: [r.prep, r.name].filter(Boolean).join(" ").trim() || top.name,
      quantity: qty,
      serving_label: per1.label,
      grams,
      // verifyItems recomputes these from the row anyway; filling them here
      // keeps the shape honest if a downstream guard reads them first.
      kcal: round1(per.kcal * f),
      protein_g: round1(per.protein_g * f),
      carb_g: round1(per.carb_g * f),
      fat_g: round1(per.fat_g * f),
      fiber_g: per.fiber_g === null ? null : round1(per.fiber_g * f),
      source: top.source,
      assumption: null,
      confidence: "high",
    });
  }
  return { items: out, blockedBy: null };
}

/** Per-100 basis for every candidate we showed the model, so a failed row read
 *  falls back to the numbers we already had rather than to zero. */
function per100ForItems(resolved: ResolvedItem[]): Map<string, Per100> {
  const byFood = new Map<string, Per100>();
  for (const r of resolved) {
    for (const c of r.candidates) {
      if (c.food_id && !byFood.has(c.food_id)) {
        byFood.set(c.food_id, {
          kcal: c.kcal, protein_g: c.protein_g, carb_g: c.carb_g, fat_g: c.fat_g, fiber_g: c.fiber_g,
          name: c.name,
        });
      }
    }
  }
  return byFood;
}

/** Serving options for every candidate we offered, so the display quantity can
 *  be reconciled against the logged grams (see reconcileQuantity). */
function servingsForItems(resolved: ResolvedItem[]): Map<string, ServingOption[]> {
  const byFood = new Map<string, ServingOption[]>();
  for (const r of resolved) {
    for (const c of r.candidates) {
      if (c.food_id && c.servings.length > 0 && !byFood.has(c.food_id)) {
        byFood.set(c.food_id, c.servings);
      }
    }
  }
  return byFood;
}

/** What the user asked for, per matched row. Each resolved item's prep intent
 *  (from its prep field and its own name) maps to every candidate food_id it
 *  could resolve to, paired with that candidate's real row name. */
function prepForItems(
  resolved: ResolvedItem[],
): Map<string, { userIntent: PrepState; rowName: string }> {
  const byFood = new Map<string, { userIntent: PrepState; rowName: string }>();
  for (const r of resolved) {
    const userIntent = prepStateOf(`${r.prep ?? ""} ${r.name}`);
    if (!userIntent) continue;
    for (const c of r.candidates) {
      if (c.food_id && !byFood.has(c.food_id)) {
        byFood.set(c.food_id, { userIntent, rowName: c.name });
      }
    }
  }
  return byFood;
}

/** Coach line without a model call, keyed on what the meal actually is. */
export function templateDronaLine(items: ParsedItem[]): string {
  const protein = Math.round(items.reduce((a, it) => a + (it.protein_g || 0), 0));
  const kcal = Math.round(items.reduce((a, it) => a + (it.kcal || 0), 0));
  if (protein >= 30) return `${protein}g protein in there. That is how you build.`;
  if (protein >= 15) return `${protein}g protein logged. Solid, keep stacking.`;
  if (kcal >= 400) return `${kcal} calories, light on protein. Add a protein hit next.`;
  return "Logged. Keep the protein coming.";
}

/**
 * Keep the coach sentence honest about numbers.
 *
 * decide writes drona_line itself, so it can state a macro it worked out in its
 * head rather than the one the row produced. Seen live 2026-08-23: a card
 * reading "Boiled Egg 231 kcal, 19g P" carried the line "Three eggs, 37.5 grams
 * protein" - the model had assumed 12.5 g per egg. The numbers were right and
 * the sentence beside them was wrong, which is worse than saying nothing.
 *
 * The pipeline's rule is that a number the user sees comes from a source row,
 * never from model arithmetic. That rule stopped at the macros; this extends it
 * to the sentence.
 *
 * DELIBERATELY LENIENT. The prompt invites the line to reference the day, so a
 * figure is accepted if it is close to ANY number the model was legitimately
 * given: this meal, the day so far, the day after this meal, the target, or
 * what is left of the target. Only a figure matching none of those is a
 * fabrication, and then we fall back to the template line rather than ship a
 * self-contradicting card. Numbers not attached to a macro word (egg counts,
 * quantities) are ignored entirely.
 */
export function groundDronaLine(
  line: string,
  items: ParsedItem[],
  today?: { kcal: number; protein_g: number } | null,
  targets?: { protein_target_g?: number | null; daily_calorie_target?: number | null } | null,
): string {
  const mealProtein = items.reduce((a, it) => a + (it.protein_g || 0), 0);
  const mealKcal = items.reduce((a, it) => a + (it.kcal || 0), 0);

  const allowed = (meal: number, soFar: number | null, target: number | null): number[] => {
    const out = [meal];
    if (soFar !== null) out.push(soFar, soFar + meal);
    if (target !== null) {
      out.push(target);
      out.push(Math.max(0, target - (soFar ?? 0) - meal));
      out.push(Math.max(0, target - (soFar ?? 0)));
    }
    return out;
  };
  const proteinOk = allowed(mealProtein, today?.protein_g ?? null, targets?.protein_target_g ?? null);
  const kcalOk = allowed(mealKcal, today?.kcal ?? null, targets?.daily_calorie_target ?? null);

  // 10% band, with a floor so small numbers are not rejected on rounding alone.
  const near = (claim: number, ok: number[], floor: number) =>
    ok.some((v) => Math.abs(claim - v) <= Math.max(floor, v * 0.1));

  const claims: Array<[RegExp, number[], number]> = [
    [/(\d+(?:\.\d+)?)\s*(?:g|gs|grams?)?\s*(?:of\s+)?protein/gi, proteinOk, 3],
    [/(\d+(?:\.\d+)?)\s*(?:kcal|calories|cals?)\b/gi, kcalOk, 25],
  ];
  for (const [re, ok, floor] of claims) {
    for (const m of line.matchAll(re)) {
      const claim = Number(m[1]);
      if (Number.isFinite(claim) && !near(claim, ok, floor)) return templateDronaLine(items);
    }
  }
  return line;
}

/** A rough, clearly-flagged line for a food decide dropped. Uses the top
 *  resolved candidate's per-100 where we have it, and keeps food_id null so it
 *  reads (and refines) as the estimate it is. */
export function fallbackFromResolved(r: ResolvedItem, candidatePer100: Map<string, Per100>): ParsedItem {
  const top = r.candidates[0];
  const p = top?.food_id ? candidatePer100.get(top.food_id) : undefined;
  const unit = r.unit.trim().toLowerCase();
  const qty = r.quantity > 0 ? r.quantity : 1;
  // MASS_UNITS, not a hand-written subset. The old inline list missed "gm",
  // "gms", "millilitre" and "milliliter", so "2 gm" fell through to the count
  // branch and was read as two PIECES.
  const portions = top?.servings.filter((s) => s.grams > 0 && !isBasisServing(s)) ?? [];
  const sv = portions.find((s) => s.is_default) ?? portions[0];
  let grams: number;
  if (MASS_UNITS.has(unit)) {
    grams = qty;
  } else if (sv) {
    // A REAL portion serving beats the model's estimate: "1 cookie (11 g)" is
    // measured, est.total_g is free text. Order matters and this is the order.
    grams = sv.grams * qty;
  } else if (r.est && r.est.total_g > 0) {
    // No portion anchor on the row, so the model's own gram estimate for the
    // line. It ALREADY accounts for the count ("2 biscuits" -> ~22 g), so it
    // must not be multiplied again. Capped like every other free-text gram.
    grams = Math.min(r.est.total_g, 5000);
  } else {
    // Nothing measured and nothing estimated. The row's only serving is a bare
    // mass label ("100 g"), which states a MASS and not a portion - multiplying
    // it by a piece count is exactly how 2 Oreos logged as 200 g. Take ONE
    // basis and let the low confidence say the rest.
    grams = 100;
  }
  const f = grams / 100;
  return {
    food_id: null,
    food_name: top?.name ?? r.name,
    quantity: qty,
    // The label that DROVE the gram math, so quantity x serving_label still
    // reads as grams on the card. Filling the raw user word here printed
    // "2 x serving" against 22 g derived from "1 cookie (11 g)".
    serving_label: (!MASS_UNITS.has(unit) && sv) ? sv.label : (unit || "serving"),
    grams: round1(grams),
    kcal: p ? round1(p.kcal * f) : 0,
    protein_g: p ? round1(p.protein_g * f) : 0,
    carb_g: p ? round1(p.carb_g * f) : 0,
    fat_g: p ? round1(p.fat_g * f) : 0,
    fiber_g: p && p.fiber_g !== null ? round1(p.fiber_g * f) : null,
    source: "estimate",
    assumption: "I may have missed this item, tap to check it",
    confidence: "low",
  };
}

export interface ParseMealInput {
  text: string;
  localHour: number | null;
  mealHint: MealType | null;
  /** "fast": one model call names AND estimates, catalog resolve, code fill,
   *  no decide. Honoured only on a first-shot log; with a meal on screen the
   *  turn may be a correction and falls through to the full pipeline. */
  mode?: "fast" | null;
  /** EXPERIMENT KNOB (fast mode only): skip the catalog resolve entirely, so
   *  every line ships the model's own estimate. Exists to measure what the
   *  catalog step actually costs end to end now that the function runs next to
   *  the DB; not exposed anywhere in product UI. */
  noCatalog?: boolean;
  /** Set only when a parsed-but-unlogged meal is on screen. */
  previousText?: string | null;
  previousItems?: PreviousItem[];
  /** The last few turns of this logging conversation, oldest first. Without it
   *  Drona can see the meal but not what either side just SAID, so a reply like
   *  "yes do that" or "no the other one" has nothing to attach to. */
  recentTurns?: { role: "user" | "drona"; text: string }[];
  recentFoods: RecentFoodContext[];
  todayTotals: { kcal: number; protein_g: number } | null;
  targets: { daily_calorie_target: number | null; protein_target_g: number | null } | null;
  // Optional: when set, the recents/targets/totals above are placeholders and
  // these values are awaited AFTER the extract call — so the context DB queries
  // run concurrently with extraction instead of blocking before it. Only the
  // decide stage needs them. The eval harness passes resolved values + no promise.
  contextPromise?: Promise<{
    recentFoods: RecentFoodContext[];
    todayTotals: { kcal: number; protein_g: number } | null;
    targets: { daily_calorie_target: number | null; protein_target_g: number | null } | null;
  }>;
}

// Injected by index.ts (production) or the eval harness (dry run). Keeping
// this structural (no supabase-js types) is what makes the module portable.
/**
 * Progress the client can render before the meal is finished (Phase 4).
 *
 * Deliberately only TWO events, and neither is "almost done". Measured on
 * device: names land ~1.2s in, macros ~1.5s. The gap worth filling is the one
 * where we know WHAT the user ate but not yet the numbers - so `items` paints
 * the rows and `fill` settles them. Anything finer would be motion without
 * information.
 *
 * The estimate rides along on `items` because the fused naming call already
 * produced it: the shimmer can animate toward a real figure rather than
 * spinning at nothing, and if the catalog then agrees within ~10% it barely
 * moves. A number that approaches something true is honest; one that approaches
 * nothing is decoration.
 */
/** The model's own numbers for a whole line, from the naming call. All four
 *  travel together: a row that shimmers a calorie count but blanks its macros
 *  reads as broken, and the card has to reserve the same space it will need
 *  once the catalog answers or the row jumps when it settles. Null on every
 *  field when the model gave no usable estimate. */
export interface ProgressItem {
  name: string;
  quantity: number;
  unit: string;
  est_kcal: number | null;
  est_protein_g: number | null;
  est_carb_g: number | null;
  est_fat_g: number | null;
}

export type ParseProgress =
  | { kind: "items"; items: ProgressItem[] }
  | { kind: "fill"; items: ParsedItem[]; meal_type: MealType; drona_line: string };

export interface ParseMealDeps {
  anthropicApiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  webSearchEnabled: boolean;
  /** Called as soon as each stage has something worth showing. Absent for
   *  non-streaming callers, which is every caller today. */
  onProgress?(p: ParseProgress): void;
  /** P3 skip-decide. 'off' always calls decide; 'shadow' calls decide but also
   *  computes the code fill and records whether they agree; 'on' skips decide
   *  when the gate passes. Default off: this removes the model from the
   *  decision, so it earns its way in on shadow-mode agreement data. */
  skipDecideMode?: "off" | "shadow" | "on";
  /** Fast Lane A: name the items in CODE and skip the extract call entirely.
   *  Shadow records what the grammar WOULD have produced without acting on it,
   *  so its agreement with extract can be measured on real traffic first. */
  fastGrammarMode?: "off" | "shadow" | "on";
  // Tier 1: catalog search (search_foods_ranked RPC + food_servings).
  // `lean` = trigram only, skip the semantic leg. The semantic leg embeds the
  // query via an EXTERNAL Voyage API call first, which is ~1s and rate-limited,
  // so a ladder of concurrent searches queues there - measured: every query in
  // a batch reporting near-identical 0.8-1.6s wall times while the co-located
  // trigram RPC costs ~30ms. Fast mode passes lean=true; synonym-bridging is
  // decide's concern, and fast has no decide.
  searchFoods(query: string, lean?: boolean): Promise<CandidateFood[]>;
  // Tier 2 backfill hook: persist an OFF product as a global foods row.
  // Returns the new (or pre-existing) food id, or null on failure/dry-run.
  backfillOffFood(food: OffProduct): Promise<string | null>;
  // Tier 2b: FatSecret lookup. Optional - absent when no credentials are
  // configured, which is how the source stays behind a flag.
  searchFatSecret?(query: string): Promise<CandidateFood[]>;
  // Cross-encoder rerank over the merged candidate docs. Optional - absent
  // when unconfigured; the merge order stands. See rerank.ts.
  rerankCandidates?(query: string, docs: string[]): Promise<{
    order: number[];
    margin: number;
    topScore: number;
  } | null>;
  // Tier 1/2 verification: per-100 macros for a food row, for the
  // server-side recompute. Null when the row can't be read.
  getFoodPer100(foodId: string): Promise<{
    // The row's own name. Carried so a line's LABEL can be made to agree with
    // the macros we compute from that same row (see verifyItems).
    name: string;
    base_unit: string;
    kcal: number;
    protein_g: number;
    carb_g: number;
    fat_g: number;
    fiber_g: number | null;
  } | null>;
  /** A food's serving options, for resolving a correction ("a small one")
   *  against the row we already matched. Optional: without it the fast
   *  correction path simply falls back to the full pipeline. */
  getFoodServings?(foodId: string): Promise<ServingOption[]>;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
}

// ── Open Food Facts lookup (tier 2) ─────────────────────────────────────────

export interface OffProduct {
  name: string;
  brand: string | null;
  barcode: string | null;
  base_unit: "g" | "ml";
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  sugar_g: number | null;
  sat_fat_g: number | null;
  sodium_mg: number | null;
  serving: ServingOption | null;
}

// OFF now runs on every item in parallel with catalog, not just on a miss, so
// this bounds how long a slow Open Food Facts response can hold up ANY meal.
// Kept short: its median is well under a second, and a catalog match already in
// hand should not wait long for a label that may not even win.
const OFF_TIMEOUT_MS = 2500;
// ODbL guardrail: identify the app on every live call.
const OFF_USER_AGENT = "Overload/1.0 (https://tryoverload.app; support@tryoverload.app)";

// De-SHOUT OFF/USDA style names ("YOGABAR MULTIGRAIN BAR" -> "Yogabar Multigrain Bar").
function titleCaseIfShouty(raw: string): string {
  const s = raw.trim();
  if (s.length < 4 || s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
}

function asNum(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// "50 g" / "250ml" / "1 bar (50 g)" -> grams (or ml) count.
function parseServingSize(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(g|ml)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function searchOpenFoodFacts(
  query: string,
  fetchFn: typeof fetch,
  log?: (msg: string) => void,
): Promise<OffProduct[]> {
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: "8",
    fields: "code,product_name,brands,nutriments,serving_size,nutrition_data_per",
  });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), OFF_TIMEOUT_MS);
  try {
    const res = await fetchFn(
      `https://world.openfoodfacts.org/cgi/search.pl?${params.toString()}`,
      { headers: { "User-Agent": OFF_USER_AGENT }, signal: controller.signal },
    );
    if (!res.ok) {
      log?.(`[parse_meal] OFF search ${res.status} for "${query}"`);
      return [];
    }
    const data = await res.json();
    const products: unknown[] = Array.isArray(data?.products) ? data.products : [];
    const out: OffProduct[] = [];
    for (const p of products) {
      if (out.length >= 3) break;
      const prod = p as Record<string, unknown>;
      const nutr = (prod.nutriments ?? {}) as Record<string, unknown>;
      const name = typeof prod.product_name === "string" ? prod.product_name.trim() : "";
      const kcal = asNum(nutr["energy-kcal_100g"]);
      const protein = asNum(nutr["proteins_100g"]);
      const carb = asNum(nutr["carbohydrates_100g"]);
      const fat = asNum(nutr["fat_100g"]);
      // Only products with a complete core macro panel are trustworthy
      // enough to log against (and to backfill into the catalog).
      if (!name || kcal === null || protein === null || carb === null || fat === null) continue;
      // Open Food Facts is crowd-sourced and carries mis-entered panels. Screen
      // them HERE so a bad row is never backfilled into our catalog, where it
      // would poison every future search for that product.
      const bad = implausiblePer100({ kcal, protein_g: protein, carb_g: carb, fat_g: fat });
      if (bad) {
        log?.(`[parse_meal] OFF row rejected ("${name}"): ${bad}`);
        continue;
      }
      const sodiumG = asNum(nutr["sodium_100g"]);
      const servingAmount = parseServingSize(prod.serving_size);
      out.push({
        name: titleCaseIfShouty(name),
        brand: typeof prod.brands === "string" && prod.brands.trim()
          ? titleCaseIfShouty(prod.brands.split(",")[0].trim())
          : null,
        barcode: typeof prod.code === "string" && prod.code ? prod.code : null,
        base_unit: prod.nutrition_data_per === "100ml" ? "ml" : "g",
        kcal,
        protein_g: protein,
        carb_g: carb,
        fat_g: fat,
        fiber_g: asNum(nutr["fiber_100g"]),
        sugar_g: asNum(nutr["sugars_100g"]),
        sat_fat_g: asNum(nutr["saturated-fat_100g"]),
        sodium_mg: sodiumG === null ? null : Math.round(sodiumG * 1000),
        serving: servingAmount
          ? { label: String(prod.serving_size).trim(), grams: servingAmount, is_default: true }
          : null,
      });
    }
    return out;
  } catch (e) {
    log?.(`[parse_meal] OFF search threw for "${query}": ${String(e).slice(0, 120)}`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

// ── Tool definitions ────────────────────────────────────────────────────────

export const PARSE_TERMINAL_TOOL = "log_meal";

// Stage 1 of the extract -> resolve -> decide workflow: segment the text into
// items. Forced via tool_choice, so declines are fields, not free text.
const EXTRACT_TOOL = {
  name: "extract_meal",
  description:
    "Report every distinct food or drink in the text as a separate item. Extraction only: " +
    "no nutrition numbers, no serving-size guessing beyond what the text says.",
  input_schema: {
    type: "object",
    properties: {
      declined: {
        type: "boolean",
        description:
          "true ONLY when the text contains NOTHING loggable as food or drink (a pure " +
          "question, an exercise log, or chatter). Any real food, however vague, is false.",
      },
      decline_message: {
        type: ["string", "null"],
        description:
          "When declined: one short sentence in Coach Drona's voice (direct, warm, no em " +
          "dashes) redirecting the user to log food. null otherwise.",
      },
      meal_type_from_text: {
        type: ["string", "null"],
        enum: ["breakfast", "lunch", "dinner", "snack", null],
        description:
          'The meal the TEXT names ("for lunch", "dinner was"). null when the text does not ' +
          "name one; never infer it from the food or the time.",
      },
      requests_research: {
        type: "boolean",
        description:
          "TRUE when the user is ACCEPTING an offer to go look the numbers up: \"yes\", " +
          '"yes please", "search for it", "look it up", "check again", "can you verify". ' +
          "Read it against the last thing Drona said in the conversation: if Drona just " +
          "offered to search and the user agreed, this is true. Only ever true when a " +
          "previous meal was given.",
      },
      asks_about_previous: {
        type: "boolean",
        description:
          "TRUE when the text QUESTIONS or CHALLENGES the meal already on screen instead of " +
          'logging or correcting it: "is that right?", "that seems high", "why is it 900 calories?", ' +
          '"are you sure it had 122 g protein?". The user is checking your numbers, not eating. ' +
          "Only ever true when a previous meal was given. Set declined FALSE in this case.",
      },
      corrects_previous: {
        type: "boolean",
        description:
          "TRUE when the text CORRECTS the meal already on screen rather than adding food: " +
          '"make it a small one", "that was 2 not 1", "actually paneer not tofu", "no sugar". ' +
          "FALSE when the user is naming NEW food to add (\"and a dosa\", \"also 2 roti\") or " +
          "logging an unrelated meal. Only ever true when a previous meal was given.",
      },
      removed_food_names: {
        type: ["array", "null"],
        items: { type: "string" },
        description:
          "Foods the user asked to REMOVE from the previous meal. Give the FOOD NAME as the " +
          'previous meal spells it, NOT the whole sentence: for "remove the tofu" send "Tofu", ' +
          'for "I did not have the rice" send "Rice". If the previous line is more specific ' +
          '("Toned Milk") send that. Leave them OUT of items as well. null or empty when ' +
          "nothing was removed. Only ever set when a previous meal was given.",
      },
      items: {
        type: "array",
        description:
          "One entry per distinct food/drink. When corrects_previous is true, list the " +
          "corrected version of EVERY line of the previous meal (unchanged ones included), " +
          "so the result replaces it wholesale. A line named in removed_food_names is the " +
          "one exception: leave it out entirely.",
        items: {
          type: "object",
          properties: {
            corrects_food_name: {
              type: ["string", "null"],
              description:
                "When correcting, the food_name of the previous line this entry replaces, " +
                "copied EXACTLY. null for a brand new item.",
            },
            name: {
              type: "string",
              description:
                'The food\'s COMMON name, spelling corrected: "roasted edamame", not ' +
                '"2 tblspn roasted edameme". No brand, no quantity, no size word.\n' +
                "KEEP every word that changes WHICH PRODUCT it is, even if that makes the " +
                "name longer. These are the product, not decoration:\n" +
                '  fat/grade: "low fat", "full fat", "full cream", "double toned", "toned", ' +
                '"skimmed", "semi skimmed"\n' +
                '  protein/sugar claims: "high protein", "zero sugar", "no added sugar"\n' +
                '  part or variant: "yolk", "white", "whole", "brown", "wholewheat"\n' +
                '  prep when it names a different food: "roasted" vs plain, "boiled" vs raw\n' +
                'So "milky mist low fat paneer" -> "low fat paneer" (NOT "paneer"), and ' +
                '"amul double toned milk" -> "double toned milk" (NOT "milk"). Dropping one ' +
                "of these words searches for a DIFFERENT food and silently logs the wrong " +
                "macros.\n" +
                "DROP only words that leave the product unchanged: fresh, homemade, plain " +
                "(when no roasted/salted variant is meant), and size words (small, medium, " +
                "large) which belong in unit.",
            },
            brand: { type: ["string", "null"], description: "Brand if the text names one." },
            quantity: { type: "number", description: "How many of unit, e.g. 2 for '2 rotis'. 1 if unstated." },
            unit: {
              type: "string",
              description:
                'The unit as the user gave it: "g", "ml", "tbsp", "tsp", "cup", "roti", ' +
                '"katori", "glass", "scoop", "piece"... "serving" when unstated.',
            },
            prep: {
              type: ["string", "null"],
              description:
                'Preparation state the text implies: "roasted", "fried", "cooked", "raw", ' +
                "etc. null when unstated.",
            },
          },
          required: ["name", "quantity", "unit"],
        },
      },
    },
    required: ["declined", "items"],
  },
};

const LOG_MEAL_TOOL = {
  name: PARSE_TERMINAL_TOOL,
  description:
    "Record the parsed meal. Call this EXACTLY ONCE as your final action, after resolving every " +
    "item. Do not describe the meal in text; this tool call is the only thing the app can log.",
  input_schema: {
    type: "object",
    properties: {
      meal_type: {
        type: "string",
        enum: ["breakfast", "lunch", "dinner", "snack"],
        description:
          "Use the meal named in the text if any; otherwise the meal_hint from context.",
      },
      items: {
        type: "array",
        description: "One entry per distinct food in the text.",
        items: {
          type: "object",
          properties: {
            food_id: {
              type: ["string", "null"],
              description:
                "The id of the chosen candidate from search_foods / lookup_packaged_food / " +
                "lookup_fatsecret, copied EXACTLY as given (FatSecret ids look like 'fs:12345'). " +
                "null ONLY for web-sourced or estimated items.",
            },
            food_name: { type: "string", description: "Display name for the log." },
            quantity: {
              type: "number",
              description: "How many of serving_label the user ate, e.g. 2 for '2 rotis'.",
            },
            serving_label: {
              type: "string",
              description:
                'Human-readable unit, e.g. "roti", "katori", "100 g", "scoop", "500 ml". ' +
                "Prefer a serving option label from the chosen candidate when one fits.",
            },
            grams: {
              type: "number",
              description:
                "TOTAL amount in grams (or ml for liquids) for this line: quantity times the " +
                "per-serving weight. This drives the macro math, so convert carefully.",
            },
            kcal: { type: "number", description: "TOTAL kcal. OMIT for catalog/off items (food_id set) — the app computes them from grams. REQUIRED only for estimate/web items." },
            protein_g: { type: "number", description: "TOTAL protein grams. Omit when food_id is set; required for estimate/web." },
            carb_g: { type: "number", description: "TOTAL carb grams. Omit when food_id is set; required for estimate/web." },
            fat_g: { type: "number", description: "TOTAL fat grams. Omit when food_id is set; required for estimate/web." },
            fiber_g: { type: ["number", "null"], description: "TOTAL fiber grams. Omit when food_id is set." },
            source: {
              type: "string",
              enum: ["catalog", "off", "fatsecret", "web", "estimate"],
              description:
                "catalog = matched via search_foods. off = matched via lookup_packaged_food. " +
                "fatsecret = matched via lookup_fatsecret (its ids start with 'fs:'). " +
                "web = numbers read from a web_search result (cite the label site in assumption). " +
                "estimate = your own knowledge, last resort.",
            },
            assumption: {
              type: ["string", "null"],
              description:
                "Short user-facing note when you guessed a variant or size, in Coach Drona's " +
                'voice, e.g. "Took that as toned milk" or "Assumed a medium katori, 150 g". ' +
                "No em dashes. null when nothing was assumed.",
            },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          // Macros are intentionally NOT required: for catalog/off items the
          // server recomputes them from grams (verifyItems), so emitting them
          // just burns output tokens (latency). The prompt requires them for
          // estimate/web items, which have no food row to recompute from.
          required: [
            "food_id", "food_name", "quantity", "serving_label", "grams",
            "source", "confidence",
          ],
        },
      },
      drona_line: {
        type: "string",
        description:
          "One short sentence from Coach Drona reacting to this meal in the context of the day. " +
          "Protein-first mindset. Plain, direct, no emoji, no em dashes, max ~15 words.",
      },
    },
    required: ["meal_type", "items", "drona_line"],
  },
};

// Basic (non-filtering) variant: the newer web_search versions are
// Opus/Sonnet-only and parse_meal runs on Haiku.
const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 2,
};

// Terminal tool for the web label lookup: read the official label and report
// per-100 macros, nothing else.
//
// The hedge this was built for is GONE. Two designs have shipped and been
// removed here, and the history is worth keeping because Super will face the
// same choice:
//   1. 501a614 raced this lookup against decide with a 4s grace window and
//      upgraded estimate lines SERVER-SIDE, before the card ever rendered.
//      Dropped for being SILENT: the user never learned a lookup happened or
//      that their numbers had been swapped.
//   2. abebc86 replaced it with a visible two-phase refine - phase 1 returns a
//      fast card marked with weak lines, the client fires phase 2, numbers get
//      swapped in AFTER the user is already reading them. Being removed by I15
//      for the opposite sin: it mutates a review card while Add is live, so a
//      user can tap Add on 180 kcal and log 240.
// The lesson is not "visible vs silent", it is WHEN: upgrade before render and
// the card is stable, upgrade after and it is not. Super does the lookup inside
// resolve (before decide, before render) AND narrates it with progress events
// plus a verified badge, which is the only combination neither design had.
//
// Today this has exactly one caller: researchPrevious, the user-challenge path.
const WEB_LOOKUP_TOOL = {
  name: "report_labels",
  description:
    "Report the official nutrition-label data you found for each food, exactly once, " +
    "after your web searches. found=false when no trustworthy label surfaced.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            for_item: { type: "string", description: "The item name EXACTLY as given to you." },
            found: { type: "boolean" },
            per_100: {
              type: ["object", "null"],
              description: "Label macros per 100 g (or 100 ml for liquids). null when not found.",
              properties: {
                kcal: { type: "number" },
                protein_g: { type: "number" },
                carb_g: { type: "number" },
                fat_g: { type: "number" },
                fiber_g: { type: ["number", "null"] },
              },
              required: ["kcal", "protein_g", "carb_g", "fat_g"],
            },
            source_note: {
              type: ["string", "null"],
              description:
                'Short source for the user. For a packaged food name the label ("per the ' +
                'Britannia label"). For a DISH say what it represents ("typical restaurant ' +
                'preparation"), so the user can tell a measured panel from a typical value. ' +
                "No URLs.",
            },
          },
          required: ["for_item", "found"],
        },
      },
    },
    required: ["results"],
  },
};

interface WebLabel {
  per_100: { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null };
  source_note: string | null;
}

// Typo-tolerant word overlap ("edameme" vs "Edamame, cooked"): any pair of
// content words sharing a 4-char prefix. Shared by the prep-state guard and
// the web-label merge.
/**
 * Do two food names refer to the same food?
 *
 * A single shared word is not enough: "milk tea" and "milk coffee" share
 * "milk", and treating that as identity lets one drink take the other's label
 * or mask it as already-covered. Require the names to agree on the whole of
 * the shorter one, so a modifier ("roasted edamame" vs "edamame") still
 * matches while two different foods that merely share an ingredient do not.
 */
/**
 * Read a quantity the model emitted, tolerating a numeric STRING.
 *
 * The schema says `type: "number"`, but a tool schema is advisory: the model
 * does sometimes send "250" instead of 250. The old check was
 * `typeof o.quantity === "number"` with a fallback of 1, so a quoted number
 * did not fail loudly - it silently became ONE. "250ml milk" logged as 1 ml.
 *
 * WHY NOT STRICT TOOL USE (I7): strict is real and does enforce the type, but
 * it requires every property in `required`, so the model must emit all eight
 * extract fields on every call. Measured on Haiku 4.5 over 5 real inputs, twice:
 * output tokens +96% (649 -> 1270) and +572 ms per extract call. Extract is the
 * first thing on the critical path and Fast targets a sub-second first row, so
 * that trade is backwards - it buys a guarantee this function already provides
 * for free. Strict also cannot express our nullable enum
 * (`type: ["string","null"]` + an enum containing null is rejected outright),
 * so adopting it would mean reshaping the schema too.
 *
 * Rejects anything that is not a finite positive number after coercion, and a
 * blank string, which Number() would happily read as 0.
 */
export function coerceQuantity(v: unknown): number {
  const n = typeof v === "number"
    ? v
    : typeof v === "string" && v.trim() !== ""
    ? Number(v.trim())
    : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 1;
}

export function wordsOverlap(a: string, b: string): boolean {
  // Three characters, not four: "tea", "dal" and "egg" are whole foods, and
  // dropping them collapses "milk tea" to "milk", which then matches every
  // milk drink there is.
  const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  const aw = words(a), bw = words(b);
  if (aw.length === 0 || bw.length === 0) return false;
  const [short, long] = aw.length <= bw.length ? [aw, bw] : [bw, aw];
  // Word-level typo tolerance lives in nearWord (textMatch.ts): proportional
  // Damerau distance, replacing a 4-char shared-prefix rule that merged rival
  // brands (bikano/bikaji, creatine/creatinine) while still missing the
  // commonest Indian food typo (panner/paneer).
  return short.every((x) => long.some((y) => nearWord(x, y)));
}

const WEB_LOOKUP_MAX_TURNS = 4;
const WEB_LOOKUP_TIMEOUT_MS = 20000;

// A bounded mini-loop over server web_search: pause turns resume, and the
// final turn forces report_labels. Used by researchPrevious (the user
// challenge path); the automatic refine that also used it is gone, see I15.
async function runWebLookup(
  deps: ParseMealDeps,
  items: ExtractedItem[],
  onUsage: (data: any) => void,
  onCall: () => void,
): Promise<Map<string, WebLabel> | null> {
  const webDeps = { ...deps, timeoutMs: Math.min(deps.timeoutMs, WEB_LOOKUP_TIMEOUT_MS) };
  // TWO SHAPES, because a label-only lookup is useless on exactly the foods the
  // catalog misses most. Measured 2026-08-23: 7 of 33 common Indian dishes have
  // no catalog row, and a dish has no brand, no official panel and no label
  // listing - so the old prompt searched for a label that cannot exist and
  // correctly reported nothing. A user tapping Double-check on "chole bhature"
  // got a dead end (verified: web_search_requests 1, found 0).
  const system =
    "You look up nutrition numbers for foods a fitness app could not find in its catalog. " +
    "For EACH item, run ONE web search, then call report_labels exactly once with per-100 " +
    "macros for everything you found. Two kinds of food, and you must tell them apart:\n" +
    'PACKAGED OR BRANDED (a product with a wrapper): search the official label ' +
    '("<brand> <product> nutrition facts per 100g") and read numbers ONLY from the ' +
    "brand's own site or a reputable label listing. source_note names the label.\n" +
    "A DISH (cooked food with no wrapper: chole bhature, paneer bhurji, misal pav, a " +
    "restaurant plate): there is no label and you must not wait for one. Search a " +
    "reputable nutrition source for a TYPICAL preparation and report that, with " +
    'source_note saying so plainly, e.g. "typical restaurant preparation". ' +
    "Prefer nutrition databases and published analyses over a random blog.\n" +
    "Report nothing for an item only when you genuinely found nothing usable. Never " +
    "invent numbers, and never average wildly disagreeing sources - pick the most " +
    "credible one. Speed matters: no extra searches, no prose.";
  const conversation: AnthropicMsg[] = [{
    role: "user",
    content: JSON.stringify(items.map((i) => ({ name: i.name, ...(i.brand ? { brand: i.brand } : {}) }))),
  }];

  for (let turn = 0; turn < WEB_LOOKUP_MAX_TURNS; turn++) {
    const lastTurn = turn === WEB_LOOKUP_MAX_TURNS - 1;
    const result = await callAnthropicOnce(webDeps, {
      model: deps.model,
      max_tokens: 800,
      system,
      tools: [WEB_SEARCH_TOOL, WEB_LOOKUP_TOOL],
      messages: conversation,
      ...(lastTurn ? { tool_choice: { type: "tool", name: "report_labels" } } : {}),
    });
    if (!result.ok) {
      deps.log?.(`[parse_meal] web lookup failed: ${result.status}`);
      return null;
    }
    onCall();
    onUsage(result.data);
    const blocks: Array<Record<string, any>> = result.data.content ?? [];

    if (result.data.stop_reason === "pause_turn") {
      conversation.push({ role: "assistant", content: blocks });
      continue;
    }
    const report = blocks.find((b) => b.type === "tool_use" && b.name === "report_labels");
    if (!report) {
      conversation.push({ role: "assistant", content: blocks });
      conversation.push({ role: "user", content: "Call report_labels now with what you have." });
      continue;
    }
    const out = new Map<string, WebLabel>();
    const results = (report.input as Record<string, unknown>)?.results;
    for (const r of Array.isArray(results) ? results : []) {
      const o = r as Record<string, any>;
      const p = o.per_100;
      if (o.found !== true || !p || typeof o.for_item !== "string") continue;
      const nums = [p.kcal, p.protein_g, p.carb_g, p.fat_g];
      if (!nums.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && (n as number) >= 0)) continue;
      out.set(o.for_item, {
        per_100: {
          kcal: p.kcal, protein_g: p.protein_g, carb_g: p.carb_g, fat_g: p.fat_g,
          // Merging happens after sanitizeItems, so a negative fiber value
          // here would reach the result unclamped.
          fiber_g: typeof p.fiber_g === "number" && Number.isFinite(p.fiber_g) && p.fiber_g >= 0 ? p.fiber_g : null,
        },
        source_note: typeof o.source_note === "string" && o.source_note.trim()
          ? scrubDashes(o.source_note).slice(0, 80)
          : null,
      });
    }
    return out.size > 0 ? out : null;
  }
  return null;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const HOUR_TO_MEAL: Array<[number, number, MealType]> = [
  [5, 11, "breakfast"],
  [11, 16, "lunch"],
  [16, 19, "snack"],
  [19, 29, "dinner"], // wraps past midnight; hours 0-5 also read as dinner
];

export function mealForHour(hour: number | null): MealType {
  if (hour === null || !Number.isFinite(hour)) return "snack";
  const h = ((hour % 24) + 24) % 24;
  const probe = h < 5 ? h + 24 : h;
  for (const [from, to, meal] of HOUR_TO_MEAL) {
    if (probe >= from && probe < to) return meal;
  }
  return "snack";
}

const EXTRACT_CORRECTION_RULES = `

A meal the user just logged may be shown to you as previous_meal (it is on screen, not yet saved). If so, decide what the new text is doing:
- CORRECTION of that meal (set corrects_previous true): it changes a size, amount, or identity of something already there, and names no new food. "make it a small one", "that was 2", "actually paneer not tofu", "no sugar in the tea". Re-list EVERY line of previous_meal with the correction applied, copying each line's exact food_name into corrects_food_name (unchanged lines included, unchanged).
- ADDITION or a new meal (corrects_previous false): the text names food that is not already in previous_meal. "and a dosa", "also 2 roti". List ONLY the new food; the app keeps the existing lines.
- QUESTION about that meal (set asks_about_previous true, declined false, items empty): the user is challenging or checking your numbers rather than eating. "is that correct?", "that seems high", "are you sure it had 122 g protein?". Never treat this as non-food chatter: the app answers it with the real numbers.
- QUESTION THAT ALSO STATES THE FIX ("that seems high, make it 100g", "is that right? it was a small one"): set corrects_previous TRUE and list the corrected items as well. The user told you the answer; do not just agree with them and change nothing.
- REMOVAL ("remove the tofu", "drop the milk", "I did not have the rice", "scratch the dosa"): put the line's name in removed_food_names, copied as the previous meal spells it, and LEAVE IT OUT of items. Set corrects_previous true. Listing it in items keeps it in the log, which is the opposite of what was asked.
- ACCEPTING A LOOKUP (set requests_research true, declined false, items empty): Drona offered to search for the real label and the user said yes. Judge this from recent_turns, not the words alone: a bare "yes" or "please" right after that offer is an acceptance.
When in doubt between correction and addition, prefer addition: adding a wrong item is easier for the user to spot and fix than silently rewriting what they already checked.`;

/**
 * Fast mode's naming call, which also carries the model's own numbers.
 *
 * Measured 2026-08-27: requiring these fields costs +658ms and roughly doubles
 * output tokens, so ONLY fast pays it - Smart keeps the lean tool and lets
 * decide handle the fallback. The win is that a separate estimate call cannot
 * start until the names exist, i.e. a full extra round trip (~1.2s); fused is
 * about half that, and the estimate is already in hand when the accept gate
 * rejects a row.
 *
 * The per-100 contract is IN THE FIELD NAMES, not just the descriptions. The
 * first probe asked for "per-100g kcal" in prose and got back
 * {est_grams: 450, est_kcal: 350} for a plate of chole bhature - 350 is
 * neither a credible total nor per-100, the model had conflated the two.
 * A name like est_per100_kcal is much harder to misread.
 */
const FAST_EXTRACT_TOOL = (() => {
  const t = JSON.parse(JSON.stringify(EXTRACT_TOOL));
  const item = t.input_schema.properties.items.items;

  // Fast mode only ever runs when there is NO previous meal (see `fastMode`
  // below), and every one of these fields is documented as "only ever true when
  // a previous meal was given". Leaving them in the schema asks Haiku to
  // consider, and often emit, five fields whose answer is fixed. Latency here is
  // output tokens, so a field the model cannot need is pure delay.
  for (const dead of ["requests_research", "asks_about_previous", "corrects_previous", "removed_food_names"]) {
    delete t.input_schema.properties[dead];
  }
  delete item.properties.corrects_food_name;
  Object.assign(item.properties, {
    est_per100_kcal: {
      type: "number",
      description: "Your best kcal PER 100 g (or 100 ml) of this food. PER 100, never the total for the amount eaten.",
    },
    est_per100_protein_g: { type: "number", description: "Protein grams PER 100 g." },
    est_per100_carb_g: { type: "number", description: "Carb grams PER 100 g." },
    est_per100_fat_g: { type: "number", description: "Fat grams PER 100 g." },
    est_total_g: {
      type: "number",
      description: 'TOTAL grams (or ml) for the WHOLE line, THE COUNT INCLUDED: "1 plate chole bhature" ~400, "2 rotis" ~80, "2 biscuits" ~15, "5 almonds" ~6. Multiply one piece by the count; never answer with one piece, and never with a whole packet.',
    },
  });
  item.required = [
    ...item.required,
    "est_per100_kcal", "est_per100_protein_g", "est_per100_carb_g", "est_per100_fat_g", "est_total_g",
  ];
  return t;
})();

const EXTRACT_SYSTEM_HEAD = `You segment free-text food logs for OVERLOAD, a lifting app. Report what the user ate via the extract_meal tool: one item per distinct food or drink, with the quantity and unit exactly as given. Correct spelling in item names ("edameme" is "edamame", "panner" is "paneer") and expand shorthand ("tblspn" is "tbsp"). Indian context: unqualified "tea" or "chai" means milk tea, extract the name as "milk tea"; unqualified "coffee" as "milk coffee" (keep "black tea", "green tea", "black coffee" as stated).`;

/** Smart only. There, nutrition is decide's job, and asking for it here would
 *  buy output tokens for numbers the second call overwrites anyway. In FAST
 *  there IS no second call, so this sentence must not be sent: it told the
 *  model not to do the exact thing FAST_EXTRACT_TOOL makes required. */
const EXTRACT_NO_NUTRITION = ` Do NOT resolve nutrition.`;

/** Both modes. quantity and unit mirror what the user SAID, in fast as much as
 *  in smart: converting a stated count to grams is est_total_g's job, not this
 *  one's, and inventing an amount nobody typed is still wrong either way. */
const EXTRACT_SHARED_RULES =
  ` Do NOT guess amounts the text does not state (use unit "serving" and quantity 1), and do NOT drop items. Composite dishes stay one item ("rajma chawal"), separately listed foods split ("paneer and 2 roti" is two).`;

/**
 * Fast only: the estimating half of the job, which Smart does in decide.
 *
 * Measured on the eval corpus in FAST_MODE before this existed: "2 good day
 * biscuits" came back 40 g and "britannia marie gold 4 biscuits" ALSO came back
 * 40 g. The count was not reaching the grams at all - the model answered "some
 * biscuits", roughly a packet, for both. On device "2 oreo biscuits" gave 56 g
 * against a true ~22 g.
 *
 * The piece weights are the ones buildDecideSystemPrompt already carries. They
 * were never wrong; they simply lived in the prompt for a call fast never
 * makes.
 */
const FAST_EXTRACT_RULES = `

FAST MODE. This is the ONLY model call in the parse. There is no second pass to correct your numbers, so the est_ fields ARE the answer.

- est_per100_kcal / _protein_g / _carb_g / _fat_g: your own best per-100 knowledge for that food. Required. Give them.
- est_total_g: grams for the WHOLE line, THE COUNT INCLUDED. Multiply one piece by the count. "2 biscuits" means two biscuits' worth, never one, and never a packet.
- The est_ fields are IN ADDITION to quantity and unit, never instead of them. An amount the user STATED still goes in quantity: "100g soya chunks" stays quantity 100 unit "g" (and est_total_g 100); "35g paneer" stays quantity 35 unit "g". Moving a stated amount into est_total_g and leaving quantity 1 logs one gram of food.
- A COUNT IS NOT A PORTION. "2 biscuits" and "4 biscuits" must give DIFFERENT totals. Answering the same "a serving of biscuits" number for both is the single commonest error here.
- Piece weights, when the food gives you nothing better. Biscuits are NOT one weight: a thin tea biscuit (Marie, Parle-G, Nice) is ~5 g, a cream or cookie one (Good Day, Oreo, Bourbon, Hide & Seek) is ~7-11 g. Also 1 cheese slice ~20 g, 1 slice bread ~30 g, 1 egg ~50 g, 1 roti ~40 g, 1 almond ~1.2 g, 1 cashew ~1.5 g, 1 walnut half ~2 g, 1 peanut ~0.9 g, 1 kimia date ~8 g, 1 medjool date ~24 g. So "4 marie biscuits" is ~20 g and never 44; "2 oreo biscuits" is ~22 g and never 56; "5 almonds" is ~6 g and never 25.
- Household amounts when the user names one: 1 katori ~150 g cooked, 1 bowl ~250 g, 1 glass ~250 ml, 1 cup ~200 ml, 1 scoop whey ~32 g, 1 plate chole bhature ~400 g.`;

/** Smart's prompt, unchanged in meaning: head + the no-nutrition rule + shared. */
const EXTRACT_SYSTEM_SMART = EXTRACT_SYSTEM_HEAD + EXTRACT_NO_NUTRITION + EXTRACT_SHARED_RULES;

/** Fast's prompt: the same segmentation job, minus the sentence that forbade
 *  nutrition, plus the estimating rules decide would otherwise have carried. */
const FAST_EXTRACT_SYSTEM = EXTRACT_SYSTEM_HEAD + EXTRACT_SHARED_RULES + FAST_EXTRACT_RULES;

export function buildDecideSystemPrompt(input: ParseMealInput): string {
  const hint = input.mealHint ?? mealForHour(input.localHour);

  // I13: frequency first, with the count and the USUAL amount. "last: 1 serving"
  // said nothing about whether this was a staple or a one-off someone tried
  // once, and the list was ordered by recency, so a single unusual dinner
  // outranked the milk they drink daily.
  const recents = input.recentFoods.length > 0
    ? input.recentFoods
      .slice(0, 20)
      .map((r) =>
        r.times && r.times > 1
          ? `- ${r.food_name} (${r.times} times, usually ${r.quantity} ${r.serving_unit})`
          : `- ${r.food_name} (last: ${r.quantity} ${r.serving_unit})`
      )
      .join("\n")
    : "(none yet)";

  const day = (() => {
    const target = input.targets?.protein_target_g ?? null;
    const kcalTarget = input.targets?.daily_calorie_target ?? null;
    const totals = input.todayTotals;
    const parts: string[] = [];
    if (totals) parts.push(`So far today: ${Math.round(totals.kcal)} kcal, ${Math.round(totals.protein_g)} g protein.`);
    if (target) parts.push(`Protein target: ${Math.round(target)} g/day.`);
    if (kcalTarget) parts.push(`Calorie target: ${Math.round(kcalTarget)} kcal/day.`);
    return parts.length > 0 ? parts.join(" ") : "No targets set.";
  })();

  return `You finalize food log entries for OVERLOAD, a lifting app. Each extracted item below carries CANDIDATE foods (per-100 macros plus serving options) already fetched from the catalog. Pick the right candidate per item, convert the quantity to grams, and log everything with ONE log_meal call. Coach Drona's voice appears only in drona_line and assumption strings: direct, warm, coach-like, never robotic. Never use em dashes anywhere in user-facing strings.

<candidate_rules>
- Choose the candidate that IS the food, not one merely similar. For generic Indian foods prefer the curated staples (Roti, Toor Dal, Curd, Toned Milk) over obscure branded rows. For a plain whole food ("chicken breast", "rice", "milk") prefer the plain/cooked/generic row over processed, fat-free, dried, deli, or flavored variants unless the user named that variant.
- Respect the item's prep state: never log a roasted/dried/fried item against a cooked/boiled candidate (2-3x density difference). If only a wrong-state candidate exists, estimate instead.
- Indian beverage defaults: unqualified "tea" or "chai" means MILK tea (the Chai / Milk Tea row, ~45 kcal/100 ml), and unqualified "coffee" means milk coffee. Herbal, black, green, or lemon tea ONLY when the user says so; picking a 1-2 kcal plain-tea row for unqualified "tea" is wrong. Any such default is never confidence high; name it in assumption.
- ACCEPTABLE means: eating the candidate instead of what the user described would move the macros less than ~10%. Judge the WORDS THE USER USED, not how similar the names look.
  DROP these words and match the row anyway, they do not change the food: brand on a food fixed by standard or nature (toned milk is 3% fat by regulation, so Amul = Mother Dairy; likewise curd, plain paneer, ghee, oil, atta, rice, dal, eggs); marketing words (fresh, farm, pure, natural, homemade, packet, tetra pack); regional synonyms (doodh = milk, dahi = curd, chawal = rice).
  NEVER drop these, they ARE the product: fat grade (low fat, full fat, full cream, toned, double toned, skimmed); protein or sugar claims (high protein, zero sugar, no added sugar, diet); part or variant (yolk, white, whole, brown, wholewheat, maida); prep state (raw, boiled, roasted, fried, dried - 2-3x density); brand on a FORMULATED product, where the recipe IS the product (protein bars and powders, biscuits, cereals, sauces, ready meals, flavoured yogurt); a DISH reduced to an ingredient (paneer butter masala is not Paneer).
  The same phrase shape gives opposite answers: "amul toned milk" -> plain toned milk row is fine, "quest protein bar" -> a generic protein bar row is NOT.
- grade_not_stocked on an item means we checked every candidate in CODE and none of them stock the grade the user asked for. Do NOT take one of those rows. ESTIMATE the product they actually named, and say so in assumption ("No low fat paneer row, so these are estimated"). A generic row's macros are more wrong than a careful estimate: low fat paneer is ~190 kcal/100 g against plain paneer's 283, double toned milk ~42 against toned's 58.
- No acceptable candidate: estimate from your own knowledge. food_id null, source "estimate", confidence low or medium, assumption naming what you assumed. Never refuse to log a real food.
</candidate_rules>

<quantity_rules>
- Macros output: for any item you matched to a candidate (food_id set, source catalog or off), give ONLY grams and OMIT kcal/protein_g/carb_g/fat_g/fiber_g — the app computes them from grams and the food row. For estimate or web items (food_id null) you MUST include all four macros, since there is no row to compute from.
- Candidates list macros PER 100 of base_unit (g or ml). grams on each logged item is the TOTAL amount eaten; when you do provide macros (estimate/web only) compute them as per100 * grams / 100.
- Use the candidate's serving options to convert household units. When the user gives an explicit amount ("50g", "500 ml"), that wins over any serving default.
- Spoon and cup weights DEPEND ON THE FOOD; a tablespoon is 15 g only for water-like liquids. If the candidate has a cup serving, derive from it (1 cup = 16 tbsp = 48 tsp). Otherwise: 1 tbsp of nuts, seeds, or roasted snacks ~8 g; powders (protein, flour, spices) ~7-9 g; oil or ghee ~14 g; nut butter, honey ~16-20 g. A guessed spoon weight is never confidence high.
- Indian household defaults when the user gives no amount and no serving option fits: 1 roti ~40 g, 1 katori ~150 g cooked, 1 glass ~250 ml, 1 cup ~200 ml, 1 bowl ~250 g, 1 scoop whey ~32 g, 1 egg ~50 g. Record any such guess in assumption.
- Piece counts for small foods use the candidate's per-piece serving when one exists; otherwise: 1 almond ~1.2 g, 1 cashew ~1.5 g, 1 walnut half ~2 g, 1 peanut ~0.9 g, 1 kimia date ~8 g, 1 medjool date ~24 g, 1 small packaged biscuit (Good Day, Marie, Parle-G) ~5-10 g. "5 almonds" is ~6 g, never 25; "2 biscuits" is ~15-20 g, never 90.
- Match the preparation state the user typed: "roasted" or "dried" foods are 2-3x more calorie-dense per gram than "cooked" or "boiled" ones. Never log a roasted/dried item against a cooked/boiled candidate row; prefer a correct-state candidate or estimate instead.
- "half" quantities are fine (quantity 0.5).
</quantity_rules>

<behavior>
- The user's recent foods (below) are strong hints: "milk" from someone who always logs Toned Milk means toned milk. Say so in assumption when you rely on this.
- meal_type: if the text names a meal ("for lunch", "dinner was"), use that. Otherwise use the hint EXACTLY: ${hint}. Do NOT infer the meal from what the food "usually" is: paneer bhurji at 9pm is dinner, not breakfast. Time of day decides, never the dish.
- Multiple foods in one text = multiple items in ONE log_meal call.
- NEVER ask the user a question. This is a one-shot logger, not a chat: the user gets no chance to reply. If an amount is missing, assume ONE standard serving (use the household defaults above) and note it in assumption, e.g. "Took that as one katori, 150 g." If a brand/variant is ambiguous, pick the most common one and say so. Estimate and log; do not stall for clarification.
- An item with no candidates is NEVER dropped: estimate the macros from your own knowledge (source "estimate"), note it in assumption, and log it. A branded snack you recognize (Haldiram's bhujia, Epigamia yogurt, etc.) always gets logged with an estimate, never skipped.
- You MUST finish by calling log_meal exactly once, covering every extracted item. Never write the parsed meal, macros, or a follow-up question as assistant text.
- USE THE USER'S OWN STAPLES when the text is VAGUE. The context lists what this person actually eats, with how many times and their usual amount. If they say "milk" and the list shows "Toned Milk (7 times, usually 200 ml)", log THEIR toned milk at THEIR 200 ml. Do not fall back to a generic or whole-fat default and then tell them their history says otherwise: they told you what they eat by eating it. Same for the amount, prefer their usual over a standard serving.
  This applies ONLY when the user was vague. If they NAME a version ("whole milk", "full cream"), that wins over history every time - they are telling you today is different, and a staple must never overrule an explicit word.
  NEVER write an assumption claiming the user said something they did not say. If their staple is not among the candidates, log the closest candidate honestly and say the staple was not available - do not invent "you said whole milk today" to justify the row you picked.
- drona_line reacts to the meal against the day so far (see context): protein lands first, praise effort, nudge gaps. One sentence, max ~15 words.
</behavior>

<user_context>
Recent foods this user logs:
${recents}

${day}
</user_context>`;
}

// ── Anthropic plumbing ──────────────────────────────────────────────────────

interface AnthropicMsg {
  role: "user" | "assistant";
  content: string | unknown[];
}

// Prompt caching: the decide system prompt and tool schemas are large and
// identical across a user's meals, so mark them as a cache breakpoint. The
// first log in a ~5 min window writes the cache; the rest read it, cutting
// input-processing latency (and cost) on every follow-up log.
function cacheableSystem(text: string): unknown {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}
function withToolCache(tools: unknown[]): unknown[] {
  if (tools.length === 0) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1 && t && typeof t === "object" && !("type" in (t as object))
      ? { ...(t as object), cache_control: { type: "ephemeral" } }
      : t
  );
}

async function callAnthropicOnce(
  deps: ParseMealDeps,
  payload: Record<string, unknown>,
): Promise<{ ok: true; data: any } | { ok: false; status: number; body: string }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": deps.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, body: await response.text() };
    }
    return { ok: true, data: await response.json() };
  } catch (e) {
    const isAbort = (e as Error)?.name === "AbortError";
    return {
      ok: false,
      status: isAbort ? 504 : 502,
      body: isAbort ? `Anthropic call exceeded ${deps.timeoutMs}ms timeout` : `fetch threw: ${String(e)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function candidatePayload(c: CandidateFood): Record<string, unknown> {
  return {
    food_id: c.food_id,
    name: c.name,
    ...(c.brand ? { brand: c.brand } : {}),
    base_unit: c.base_unit,
    per_100: {
      kcal: c.kcal,
      protein_g: c.protein_g,
      carb_g: c.carb_g,
      fat_g: c.fat_g,
      ...(c.fiber_g !== null ? { fiber_g: c.fiber_g } : {}),
    },
    servings: c.servings.slice(0, 6),
    source: c.source,
  };
}

// ── Stage 2: resolve (pure code, all items in parallel) ─────────────────────

export interface ExtractedItem {
  name: string;
  brand: string | null;
  quantity: number;
  unit: string;
  prep: string | null;
  /** When this entry corrects a line of the meal under review, that line's
   *  food_name verbatim — the handle we re-target it by. */
  correctsFoodName?: string | null;
  /** Fast mode only: the model's own per-100 numbers, produced in the SAME
   *  call that named the food. Null when any field was missing or negative -
   *  a partial estimate is not an estimate. */
  est?: { kcal: number; protein_g: number; carb_g: number; fat_g: number; total_g: number } | null;
}

export interface ResolvedItem extends ExtractedItem {
  candidates: CandidateFood[];
  /** Absolute relevance of the top candidate after rerank. The P3 skip-decide
   *  gate keys on this; absent when rerank did not run. */
  rerankTopScore?: number;
}

// A cup serving anchors every spoon: 1 cup = 16 tbsp = 48 tsp. Deriving the
// spoon weights in code hands the decide model real numbers instead of a
// water-density guess (the 2x roasted-edamame bug).
/**
 * True only for a serving that is exactly ONE cup.
 *
 * The anchors below divide the cup weight by 16 and 48, so any other multiple
 * silently poisons every spoon it derives: "1/2 cup" yields a half-weight
 * tablespoon, "2 cup" a doubled one. That is the same failure mode this whole
 * function exists to prevent, so the match has to be exact rather than a
 * substring test for "cup".
 */
export function isOneCupLabel(label: string): boolean {
  const l = label.toLowerCase().trim();
  if (/\bcups\b/.test(l)) return false;                 // "2 cups"
  const m = l.match(/^(.*?)\bcup\b/);
  if (!m) return false;
  const prefix = m[1].trim();
  // Bare "cup", or a quantity that is precisely 1. Anything else - "1/2",
  // "0.5", "2", "3/4" - is rejected rather than guessed at.
  return prefix === "" || /(^|\s)1$/.test(prefix);
}

function synthesizeVolumeAnchors(c: CandidateFood): CandidateFood {
  if (c.base_unit !== "g") return c;
  const has = (re: RegExp) => c.servings.some((s) => re.test(s.label.toLowerCase()));
  const cup = c.servings.find((s) => isOneCupLabel(s.label) && s.grams > 30 && s.grams < 400);
  if (!cup) return c;
  const derived: ServingOption[] = [];
  if (!has(/\b(tbsp|tablespoon)\b/)) derived.push({ label: "1 tbsp", grams: round1(cup.grams / 16) });
  if (!has(/\b(tsp|teaspoon)\b/)) derived.push({ label: "1 tsp", grams: round1(cup.grams / 48) });
  return derived.length > 0 ? { ...c, servings: [...c.servings, ...derived] } : c;
}

async function resolveOneItem(
  deps: ParseMealDeps,
  item: ExtractedItem,
  steps: ParseStep[],
  toolCalls: string[],
  /** Lower-cased names of foods this user logs repeatedly (I13). Used ONLY to
   *  stop the reranker discarding them; see the promotion below. */
  stapleNames?: Set<string>,
  /** Fast mode: skip FatSecret (~4s cold cache) and the reranker (~400ms +
   *  429 risk). The accept gate does the judging instead. */
  lean = false,
): Promise<ResolvedItem> {
  // Query ladder: full name, brand-qualified, then progressively fewer words
  // (the 0079 search requires EVERY word to match, so an over-specified name
  // like "almonds raw whole" returns nothing while "almonds" hits). A
  // generalized retry only fires when the specific query found zero rows.
  const queries: string[] = [];
  const push = (q: string) => { if (q && !queries.includes(q)) queries.push(q); };
  // Brand-qualified FIRST. The loop below stops at the first query that
  // returns anything, so leading with the generic name lets a generic row
  // win for a branded item whose own row exists and is never searched for.
  // Only prefix the brand when the name does not already carry it. The model
  // reports brand "Oreo" AND name "Oreo biscuits" for "2 oreo biscuits", which
  // built the query "Oreo Oreo biscuits" - a wasted ~500ms search for a string
  // no row contains, and it pushes a real query off the 4-deep ladder.
  const nameHasBrand = !!item.brand &&
    item.name.toLowerCase().includes(item.brand.toLowerCase());
  if (item.brand && !nameHasBrand) push(`${item.brand} ${item.name}`);
  push(item.name);
  const words = item.name.split(/\s+/).filter(Boolean);
  // Drop LEADING words before trailing ones. Prep state is written as a
  // prefix ("roasted edamame", "boiled egg"), so trimming from the front
  // keeps the food and sheds the modifier; trimming from the back does the
  // reverse and searches for "roasted", losing the identity entirely.
  for (let i = 1; i < words.length; i++) push(words.slice(i).join(" "));
  for (let n = words.length - 1; n >= 1; n--) push(words.slice(0, n).join(" "));
  // Catalog and OFF run CONCURRENTLY and both feed decide - OFF is no longer a
  // miss-only fallback. Our own catalog is largely OFF-derived, so OFF is not a
  // lower-trust tier; decide picks between them and the guardrails recompute
  // and sanity-check whatever it picks. Catalog still leads the merged list
  // (a curated row with real servings should outrank a raw label), and items
  // resolve in parallel, so the meal pays roughly one OFF latency, not N.
  // A multi-word name has TWO plausible identities, and the ladder above only
  // explores one of them. It drops LEADING words first, which is right for
  // "roasted edamame" (prep prefix) and wrong for "paneer bhurji", where the
  // head noun IS the food and the tail is the style: the full query matches
  // nothing (the 0079 search requires every word), so it falls to "bhurji"
  // alone and returns Egg Bhurji. Running BOTH ends and merging lets rerank
  // decide which reading the user meant. Catalog search is ~30ms, so the
  // second query is far cheaper than the wrong food.
  const multiWord = words.length > 1;
  const runCatalog = async (): Promise<CandidateFood[]> => {
    // All ladder queries fire CONCURRENTLY; the ladder's preference order is
    // applied to the results, not to the waiting. The serial version paid the
    // SUM of the queries (measured 300-1400ms EACH against production - the
    // "~30ms" note above was from another region), so a two-success ladder cost
    // 0.7-2.5s. Concurrent, it costs the slowest single query. The trade is
    // that we always run all four searches instead of stopping after two
    // successes - a few extra ~30ms index hits now that the function runs next
    // to the DB, spent to remove a serial wait.
    //
    // Success-counting semantics are unchanged: results merge in ladder order
    // and only the first N successful queries contribute, so the candidate
    // list is identical to what the serial loop produced.
    const ladder = queries.slice(0, 4);
    const settled = await Promise.all(ladder.map(async (q) => {
      toolCalls.push("search_foods");
      const tq0 = Date.now();
      let found: CandidateFood[] = [];
      try {
        found = (await deps.searchFoods(q, lean)).slice(0, 6);
      } catch (e) {
        deps.log?.(`[parse_meal] searchFoods threw for "${q}": ${String(e).slice(0, 120)}`);
      }
      return { q, found, ms: Date.now() - tq0 };
    }));
    const merged: CandidateFood[] = [];
    const seenKeys = new Set<string>();
    let successes = 0;
    for (const { q, found, ms } of settled) {
      const counted = successes < (multiWord ? 2 : 1);
      if (found.length > 0 && counted) {
        successes++;
        for (const c of found) {
          const key = c.food_id ?? `name:${c.name.toLowerCase()}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            merged.push(c);
          }
        }
      }
      steps.push({
        iter: 1,
        tool: "search_foods",
        input: { query: q, ms },
        result: { count: found.length, top: found.slice(0, 5).map((c) => c.name) },
      });
    }
    return merged.slice(0, 10);
  };
  const runOff = async (): Promise<CandidateFood[]> => {
    // Fast mode is catalog + the model's own estimate, nothing else. OFF sits
    // in the same Promise.all as the catalog search, so its latency IS the
    // resolve time whenever it is the slowest leg - and it was: 1.3s when it
    // returned nothing against 3.4-4.6s when it returned products to back-fill.
    // What it bought for that was thin. On "banana" it offered "Yogurt Bnine
    // BANANA" and "Banana chips", which the accept gate then threw away.
    // A packaged-food database earns its place in Smart, where there is time to
    // rerank it and a model to judge it. Here the honest fallback is the
    // estimate, which already rode in on the naming call for free.
    if (lean) return [];
    const q = item.brand ? `${item.brand} ${item.name}` : item.name;
    toolCalls.push("lookup_packaged_food");
    const found: CandidateFood[] = [];
    try {
      const fetchFn = deps.fetchFn ?? fetch;
      const products = await searchOpenFoodFacts(q, fetchFn, deps.log);
      // Backfill so the candidate carries a real food_id (verify needs it) and
      // the NEXT user's catalog search finds it at tier 1 - the catalog is
      // meant to compound with use.
      //
      // CONCURRENTLY. These were awaited one at a time, so a query returning
      // three products paid three sequential cross-region writes INSIDE the
      // user's parse. OFF_TIMEOUT_MS caps the search but not this loop, which
      // is why resolve swung between 1.3s (OFF found nothing) and 4.6s (OFF
      // found three). The writes are independent rows; nothing here reads back
      // what another one wrote.
      const ids = await Promise.all(products.map((p) => deps.backfillOffFood(p)));
      products.forEach((p, i) => {
        found.push({
          food_id: ids[i],
          name: p.name,
          brand: p.brand,
          base_unit: p.base_unit,
          kcal: p.kcal,
          protein_g: p.protein_g,
          carb_g: p.carb_g,
          fat_g: p.fat_g,
          fiber_g: p.fiber_g,
          servings: p.serving ? [p.serving] : [],
          source: "off",
        });
      });
    } catch (e) {
      deps.log?.(`[parse_meal] OFF resolve threw for "${q}": ${String(e).slice(0, 120)}`);
    }
    steps.push({
      iter: 1,
      tool: "lookup_packaged_food",
      input: { query: q },
      result: { count: found.length, top: found.slice(0, 5).map((c) => c.name) },
    });
    return found;
  };

  const runFatSecret = async (): Promise<CandidateFood[]> => {
    if (lean || !deps.searchFatSecret) return [];
    const q = item.brand ? `${item.brand} ${item.name}` : item.name;
    toolCalls.push("lookup_fatsecret");
    let found: CandidateFood[] = [];
    try {
      found = await deps.searchFatSecret(q);
    } catch (e) {
      deps.log?.(`[parse_meal] FatSecret resolve threw for "${q}": ${String(e).slice(0, 120)}`);
    }
    steps.push({
      iter: 1,
      tool: "lookup_fatsecret",
      input: { query: q },
      result: { count: found.length, top: found.slice(0, 5).map((c) => c.name) },
    });
    return found;
  };

  const [catalogCands, offCands, fsCands] = await Promise.all([
    runCatalog(),
    runOff(),
    runFatSecret(),
  ]);
  // Catalog first (a curated row with real servings should outrank a raw
  // label), then OFF, then FatSecret. Dedupe by food_id, falling back to a
  // normalised name for rows with no id of their own.
  const seenKey = new Set<string>();
  const candidates: CandidateFood[] = [];
  for (const c of [...catalogCands, ...offCands, ...fsCands]) {
    const key = c.food_id ?? `name:${c.name.toLowerCase()}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    candidates.push(c);
  }

  // Never offer the model a physically impossible row: it cannot tell a bad
  // label from a good one, and picking it produces confident nonsense. Dropping
  // it here means a saner candidate wins, or the item honestly falls to an
  // estimate. (Keep them if EVERY candidate is junk, so we still show something
  // and the verify-stage flag warns the user.)
  const sane = candidates.filter((c) =>
    implausiblePer100({ kcal: c.kcal, protein_g: c.protein_g, carb_g: c.carb_g, fat_g: c.fat_g }) === null
  );
  if (sane.length !== candidates.length) {
    const dropped = candidates.length - sane.length;
    deps.log?.(`[parse_meal] dropped ${dropped} implausible candidate(s) for "${item.name}"`);
    steps.push({ iter: 1, tool: "implausible_filtered", input: { item: item.name, dropped } });
  }
  let usable = sane.length > 0 ? sane : candidates;
  let rerankTopScore: number | undefined;

  // Rerank: the user's own phrase against each candidate, best first. This is
  // where "2 whole eggs" beats "Eggs, chicken, yolk, raw" no matter what order
  // the sources returned. Fail-open: on any miss the merge order stands.
  if (!lean && deps.rerankCandidates && usable.length > 1) {
    const rrQuery = [item.prep, item.brand, item.name].filter(Boolean).join(" ");
    const docs = usable.map((c) => (c.brand ? `${c.brand} ${c.name}` : c.name));
    const rr = await deps.rerankCandidates(rrQuery, docs).catch(() => null);
    if (rr) {
      usable = rr.order.map((idx) => usable[idx]).filter(Boolean);
      rerankTopScore = rr.topScore;
      steps.push({
        iter: 1,
        tool: "rerank",
        input: { item: item.name },
        // margin recorded for P3: a wide margin is what will let Smart skip
        // the decide call for this item.
        result: {
          top: usable.slice(0, 3).map((c) => c.name),
          margin: Math.round(rr.margin * 1000) / 1000,
          top_score: Math.round(rr.topScore * 1000) / 1000,
        },
      });
    }
  }

  // I13 + 0107: the RERANKER UNDOES PERSONALISATION, so put it back.
  //
  // Measured 2026-08-24 on a user with 7 Toned Milk logs in 14 days. Migration
  // 0107 correctly returned "Toned Milk" as the #1 candidate for the query
  // "milk". The reranker then reordered to Milk-whole / Milk-whole-UHT /
  // Milk-sheeps-raw and dropped Toned Milk out of the top 3 entirely, because
  // it scores the bare word "milk" against candidate NAMES and has no idea what
  // this person drinks every morning.
  //
  // Habit is not a semantic question. The reranker's job is telling "2 whole
  // eggs" from "Eggs, chicken, yolk, raw"; it is not equipped to overrule a food
  // the user has logged repeatedly. So a staple keeps its place at the head and
  // the reranker orders everything below it.
  if (stapleNames && stapleNames.size > 0 && usable.length > 1) {
    const isStaple = (c: CandidateFood) => stapleNames.has(c.name.trim().toLowerCase());
    const mine = usable.filter(isStaple);
    if (mine.length > 0 && mine.length < usable.length) {
      usable = [...mine, ...usable.filter((c) => !isStaple(c))];
      steps.push({
        iter: 1,
        tool: "staple_promoted",
        input: { item: item.name },
        result: { top: usable.slice(0, 3).map((c) => c.name) },
      });
    }
  }

  // decide reads every candidate we pass; past ~6 the list is distractors.
  usable = usable.slice(0, 6);
  return { ...item, candidates: usable.map(synthesizeVolumeAnchors), rerankTopScore };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// House rule: no em/en dashes in any user-facing string. The prompt asks for
// this, but a deterministic scrub beats hoping the model complies.
function scrubDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
}

/** `name` is here so the CANDIDATE-fallback branch of verifyItems can run the
 *  same name/row agreement checks the row-read branch does. FatSecret rows are
 *  never persisted, so their ids are ephemeral and getFoodPer100 is skipped for
 *  them - without a name on the fallback, every fatsecret pick bypassed
 *  variantClash and unhonouredGrade entirely. */
export type Per100 = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  name?: string;
};

// ── Name/row agreement ──────────────────────────────────────────────────────
// decide hands back a food_id AND a display name for the same line. They can
// disagree, and when they do the macros follow the id while the user reads the
// name, so a slipped id is invisible: the reported case logged pure YOLK
// macros (347 kcal, 31 g fat per 100 g) under the label "Eggs, chicken, whole,
// raw", 2.6x the real figure for the whole eggs the user actually ate. Two
// guards: repoint the id when the model's own words name a different row it
// was shown, then display the row's real name either way.

/** Order- and punctuation-insensitive, singular-folded token key.
 *  "Eggs, chicken, whole, raw" and "raw whole chicken egg" share a key. */
function nameKey(s: string): string {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .sort().join(" ");
}

/** Whether `outer` contains every (singular-folded) word of `inner`. */
function coversAllWords(outer: string, inner: string): boolean {
  const fold = (s: string) =>
    s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
      .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
  const have = new Set(fold(outer));
  const want = fold(inner);
  return want.length > 0 && want.every((w) => have.has(w));
}

/** Mutually exclusive variants that move macros a lot. Only these: a blanket
 *  "the names differ" test fires on every harmless shortening ("Chicken
 *  breast" for "Chicken, breast, meat only, roasted") and a chip the user
 *  learns to ignore is worse than no chip. */
const VARIANT_GROUPS: string[][] = [
  ["whole", "yolk", "white"],  // egg part: 143 vs 347 vs 52 kcal per 100 g
  ["raw", "boiled", "fried", "poached", "scrambled", "roasted", "grilled", "dried"],
  // Fat/protein grade. PHRASES, not words: "double toned" and "toned" are
  // different milks, and "low fat" is two words. Matched longest-first against
  // the whole name so "double toned" never reads as "toned". This group is why
  // a 50 g "low fat paneer" request cannot silently log full-fat paneer (190
  // vs 283 kcal per 100 g), which is exactly what shipped on 2026-08-22.
  ["double toned", "low fat", "full cream", "full fat", "semi skimmed", "skimmed", "toned"],
  ["high protein", "regular"],
];

/** The GRADE groups (fat level, protein claim). Unlike an egg part or a prep
 *  word, a grade the user asked for and the row does not mention is a real
 *  problem: "low fat paneer" matched to a plain "Milky Mist Paneer" row logs
 *  283 kcal/100g against the product's real 190, and nothing else in the chain
 *  notices, because no term CONTRADICTS, the row is simply silent. */
const GRADE_GROUPS = VARIANT_GROUPS.slice(2);

/** What the row is vs what the model called it, when the two contradict each
 *  other inside one group. null when they agree, or when either says nothing. */
export function variantClash(
  said: string,
  rowName: string,
): { said: string; row: string } | null {
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
  const a = norm(said), b = norm(rowName);
  for (const group of VARIANT_GROUPS) {
    // Longest first: "double toned" must win over "toned" inside the same name.
    const ordered = [...group].sort((x, y) => y.length - x.length);
    const inSaid = ordered.find((g) => a.includes(` ${g} `));
    if (!inSaid) continue;
    // A row can legitimately list SEVERAL terms of one group: USDA writes
    // "Egg, whole, boiled or poached". If the user's own term is among them
    // there is no contradiction - comparing against whichever term happens to
    // be longest called boiled-vs-poached a clash and rejected the exact row
    // the user wanted.
    if (b.includes(` ${inSaid} `)) continue;
    const inRow = ordered.find((g) => b.includes(` ${g} `));
    if (inRow) return { said: inSaid, row: inRow };
  }
  return null;
}

/** A GRADE the user asked for that the matched row does not claim at all, or
 *  null. Silence is the failure mode variantClash cannot see: no term
 *  contradicts, so the wrong-grade row ships looking confident. */
export function unhonouredGrade(said: string, rowName: string): string | null {
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
  const a = norm(said), b = norm(rowName);
  for (const group of GRADE_GROUPS) {
    const ordered = [...group].sort((x, y) => y.length - x.length);
    const inSaid = ordered.find((g) => a.includes(` ${g} `));
    if (!inSaid) continue;
    const rowHasAny = ordered.some((g) => b.includes(` ${g} `));
    if (!rowHasAny) return inSaid;
  }
  return null;
}

/**
 * The grade the user asked for that NO candidate stocks (I11), or null.
 *
 * unhonouredGrade already catches this, but only at verify time, once decide
 * has committed: the line ships with the generic row's macros and a chip
 * apologising for them. By then the damage is done, because the chip does not
 * change the numbers that land in the log.
 *
 * Asking the same question BEFORE decide lets it estimate instead. An estimate
 * of "low fat paneer" lands near the real 190 kcal/100 g; the plain Milky Mist
 * Paneer row it would otherwise take is 283, so the estimate is the more
 * accurate answer even though it is the less confident-looking one. Same for
 * "double toned milk" (42 vs the 58 of the toned row that wins today).
 *
 * Only GRADE_GROUPS, deliberately: fat level and protein claims move macros a
 * long way and are fixed by standard. Prep state and egg part are handled by
 * variantClash, which can see a contradiction rather than a silence.
 */
export function gradeNotStocked(name: string, candidates: CandidateFood[]): string | null {
  if (candidates.length === 0) return null;
  const norm = (x: string) => ` ${x.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
  // Longest first, so "double toned" is never read as "toned".
  const longestIn = (group: string[], text: string): string | null =>
    [...group].sort((a, b) => b.length - a.length).find((g) => text.includes(` ${g} `)) ?? null;

  const said = norm(name);
  for (const group of GRADE_GROUPS) {
    const want = longestIn(group, said);
    if (!want) continue;
    // EQUALITY, not mere presence. Two different misses have to be caught and
    // unhonouredGrade only sees one of them:
    //   silence      - "low fat paneer" vs "Milky Mist Paneer" (no grade at all)
    //   contradiction- "double toned milk" vs "Amul Taaza Toned Milk", where the
    //                  row does carry A grade, just the wrong one. variantClash
    //                  spots that later, but only to apologise on the card; by
    //                  then the toned row's 58 kcal/100 ml is already the number
    //                  being logged for a 42 kcal product.
    // Comparing the row's OWN longest term to the user's catches both, and in
    // both directions ("toned" asked, "double toned" row is also a miss).
    if (candidates.some((c) => longestIn(group, norm(c.name)) === want)) continue;
    return want;
  }
  return null;
}

/**
 * Lines a correction did NOT touch (I1).
 *
 * The extract contract asks for the corrected version of EVERY previous line,
 * unchanged ones included, so a correction re-resolves and re-decides the whole
 * meal. Search and rerank are not deterministic across calls, so a line the
 * user never mentioned can come back pointing at a DIFFERENT row: say "make the
 * roti 3" and your dal can quietly change underneath you. Nothing surfaces it,
 * because the correction card legitimately shows every line as new.
 *
 * Matching one of these means we can leave the line out of resolve entirely and
 * let the previous version through untouched, which is both faster and, more to
 * the point, stable.
 *
 * DELIBERATELY STRICT, because the two errors are not symmetrical. Treating a
 * changed line as unchanged silently discards the user's edit; treating an
 * unchanged line as changed just costs a re-resolve. So this demands the same
 * name AND the same amount AND the same unit, and gives up on anything it
 * cannot line up exactly.
 */
export function unchangedInCorrection(
  item: ExtractedItem,
  previous: PreviousItem[],
): PreviousItem | null {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const unit = (x: string) => norm(x).replace(/s$/, "");
  // A RE-TARGET is a change, however tidy it looks. "actually paneer not tofu"
  // keeps the amount and the unit and points corrects_food_name at the old
  // line, so keying off that field alone reads it as untouched and throws the
  // swap away. The item's OWN name has to be the one already on the card.
  if (item.correctsFoodName && norm(item.correctsFoodName) !== norm(item.name)) return null;
  const target = norm(item.name);
  // Scan ALL same-named lines, do not stop at the first. A meal can hold two
  // entries sharing a name and differing only in size - the "chai 75 g / chai
  // 150 g" case this file calls out elsewhere - and returning on the first one
  // would report a genuinely unchanged line as changed whenever the matching
  // duplicate is not first in the array. That is the safe direction (an extra
  // re-resolve, not lost data), but a re-resolve is exactly the
  // nondeterministic repoint I1 exists to avoid, so do not accept it needlessly.
  for (const p of previous) {
    if (norm(p.food_name) !== target) continue;
    // A prep word the previous line never carried IS a change ("make the egg
    // boiled"). Keep scanning: another same-named line may carry it.
    if (item.prep && !norm(p.food_name).includes(norm(item.prep))) continue;
    const sameQty = Math.abs((item.quantity || 1) - (p.quantity || 1)) < 0.001;
    const sameUnit = unit(item.unit || "serving") === unit(p.serving_label || "serving");
    if (sameQty && sameUnit) return p;
  }
  return null;
}

/**
 * Does a removal phrase name this line? (I6a)
 *
 * Directional on purpose. wordsOverlap asks "are these the same food", which
 * needs the SHORTER side fully covered - and that is the wrong question here.
 * "remove the milk" against "Toned Milk" makes the ROW the shorter side, so it
 * demanded a match for "toned" inside the user's phrase, found none, and
 * reported no match. The line then looked accidentally dropped and
 * keepUncoveredPrevious put it back: the exact resurrection I6a exists to stop.
 * Migration 0106 made this common by adding multi-word graded names.
 *
 * So: strip the command words, then ask only that what REMAINS appears in the
 * row's name. "milk" is inside "toned milk"; the row may be more specific than
 * the user bothered to be, which is the normal case.
 */
const REMOVAL_FILLER = new Set([
  "remove", "delete", "drop", "scratch", "cancel", "undo", "take", "off", "out",
  "the", "that", "this", "those", "these", "a", "an", "my", "i", "did", "not",
  "have", "had", "no", "from", "it", "one", "and", "please", "just",
]);

export function removalNames(phrase: string, rowName: string): boolean {
  const words = (x: string) =>
    x.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  const needle = words(phrase).filter((w) => !REMOVAL_FILLER.has(w));
  if (needle.length === 0) return false;
  const hay = words(rowName);
  if (hay.length === 0) return false;
  return needle.every((n) => hay.some((h) => nearWord(n, h)));
}

/**
 * Which previous line does a removal phrase actually name? (I6a)
 *
 * removalNames answers "could this phrase refer to this row", which is too
 * loose to act on when several rows could answer yes. "remove the milk" against
 * a meal holding BOTH "Milk" and "Chai / Milk Tea" matches both, and treating
 * every match as removed deletes a drink the user never mentioned - then, if it
 * was the only other line, trips the empty-meal path and wipes the card.
 *
 * So pick ONE: the candidate carrying the fewest words the phrase did not ask
 * for. "Milk" adds nothing beyond "milk"; "Chai / Milk Tea" adds two. Ties go
 * to the first, and no candidate returns null rather than guessing.
 */
export function bestRemovalTarget(phrase: string, previous: PreviousItem[]): PreviousItem | null {
  const words = (x: string) => x.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  let best: PreviousItem | null = null;
  let bestExtra = Infinity;
  for (const p of previous) {
    if (!removalNames(phrase, p.food_name)) continue;
    const extra = words(p.food_name).length;
    if (extra < bestExtra) {
      best = p;
      bestExtra = extra;
    }
  }
  return best;
}

/** Repoint a line whose food_id contradicts its own name.
 *
 *  Deliberately narrow: it moves the id only when another candidate FROM THE
 *  SAME SEARCH carries a name the model wrote out token-for-token. That is a
 *  slip rather than a judgement call, so acting on it is safe. Anything looser
 *  would overrule deliberate picks, where the model shortens a branded row's
 *  name or names a row no search returned. Everything it cannot fix is still
 *  made visible downstream by the row-name display + variant chip. */
export function retargetMismatchedIds(
  items: ParsedItem[],
  resolved: ResolvedItem[],
  log?: (msg: string) => void,
): ParsedItem[] {
  if (resolved.length === 0) return items;
  return items.map((item) => {
    // fatsecret included: it is a real candidate source, so a decide slip onto
    // the wrong fs: id is the same fixable mistake as a catalog slip. Excluding
    // it left the newest source as the only one with no id repair, downgrading
    // a correctable slip into a mere warning chip.
    if (
      !item.food_id ||
      (item.source !== "catalog" && item.source !== "off" && item.source !== "fatsecret")
    ) return item;
    // The candidate set this line was actually chosen from.
    const group = resolved.find((r) => r.candidates.some((c) => c.food_id === item.food_id));
    if (!group) return item;
    const chosen = group.candidates.find((c) => c.food_id === item.food_id);
    const key = nameKey(item.food_name);
    if (!key || (chosen && nameKey(chosen.name) === key)) return item;
    // A chosen row that CONTAINS every word of the stated name is the model
    // shortening a label it meant ("Toned milk" for "Amul taaza Toned Milk"),
    // not slipping. Only a name the chosen row contradicts is evidence of a
    // slip, so this is what keeps the rule off deliberate branded picks.
    if (chosen && coversAllWords(chosen.name, item.food_name)) return item;
    const exact = group.candidates.find(
      (c) => c.food_id && c.food_id !== item.food_id && nameKey(c.name) === key,
    );
    if (!exact) return item;
    log?.(
      `[parse_meal] id/name slip: "${item.food_name}" pointed at ` +
      `"${chosen?.name ?? item.food_id}", repointed to the row it names`,
    );
    return { ...item, food_id: exact.food_id, source: exact.source };
  });
}

// The receipts step: for items the model matched to a real food row, recompute
// line macros from the row's per-100 values so catalog-backed numbers are
// deterministic, never model arithmetic.
//
// `fallback` carries the per-100 values the resolve stage already fetched for
// each candidate. It matters because the decide schema tells the model to OMIT
// macros whenever food_id is set, and sanitizeItems defaults anything missing
// to 0: if the row read then fails, there are no model numbers to fall back on
// and the line would ship as a silent 0 kcal food. The candidate we offered in
// the first place is the right answer there, and costs no extra query.
/**
 * Ephemeral ids have done their job (addressing a candidate for decide and
 * keying the per-100 recompute). Drop them before the client can try to log one
 * against meal_entries.food_id, which is a uuid FK into `foods` - an `fs:` id
 * fails that insert, so the user cannot log the meal they just confirmed.
 *
 * This is a helper rather than an inline map because EVERY return path owes it:
 * the skip-decide path returns early and used to bypass the inline version.
 */
export function stripEphemeralIds(items: ParsedItem[]): ParsedItem[] {
  return items.map((it) => (isEphemeralId(it.food_id) ? { ...it, food_id: null } : it));
}

/**
 * Reconcile a line's displayed name against the row its macros came from, and
 * chip it when the two disagree.
 *
 * Shared by both verifyItems branches on purpose. It used to live only in the
 * row-read branch, so any line whose per-100 came from the CANDIDATE fallback -
 * which is every FatSecret pick, since their ids are ephemeral and the row read
 * is skipped - silently bypassed both guards. FatSecret exists to fix the
 * low-fat-paneer class of bug, so it of all sources must be checked.
 */
function applyNameAgreement(
  deps: ParseMealDeps,
  said: string,
  rowName: string,
  scaled: ParsedItem,
): ParsedItem {
  const row = rowName.trim();
  if (!row) return scaled;
  const named = { ...scaled, food_name: row };
  const clash = variantClash(said, row);
  if (clash) {
    // retargetMismatchedIds could not fix this one, so say it out loud
    // rather than let a confident-looking line carry the wrong variant.
    deps.log?.(`[parse_meal] variant mismatch: model said "${said}", row is "${row}"`);
    return {
      ...named,
      confidence: "low",
      assumption: appendAssumption(named, `I logged the ${clash.row} one, not the ${clash.said}`),
    };
  }
  const missingGrade = unhonouredGrade(said, row);
  if (missingGrade) {
    // We have no row for the grade they asked for (usually a coverage gap,
    // e.g. an India-only low fat SKU). Say so instead of shipping the plain
    // row's macros as if they were the product's.
    deps.log?.(`[parse_meal] grade not honoured: asked "${missingGrade}", row is "${row}"`);
    return {
      ...named,
      confidence: "low",
      assumption: appendAssumption(
        named,
        `I could not find a ${missingGrade} row for this, so these are the regular numbers`,
      ),
    };
  }
  return named;
}

export async function verifyItems(
  deps: ParseMealDeps,
  items: ParsedItem[],
  fallback?: Map<string, Per100>,
): Promise<ParsedItem[]> {
  return await Promise.all(items.map(async (item) => {
    if (item.source !== "catalog" && item.source !== "off" && item.source !== "fatsecret") {
      // An estimate carries the model's OWN numbers, so an all-zero line means
      // it omitted them (the decide schema says to omit only when a food_id is
      // set, and it sometimes applies that to the wrong line). NOTHING
      // downstream catches this: 0 kcal against 0 macros is internally
      // consistent, so checkAtwater passes it and "Chicken Breast 200g" ships
      // reading 0 kcal / 0 g protein, which is worse than a rough guess
      // because it silently drags the day's totals down.
      const zeroed = item.grams > 0 &&
        !item.kcal && !item.protein_g && !item.carb_g && !item.fat_g;
      if (!zeroed) return item;
      deps.log?.(`[parse_meal] estimate line came back with no numbers: "${item.food_name}"`);
      return {
        ...item,
        confidence: "low",
        assumption: appendAssumption(item, "I could not put numbers on this one, tap to set them"),
      };
    }
    const usable = item.food_id && Number.isFinite(item.grams) && item.grams > 0;
    // An ephemeral id names no row, so skip the read and let the candidate map
    // below supply the basis. The macros are still recomputed in CODE from a
    // real per-100 panel, never taken from model arithmetic.
    const per100 = usable && !isEphemeralId(item.food_id)
      ? await deps.getFoodPer100(item.food_id!)
      : null;
    // A catalog/OFF claim we cannot check is not a catalog/OFF number. Fall
    // back to the candidate's own per-100 basis; failing that, call the line
    // what it is - an estimate - rather than let the UI present an unverified
    // number with the authority of a looked-up row.
    if (!per100) {
      const alt = usable ? fallback?.get(item.food_id!) : undefined;
      if (!alt) {
        const zeroed = item.kcal === 0 && item.protein_g === 0 && item.carb_g === 0 && item.fat_g === 0;
        return {
          ...item,
          source: "estimate" as const,
          food_id: null,
          confidence: "low" as const,
          // Never ship a silent zero: the model was told to omit these.
          assumption: zeroed
            ? appendAssumption(item, "I could not read this food's nutrition, the numbers here are not reliable")
            : item.assumption,
        };
      }
      const g = item.grams / 100;
      // Same name/row agreement the row-read branch gets. This is the branch
      // every FatSecret pick takes (ephemeral id => no row read), so skipping
      // it here left the newest source as the only one with no variant guard.
      return applyNameAgreement(deps, item.food_name, (alt.name ?? "").trim(), {
        ...item,
        kcal: round1(alt.kcal * g),
        protein_g: round1(alt.protein_g * g),
        carb_g: round1(alt.carb_g * g),
        fat_g: round1(alt.fat_g * g),
        fiber_g: alt.fiber_g === null ? item.fiber_g : round1(alt.fiber_g * g),
        confidence: "medium" as const,
      });
    }
    const f = item.grams / 100;
    // Label and numbers now come from the SAME row, so they cannot disagree.
    // The model's own wording is kept only when the row has no usable name.
    const scaled = applyNameAgreement(deps, item.food_name, (per100.name ?? "").trim(), {
      ...item,
      kcal: round1(per100.kcal * f),
      protein_g: round1(per100.protein_g * f),
      carb_g: round1(per100.carb_g * f),
      fat_g: round1(per100.fat_g * f),
      fiber_g: per100.fiber_g === null ? item.fiber_g : round1(per100.fiber_g * f),
    });
    // Last line of defence. Deliberately understated: we mark the line low
    // confidence (so the UI can show it as unverified) but do NOT editorialise
    // on the card. Volunteering doubt about our own numbers on every borderline
    // meal teaches the user to trust none of them, which is worse than being
    // occasionally wrong. The rigour belongs in the challenge path — when the
    // user says "that looks off", we go and check properly.
    const bad = implausiblePer100(per100) ?? implausibleLine(scaled);
    if (!bad) return scaled;
    deps.log?.(`[parse_meal] implausible row used for "${item.food_name}": ${bad}`);
    return { ...scaled, confidence: "low" as const };
  }));
}

// Clamp/normalize whatever the model handed us before it touches the DB or UI.
function sanitizeItems(raw: unknown): ParsedItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ParsedItem[] = [];
  for (const r of raw.slice(0, 12)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const name = typeof o.food_name === "string" ? o.food_name.trim().slice(0, 120) : "";
    if (!name) continue;
    const num = (v: unknown, max: number): number => {
      const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
      return Math.min(Math.max(n, 0), max);
    };
    // "fatsecret" MUST be listed: it is in the decide schema's source enum, and
    // verifyItems keys the row-recompute branch off it. Dropping it here rewrote
    // every FatSecret pick to "estimate", which then took verifyItems' estimate
    // branch - and because the schema tells the model to omit macros whenever a
    // food_id is set (fs: ids included), those lines shipped as silent zeros.
    const source = o.source === "catalog" || o.source === "off" || o.source === "fatsecret" ||
        o.source === "web" || o.source === "estimate"
      ? o.source
      : "estimate";
    items.push({
      food_id: typeof o.food_id === "string" && o.food_id.length > 0 ? o.food_id : null,
      food_name: name,
      quantity: num(o.quantity, 100) || 1,
      serving_label: typeof o.serving_label === "string" && o.serving_label.trim()
        ? o.serving_label.trim().slice(0, 40)
        : "serving",
      grams: num(o.grams, 5000),
      kcal: num(o.kcal, 10000),
      protein_g: num(o.protein_g, 1000),
      carb_g: num(o.carb_g, 1500),
      fat_g: num(o.fat_g, 1000),
      fiber_g: typeof o.fiber_g === "number" && Number.isFinite(o.fiber_g)
        ? Math.min(Math.max(o.fiber_g, 0), 300)
        : null,
      source,
      assumption: typeof o.assumption === "string" && o.assumption.trim()
        ? scrubDashes(o.assumption).slice(0, 160)
        : null,
      confidence: o.confidence === "high" || o.confidence === "medium" || o.confidence === "low"
        ? o.confidence
        : "medium",
    });
  }
  return items;
}

// ── Nutrient plausibility ───────────────────────────────────────────────────
// Every other guardrail checks CONSISTENCY (do the numbers agree with each
// other?). This one checks PLAUSIBILITY (can this food exist?), which is the
// gap crowd-sourced data walks through: a row claiming 25 g protein per 100 ml
// for a coffee latte is internally consistent and completely wrong. It logged
// 163 g protein for two lattes (prod, 2026-07-19) and every existing check
// passed it.
//
// The rules are split by CONSEQUENCE, because the cost of being wrong differs:
//
//   REJECT  — only the physically impossible. Rejecting drops a food from the
//             candidates entirely, so a false positive silently deletes a real
//             food. These thresholds are therefore unarguable physics.
//   FLAG    — merely implausible. Flagging just lowers confidence and adds a
//             note, so a false positive costs the user a glance, not a wrong
//             log. This is where judgement calls live.
//
// Why not a "drinks can't have 25 g protein per 100 ml" rule, which is what the
// Super Coffee latte actually violated? Because neither base_unit nor
// food_category reliably marks a drink in this catalog: tuna in olive oil and
// soya chunks are stored as 'ml', and protein POWDERS are categorised
// 'beverage' with a legitimate 80 g protein per 100 g. Any such rule rejects
// real foods. The per-LINE flag below catches the same case without that risk:
// whatever the food, 163 g of protein on one line deserves a second look.
const PLAUSIBLE = {
  maxKcalPer100: 920,      // USDA lists pure fats (lard, tallow, fish oil) at
                           // 902, so 900 would have deleted real foods. 9 kcal
                           // per gram is the physical ceiling; this allows the
                           // rounding above it and nothing more.
  maxMacroSumPer100: 105,  // macros cannot outweigh the food (+5 for rounding)
  maxProteinPer100: 100,   // the hard ceiling: 100 g of food cannot hold more
                           // than 100 g of protein. Real ultra-filtered isolates
                           // label as high as 98.9, so anything below this bound
                           // would delete a genuine product.
  flagLineProtein: 100,    // one line: a 300 g chicken breast is only ~90 g
  flagLineKcal: 2000,      // one line above a day's worth of food
};

/** Why this per-100 basis cannot describe ANY real food, or null if it could.
 *  Used to reject: keep it to physics, never taste. */
export function implausiblePer100(
  per100: { kcal: number; protein_g: number; carb_g: number; fat_g: number },
): string | null {
  const { kcal, protein_g, carb_g, fat_g } = per100;
  if ([kcal, protein_g, carb_g, fat_g].some((v) => !Number.isFinite(v) || v < 0)) {
    return "negative or missing values";
  }
  if (protein_g + carb_g + fat_g > PLAUSIBLE.maxMacroSumPer100) {
    return `its macros total ${Math.round(protein_g + carb_g + fat_g)} g per 100, more than the food weighs`;
  }
  if (kcal > PLAUSIBLE.maxKcalPer100) return `${Math.round(kcal)} kcal per 100 is more than pure fat`;
  if (protein_g > PLAUSIBLE.maxProteinPer100) {
    return `${Math.round(protein_g)} g protein per 100 is more than pure isolate`;
  }
  return null;
}

/** A zero line, for checking totals without a full ParsedItem to hand. */
const EMPTY_LINE: ParsedItem = {
  food_id: null, food_name: "", quantity: 1, serving_label: "", grams: 0,
  kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: null,
  source: "estimate", assumption: null, confidence: "medium",
};

/** Why a LOGGED line looks wrong for a single food, or null. Used to flag, not
 *  reject — this is the net that caught 163 g of protein from two lattes. */
export function implausibleLine(item: ParsedItem): string | null {
  if (item.protein_g > PLAUSIBLE.flagLineProtein) {
    return `${Math.round(item.protein_g)} g of protein in one item is a lot`;
  }
  if (item.kcal > PLAUSIBLE.flagLineKcal) {
    return `${Math.round(item.kcal)} calories in one item is a lot`;
  }
  return null;
}

// ── Deterministic guardrails ────────────────────────────────────────────────
// Pure-code checks on model output. These are safety nets for whole CLASSES of
// error (impossible densities, kcal that contradicts the macros, roasted-vs-
// cooked mismatches), not precision tools; precision comes from catalog
// serving anchors and server-side macro recompute.

const ML_PER_SPOON_UNIT: Record<string, number> = {
  tsp: 4.93, teaspoon: 4.93, tbsp: 14.79, tablespoon: 14.79, cup: 236.59,
};
// Broad food-density envelope in g/ml: puffed cereal ~0.15 up to honey ~1.5.
const DENSITY_MIN = 0.15;
const DENSITY_MAX = 1.6;

// "tbsp" / "2 tbsp" / "1 tablespoon" -> total ml for the label itself.
function labelVolumeMl(label: string): number | null {
  const m = label.toLowerCase().match(/^(\d+(?:\.\d+)?)?\s*(tsp|teaspoon|tbsp|tablespoon|cup)s?\b/);
  if (!m) return null;
  return (m[1] ? parseFloat(m[1]) : 1) * ML_PER_SPOON_UNIT[m[2]];
}

function appendAssumption(item: ParsedItem, note: string): string {
  return item.assumption ? `${item.assumption}. ${note}` : note;
}

// Volumetric sanity: grams for a spoon/cup line must imply a physically
// possible density. Runs BEFORE verifyItems so corrected grams drive the
// macro recompute; estimate items get their macros scaled proportionally.
export function clampVolumetricGrams(items: ParsedItem[]): ParsedItem[] {
  return items.map((item) => {
    const perLabelMl = labelVolumeMl(item.serving_label);
    if (perLabelMl === null || !(item.grams > 0) || !(item.quantity > 0)) return item;
    // A label may or may not already include its own count ("2 tbsp" vs "tbsp"),
    // and the model is not consistent about it, so multiplying by quantity can
    // double-count. This guard exists to catch the IMPOSSIBLE, so read it both
    // ways and only act when neither reading is physically possible - a false
    // clamp would corrupt a perfectly good line.
    const candidates = [perLabelMl * item.quantity, perLabelMl];
    const plausible = candidates.some((ml) => {
      const d = item.grams / ml;
      return d >= DENSITY_MIN && d <= DENSITY_MAX;
    });
    if (plausible) return item;
    // Clamp against the reading that needs the least correction.
    const totalMl = candidates.reduce((best, ml) =>
      Math.abs(item.grams / ml - 1) < Math.abs(item.grams / best - 1) ? ml : best
    );
    const density = item.grams / totalMl;
    const bound = density > DENSITY_MAX ? DENSITY_MAX : DENSITY_MIN;
    const grams = round1(totalMl * bound);
    const scale = grams / item.grams;
    return {
      ...item,
      grams,
      kcal: round1(item.kcal * scale),
      protein_g: round1(item.protein_g * scale),
      carb_g: round1(item.carb_g * scale),
      fat_g: round1(item.fat_g * scale),
      fiber_g: item.fiber_g === null ? null : round1(item.fiber_g * scale),
      confidence: "low",
      assumption: appendAssumption(item, `Adjusted to ${grams} g, the logged weight was not physically possible for ${item.serving_label}`),
    };
  });
}

// Atwater consistency: kcal must roughly match 4P + 4C + 9F. Runs AFTER
// verifyItems. Generous 30% tolerance absorbs fiber/rounding conventions.
// Only a model-INVENTED line gets its kcal recomputed from its own macros.
// Anything that came from a real label - catalog, OFF, or a web lookup - is
// flagged instead: a printed panel legitimately breaks strict Atwater (fiber
// netting, sugar alcohols, alcohol, rounding), and overwriting it would
// replace a real number with a computed guess. That matters most on the
// research path, where the user challenged a number and explicitly asked us
// to go read the label.
export function checkAtwater(items: ParsedItem[]): ParsedItem[] {
  return items.map((item) => {
    // A line the user typed themselves is not ours to second-guess. They may
    // deliberately be accounting for fiber or alcohol, and telling them their
    // own numbers "disagree" after they merely changed the quantity reads as
    // the app arguing with them.
    if (item.source === "manual") return item;
    const atwater = 4 * item.protein_g + 4 * item.carb_g + 9 * item.fat_g;
    if (atwater < 20 && item.kcal < 20) return item;
    const ref = Math.max(item.kcal, atwater);
    if (ref <= 0 || Math.abs(item.kcal - atwater) / ref <= 0.3) return item;
    if (item.source === "estimate") {
      return { ...item, kcal: round1(atwater) };
    }
    return {
      ...item,
      confidence: "low",
      assumption: appendAssumption(item, "Calories and macros disagree on the source label, treat this line as rough"),
    };
  });
}

// Quantity/serving reconciliation: `grams` is the authoritative total (it
// drives every macro via verifyItems), but the model also emits quantity +
// serving_label for DISPLAY. Those can disagree when the serving label already
// encodes a count: "2 pc gulab jamun" logged quantity 2 against the "2 pieces"
// serving (130 g) while grams stayed 130 — the UI then reads "2 x 2 pieces",
// i.e. double what was actually logged. Nutrition is never touched here; we
// only rewrite the displayed quantity so quantity x serving == grams holds.
export function reconcileQuantity(
  items: ParsedItem[],
  servingsByFood: Map<string, ServingOption[]>,
): ParsedItem[] {
  return items.map((item) => {
    if (!(item.grams > 0)) return item;
    // A bare unit label ("g", "ml") IS the amount: there is no serving size to
    // divide by, so the displayed quantity must equal the logged grams. Without
    // this the card prints decide's own quantity verbatim, which is how "250ml
    // toned milk" shipped reading "100 x ml" while its macros were right for
    // 250 (observed on device 2026-08-22). The anchor path below cannot catch
    // it: a bare unit never matches a serving label, so it returned untouched.
    //
    // This branch runs for EVERY source, before the food_id gate below. It is
    // pure display arithmetic and needs no row: an ESTIMATE line has a quantity
    // and a label just like a catalog one, and gating it on food_id left
    // exactly the same "100 x ml" caption on every ungrounded line.
    if (MASS_UNITS.has(item.serving_label.trim().toLowerCase())) {
      const q = Math.round(item.grams * 100) / 100;
      return q > 0 && Math.abs(q - item.quantity) > 0.05 ? { ...item, quantity: q } : item;
    }
    // The serving-anchor path below DOES need a row to look anchors up on.
    if (!item.food_id) return item;
    const servings = servingsByFood.get(item.food_id);
    if (!servings || servings.length === 0) return item;
    const match = servings.find((s) => s.label.toLowerCase() === item.serving_label.toLowerCase());
    if (!match || !(match.grams > 0)) return item;
    const implied = item.grams / match.grams;
    // Tolerate rounding; only rewrite when the stated quantity is genuinely
    // inconsistent with the logged grams.
    if (Math.abs(implied - item.quantity) <= 0.05) return item;
    const q = implied >= 1 ? Math.round(implied * 100) / 100 : Math.round(implied * 1000) / 1000;
    return { ...item, quantity: q > 0 ? q : item.quantity };
  });
}

// Preparation-state mismatch: the user typed roasted/dried/fried but the
// matched row is a cooked/boiled food (or vice versa). Water content differs
// 2-3x, so macros are systematically wrong; surface it and drop confidence.
const DRY_PREP_RE = /\b(roasted|dry.?roasted|toasted|dried|dehydrated|fried|crispy|crunchy)\b/i;
const WET_PREP_RE = /\b(cooked|boiled|steamed|stewed)\b/i;

export type PrepState = "dry" | "wet";

/** The prep state a piece of text implies, or null if it says nothing. */
export function prepStateOf(text: string): PrepState | null {
  if (DRY_PREP_RE.test(text)) return "dry";
  if (WET_PREP_RE.test(text)) return "wet";
  return null;
}

/**
 * Per-item preparation-state check.
 *
 * `prepByFoodId` carries, for each matched row, what the USER asked for and the
 * ROW's own name - both resolved per item, not scraped from the whole message.
 * The old meal-wide version read the prep word from anywhere in the text, so
 * "boiled eggs and roasted chana" flagged the correctly-cooked eggs because
 * "roasted" appeared somewhere; and it needed the row name to share a word with
 * the text, so "roasted chana" -> "Chickpeas, boiled" slipped through since
 * "chana" and "chickpeas" share nothing. Keying on food_id fixes both, and it
 * catches wet->dry as well as dry->wet.
 */
export function flagPrepMismatch(
  items: ParsedItem[],
  // Omitted by the research and correction paths: their items are web labels
  // (no food_id, skipped anyway) or serving/quantity edits that never change
  // prep, so there is no row to check against.
  prepByFoodId: Map<string, { userIntent: PrepState; rowName: string }> = new Map(),
): ParsedItem[] {
  return items.map((item) => {
    // Never second-guess a line the user typed (contract invariant 2/3).
    if (!item.food_id || item.source === "manual") return item;
    const entry = prepByFoodId.get(item.food_id);
    if (!entry) return item;
    const rowState = prepStateOf(entry.rowName);
    if (!rowState || rowState === entry.userIntent) return item;
    // dry food matched to a wet row reads LOW (wet food is mostly water); the
    // reverse reads high. Name the direction so the note is actually useful.
    const note = entry.userIntent === "dry"
      ? "You said roasted or dried but I matched a cooked entry, calories may read low"
      : "You said cooked or boiled but I matched a dried entry, calories may read high";
    return { ...item, confidence: "low", assumption: appendAssumption(item, note) };
  });
}

/**
 * Answer "is that right?" about the meal on screen, with receipts.
 *
 * Built in CODE from the food rows, not by the model: the whole point is to
 * show where a number actually came from, and a model asked to justify its own
 * output will happily invent a justification. One catalog read per line, no
 * extra model call, so a challenge is answered in about a second.
 *
 * When the underlying row is implausible we say so outright — the user
 * challenging the number is usually right, and admitting it beats defending it.
 */
async function answerAboutPrevious(
  deps: ParseMealDeps,
  previous: PreviousItem[],
  canResearch: boolean,
): Promise<string> {
  const parts: string[] = [];
  for (const p of previous.slice(0, 3)) {
    if (!p.food_id) {
      parts.push(`${p.food_name}: my own estimate for ${round1(p.grams)} g, no label behind it.`);
      continue;
    }
    const per100 = await deps.getFoodPer100(p.food_id).catch(() => null);
    if (!per100) continue;
    const unit = per100.base_unit === "ml" ? "ml" : "g";
    const total = round1(per100.protein_g * (p.grams / 100));
    const totalKcal = round1(per100.kcal * (p.grams / 100));
    parts.push(
      `${p.food_name}: the label says ${round1(per100.protein_g)} g protein and ` +
      `${Math.round(per100.kcal)} kcal per 100 ${unit}, times ${round1(p.grams)} ${unit} = ${total} g protein.`,
    );
    // Both nets: an impossible per-100 basis, or a total that is a lot for one
    // item (the case the user actually catches, like 163 g of protein).
    const bad = implausiblePer100(per100)
      ?? implausibleLine({ ...EMPTY_LINE, protein_g: total, kcal: totalKcal });
    if (bad) parts.push(`Worth flagging: ${bad}.`);
  }
  if (parts.length === 0) return "I could not trace those numbers. Tap a line to set it yourself.";
  // The user has told us the cheap answer looks wrong, so this is exactly when
  // to offer the expensive one. Offered only here, never unprompted: volunteering
  // doubt on every meal would just teach them to distrust every number.
  parts.push(
    canResearch
      ? "Want me to look up the label online, or would you rather set it yourself?"
      : "Tap the line to set it yourself and I will use your numbers.",
  );
  return scrubDashes(parts.join(" ")).slice(0, 400);
}

/**
 * The user accepted an offer to go and check: look the label up on the web and
 * rebuild their lines from it.
 *
 * This is the one place we spend real time on purpose. Normally a web search is
 * a last resort because it costs seconds, but here the user has explicitly told
 * us the cheap answer was wrong — so the expensive answer is the right one.
 * Keeps their grams (they know what they ate) and replaces only the per-100
 * basis, which is the part that was in doubt.
 */
async function researchPrevious(
  deps: ParseMealDeps,
  previous: PreviousItem[],
  onUsage: (data: any) => void,
  onCall: () => void,
): Promise<{ items: ParsedItem[]; note: string; conflict: string | null } | null> {
  if (!deps.webSearchEnabled || previous.length === 0) return null;
  const targets: ExtractedItem[] = previous.slice(0, 3).map((p) => ({
    name: p.food_name,
    brand: null,
    quantity: p.quantity,
    unit: p.serving_label,
    prep: null,
  }));
  const labels = await runWebLookup(deps, targets, onUsage, onCall).catch(() => null);
  if (!labels || labels.size === 0) return null;

  const items: ParsedItem[] = [];
  let changed = 0;
  const conflicts: string[] = [];
  for (const p of previous) {
    let label: WebLabel | null = null;
    for (const [forItem, l] of labels) {
      if (wordsOverlap(p.food_name, forItem)) { label = l; break; }
    }
    if (!label || !(p.grams > 0)) {
      // No label for this line (not looked up, or no name match). Keep it as it
      // was: the caller replaces the whole meal with what we return.
      items.push(previousAsParsedItem(p));
      continue;
    }
    const f = p.grams / 100;

    // Does the web disagree MATERIALLY with the row we already had? Brands ship
    // near-identical names for very different products (Super Coffee sells both
    // a 60 kcal Vanilla Latte and a 150 kcal Protein+ Vanilla Latte), so a big
    // gap usually means the lookup found a DIFFERENT VARIANT rather than a
    // better number. Silently swapping there turns a right answer into a wrong
    // one, so the user gets to choose instead.
    if (p.food_id) {
      const current = await deps.getFoodPer100(p.food_id).catch(() => null);
      if (current) {
        const curKcal = current.kcal * f;
        const webKcal = label.per_100.kcal * f;
        const ref = Math.max(curKcal, webKcal);
        if (ref > 40 && Math.abs(curKcal - webKcal) / ref > 0.3) {
          conflicts.push(
            `${p.food_name}: you have ${Math.round(curKcal)} kcal logged, the label I found gives ` +
            `${Math.round(webKcal)} kcal. Brands sell close variants under the same name, so check which one you had.`,
          );
        }
      }
    }
    changed++;
    items.push({
      // food_id drops: these macros are the web label's, not that catalog row's,
      // so verifyItems must not overwrite them with the numbers we distrusted.
      food_id: null,
      food_name: p.food_name,
      quantity: p.quantity,
      serving_label: p.serving_label,
      grams: p.grams,
      kcal: round1(label.per_100.kcal * f),
      protein_g: round1(label.per_100.protein_g * f),
      carb_g: round1(label.per_100.carb_g * f),
      fat_g: round1(label.per_100.fat_g * f),
      fiber_g: label.per_100.fiber_g === null ? null : round1(label.per_100.fiber_g * f),
      source: "web",
      assumption: label.source_note ?? "Checked against the label online",
      confidence: "medium",
    });
  }
  if (changed === 0) return null;
  return {
    items,
    note: "Checked the label online and updated these numbers.",
    conflict: conflicts.length > 0 ? scrubDashes(conflicts.join(" ")).slice(0, 400) : null,
  };
}

/** Match a user's phrasing of an amount ("small", "1 medium", "2 pieces")
 *  against a food's real serving labels. Exact first, then substring both
 *  ways so "small" finds "1 small/individual". */
function matchServing(servings: ServingOption[], unit: string): ServingOption | null {
  const u = unit.trim().toLowerCase();
  if (!u) return null;
  const norm = (s: string) => s.toLowerCase().replace(/^\d+(\.\d+)?\s*/, "").trim();
  return servings.find((s) => s.label.toLowerCase() === u)
    ?? servings.find((s) => norm(s.label) === u)
    ?? servings.find((s) => norm(s.label).includes(u) || u.includes(norm(s.label)))
    ?? null;
}

/**
 * Resolve a correction WITHOUT a decide call.
 *
 * A correction like "make it a small one" changes only how much of an
 * already-identified food was eaten. The food row is known (food_id from the
 * line on screen), so its servings and per-100 macros are all we need: pick the
 * serving the user named, scale, done. That turns a ~6s reparse into ~2s (one
 * extract call plus one catalog read), which matters because corrections come
 * in bursts while the user is looking at the card.
 *
 * Returns null when anything is ambiguous — an unknown food, a serving we
 * cannot match, a changed food identity — so the caller falls back to the full
 * pipeline rather than guessing.
 */
export async function tryFastCorrection(
  deps: ParseMealDeps,
  extItems: ExtractedItem[],
  previous: PreviousItem[],
): Promise<ParsedItem[] | null> {
  const byName = new Map(previous.map((p) => [p.food_name.toLowerCase(), p]));
  const out: ParsedItem[] = [];

  for (const item of extItems) {
    const prev = item.correctsFoodName ? byName.get(item.correctsFoodName.toLowerCase()) : undefined;
    // Every line must map to a known, catalog-backed previous line.
    if (!prev || !prev.food_id) return null;
    // A changed identity ("paneer not tofu") needs a real re-resolve.
    if (!wordsOverlap(item.name, prev.food_name)) return null;

    const per100 = await deps.getFoodPer100(prev.food_id);
    if (!per100) return null;

    let grams: number | null = null;
    let servingLabel = prev.serving_label;
    const massUnit = item.unit.trim().toLowerCase();
    if (massUnit === "g" || massUnit === "ml" || massUnit === "gram" || massUnit === "grams") {
      grams = item.quantity;
      servingLabel = massUnit === "ml" ? "ml" : "g";
    } else {
      const servings = await deps.getFoodServings?.(prev.food_id) ?? [];
      const sv = matchServing(servings, item.unit)
        // "make it 2" keeps the serving and only changes the count.
        ?? (item.unit === "serving" ? matchServing(servings, prev.serving_label) : null);
      if (!sv || !(sv.grams > 0)) return null;
      grams = sv.grams * item.quantity;
      servingLabel = sv.label;
    }
    if (!(grams > 0)) return null;

    // A line the user edited by hand is authoritative. Recomputing it from the
    // catalog would silently discard the numbers they typed - the exact thing
    // ParsedItemEditor promises never happens - and relabel their line
    // "catalog". Rescale THEIR macros to the new weight and keep the
    // provenance. Without a usable previous basis there is nothing to scale,
    // so fall back to the full pipeline rather than quietly substituting the
    // catalog's numbers.
    if (prev.source === "manual") {
      if (!(prev.grams > 0) || typeof prev.kcal !== "number") return null;
      const s = grams / prev.grams;
      out.push({
        food_id: prev.food_id,
        food_name: prev.food_name,
        quantity: item.quantity,
        serving_label: servingLabel,
        grams: round1(grams),
        kcal: round1(prev.kcal * s),
        protein_g: round1((prev.protein_g ?? 0) * s),
        carb_g: round1((prev.carb_g ?? 0) * s),
        fat_g: round1((prev.fat_g ?? 0) * s),
        fiber_g: typeof prev.fiber_g === "number" ? round1(prev.fiber_g * s) : null,
        source: "manual",
        assumption: prev.assumption ?? null,
        confidence: prev.confidence ?? "high",
      });
      continue;
    }

    const f = grams / 100;
    out.push({
      food_id: prev.food_id,
      food_name: prev.food_name,
      quantity: item.quantity,
      serving_label: servingLabel,
      grams: round1(grams),
      kcal: round1(per100.kcal * f),
      protein_g: round1(per100.protein_g * f),
      carb_g: round1(per100.carb_g * f),
      fat_g: round1(per100.fat_g * f),
      fiber_g: per100.fiber_g === null ? null : round1(per100.fiber_g * f),
      // Keep the line's provenance. Hardcoding "catalog" promoted an OFF-backed
      // row to a fully vetted one: the card's "from label" chip vanished and a
      // packaged-food panel started reading as a curated match, purely because
      // the user changed the quantity. Same for the assumption note, which
      // explains an earlier judgement that a rescale does not invalidate.
      source: prev.source ?? "catalog",
      assumption: prev.assumption ?? null,
      confidence: "high",
    });
  }
  return out.length > 0 ? out : null;
}

// Extract -> resolve -> decide. Two model calls on the common path (three
// or four only when server web_search fires), with every catalog lookup a
// deterministic parallel fetch between them — versus 3-6 sequential model
// turns in the old tool-loop design.
export async function runParseMeal(
  deps: ParseMealDeps,
  input: ParseMealInput,
): Promise<ParseMealResult> {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    web_search_requests: 0,
  };
  const toolCalls: string[] = [];
  const steps: ParseStep[] = [];
  let anthropicCalls = 0;
  // Stage timing (temporary #1 latency instrumentation, folded into steps).
  const T: Record<string, number> = {};

  const accumulate = (data: any) => {
    const u = data.usage ?? {};
    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    usage.web_search_requests += u.server_tool_use?.web_search_requests ?? 0;
  };
  const declineResult = (message: string, cleared?: boolean): ParseMealResult => ({
    parsed: null,
    declined: cleared ? { message, cleared } : { message },
    usage,
    tool_calls: toolCalls,
    steps,
    iterations: anthropicCalls,
  });

  // ── Stage 1: extract ──────────────────────────────────────────────────────
  const prevItems = input.previousItems ?? [];
  const hasPrevious = prevItems.length > 0;
  // Fast only ever handles a first-shot log. With a card on screen the turn may
  // be a correction, removal, question or addition, and those need the full
  // pipeline; silently degrading them to fast would eat the user's intent.
  const fastMode = input.mode === "fast" && !hasPrevious;
  // The prep-state guard looks for words like "roasted" in what the user wrote.
  // On a follow-up the current text is "yes" or "make it 3", so the describing
  // words live in the ORIGINAL message: match against both.
  // ── Lane A: can CODE name these items? ────────────────────────────────────
  // Only on a first-shot log. With a card on screen the turn may be a
  // correction, a removal, a question or an addition, and all of those need the
  // model to read intent - "And a dosa" parses cleanly as one dosa but MEANS
  // add it to what is already there.
  const grammarMode = deps.fastGrammarMode ?? "off";
  const laneA = (!hasPrevious && grammarMode !== "off")
    ? parseFastGrammar(input.text)
    : null;
  if (laneA) {
    steps.push({
      iter: 0,
      tool: "lane_a_grammar",
      input: { mode: grammarMode, items: laneA.length },
      result: { named: laneA.map((i) => `${i.quantity} ${i.unit} ${i.prep ?? ""} ${i.name}`.trim()) },
    });
  }

  const tExtract0 = Date.now();
  // THE POINT of Lane A: when it is on and it matched, the extract call does
  // not happen at all. That is the ~1.2s the sub-second budget needs back.
  const extractRes = (laneA && grammarMode === "on")
    ? null
    : await callAnthropicOnce(deps, {
    model: deps.model,
    max_tokens: 700,
    // The correction rules only matter when a meal is on screen, so they stay
    // out of the prompt otherwise (smaller prompt, no behaviour to misfire).
    // fastMode is defined as mode === "fast" && !hasPrevious, so these three
    // branches are exclusive by construction.
    system: cacheableSystem(
      fastMode
        ? FAST_EXTRACT_SYSTEM
        : hasPrevious
        ? EXTRACT_SYSTEM_SMART + EXTRACT_CORRECTION_RULES
        : EXTRACT_SYSTEM_SMART,
    ),
    tools: withToolCache([fastMode ? FAST_EXTRACT_TOOL : EXTRACT_TOOL]),
    tool_choice: { type: "tool", name: "extract_meal" },
    messages: [{
      role: "user",
      content: hasPrevious
        ? JSON.stringify({
          text: input.text.trim().slice(0, 500),
          // What was actually SAID, so "yes" / "no, the other one" resolve.
          recent_turns: (input.recentTurns ?? []).slice(-4).map((t) => ({
            [t.role === "user" ? "user" : "drona"]: t.text.slice(0, 240),
          })),
          previous_meal: {
            text: input.previousText ?? "",
            items: prevItems.map((p) => ({
              food_name: p.food_name,
              quantity: p.quantity,
              serving_label: p.serving_label,
              grams: p.grams,
            })),
          },
        })
        : input.text.trim().slice(0, 500),
    }],
  });
  if (extractRes && !extractRes.ok) {
    throw new Error(`anthropic_${extractRes.status}: ${extractRes.body.slice(0, 300)}`);
  }
  if (extractRes) {
    anthropicCalls++;
    accumulate(extractRes.data);
    toolCalls.push("extract_meal");
  }

  const extractBlock = extractRes
    ? ((extractRes.data.content ?? []) as Array<Record<string, any>>)
      .find((b) => b.type === "tool_use" && b.name === "extract_meal")
    : undefined;
  // When the extract call was skipped, the grammar's own items ARE the extract
  // result. Every flag defaults false: the grammar refuses corrections,
  // removals and questions outright, so none of them can be true here.
  const ext: Record<string, unknown> = extractBlock?.input ?? (
    laneA && grammarMode === "on"
      ? {
        declined: false,
        items: laneA.map((i) => ({
          name: i.name,
          brand: null,
          quantity: i.quantity,
          unit: i.unit,
          prep: i.prep,
          corrects_food_name: null,
        })),
      }
      : {}
  );
  let extItems: ExtractedItem[] = (Array.isArray(ext.items) ? ext.items : [])
    .slice(0, 12)
    .flatMap((r: unknown): ExtractedItem[] => {
      if (!r || typeof r !== "object") return [];
      const o = r as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
      if (!name) return [];
      return [{
        name,
        brand: typeof o.brand === "string" && o.brand.trim() ? o.brand.trim().slice(0, 60) : null,
        // NOT capped at 100: for a mass/volume unit the quantity IS the amount,
        // so "500 ml milk" or "250 g chicken" would be silently truncated. The
        // bound only exists to stop absurd input reaching the model.
        quantity: coerceQuantity(o.quantity),
        unit: typeof o.unit === "string" && o.unit.trim() ? o.unit.trim().slice(0, 30) : "serving",
        prep: typeof o.prep === "string" && o.prep.trim() ? o.prep.trim().slice(0, 30) : null,
        correctsFoodName: typeof o.corrects_food_name === "string" && o.corrects_food_name.trim()
          ? o.corrects_food_name.trim().slice(0, 120)
          : null,
        // All five or nothing: a partial estimate is not an estimate, and a
        // missing field silently read as 0 is how zero-kcal lines shipped once
        // before.
        est: (() => {
          const nums = ["est_per100_kcal", "est_per100_protein_g", "est_per100_carb_g", "est_per100_fat_g", "est_total_g"]
            .map((k) => o[k]);
          if (!nums.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return null;
          const [kcal, protein_g, carb_g, fat_g, total_g] = nums as number[];
          return total_g > 0 ? { kcal, protein_g, carb_g, fat_g, total_g: Math.min(total_g, 5000) } : null;
        })(),
      }];
    });
  // Shadow: did the grammar name the same foods the model did? Recorded, never
  // acted on, so flipping to "on" is a decision made from real traffic rather
  // than from how confident the grammar feels. Names are compared through
  // wordsOverlap because extract deliberately corrects spelling ("panner" ->
  // "paneer") and canonicalises ("chai" -> "milk tea"), so an exact match would
  // report disagreement where the two actually agree.
  if (laneA && grammarMode === "shadow" && extractRes) {
    const sameCount = laneA.length === extItems.length;
    const sameNames = sameCount &&
      laneA.every((g, i) => wordsOverlap(g.name, extItems[i].name));
    const sameAmounts = sameCount && laneA.every((g, i) =>
      Math.abs(g.quantity - extItems[i].quantity) < 0.01 &&
      g.unit.replace(/s$/, "") === extItems[i].unit.toLowerCase().replace(/s$/, "")
    );
    steps.push({
      iter: 0,
      tool: "lane_a_shadow",
      input: { same_count: sameCount, same_names: sameNames, same_amounts: sameAmounts },
      result: (sameNames && sameAmounts) ? { agree: true } : {
        grammar: laneA.map((i) => `${i.quantity} ${i.unit} ${i.name}`),
        extract: extItems.map((i) => `${i.quantity} ${i.unit} ${i.name}`),
      },
    });
  }

  // Only trust the correction flag when a previous meal was actually supplied.
  const correctsPrevious = hasPrevious && ext.corrects_previous === true;
  // Previous lines the user explicitly re-targeted. These are deliberately
  // replaced, so the no-drop guard must not resurrect them.
  const replacedNames = new Set(
    extItems
      .map((i) => i.correctsFoodName?.trim().toLowerCase())
      .filter((n): n is string => !!n),
  );
  // I6a: deletion by text used to be IMPOSSIBLE to express. "remove the tofu"
  // left the line out of items, and keepUncoveredPrevious - whose job is to stop
  // decide silently dropping food - dutifully put it back. The user's only way
  // to delete was the card's own X button.
  //
  // No new suppression mechanism needed: a removed line is the same shape as a
  // re-targeted one, in that the guard must not resurrect it. Feeding removals
  // into replacedNames reuses that path exactly.
  const removedNames: string[] = Array.isArray(ext.removed_food_names)
    ? (ext.removed_food_names as unknown[])
      .filter((n): n is string => typeof n === "string" && n.trim() !== "")
      .map((n) => n.trim().toLowerCase())
    : [];
  // Removal is ENFORCED here, not merely requested. The schema tells the model
  // to leave a removed line out of items, but a prompt instruction is not
  // something to trust per turn - which is precisely why keepUncoveredPrevious
  // and preserveManual exist. If the model names a line as removed and then
  // lists it anyway, the user's delete would silently do nothing.
  // Resolve each removal phrase to the ONE previous line it names, then act only
  // on that line. Acting on every loose match deletes food the user never
  // mentioned: "remove the milk" would take "Chai / Milk Tea" with it.
  const removedTargets = new Set<string>();
  if (hasPrevious) {
    for (const n of removedNames) {
      replacedNames.add(n);
      const target = bestRemovalTarget(n, prevItems);
      if (target) {
        const key = target.food_name.trim().toLowerCase();
        replacedNames.add(key);
        removedTargets.add(key);
      }
    }
  }
  // Enforce the removal in CODE. The schema asks the model to leave a removed
  // line out of items, and a per-turn instruction is not something to trust -
  // which is why keepUncoveredPrevious and preserveManual exist at all. Matched
  // by exact name against the RESOLVED target, not by the loose phrase: the
  // correction contract has the model relist lines verbatim, so an exact match
  // is enough, and anything looser risks deleting a line nobody asked about.
  if (removedTargets.size > 0) {
    const before = extItems.length;
    extItems = extItems.filter((it) => !removedTargets.has(it.name.trim().toLowerCase()));
    if (extItems.length !== before) {
      deps.log?.(`[parse_meal] dropped ${before - extItems.length} item(s) the model removed then relisted`);
    }
  }
  const mealFromText: MealType | null =
    ext.meal_type_from_text === "breakfast" || ext.meal_type_from_text === "lunch" ||
    ext.meal_type_from_text === "dinner" || ext.meal_type_from_text === "snack"
      ? ext.meal_type_from_text
      : null;
  steps.push({
    iter: 0,
    tool: "extract_meal",
    input: { item_count: extItems.length, declined: ext.declined === true },
  });

  // The user accepted the offer to go and check. This is the one path that
  // spends web-search time on purpose: they have told us the fast answer was
  // wrong, so the slow one is worth it.
  if (hasPrevious && ext.requests_research === true) {
    const researched = await researchPrevious(deps, prevItems, accumulate, () => anthropicCalls++)
      .catch(() => null);
    steps.push({ iter: 1, tool: "research_previous", input: { found: researched ? researched.items.length : 0 } });
    if (researched?.conflict) {
      // The web found something materially different, most likely another
      // variant. Offer it rather than apply it: a wrong silent swap is worse
      // than the number they already had.
      const items = flagPrepMismatch(checkAtwater(researched.items));
      T.decide_ms = 0;
      steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: true } });
      return {
        parsed: null,
        declined: { message: researched.conflict },
        proposal: { items, note: "Use the label I found" },
        usage,
        tool_calls: [...toolCalls, "research_previous"],
        steps,
        iterations: anthropicCalls,
      };
    }
    if (researched) {
      const items = flagPrepMismatch(checkAtwater(researched.items));
      T.decide_ms = 0;
      steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: true } });
      return {
        parsed: {
          meal_type: mealFromText ?? input.mealHint ?? mealForHour(input.localHour),
          items,
          drona_line: researched.note,
          corrects_previous: true,
        },
        declined: null,
        usage,
        tool_calls: [...toolCalls, "research_previous"],
        steps,
        iterations: anthropicCalls,
      };
    }
    // Nothing trustworthy online: say so plainly instead of inventing a number.
    T.decide_ms = 0;
    steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: true } });
    return {
      parsed: null,
      declined: {
        message: "I could not find a label I trust for that one. Tap the line and set the numbers yourself, and I will use them.",
      },
      usage,
      tool_calls: [...toolCalls, "research_previous"],
      steps,
      iterations: anthropicCalls,
    };
  }

  // A question about the meal on screen is answered with its real provenance,
  // never brushed off as chatter. The client keeps the card and shows this as
  // a notice, so challenging a number costs the user nothing.
  // I6b: a challenge that also states the fix must APPLY the fix. "that seems
  // high, make it 100g" is both a question and an instruction, and answering the
  // question while discarding the instruction leaves the user's correction on
  // the floor - they have to say it twice. A pure question carries no items and
  // no correction flag, so those two conditions separate the cases cleanly.
  const challengeCarriesFix = correctsPrevious || extItems.length > 0 || removedNames.length > 0;
  if (hasPrevious && ext.asks_about_previous === true && !challengeCarriesFix) {
    const answer = await answerAboutPrevious(deps, prevItems, deps.webSearchEnabled).catch(() => "");
    if (answer) {
      steps.push({ iter: 1, tool: "answer_about_previous", input: { items: prevItems.length } });
      T.decide_ms = 0;
      steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: false } });
      return {
        parsed: null,
        declined: { message: answer },
        usage,
        tool_calls: [...toolCalls, "answer_about_previous"],
        steps,
        iterations: anthropicCalls,
      };
    }
  }

  // I6a edge case: the user removed the ONLY line. extract correctly returns no
  // items, and the generic empty check below would call that non-food and tell
  // them to say what they ate - next to the line they just deleted, because a
  // decline keeps the card. Removing the last line by TEXT should behave like
  // removing it with the X button, which already clears the card.
  if (hasPrevious && extItems.length === 0 && removedNames.length > 0) {
    const what = removedNames.length === 1 ? removedNames[0] : "those";
    return declineResult(`Removed ${what}. Nothing left on this one.`, true);
  }

  if (ext.declined === true || extItems.length === 0) {
    const msg = typeof ext.decline_message === "string" && ext.decline_message.trim()
      ? scrubDashes(ext.decline_message).slice(0, 200)
      : "That did not look like food to me. Tell me what you ate and I will log it.";
    return declineResult(msg);
  }

  T.extract_ms = tExtract0 ? Date.now() - tExtract0 : 0;

  // Correction fast path: a pure serving/quantity change on already-identified
  // foods needs no search and no decide call — just that food's servings and
  // per-100 macros. ~2s instead of ~6s. Falls through on anything ambiguous.
  if (correctsPrevious) {
    const tFast0 = Date.now();
    const correctedRaw = await tryFastCorrection(deps, extItems, prevItems).catch(() => null);
    const corrected = correctedRaw ? keepUncoveredPrevious(correctedRaw, prevItems, replacedNames) : null;
    T.fast_correction_ms = Date.now() - tFast0;
    if (corrected) {
      T.fast_correction = 1;
      steps.push({ iter: 1, tool: "fast_correction", input: { items: corrected.length } });
      const items = flagPrepMismatch(checkAtwater(corrected));
      T.decide_ms = 0;
      steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: false } });
      return {
        parsed: {
          meal_type: mealFromText ?? input.mealHint ?? mealForHour(input.localHour),
          items,
          drona_line: "Updated. Numbers adjusted.",
          corrects_previous: true,
        },
        declined: null,
        usage,
        tool_calls: [...toolCalls, "fast_correction"],
        steps,
        iterations: anthropicCalls,
      };
    }
    T.fast_correction = 0;
  }

  // Context (recents/targets/totals) was fired concurrently with the extract
  // call in index.ts; only the decide stage needs it. Awaiting here means those
  // DB queries overlapped extraction instead of blocking before the parse.
  if (input.contextPromise) {
    const tCtx0 = Date.now();
    try {
      const ctx = await input.contextPromise;
      input.recentFoods = ctx.recentFoods;
      input.todayTotals = ctx.todayTotals;
      input.targets = ctx.targets;
    } catch { /* non-fatal: decide runs with empty context */ }
    T.context_wait_ms = Date.now() - tCtx0;
  }

  // ── Stage 2: resolve, all items in parallel ───────────────────────────────
  // I1: on a correction, resolve only what actually CHANGED. An untouched line
  // re-resolved is an untouched line at risk: search and rerank are not
  // deterministic, so "make the roti 3" could quietly repoint the dal. The
  // previous version is restored verbatim by keepUncoveredPrevious below.
  let toResolve = extItems;
  if (correctsPrevious && prevItems.length > 0) {
    const passthrough = new Map<number, PreviousItem>();
    extItems.forEach((it, i) => {
      const same = unchangedInCorrection(it, prevItems);
      if (same) passthrough.set(i, same);
    });
    // If EVERYTHING looks unchanged we have almost certainly misread the turn,
    // so resolve normally rather than hand back an identical meal.
    if (passthrough.size > 0 && passthrough.size < extItems.length) {
      // A passed-through line must not also be marked replaced, or the restore
      // guard reads it as deliberately dropped and the line disappears.
      for (const p of passthrough.values()) replacedNames.delete(p.food_name.toLowerCase());
      toResolve = extItems.filter((_, i) => !passthrough.has(i));
      steps.push({
        iter: 1,
        tool: "correction_scope",
        input: { changed: toResolve.length, untouched: passthrough.size },
      });
    }
  }
  const tResolve0 = Date.now();
  // Only foods with a repeat count are staples; the recency fallback list has
  // no `times` and must not be treated as habit.
  const stapleNames = new Set(
    (input.recentFoods ?? [])
      .filter((r) => (r.times ?? 0) >= 2)
      .map((r) => r.food_name.trim().toLowerCase()),
  );
  // FAST MODE: paint the rows BEFORE the resolve, not after it.
  //
  // The names and the model's own per-100 numbers both came back on the extract
  // call, so this is the moment they are known. Emitting after the resolve (as
  // this used to) left only the accept gate to overlap: measured on device,
  // rows landed at 7371ms of a 7628ms parse, so the user waited the full time
  // and then saw everything at once. The resolve is the slow part - catalog,
  // OFF, FatSecret, and OFF's 503 retries - and it is exactly what the
  // shimmering number is meant to cover.
  if (fastMode) {
    deps.onProgress?.({
      kind: "items",
      items: toResolve.map((r) => {
        // est is per 100g; the row shows the whole line.
        const line = r.est ? r.est.total_g / 100 : 0;
        return {
          name: r.brand ? `${r.brand} ${r.name}` : r.name,
          quantity: r.quantity,
          unit: r.unit,
          est_kcal: r.est ? round1(r.est.kcal * line) : null,
          est_protein_g: r.est ? round1(r.est.protein_g * line) : null,
          est_carb_g: r.est ? round1(r.est.carb_g * line) : null,
          est_fat_g: r.est ? round1(r.est.fat_g * line) : null,
        };
      }),
    });
  }

  // Experiment knob: estimate-only fast mode. No candidates means the accept
  // gate has nothing to accept, so every line falls through to the model's own
  // estimate - which is the point: it isolates what the catalog step costs.
  const skipResolve = fastMode && input.noCatalog === true;
  const resolved: ResolvedItem[] = skipResolve
    ? toResolve.map((item) => ({ ...item, candidates: [] }))
    : await Promise.all(
      toResolve.map((item) => resolveOneItem(deps, item, steps, toolCalls, stapleNames, fastMode)),
    );
  T.resolve_ms = Date.now() - tResolve0;
  if (skipResolve) T.no_catalog = 1;
  const tDecide0 = Date.now();

  // ── Stage 3: decide ───────────────────────────────────────────────────────
  // One forced log_meal call. NO web lookup here any more: web search is a
  // USER-INITIATED lookup only (the challenge path), never an automatic one
  // for items this phase left weak. Phase 1 stays fast and always returns a
  // usable meal immediately; the web only ever improves it afterwards.
  //
  // P3: when every item reranked strongly and its quantity converts without
  // judgment, the code fill IS the answer and this whole call is skipped.
  const candidatePer100 = per100ForItems(resolved);

  // ── FAST MODE: no decide call, ever ───────────────────────────────────────
  // The pick decide makes in Smart is made here by the accept gate, which
  // DEFAULTS TO NO: a row that does not cover the user's words falls through to
  // the estimate the naming call already produced. Near-but-uncertain beats
  // precise-about-the-wrong-food, and the estimate is free at this point - it
  // rode in on the extract call.
  if (fastMode) {
    // The rows were already painted above, before the resolve. One `items`
    // event per parse: a second one here would renumber rows the card has
    // already keyed and animated.
    const guards = { variantClash, unhonouredGrade, implausiblePer100 };
    const fastItems: ParsedItem[] = resolved.map((r) => {
      // What the user actually named: prep + BRAND + name.
      //
      // The brand was missing, and its absence inverted the gate. Extract
      // reports brand "Amul" and name "cheese slice" separately, so `said` was
      // just "cheese slice" - the word "amul" was never required of a
      // candidate, and worse, firstAcceptable then counted it AGAINST the right
      // row. Measured on device: "Amul Cheese Slice A" carries two words the
      // user "did not say" (amul, a) while "Cheese, provolone, sliced" carries
      // one (provolone), so provolone won 2 of 5 runs. A row was beating the
      // correct one precisely by NOT being the brand that was asked for.
      //
      // With the brand in `said`, coverage now REJECTS provolone outright
      // (nothing in it covers "amul") rather than merely ranking it lower.
      //
      // Both joins guard against doubling, as the prep one already did: extract
      // often bakes the qualifier into the name too ("boiled egg" + prep
      // "boiled", "Oreo biscuits" + brand "Oreo"), and the trace showed the gate
      // judging "boiled boiled egg", which skews coverage and the guards.
      const withPrefix = (prefix: string | null | undefined, base: string) =>
        prefix && !base.toLowerCase().includes(prefix.toLowerCase())
          ? `${prefix} ${base}`
          : base;
      // The brand is only required when it IS the product. On a commodity fixed
      // by standard (Amul vs Mother Dairy toned milk) requiring it would lock
      // the generic row out of every branded phrase.
      const brandWord = brandIsIdentity(r.brand, r.name) ? r.brand : null;
      const said = withPrefix(r.prep, withPrefix(brandWord, r.name));
      const pick = firstAcceptable(said, r.candidates, guards);
      const per1 = pick ? gramsPerUnit(r.unit, pick.cand) : null;
      // Per-item verdict in the trace. Fast has no decide output to read, so
      // without this a wrong line is undiagnosable after the fact.
      steps.push({
        iter: 2,
        tool: "fast_fill",
        input: { item: said, unit: r.unit, candidates: r.candidates.length },
        result: {
          picked: pick ? pick.cand.name : null,
          unit_resolved: !!per1,
          used: pick && per1 ? "catalog" : (r.est ? "estimate" : "fallback"),
        },
      });
      if (pick && per1) {
        const qty = r.quantity > 0 ? r.quantity : 1;
        const grams = round1(per1.grams * qty);
        const f = grams / 100;
        return {
          food_id: pick.cand.food_id,
          // The user's phrase, not the row's name: verifyItems runs the
          // name/row agreement on it, then displays the row's real name.
          food_name: said,
          quantity: qty,
          serving_label: per1.label,
          grams,
          kcal: round1(pick.cand.kcal * f),
          protein_g: round1(pick.cand.protein_g * f),
          carb_g: round1(pick.cand.carb_g * f),
          fat_g: round1(pick.cand.fat_g * f),
          fiber_g: pick.cand.fiber_g === null ? null : round1(pick.cand.fiber_g * f),
          source: pick.cand.source,
          assumption: null,
          confidence: "high" as const,
        };
      }
      // An ACCEPTED row whose unit would not resolve (tbsp on a row with no
      // spoon anchor, katori on a USDA row) used to discard the row entirely
      // and fall to a pure estimate. Half of that estimate is unnecessary: the
      // row's per-100 is measured, only the PORTION is a guess. So use the
      // row's density with the model's gram estimate - roasted edamame gets
      // its real 38 g protein per 100 instead of the model's 11.
      if (pick && !per1 && r.est && r.est.total_g > 0) {
        const grams = round1(Math.min(r.est.total_g, 5000));
        const f = grams / 100;
        return {
          food_id: pick.cand.food_id,
          food_name: said,
          quantity: r.quantity > 0 ? r.quantity : 1,
          serving_label: r.unit,
          grams,
          kcal: round1(pick.cand.kcal * f),
          protein_g: round1(pick.cand.protein_g * f),
          carb_g: round1(pick.cand.carb_g * f),
          fat_g: round1(pick.cand.fat_g * f),
          fiber_g: pick.cand.fiber_g === null ? null : round1(pick.cand.fiber_g * f),
          source: pick.cand.source,
          assumption: `Took that as about ${Math.round(grams)} g`,
          confidence: "medium" as const,
        };
      }
      if (r.est) {
        // The model's own numbers, sanity-checked before anyone sees them.
        // Atwater first: when stated kcal and macros disagree by more than 30%
        // (the shipped checkAtwater tolerance) the macros win - three
        // constrained numbers against one free one, and the probe caught the
        // model conflating a total with per-100 exactly once already.
        const { protein_g, carb_g, fat_g, total_g } = r.est;
        const atwater = 4 * protein_g + 4 * carb_g + 9 * fat_g;
        const kcal = (atwater > 0 && Math.abs(r.est.kcal - atwater) > 0.3 * Math.max(r.est.kcal, atwater))
          ? atwater
          : r.est.kcal;
        const bad = implausiblePer100({ kcal, protein_g, carb_g, fat_g });
        if (!bad) {
          const f = total_g / 100;
          return {
            food_id: null,
            // Brand included: an estimate has no row name to display, so this
            // IS the display, and "multigrain bar" for a Yogabar loses the
            // product identity the user typed.
            food_name: r.brand ? `${r.brand} ${r.name}` : r.name,
            quantity: r.quantity > 0 ? r.quantity : 1,
            serving_label: r.unit,
            grams: round1(total_g),
            kcal: round1(kcal * f),
            protein_g: round1(protein_g * f),
            carb_g: round1(carb_g * f),
            fat_g: round1(fat_g * f),
            fiber_g: null,
            source: "estimate" as const,
            assumption: pick
              ? "Close matches did not quite fit, so these are estimated"
              : "No close match in the catalog, so these are estimated",
            confidence: "medium" as const,
          };
        }
        deps.log?.(`[parse_meal] fast estimate failed physics for "${r.name}": ${bad}`);
      }
      // No acceptable row AND no usable estimate: the existing best-effort
      // fallback, visibly low-confidence rather than silently dropped.
      return fallbackFromResolved(r, candidatePer100);
    });

    // verifyItems re-reads the chosen food rows, so it is a DB round trip that
    // was sitting outside every timer: extract_ms + resolve_ms never added up
    // to latency_ms and the gap was being blamed on plumbing.
    const tVerify0 = Date.now();
    const verified = await verifyItems(deps, fastItems, candidatePer100);
    T.verify_ms = Date.now() - tVerify0;

    const tPost0 = Date.now();
    const items = stripEphemeralIds(flagPrepMismatch(
      checkAtwater(reconcileQuantity(verified, servingsForItems(resolved))),
      prepForItems(resolved),
    ));
    T.post_ms = Date.now() - tPost0;
    T.decide_ms = 0;
    steps.push({ iter: 9, tool: "__timing", input: { ...T, fast: true } });
    const fastMeal = mealFromText ?? input.mealHint ?? mealForHour(input.localHour);
    const fastLine = templateDronaLine(items);
    deps.onProgress?.({ kind: "fill", items, meal_type: fastMeal, drona_line: fastLine });
    return {
      parsed: {
        meal_type: fastMeal,
        items,
        drona_line: fastLine,
        corrects_previous: false,
      },
      declined: null,
      usage,
      tool_calls: toolCalls,
      steps,
      iterations: anthropicCalls,
    };
  }

  const skipMode = deps.skipDecideMode ?? "off";
  const codeFill = (skipMode !== "off" && !correctsPrevious)
    ? codeFillItems(resolved, candidatePer100)
    : null;
  if (codeFill) {
    steps.push({
      iter: 2,
      tool: "code_fill",
      input: { mode: skipMode },
      result: codeFill.blockedBy
        ? { filled: false, blocked_by: codeFill.blockedBy }
        : { filled: true, items: codeFill.items.map((it) => `${it.food_name} ${it.grams}g`) },
    });
  }
  if (skipMode === "on" && codeFill && !codeFill.blockedBy) {
    T.decide_ms = 0;
    // clampVolumetricGrams included so this path runs the SAME guardrail chain
    // as the decide path. codeFillItems derives grams from real serving anchors
    // rather than free-form model output, so it should rarely bite - but "should
    // rarely" is not a reason for two paths to have different defences.
    const filled = stripEphemeralIds(flagPrepMismatch(
      checkAtwater(reconcileQuantity(
        await verifyItems(deps, clampVolumetricGrams(codeFill.items), candidatePer100),
        servingsForItems(resolved),
      )),
      prepForItems(resolved),
    ));
    steps.push({ iter: 9, tool: "__timing", input: { ...T, skipped_decide: true } });
    return {
      parsed: {
        meal_type: mealFromText ?? input.mealHint ?? mealForHour(input.localHour),
        items: filled,
        drona_line: templateDronaLine(filled),
        corrects_previous: false,
      },
      declined: null,
      usage,
      tool_calls: toolCalls,
      steps,
      iterations: anthropicCalls,
    };
  }
  const decideSystem = buildDecideSystemPrompt(input);
  const decidePayload = {
    user_text: input.text.trim().slice(0, 500),
    meal_type_from_text: mealFromText,
    items: resolved.map((r) => ({
      name: r.name,
      ...(r.brand ? { brand: r.brand } : {}),
      quantity: r.quantity,
      unit: r.unit,
      ...(r.prep ? { prep: r.prep } : {}),
      // I11: computed in CODE, not left for the model to notice. When the user
      // named a grade and not one candidate stocks it, say so plainly here so
      // decide estimates instead of dressing a generic row as a match.
      ...((() => {
        const g = gradeNotStocked(r.name, r.candidates);
        return g ? { grade_not_stocked: g } : {};
      })()),
      // Top 4 candidates: the ranked search already puts the right row first;
      // extra candidates only inflate decide-call input tokens (latency).
      candidates: r.candidates.slice(0, 4).map(candidatePayload),
    })),
  };

  const result = await callAnthropicOnce(deps, {
    model: deps.model,
    max_tokens: deps.maxTokens,
    system: cacheableSystem(decideSystem),
    tools: withToolCache([LOG_MEAL_TOOL]),
    tool_choice: { type: "tool", name: PARSE_TERMINAL_TOOL },
    messages: [{ role: "user", content: JSON.stringify(decidePayload) }],
  });
  if (!result.ok) {
    throw new Error(`anthropic_${result.status}: ${result.body.slice(0, 300)}`);
  }
  anthropicCalls++;
  accumulate(result.data);

  const blocks: Array<Record<string, any>> = result.data.content ?? [];
  const terminal = blocks.find((b) => b.type === "tool_use" && b.name === PARSE_TERMINAL_TOOL);
  if (!terminal) {
    // Forced tool_choice makes this near-impossible; fail soft as a decline.
    return declineResult(
      "I could not pull any food out of that. Give me the foods and amounts and I will log them.",
    );
  }

  toolCalls.push(PARSE_TERMINAL_TOOL);
  const raw = (terminal.input ?? {}) as Record<string, unknown>;
  steps.push({
    iter: 2,
    tool: PARSE_TERMINAL_TOOL,
    input: { item_count: Array.isArray(raw.items) ? raw.items.length : 0 },
  });

  // Fix a slipped food_id BEFORE the macro recompute, so the numbers are
  // computed from the row the user actually meant.
  const picked = retargetMismatchedIds(
    clampVolumetricGrams(sanitizeItems(raw.items)),
    resolved,
    deps.log,
  );
  let items = await verifyItems(deps, picked, candidatePer100);
  if (correctsPrevious) {
    // Enforce the correction contract on every line the user did not re-target:
    // still present (1), and if it was hand-edited, its provenance and numbers
    // survive (2, 3).
    items = keepUncoveredPrevious(items, prevItems, replacedNames);
    items = preserveManual(items, prevItems, replacedNames);
  } else {
    // A fresh parse: every food the user named must reach the log, even if
    // decide forgot to emit one.
    items = reconcileExtracted(items, resolved, candidatePer100);
  }

  items = flagPrepMismatch(
    checkAtwater(reconcileQuantity(items, servingsForItems(resolved))),
    prepForItems(resolved),
  );

  // Shadow mode: decide already produced the real answer above. Compare what
  // the code fill WOULD have shipped, so the decision to skip decide is made on
  // measured agreement over real traffic rather than on how sure the gate feels.
  if (skipMode === "shadow" && codeFill && !codeFill.blockedBy) {
    // Compare LIKE WITH LIKE. `items` has already been through verifyItems,
    // reconcileQuantity, checkAtwater and flagPrepMismatch; comparing raw
    // codeFillItems output against that measured the guardrails as if they were
    // a disagreement, skewing the very number that gates flipping this on.
    // Costs one extra verifyItems pass while shadow is enabled, which is the
    // price of a metric worth trusting - and it means the guards themselves
    // (including the variant checks) are exercised on this path before we rely
    // on them.
    const codeItems = stripEphemeralIds(flagPrepMismatch(
      checkAtwater(reconcileQuantity(
        await verifyItems(deps, codeFill.items, candidatePer100),
        servingsForItems(resolved),
      )),
      prepForItems(resolved),
    ));
    const sameShape = codeItems.length === items.length;
    // STRICT: identical row and amount.
    const sameRow = sameShape && codeItems.every((cf, i) =>
      cf.food_id === items[i].food_id &&
      Math.abs(cf.grams - items[i].grams) <= Math.max(1, items[i].grams * 0.05)
    );
    // WHAT THE USER SEES: two different rows for the same food ("Whey Protein"
    // vs "100% Whey Protein") are not a defect if the numbers land in the same
    // place. Strict row equality would veto the skip over distinctions nobody
    // can perceive, so the decision to flip this on is judged on the macros.
    const sum = (xs: ParsedItem[], k: "kcal" | "protein_g") =>
      xs.reduce((a, it) => a + (it[k] || 0), 0);
    const near = (a: number, b: number, floor: number) =>
      Math.abs(a - b) <= Math.max(floor, Math.max(a, b) * 0.1);
    const sameMacros = sameShape &&
      near(sum(codeItems, "kcal"), sum(items, "kcal"), 20) &&
      near(sum(codeItems, "protein_g"), sum(items, "protein_g"), 3);
    steps.push({
      iter: 8,
      tool: "code_fill_shadow",
      input: { same_row: sameRow, same_macros: sameMacros },
      result: sameRow ? { agree: true } : {
        code: codeItems.map((it) => `${it.food_name} ${it.grams}g ${Math.round(it.kcal)}kcal`),
        decide: items.map((it) => `${it.food_name} ${it.grams}g ${Math.round(it.kcal)}kcal`),
        same_macros: sameMacros,
      },
    });
  }
  // See stripEphemeralIds: every path that returns items to the client must
  // strip them, not just this one.
  items = stripEphemeralIds(items);
  if (items.length === 0) {
    return declineResult(
      "I could not pull any food out of that. Give me the foods and amounts and I will log them.",
    );
  }
  const mealType: MealType =
    raw.meal_type === "breakfast" || raw.meal_type === "lunch" ||
    raw.meal_type === "dinner" || raw.meal_type === "snack"
      ? raw.meal_type
      : (mealFromText ?? input.mealHint ?? mealForHour(input.localHour));
  // Grounded against the FINAL items (stripEphemeralIds ran above), so a
  // sentence quoting a macro the model invented cannot survive next to the
  // numbers that contradict it.
  const dronaLine = typeof raw.drona_line === "string" && raw.drona_line.trim()
    ? groundDronaLine(
      scrubDashes(raw.drona_line).slice(0, 200),
      items,
      input.todayTotals,
      input.targets,
    )
    : "Logged. Keep the protein coming.";
  T.decide_ms = Date.now() - tDecide0;

  steps.push({ iter: 9, tool: "__timing", input: { ...T } });
  return {
    parsed: { meal_type: mealType, items, drona_line: dronaLine, corrects_previous: correctsPrevious },
    declined: null,
    usage,
    tool_calls: toolCalls,
    steps,
    iterations: anthropicCalls,
  };
}


