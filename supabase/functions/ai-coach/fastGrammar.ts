/**
 * Lane A of Fast mode: name the items with CODE, so the LLM never runs.
 *
 * Extract costs ~1.2s, which is most of the budget for a sub-second first row.
 * Plenty of real logs do not need it: "2 eggs and a banana" is two amounts and
 * two nouns. This parses those and returns null for everything else, which
 * falls through to Lane B exactly as before.
 *
 * CONSERVATIVE BY DESIGN, because the two failure directions are not equal.
 * Refusing a line the grammar could have handled costs ~1.2s. Mis-parsing one
 * costs a WRONG FOOD LOGGED with no model anywhere in the path to catch it, on
 * the mode whose whole promise is that it is trustworthy enough to be fast. So
 * anything unfamiliar - a correction, a question, a trailing clause, a word the
 * grammar cannot account for - returns null rather than a guess.
 *
 * ALL OR NOTHING per message: if any part fails, the whole message goes to
 * Lane B. A half-parsed meal would need the model anyway, and mixing a
 * code-named item with a model-named one makes the result impossible to reason
 * about.
 */

export interface GrammarItem {
  name: string;
  quantity: number;
  unit: string;
  prep: string | null;
}

/** Mass and volume units: the quantity IS the amount. */
const MASS_UNITS: Record<string, string> = {
  g: "g", gm: "g", gms: "g", gram: "g", grams: "g",
  ml: "ml", mls: "ml", l: "l", litre: "l", liter: "l", kg: "kg",
};

/** Household containers and pieces: the quantity counts servings. */
const COUNT_UNITS = new Set([
  "cup", "cups", "katori", "katoris", "bowl", "bowls", "glass", "glasses",
  "plate", "plates", "scoop", "scoops", "slice", "slices", "piece", "pieces",
  "pc", "pcs", "spoon", "spoons",
  // NOTE: "egg" and "roti" are deliberately NOT here. They read like counting
  // units ("2 roti") but they are the FOOD, and listing them made the
  // name-contains-a-unit guard reject "2 eggs" outright. They parse as a
  // counted noun instead, which is what they are.
  "tbsp", "tsp", "tablespoon", "teaspoon", "serving", "servings", "packet", "packets",
]);

/** Prep words that name a different food, so they must survive into the query. */
const PREP_WORDS = new Set([
  "boiled", "raw", "fried", "roasted", "grilled", "poached", "scrambled",
  "steamed", "baked", "dried",
]);

/**
 * Words that mean this turn is NOT a first-shot log. Lane A never handles
 * corrections, removals, questions or answers - those need the model to read
 * intent, and getting them wrong is destructive rather than merely slow.
 */
const DISQUALIFYING = [
  "make it", "make the", "actually", "instead", "no wait", "sorry",
  "remove", "delete", "drop the", "scratch", "cancel",
  "is that", "are you", "seems", "why", "how many", "how much", "correct",
  "yes", "no thanks", "please look", "check again", "search",
  "i also had", "i had", "i ate", "was", "is from", "from country",
];

const ARTICLES = new Set(["a", "an", "one"]);
const NOISE = new Set(["of", "the"]);
/** Left over when a message is split on "and" / "," / "+": ", and x" leaves
 *  "and x". Stripped, never allowed to become part of a food name. */
const LEADING_CONNECTIVES = new Set(["and", "plus", "also", "with", "then"]);

/** Every unit token the grammar knows. A name containing one of these means the
 *  amount was written somewhere the grammar did not look, so it must refuse. */
const ALL_UNIT_WORDS = new Set([
  ...Object.keys(MASS_UNITS),
  ...COUNT_UNITS,
  "half", "quarter", "pkt", "pkts", "min", "mins", "hour", "hours",
  // Misspellings seen in real logs. They are units the grammar does NOT parse,
  // so their presence in a name proves an amount was missed.
  "tblspn", "tblsp", "tbsp", "tspn", "spoon", "spoons", "cals", "cal", "calories", "kcal",
]);

/** Words that start a clause the grammar does not model - a meal hint, a brand
 *  tail, a time. Their presence means the message says more than a food name,
 *  so Lane A refuses it rather than folding the clause into the name
 *  ("8gm peanuts for snacks" became a food called "peanuts for snacks"). */
const CLAUSE_STARTERS = new Set([
  "for", "from", "after", "before", "in", "at", "during",
  // "1 tsp ghee ON MY roti" is two foods, and without this the grammar read it
  // as one food called "ghee on my roti" and silently lost the roti.
  "on", "my", "over", "inside",
]);

/** Words that describe PROVENANCE, not the product. The I11b taxonomy calls
 *  these droppable: they do not change what the food is. Extract removes them;
 *  Lane A must too, or "100g fresh homemade curd" searches for that whole
 *  phrase, misses the plain Curd row, and falls back to an estimate. */
const PROVENANCE_WORDS = new Set([
  "fresh", "homemade", "home", "made", "pure", "natural", "organic", "farm",
  "packet", "packaged", "tetra", "pack", "plain", "regular", "normal",
]);

/**
 * A name is only a name if it is plain words. Anything else means the grammar
 * misread the shape, and the SAFE response to misreading is to hand the message
 * to Lane B, not to log a guess.
 */
