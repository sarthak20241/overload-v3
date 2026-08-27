/**
 * Is this catalog row actually the food the user named?
 *
 * The single most expensive class of bug in this pipeline is a row that shares
 * a word with the query and nothing else. Real examples, all shipped:
 *
 *   "paneer bhurji"  -> Bhujia            a fried snack, 609 kcal/100g
 *   "chole bhature"  -> Starbucks signature chocolat
 *   "low fat paneer" -> Milky Mist Paneer  full fat, 283 against a real 190
 *   "2 whole eggs"   -> Eggs, chicken, yolk, raw   347 against 143
 *
 * Each looked confident on the card. None carried a warning, because nothing
 * in the chain asked the only question that matters: does this row COVER what
 * the user said?
 *
 * DEFAULTS TO NO. A rejected row falls back to the model's estimate, and an
 * estimate of paneer bhurji is roughly right where Bhujia is three times wrong.
 * "Near but not certain" beats "precise about the wrong food" every time, so
 * anything this cannot positively justify is refused.
 */

import { nearWord } from "./textMatch.ts";
import type { CandidateFood } from "./parseMeal.ts";

export type RejectReason =
  | "uncovered-word"
  | "variant-clash"
  | "grade-not-honoured"
  | "implausible";

export interface AcceptResult {
  ok: boolean;
  reason?: RejectReason;
  /** The user word that went unmatched, for the chip and for traces. */
  detail?: string;
}

/** Words that carry no identity: dropping them cannot change WHICH food it is.
 *  Kept deliberately short - every word added here is a word the gate stops
 *  checking, which is how "low fat" got dropped in the first place. */
const NON_IDENTIFYING = new Set([
  "fresh", "homemade", "home", "made", "pure", "natural", "organic", "farm",
  "packet", "packaged", "tetra", "pack", "a", "an", "the", "of", "with",
  "raw", "cooked", "plain",
]);

/** Regional synonyms extract normally resolves, kept here because the gate must
 *  not punish a name that arrived un-normalised. */
const SYNONYMS: Record<string, string[]> = {
  doodh: ["milk"],
  dahi: ["curd", "yoghurt", "yogurt"],
  chawal: ["rice"],
  atta: ["flour", "wheat"],
  chai: ["tea"],
  anda: ["egg", "eggs"],
};

function contentWords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !NON_IDENTIFYING.has(w));
}

/**
 * Does every identifying word the user said appear in the row's name?
 *
 * DIRECTIONAL, and that direction is the whole point. The row is allowed to say
 * MORE than the user did ("milk" is satisfied by "Amul Taaza Toned Milk"),
 * because a person names a food loosely and the catalog names it precisely. But
 * the row may not be missing something the user DID say - that word is the
 * difference between paneer bhurji and bhujia.
 */
export function coversUserWords(said: string, rowName: string, brand?: string | null): boolean {
  const needle = contentWords(said);
  if (needle.length === 0) return false;
  const hay = contentWords(`${rowName} ${brand ?? ""}`);
  if (hay.length === 0) return false;
  return needle.every((n) => {
    if (hay.some((h) => nearWord(n, h))) return true;
    const alts = SYNONYMS[n];
    return alts ? alts.some((a) => hay.some((h) => nearWord(a, h))) : false;
  });
}

export function acceptCandidate(
  said: string,
  cand: CandidateFood,
  guards: {
    variantClash: (said: string, row: string) => { said: string; row: string } | null;
    unhonouredGrade: (said: string, row: string) => string | null;
    implausiblePer100: (p: { kcal: number; protein_g: number; carb_g: number; fat_g: number }) => string | null;
  },
): AcceptResult {
  const row = cand.name;

  // ORDER MATTERS, for the message rather than the verdict. Word coverage
  // catches almost everything the specific guards catch - "low fat paneer" vs
  // "Milky Mist Paneer" fails coverage on "low" long before anyone asks about
  // grades. But the REASON becomes the chip the user reads, and "I could not
  // find a low fat row" is worth far more to them than "a word did not match".
  // So the guards that can explain themselves go first.
  const clash = guards.variantClash(said, row);
  if (clash) return { ok: false, reason: "variant-clash", detail: clash.said };

  const grade = guards.unhonouredGrade(said, row);
  if (grade) return { ok: false, reason: "grade-not-honoured", detail: grade };

  if (!coversUserWords(said, row, cand.brand)) {
    const missing = contentWords(said).find((n) => !coversUserWords(n, row, cand.brand));
    return { ok: false, reason: "uncovered-word", detail: missing };
  }

  const bad = guards.implausiblePer100(cand);
  if (bad) return { ok: false, reason: "implausible", detail: bad };

  return { ok: true };
}

/**
 * First candidate that survives, or null. Callers treat null as "use the
 * estimate": with the model's own numbers already in hand from the naming call,
 * refusing costs nothing but a chip.
 */
export function firstAcceptable(
  said: string,
  candidates: CandidateFood[],
  guards: Parameters<typeof acceptCandidate>[2],
): { cand: CandidateFood; index: number } | null {
  for (let i = 0; i < candidates.length; i++) {
    if (acceptCandidate(said, candidates[i], guards).ok) return { cand: candidates[i], index: i };
  }
  return null;
}
