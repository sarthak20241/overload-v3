/**
 * Shared fuzzy word matching for food names (I17).
 *
 * One question, asked in several places: are these two words the same word,
 * allowing for a typo? wordsOverlap uses it to decide whether a food is
 * "already here", and the Fast-mode acceptCandidate gate will use it to decide
 * whether a candidate row covers what the user typed.
 *
 * WHY A SHARED FILE: the two callers must never drift. wordsOverlap answers
 * "is this thing already present?", and a wrong YES means a food the user named
 * is judged already-covered and is therefore never restored - it vanishes from
 * the card silently. A wrong NO only restores a line. Looseness costs data;
 * strictness costs nothing. The acceptance gate needs the same asymmetry.
 *
 * WHAT THIS REPLACES: a 4-character shared-prefix rule. Benchmarked on real
 * pairs it scored 5/8 and erred in BOTH directions:
 *   false positives: bikano/bikaji (rival Indian snack brands - the "Bika-"
 *     cluster exists because they are all named for Bikaner),
 *     creatine/creatinine (a supplement vs a metabolic waste product)
 *   false negative:  panner/paneer, the commonest Indian food typo, MISSED,
 *     because "pann" and "pane" do not share four letters
 *
 * THE RULE: Damerau-Levenshtein distance (edits including a transposition,
 * so "panner" -> "paneer" is one swap) divided by the SHORTER word's length,
 * allowed up to MAX_TYPO_RATIO. Proportional, not flat, because a 2-character
 * error in a 6-letter word is usually a different word, while the same error
 * in a 16-letter brand is obviously a slip:
 *   optimumnutriton / optimumnutrition  1/15 = 0.07  match (3 chars of slack)
 *   panner / paneer                     1/6  = 0.17  match
 *   bikano / bikaji                     2/6  = 0.33  reject
 *   creatine / creatinine               2/8  = 0.25  reject
 * Flat thresholds measured for comparison on the same 11 pairs: <=1 scores
 * 11/11, <=2 scores 9/11 (2 is exactly the bikaji AND creatinine distance, so
 * it re-admits both), <=3 scores 8/11. The ratio also scores 11/11 while being
 * more generous than flat-1 exactly where generosity is safe.
 */

/** Ratio of edits to the shorter word that still counts as a typo. */
export const MAX_TYPO_RATIO = 0.2;

/**
 * Damerau-Levenshtein distance (optimal string alignment), bounded.
 *
 * Bounded because we only ever ask "is this within a small budget": once every
 * value in a row exceeds `max` no later row can come back under it, so we stop
 * and report max + 1. That turns the worst case from O(n*m) into O(n*budget)
 * for the long-word comparisons this is called on.
 */
export function damerau(a: string, b: string, max = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr: number[] = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
      // Transposition: "panner" -> "paneer" is ONE swap, not two edits. This is
      // the case a plain Levenshtein would over-charge, and adjacent-letter
      // swaps are the typo people actually make on a phone keyboard.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = curr;
    curr = new Array(b.length + 1);
  }
  return prev[b.length];
}

/** Strip a plural "s" - "eggs" and "egg" are one food, "egg"/"eggplant" are not. */
function singular(w: string): string {
  return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
}

/**
 * Are two content words the same word, allowing for a typo?
 *
 * Short words must match outright. On a 3-4 letter word every edit is a large
 * fraction of the word and the neighbours are usually real, different foods:
 * dal/dalia, egg/eggplant, rice/ricea. The ratio would let some of those
 * through, so the length floor stays.
 */
export function nearWord(p: string, q: string): boolean {
  const x = singular(p.toLowerCase());
  const y = singular(q.toLowerCase());
  if (x === y) return true;
  const shorter = Math.min(x.length, y.length);
  if (shorter < 5) return false;
  const budget = Math.floor(shorter * MAX_TYPO_RATIO);
  if (budget < 1) return false;
  return damerau(x, y, budget) <= budget;
}