function cleanName(words: string[]): string | null {
  let kept = [...words];
  while (kept.length > 0 && LEADING_CONNECTIVES.has(kept[0])) kept = kept.slice(1);
  kept = kept.filter((w) => !NOISE.has(w));
  // Drop provenance words, but never ALL the words: "homemade" alone is not a
  // food, and refusing is better than searching for nothing.
  const withoutProvenance = kept.filter((w) => !PROVENANCE_WORDS.has(w));
  if (withoutProvenance.length > 0) kept = withoutProvenance;
  if (kept.length === 0 || kept.length > 4) return null;
  // A digit inside the name means an amount the grammar failed to consume:
  // "paneer 100g", "rasmalai 2pc", "good day biscuits 2".
  if (kept.some((w) => /\d/.test(w))) return null;
  // A unit word inside the name means the same: "tea half cup".
  if (kept.some((w) => ALL_UNIT_WORDS.has(w))) return null;
  // A connective surviving anywhere means the split missed a boundary.
  if (kept.some((w) => LEADING_CONNECTIVES.has(w))) return null;
  // Spelled-out numbers are not handled; refuse rather than read "two rotis"
  // as a food called "two rotis".
  if (kept.some((w) => WORD_NUMBERS.has(w))) return null;
  if (kept.every((w) => PREP_WORDS.has(w))) return null;
  if (kept.some((w) => CLAUSE_STARTERS.has(w))) return null;
  return kept.join(" ");
}

const WORD_NUMBERS = new Set([
  "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "half",
]);

function parsePart(raw: string): GrammarItem | null {
  const part = raw.trim().toLowerCase().replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!part) return null;

  let prep: string | null = null;
  const takePrep = (arr: string[]): string[] => {
    const i = arr.findIndex((x) => PREP_WORDS.has(x));
    if (i === -1) return arr;
    prep = arr[i];
    return [...arr.slice(0, i), ...arr.slice(i + 1)];
  };

  // Strip connectives left behind by the split before matching any shape.
  let w = part.split(" ");
  while (w.length > 0 && LEADING_CONNECTIVES.has(w[0])) w = w.slice(1);
  if (w.length === 0) return null;
  const body = w.join(" ");

  // SHAPE 1  "100g paneer" / "250 ml milk"
  const m1 = body.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)\s+(.+)$/);
  if (m1 && MASS_UNITS[m1[2]]) {
    const name = cleanName(takePrep(m1[3].split(" ")));
    return name ? { name, quantity: Number(m1[1]), unit: MASS_UNITS[m1[2]], prep } : null;
  }
  // SHAPE 2  "1 katori dal" / "2 scoops whey"
  if (m1 && COUNT_UNITS.has(m1[2])) {
    const name = cleanName(takePrep(m1[3].split(" ")));
    return name ? { name, quantity: Number(m1[1]), unit: m1[2].replace(/s$/, ""), prep } : null;
  }
  // SHAPE 3  "paneer 100g" - name BEFORE the amount, common in real logs.
  const m3 = body.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/);
  if (m3 && MASS_UNITS[m3[3]]) {
    const name = cleanName(takePrep(m3[1].split(" ")));
    return name ? { name, quantity: Number(m3[2]), unit: MASS_UNITS[m3[3]], prep } : null;
  }
  // SHAPE 4  "curd 1 katori"
  if (m3 && COUNT_UNITS.has(m3[3])) {
    const name = cleanName(takePrep(m3[1].split(" ")));
    return name ? { name, quantity: Number(m3[2]), unit: m3[3].replace(/s$/, ""), prep } : null;
  }
  // SHAPE 5  "2 eggs" / "2 boiled eggs" - the noun carries the count.
  const m5 = body.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (m5) {
    const name = cleanName(takePrep(m5[2].split(" ")));
    return name ? { name, quantity: Number(m5[1]), unit: "serving", prep } : null;
  }
  // SHAPE 6  "a bowl of dal" / "a glass of milk"
  const m6 = body.match(/^(?:a|an|one)\s+([a-z]+)\s+of\s+(.+)$/);
  if (m6 && COUNT_UNITS.has(m6[1])) {
    const name = cleanName(takePrep(m6[2].split(" ")));
    return name ? { name, quantity: 1, unit: m6[1].replace(/s$/, ""), prep } : null;
  }
  // SHAPE 7  "a banana" - an ARTICLE is the amount signal.
  if (ARTICLES.has(w[0])) {
    const name = cleanName(takePrep(w.slice(1)));
    return name ? { name, quantity: 1, unit: "serving", prep } : null;
  }
  // NO BARE-PHRASE SHAPE, deliberately, and this is the hardest limit here.
  // A grammar cannot tell a food from a sentence. Accepting any 1-4 words as a
  // name logged "feeling tired today man" as Man Fuel High Protein Health Shake
  // and "craving pizza right now" as 700 kcal of pizza - both caught by the
  // eval's decline cases, both of which Lane B declines correctly.
  // Telling those apart needs the CATALOG, not more word rules: the real test
  // is whether a candidate covers the words the user said. Until Lane A runs
  // that acceptance gate itself, a phrase with no amount signal goes to Lane B,
  // which has a model that can decline.
  return null;
}

export function parseFastGrammar(text: string): GrammarItem[] | null {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 120) return null;
  if (DISQUALIFYING.some((d) => t.includes(d))) return null;
  // "Water: 2500 ml, Sleep: 600 min, Weight: 70.45 kg" is a metrics log, not a
  // meal, and the grammar happily read all three as foods. A colon means the
  // message has structure this parser does not model.
  if (t.includes(":")) return null;
  // Multi-line means a whole-day dump; Lane B owns those.
  if (t.includes("\n")) return null;
  // A digit-free, unit-free single word is fine ("curd"), but a message with no
  // letters at all is not food.
  if (!/[a-z]/.test(t)) return null;

  // NOT "with": it joins a dish to its parts ("protein shake with 500ml milk
  // and 1 scoop whey" is ONE shake, not three items) rather than separating
  // two foods.
  const parts = t.split(/\s+and\s+|\s*,\s*|\s*\+\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 6) return null;

  const out: GrammarItem[] = [];
  for (const p of parts) {
    const item = parsePart(p);
    if (!item) return null;
    out.push(item);
  }
  return out;
}
