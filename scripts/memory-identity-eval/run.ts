// Real-Jev test set for the user's food memory (owner decision 2026-10-11):
// Jev judges identity only - is this remembered food what the user means? -
// and code chooses between several that are.
//
//   deno run -A scripts/memory-identity-eval/run.ts            # new question
//   OLD=1 deno run -A scripts/memory-identity-eval/run.ts      # + the old one, for comparison
//   ONLY=too-yum,kesar-pista REPEAT=5 deno run -A ...          # some cases, several times
//   FLOOR=0.75 deno run -A ...                                 # serve at another floor
//   RESPELL=0 deno run -A ...                                  # ask Jev with the words as typed
//   DROP_RULE=protein deno run -A ...                          # ask without one sentence of the rule
//   RULE_ADD=shorthand deno run -A ...                         # ask with one more sentence
//   ASK=choice deno run -A ...                                 # one choice question, not a score per food
//   MAYBE_FLOOR=0.3 deno run -A ...                            # send more saved foods to decide
//   ASK=pipeline PIPE_FLOOR=0.3 deno run -A ...                # score to serve, then a choice to decide
//   CAND_BRAND=field|brackets deno run -A ...                  # saved foods shown with their brand
//   ASK=prod CAND_BRAND=brackets deno run -A ...               # the app's matchMemory end to end
//
// Needs JEV_API_KEY (env or .env.local). One Jev call per case; no Anthropic
// calls. Cases marked "real" are one user's live rows from 2026-10-06..08, and
// the branded oats cases from 2026-09-30..10-28 (parse_traces).
//
// A row can answer "same" and still not be served: serving needs MEMORY_FLOOR.
// So a branded case that should be served carries `serves`, and REPEAT shows
// how often it clears the floor, since one call can land either side of it.

import { asChoice, askJev, type JevQuestion } from "../../supabase/functions/ai-coach/jev.ts";
import {
  decideMemory,
  matchMemory,
  type MemoryFood,
  MEMORY_MAYBE_FLOOR,
  MEMORY_RULE,
  brandApart,
  memoryInputName,
  memoryQuestions,
  respellForJev,
} from "../../supabase/functions/ai-coach/userFoodMemory.ts";

type Level = "different" | "unclear" | "same";
interface Case {
  id: string;
  real?: boolean;
  typed: string;
  /** The brand extract split out of `typed`, as production passes it. */
  brand?: string;
  /** Remembered row -> the answers that count as right. */
  rows: Record<string, Level[]>;
  /** The food decideMemory should serve (any one of a list, null allowed), or null for none. Optional. */
  serves?: string | Array<string | null> | null;
  /** How often the user logged each row (decideMemory ranks by it). */
  times?: Record<string, number>;
}

const S: Level[] = ["same"], D: Level[] = ["different"], U: Level[] = ["unclear"];
const SU: Level[] = ["same", "unclear"], UD: Level[] = ["unclear", "different"];

/** Her two saved Too Yumm rows: the label she pasted, and her hand fix of a guess. */
const TOO_YUM = ["Too Yumm! High Protein Super Oats - Masala", "Too Yumm High Protein Super Oats Masala (estimate)"];
/** Her real 10-28 shortlist for "too yum protein oats", minus the rows that were never close. */
const TOO_YUM_ROWS: Record<string, Level[]> = {
  [TOO_YUM[0]]: S, [TOO_YUM[1]]: S,
  "Pintola protein oats": D, "Pintola chocolate protein oats": D,
  "Muscleblaze Apple Cinnamon Protein Oats": D, "MuscleBlaze Banana Strawberry Protein Oats": D,
  "Doctor’s Choice Banana Caramel Protein Oats": D, "casein": D,
};
/** The same shortlist seen from another brand's line: both Too Yumm rows conflict. */
const TOO_YUM_ROWS_AS_OTHER: Record<string, Level[]> = Object.fromEntries(
  Object.keys(TOO_YUM_ROWS).map((n) => [n, D]),
);

const CASES: Case[] = [
  {
    id: "cucumber", real: true, typed: "cucumber",
    rows: { "cucumber": S, "cucumbers": S, "Cucumber, raw": S, "carrot": D, "cashew": D, "casein": D },
    times: { "cucumber": 7, "cucumbers": 1, "Cucumber, raw": 1 }, serves: "cucumber",
  },
  {
    id: "whole-egg", real: true, typed: "whole egg",
    rows: { "whole egg": S, "whole eggs": S, "Egg, whole, raw": SU, "egg white": D, "boiled egg white": D, "boiled eggs": SU },
    times: { "whole egg": 3, "whole eggs": 2 }, serves: "whole egg",
  },
  {
    id: "casein", real: true, typed: "casein",
    rows: {
      "casein": S, "Myprotein unflavoured casein": S, "MyProtein MyProtein Impact Casein Protein, Unflavoured": S,
      "Amul Protein Lassi - Rose Flavour": D, "Superyou protein puff": D,
    },
    times: { "Myprotein unflavoured casein": 4, "casein": 2 }, serves: "Myprotein unflavoured casein",
  },
  {
    id: "royal-gala", real: true, typed: "royal gala apple",
    rows: { "apple": SU, "Apple, raw": SU, "Muscleblaze Apple Cinnamon Protein Oats": D },
  },
  {
    id: "cocoa", real: true, typed: "cocoa powder",
    rows: { "Cocoa, dry powder, unsweetened": S, "Farmley date powder": D, "Chia seeds": D },
    serves: "Cocoa, dry powder, unsweetened",
  },
  {
    id: "walnut", real: true, typed: "walnut",
    rows: { "walnuts": S, "walnut": S, "Almond butter": D },
  },
  {
    id: "veggies", real: true, typed: "veggies",
    rows: { "Veggies": S, "vegetables": S, "Mixed vegetables": SU, "vegetables and seasoning": SU },
  },
  {
    id: "whey-variants", typed: "whey",
    rows: { "chocolate whey": S, "vanilla whey": S, "casein": D },
    times: { "chocolate whey": 3, "vanilla whey": 1 }, serves: "chocolate whey",
  },
  {
    id: "flavour-conflict", typed: "chocolate whey",
    rows: { "vanilla whey": D, "chocolate whey": S, "chocolate milk": D },
    serves: "chocolate whey",
  },
  {
    // Fat-level variants of what the user typed, and a different food that only
    // shares the word. Not the prompt's own word-order example.
    id: "milk-variants", typed: "milk",
    rows: { "toned milk": SU, "skimmed milk": SU, "milk cake": D },
  },
  {
    id: "word-order", typed: "butter chicken",
    rows: { "chicken butter masala": SU, "chicken with butter": SU, "peanut butter": D },
  },
  {
    // Fried changes the food enough that "different" is the safe answer too.
    id: "preparation", typed: "chicken breast",
    rows: { "fried chicken breast": ["same", "unclear", "different"], "raw chicken breast": SU, "chicken curry": D },
  },
  {
    id: "raw-vs-cooked", typed: "raw chicken breast",
    rows: { "cooked chicken breast": D, "grilled chicken breast": D, "raw chicken breast": S },
    serves: "raw chicken breast",
  },
  {
    id: "vague", typed: "shake",
    rows: { "protein shake": UD.concat("same"), "banana shake": UD.concat("same") },
  },
  {
    id: "dish-vs-ingredient", typed: "paneer",
    rows: { "Milky Mist high protein low fat paneer": S, "paneer tikka": D },
  },
  {
    id: "oats", typed: "oats",
    rows: { "rolled oats": S, "Doctor's Choice banana caramel protein oats": SU, "oat milk": D },
  },
  // ── Branded protein oats (one user, 2026-09-30..10-28) ────────────────────
  // She saved the Too Yumm label on 10-11 and typed it three more times; every
  // time the label scored under MEMORY_FLOOR and the line was a guess or, once,
  // another company's masala oats. The rows are her real shortlist.
  {
    // 10-28 Precise: extract split the brand out. Live: same 0.56 / 0.51.
    id: "too-yum", real: true, typed: "too yum protein oats", brand: "Too Yum",
    rows: TOO_YUM_ROWS,
    serves: TOO_YUM,
  },
  {
    // 10-18 Precise: the same words, brand not split out. Live: same 0.72.
    id: "too-yum-nobrand", real: true, typed: "too yum protein oats",
    rows: TOO_YUM_ROWS,
    serves: TOO_YUM,
  },
  {
    // 10-28 Quick: she added the flavour. Live: same 0.72.
    id: "too-yum-masala", real: true, typed: "Too Yum protein oats masala",
    rows: TOO_YUM_ROWS,
    serves: TOO_YUM,
  },
  {
    // 10-18 second try: brand split out of "Too Yum protein masala oats". Live: same 0.68.
    id: "too-yum-split", real: true, typed: "protein masala oats", brand: "Too Yum",
    rows: TOO_YUM_ROWS,
    serves: TOO_YUM,
  },
  {
    // 09-30 Precise logged plain rolled oats. Live (older question): same 0.07.
    id: "doctors-banana-caramel", real: true, typed: "doctors banana caramel oats",
    rows: {
      "Doctor's Choice banana caramel protein oats": S, "Muscleblaze Apple Cinnamon Protein Oats": D,
      "Banana": D, "rolled oats": D,
    },
    serves: "Doctor's Choice banana caramel protein oats",
  },
  {
    // 10-30: worked live, kept so a fix cannot break it.
    id: "mb-banana-strawberry", real: true, typed: "mb banana strawberry oats",
    rows: {
      "MuscleBlaze Banana Strawberry Protein Oats": S, "Muscleblaze Apple Cinnamon Protein Oats": D,
      "Pintola chocolate protein oats": D,
    },
    serves: "MuscleBlaze Banana Strawberry Protein Oats",
  },
  {
    // 10-09..15: no brand written, and her only kesar pista oats is this one,
    // saved with the brand LAST. Live it scored 0.5-0.56 and missed three times
    // (Quaker cherry pistachio, a 408 kcal "oats" row, a guess). Owner decision
    // 2026-10-31: serve her most apt food and let the kept line teach the alias.
    id: "kesar-pista", real: true, typed: "Kesar pista oats",
    rows: {
      "Kesar pista oats yogabar": S, "Doctor’s Choice Banana Caramel Protein Oats": D,
      "Pintola chocolate protein oats": D,
    },
    serves: "Kesar pista oats yogabar",
  },
  // ── A brand written last is still the brand (2026-10-31) ─────────────────
  // Saved names copy whatever wording a log or the cache used, so the brand is
  // often last. Not a different food: "Kesar pista oats yogabar" scored 0.11
  // for "kesar pista oats", "Yogabar Kesar pista oats" 0.96.
  {
    id: "brand-last-milk", typed: "toned milk",
    rows: { "Toned milk amul": S, "Milk cake": D, "Skimmed milk amul": D },
    serves: "Toned milk amul",
  },
  {
    id: "brand-last-paneer", typed: "low fat paneer",
    rows: { "Low fat paneer milky mist": S, "Paneer tikka": D, "Full fat paneer amul": D },
    serves: "Low fat paneer milky mist",
  },
  {
    id: "brand-last-whey", typed: "chocolate whey",
    rows: { "Chocolate whey optimum nutrition": S, "Vanilla whey optimum nutrition": D, "Chocolate milk": D },
    serves: "Chocolate whey optimum nutrition",
  },
  // ── Word order that DOES make another food: guards for dropping the rule ─
  {
    id: "order-choc-milk", typed: "chocolate milk",
    rows: { "Milk chocolate": D, "Dairy Milk chocolate bar": D, "Amul chocolate milk": S },
    serves: "Amul chocolate milk",
  },
  {
    id: "order-masala-tea", typed: "masala tea",
    rows: { "Tea masala powder": D, "Masala chai": S },
    serves: "Masala chai",
  },
  {
    id: "order-peanut-butter", typed: "peanut butter",
    rows: { "Butter peanuts": D, "Pintola peanut butter": S },
    serves: "Pintola peanut butter",
  },
  {
    id: "order-coconut-milk", typed: "coconut milk",
    rows: { "Milk with coconut sugar": D, "Coconut milk": S },
    serves: "Coconut milk",
  },
  {
    // Nothing right saved: a reversed name must not be served at all.
    id: "order-only-wrong", typed: "chocolate milk",
    rows: { "Milk chocolate": D },
    serves: null,
  },
  // ── A new food: nothing she saved is it (2026-10-31) ─────────────────────
  // Most lines she logs are not in her memory at all. Any bar low enough to
  // always take the top saved food would log one of these instead.
  {
    id: "new-chicken-curry", typed: "chicken curry",
    rows: { "raw chicken breast": D, "grilled chicken breast": D, "chicken ham": D, "whole egg": D },
    serves: null,
  },
  {
    id: "new-masala-oats", typed: "masala oats",
    rows: {
      "Too Yumm! High Protein Super Oats - Masala": SU, "Pintola protein oats": D, "rolled oats": D,
      "Kesar pista oats yogabar": D,
    },
    serves: [null, "Too Yumm! High Protein Super Oats - Masala"],
  },
  {
    id: "new-apple-pie", typed: "apple pie",
    rows: { "apple": D, "Apple, raw": D, "Muscleblaze Apple Cinnamon Protein Oats": D },
    serves: null,
  },
  {
    id: "new-peanut-chikki", typed: "peanut chikki",
    rows: { "peanuts": D, "Pintola peanut butter": D, "roasted chana": D },
    serves: null,
  },
  {
    id: "new-coconut-water", typed: "coconut water",
    rows: { "Coconut milk": D, "Amul skimmed milk": D, "water chestnut": D },
    serves: null,
  },
  {
    id: "new-paneer-tikka", typed: "paneer tikka",
    rows: { "Milky Mist high protein low fat paneer": D, "Low fat paneer milky mist": D, "chicken tikka": D },
    serves: null,
  },
  {
    // The guard any fix must keep: same flavour, ANOTHER brand is never served.
    id: "other-brand-masala", typed: "saffola masala oats", brand: "Saffola",
    rows: { ...TOO_YUM_ROWS_AS_OTHER, "Saffola Masala Oats - Classic Masala": S },
    serves: "Saffola Masala Oats - Classic Masala",
  },
  {
    id: "other-brand-protein-oats", typed: "pintola protein oats", brand: "Pintola",
    rows: { ...TOO_YUM_ROWS_AS_OTHER, "Pintola protein oats": S, "Pintola chocolate protein oats": SU },
    times: { "Pintola protein oats": 3, "Pintola chocolate protein oats": 1 },
    serves: ["Pintola protein oats", "Pintola chocolate protein oats"],
  },
];

// ── The old question (main before 2026-10-11), for comparison ───────────────

const OLD_LEVELS = [
  "Different food or an explicitly conflicting brand, flavour, preparation, or variant.",
  "Unresolved: more than one remembered product fits the shorthand, or the identity is unclear.",
  "The same remembered product, including unique compatible shorthand or omitted descriptors. No explicit detail conflicts and no other remembered product equally fits.",
];
const OLD_RULE =
  "Resolve the user's shorthand against ONLY this user's remembered foods in remembered_foods. " +
  "The candidate is a food this user previously accepted. Judge intended identity, not exact wording. " +
  "Missing words such as protein, product-line words, or full brand spelling are unspecified, not contradictory. " +
  "Punctuation, possessives, abbreviation and obvious spelling errors may be shorthand. " +
  "A partial brand may identify its unique compatible remembered brand. " +
  "The core food or ingredient must be the same. Different ingredients or plant species are different foods even when both are seeds, nuts, grains or milk. " +
  "Every explicitly named flavour, brand, preparation, fat level, and other variant must agree. " +
  "An explicit different flavour/brand or raw versus cooked is a conflict. " +
  "If multiple remembered products fit the stated details, choose unresolved for each, unless this user has a confirmed alias that uniquely identifies one. " +
  "Do not invent aliases and do not prefer protein products merely because the user logged them. " +
  "Other brands/flavours in the list do not create ambiguity when they conflict with explicit input details. " +
  "Quantities do not affect food identity. Score the specified candidate using the ordered criteria.";

// ── Running ─────────────────────────────────────────────────────────────────

/** The Jev key: JEV_API_KEY from the environment, else from .env.local. */
function key(): string {
  const fromEnv = Deno.env.get("JEV_API_KEY");
  if (fromEnv) return fromEnv;
  for (const path of [".env.local", "../../.env.local"]) {
    try {
      const line = Deno.readTextFileSync(path).split("\n").find((l) => l.startsWith("JEV_API_KEY="));
      if (line) return line.slice("JEV_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
    } catch { /* try the next */ }
  }
  throw new Error("JEV_API_KEY not found");
}

/** A remembered food with neutral numbers; only its name, habit and trust matter here. */
const food = (name: string, times = 1): MemoryFood => ({
  key: name.toLowerCase(), name, food_id: null,
  per100: { kcal: 100, protein_g: 10, carb_g: 10, fat_g: 2, fiber_g: null },
  serving: null, source: "catalog", level: "precise", trust: 3, times,
  last_logged_at: "2026-10-01T00:00:00Z",
});

/** DROP_RULE=<name> asks without one sentence of the rule, to measure it
 *  before it is removed. The sentence must still be in the rule. The
 *  word-order sentence went this way on 2026-10-31. */
const DROP: Record<string, string> = { "protein": "Do not prefer protein products merely because the user logged them. " };
const dropped = Deno.env.get("DROP_RULE") ? DROP[Deno.env.get("DROP_RULE")!] : undefined;
if (Deno.env.get("DROP_RULE") && !dropped) throw new Error(`unknown DROP_RULE; known: ${Object.keys(DROP).join(", ")}`);
function addTo(q: Record<string, JevQuestion>): Record<string, JevQuestion> {
  if (!added) return q;
  return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { ...v, instructions: withAdded(String(v.instructions ?? "")) }]));
}
function withoutRule(q: Record<string, JevQuestion>): Record<string, JevQuestion> {
  if (!dropped) return q;
  return Object.fromEntries(Object.entries(q).map(([k, v]) => {
    const text = String(v.instructions ?? "");
    if (!text.includes(dropped)) throw new Error("DROP_RULE sentence is not in the rule any more");
    return [k, { ...v, instructions: text.replace(dropped, "") }];
  }));
}

/** CAND_BRAND=field|brackets: what Jev would see if each saved food carried
 *  its brand in a field of its own. "field": "<name> (brand: <brand>)".
 *  "brackets": the brand's words moved out of the name, "<rest> (<brand>)".
 *  The brands are this eval's own list (a saved food has no brand field yet). */
const CAND_BRAND = Deno.env.get("CAND_BRAND") as "field" | "brackets" | undefined;
if (CAND_BRAND && !["field", "brackets"].includes(CAND_BRAND)) throw new Error("CAND_BRAND is field or brackets");
const EVAL_BRANDS = [
  "Too Yumm", "Pintola", "MuscleBlaze", "Doctor's Choice", "Doctor’s Choice", "Yogabar", "Saffola", "Amul",
  "Milky Mist", "Optimum Nutrition", "Myprotein", "Mother Dairy", "Quaker", "Siggi's", "Epigamia", "Farmley",
];
const brandOf = (name: string) =>
  EVAL_BRANDS.find((b) => new RegExp(`(^|[^\\p{L}])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}])`, "iu").test(name)) ?? null;
function shownName(name: string): string {
  const b = CAND_BRAND ? brandOf(name) : null;
  if (!b) return name;
  if (CAND_BRAND === "field") return `${name} (brand: ${b})`;
  const rest = name.replace(new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"), " ")
    .replace(/^[\s!,:-]+|[\s,:-]+$/g, "").replace(/\s{2,}/g, " ");
  return `${rest} (${b})`;
}
/** brackets: the saved food carries its brand, and the app's own brandApart
 *  shows it. field: the name is rewritten here (not what the app ships). */
const branded = (f: MemoryFood): MemoryFood => (CAND_BRAND === "brackets" ? { ...f, brand: brandOf(f.name) } : f);
function withBrands(q: Record<string, JevQuestion>): Record<string, JevQuestion> {
  if (CAND_BRAND !== "field") return q;
  return Object.fromEntries(Object.entries(q).map(([k, v]) => {
    const text = String(v.instructions ?? "");
    const m = /Candidate previously logged by this user: (.+)\.$/.exec(text);
    if (!m) return [k, v];
    return [k, { ...v, instructions: text.slice(0, m.index) + `Candidate previously logged by this user: ${shownName(m[1])}.` }];
  }));
}

/** RULE_ADD=shorthand adds a sentence to the rule, to measure it before it ships. */
const ADD: Record<string, string> = {
  shorthand: "The user types quick shorthand, and saved names are often clumsy too: a brand may sit at the start, " +
    "middle or end, run together with other words or be misspelled, and words may come in another order. " +
    "Judge whether the candidate is a probable reading of the same product, not whether the words line up. ",
};
const added = Deno.env.get("RULE_ADD") ? ADD[Deno.env.get("RULE_ADD")!] : undefined;
if (Deno.env.get("RULE_ADD") && !added) throw new Error(`unknown RULE_ADD; known: ${Object.keys(ADD).join(", ")}`);
const ANCHOR = "Judge intended identity, not exact wording. ";
function withAdded(text: string): string {
  if (!added) return text;
  if (!text.includes(ANCHOR)) throw new Error("RULE_ADD anchor is not in the rule any more");
  return text.replace(ANCHOR, ANCHOR + added);
}

/** ASK=choice asks ONE choice question per line: which saved food (or none)
 *  is it? Instead of a score per saved food. Served when the top pick's
 *  chance reaches a floor; the summary reports several floors. */
const CHOICE = Deno.env.get("ASK") === "choice";
/** ASK=pipeline: the score per food first (served at the floor); when nothing
 *  is served, one choice question, and its top pick at PIPE_FLOOR or more goes
 *  to decide. Decide is a model, so the summary counts what reaches it. */
const PIPELINE = Deno.env.get("ASK") === "pipeline";
/** ASK=prod: the app's own matchMemory (score, maybe band, choice), with saved
 *  brands when CAND_BRAND=brackets. What ships, end to end. */
const PROD = Deno.env.get("ASK") === "prod";
const PIPE_FLOOR = Number(Deno.env.get("PIPE_FLOOR") ?? "0.3");
/** PIPE_STEP2=score replays the build: step 2 is the score's own maybe pick.
 *  PIPE_STEP2=both: the score's maybe pick first, else the choice question. */
const STEP2 = (["score", "both"].includes(Deno.env.get("PIPE_STEP2") ?? "") ? Deno.env.get("PIPE_STEP2") : "choice") as
  "score" | "both" | "choice";
const CHOICE_FLOORS = [0, 0.2, 0.3, 0.4, 0.5, 0.7];
function choiceQuestion(typed: string, names: string[]): JevQuestion {
  const body = MEMORY_RULE
    .replace("Judge one thing: is the candidate, a food this user logged before, a food the user's words describe? ", "")
    .replace(" Score the candidate using the ordered criteria.", "");
  const criteria: Record<string, string> = {};
  names.forEach((n, i) => { criteria[`m${i + 1}`] = CAND_BRAND === "brackets" ? brandApart(n, brandOf(n)) : shownName(n); });
  criteria.none = "None of these saved foods is the food the user means.";
  return {
    type: "choice",
    instructions: withAdded(
      "Which of these foods, each one this user logged before, is the food the user's words describe? " + body +
        ` Answer none when no candidate is that food. Input food: ${typed}.`,
    ),
    criteria,
  };
}

/** FLOOR=0.75 replays the old serving floor against today's answers; unset = MEMORY_FLOOR. */
const FLOOR = Deno.env.get("FLOOR") ? Number(Deno.env.get("FLOOR")) : undefined;

/** MAYBE_FLOOR=0.3 sends more to decide; unset = MEMORY_MAYBE_FLOOR. */
const MAYBE_FLOOR = Deno.env.get("MAYBE_FLOOR") ? Number(Deno.env.get("MAYBE_FLOOR")) : MEMORY_MAYBE_FLOOR;

const LEVELS: Level[] = ["different", "unclear", "same"];
const pct = (n: number) => `${Math.round(n * 100)}`.padStart(3);

/** One case against the real Jev (new question, or the old one when `old`), plus what decideMemory serves. */
async function run(c: Case, apiKey: string, old: boolean, choice = CHOICE) {
  const names = Object.keys(c.rows);
  const line = { name: c.typed, brand: c.brand ?? null };
  // As production asks: the brand spelled as her saved foods spell it
  // (respellForJev). RESPELL=0 asks with the words as typed.
  const asked = (Deno.env.get("RESPELL") !== "0" && respellForJev(line, names.map((n) => food(n)))) || line;
  const questions: Record<string, JevQuestion> = old
    ? Object.fromEntries(names.map((n, i) => [`m${i + 1}`, {
      type: "score", criteria: OLD_LEVELS,
      instructions: OLD_RULE + ` Input food: ${c.typed}. Candidate previously logged by this user: ${n}.`,
    }]))
    : choice
    ? { pick: choiceQuestion(memoryInputName(asked), names) }
    : withBrands(addTo(withoutRule(memoryQuestions(asked, names.map((n) => branded(food(n)))))));
  const state = old
    ? { foods: [{ id: "f1", name: c.typed, brand: null }], remembered_foods: names.map((n, i) => ({ id: `m${i + 1}`, name: n, confirmed_aliases: [] })) }
    : { foods: [{ id: "f1", name: asked.name, brand: asked.brand }] };
  const res = await askJev(state, questions, { apiKey, timeoutMs: 15000 });
  if (!res.ok) return { c, error: `${res.failure} ${res.detail}` };
  if (choice && !old) {
    const a = asChoice(res.response.answers.pick);
    if (!a) return { c, error: "no choice answer" };
    const probs = a.probabilities ?? {};
    const ranked = Object.entries(probs).sort((x, y) => y[1] - x[1]);
    const top = ranked.find(([k]) => k !== "none");
    return {
      c, rows: [], served: null, also: [], maybe: null, respelled: asked === line ? null : asked,
      choice: {
        none: probs.none ?? 0,
        top: top ? { name: names[Number(top[0].slice(1)) - 1], p: top[1] } : null,
        ranked: ranked.slice(0, 4).map(([k, p]) => `${k === "none" ? "none" : names[Number(k.slice(1)) - 1]} ${Math.round(p * 100)}`),
      },
    };
  }
  const rows = names.map((n, i) => {
    const p = (res.response.answers[`m${i + 1}`] as { probabilities?: Record<string, number> })?.probabilities ?? {};
    const ch = { different: p["0"] ?? 0, unclear: p["1"] ?? 0, same: p["2"] ?? 0 };
    const top = LEVELS.reduce((a, b) => (ch[b] > ch[a] ? b : a));
    return { name: n, ch, top, ok: c.rows[n].includes(top) };
  });
  const foods = names.map((n) => food(n, c.times?.[n] ?? 1));
  const d = decideMemory(foods, rows.map((r) => r.ch.same), FLOOR, memoryInputName(line));
  // Not served: would it go to decide to judge (MEMORY_MAYBE_FLOOR)?
  const m = d.food ? null : decideMemory(foods, rows.map((r) => r.ch.same), MAYBE_FLOOR, memoryInputName(line));
  return {
    c, rows, served: d.food?.name ?? null, also: d.food?.also ?? [], maybe: m?.food?.name ?? null,
    respelled: asked === line ? null : asked,
  };
}

const apiKey = key();
const withOld = Deno.env.get("OLD") === "1";
const only = (Deno.env.get("ONLY") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const repeat = Math.max(1, Number(Deno.env.get("REPEAT") ?? "1") || 1);
const picked = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;
if (only.length && picked.length !== only.length) {
  console.log(`unknown case id in ONLY: ${only.filter((o) => !CASES.some((c) => c.id === o)).join(", ")}`);
  Deno.exit(1);
}
let rowsOk = 0, rowsAll = 0, servesOk = 0, servesAll = 0, reachOk = 0, wrongMaybe = 0, failed = 0;
const choiceTally: Record<number, { right: number; wrong: number; miss: number }> = {};
const choiceWrong: Record<number, string[]> = {};
const pipe: Record<string, number> = {};
const pipeBad: Record<string, string[]> = {};
for (const c of picked) for (let rep = 1; rep <= repeat; rep++) {
  const r = await run(c, apiKey, false);
  if ("error" in r) { failed++; console.log(`ERROR ${c.id}: ${r.error}`); continue; }
  const brand = c.brand ? ` (brand "${c.brand}")` : "";
  if (PROD) {
    // The app's own matchMemory, end to end: score, maybe band, then the choice.
    const foods = Object.keys(c.rows).map((n) => branded(food(n, c.times?.[n] ?? 1)));
    const m = await matchMemory({ apiKey, timeoutMs: 15000 }, foods, { name: c.typed, brand: c.brand ?? null });
    const ch = m.trace.choice as { pick?: string; p?: number; none?: number } | undefined;
    console.log(`\n${c.real ? "[real] " : ""}${c.id}${repeat > 1 ? ` #${rep}` : ""}: typed "${c.typed}"${brand}`);
    console.log(m.food ? `   serves: ${m.food.name} (${Math.round(m.confidence * 100)})`
      : `   -> ${m.maybe ? `decide judges ${m.maybe.name}` : "normal lookup"}` +
        (ch ? `   [choice: ${ch.pick} ${Math.round((ch.p ?? 0) * 100)}, none ${Math.round((ch.none ?? 0) * 100)}]` : ""));
    if (c.serves !== undefined) {
      servesAll++;
      const want = (n: string | null) => Array.isArray(c.serves) ? (c.serves as Array<string | null>).includes(n) : n === c.serves;
      const toDecide = m.maybe?.name ?? null;
      const tag = m.food
        ? (want(m.food.name) ? "served_right" : "served_wrong")
        : toDecide
        ? (want(toDecide) ? "decide_right" : "decide_wrong")
        : (want(null) ? "lookup_right" : "miss");
      pipe[tag] = (pipe[tag] ?? 0) + 1;
      if (tag === "served_wrong" || tag === "decide_wrong" || tag === "miss") {
        (pipeBad[tag] ??= []).push(`${c.id}: "${c.typed}" -> ${m.food?.name ?? toDecide ?? "nothing"}`);
      }
    }
    continue;
  }
  if (PIPELINE) {
    type Ch = { none: number; top: { name: string; p: number } | null; ranked: string[] };
    let toDecide: string | null = null, pick = "";
    if (!r.served && (STEP2 === "score" || (STEP2 === "both" && r.maybe))) {
      // As built: the score's own pick at MAYBE_FLOOR, no second question.
      toDecide = r.maybe ?? null;
      pick = `score ${Math.round((r.rows!.find((x) => x.name === r.maybe)?.ch.same ?? 0) * 100)}`;
    } else if (!r.served) {
      const rc = await run(c, apiKey, false, true);
      if ("error" in rc) { failed++; console.log(`ERROR ${c.id}: ${rc.error}`); continue; }
      const ch = (rc as { choice: Ch }).choice;
      pick = ch.ranked.join(" | ");
      if (ch.top && ch.top.p >= PIPE_FLOOR) toDecide = ch.top.name;
    }
    console.log(`\n${c.real ? "[real] " : ""}${c.id}${repeat > 1 ? ` #${rep}` : ""}: typed "${c.typed}"${brand}`);
    console.log(r.served ? `   step 1 serves: ${r.served}` : `   step 1: none | step 2 choice: ${pick}\n   -> ${toDecide ? `decide judges ${toDecide}` : "normal lookup"}`);
    if (c.serves !== undefined) {
      servesAll++;
      const want = (n: string | null) => Array.isArray(c.serves) ? (c.serves as Array<string | null>).includes(n) : n === c.serves;
      const tag = r.served
        ? (want(r.served) ? "served_right" : "served_wrong")
        : toDecide
        ? (want(toDecide) ? "decide_right" : "decide_wrong")
        : (want(null) ? "lookup_right" : "miss");
      pipe[tag] = (pipe[tag] ?? 0) + 1;
      if (tag === "served_wrong" || tag === "decide_wrong" || tag === "miss") {
        (pipeBad[tag] ??= []).push(`${c.id}: "${c.typed}" -> ${r.served ?? toDecide ?? "nothing"}  [${r.served ? "score" : pick}]`);
      }
    }
    continue;
  }
  if (CHOICE) {
    const ch = (r as { choice: { none: number; top: { name: string; p: number } | null; ranked: string[] } }).choice;
    console.log(`\n${c.real ? "[real] " : ""}${c.id}${repeat > 1 ? ` #${rep}` : ""}: typed "${c.typed}"${brand}`);
    console.log(`   choice: ${ch.ranked.join(" | ")}`);
    if (c.serves !== undefined) {
      servesAll++;
      const want = (n: string | null) => Array.isArray(c.serves) ? (c.serves as Array<string | null>).includes(n) : n === c.serves;
      for (const f of CHOICE_FLOORS) {
        const served = ch.top && ch.top.p >= f ? ch.top.name : null;
        const t = (choiceTally[f] ??= { right: 0, wrong: 0, miss: 0 });
        if (want(served)) t.right++;
        else if (served) { t.wrong++; (choiceWrong[f] ??= []).push(`${c.id}: "${c.typed}" -> ${served} ${Math.round(ch.top!.p * 100)}`); }
        else t.miss++;
      }
    }
    continue;
  }
  console.log(`\n${c.real ? "[real] " : ""}${c.id}${repeat > 1 ? ` #${rep}` : ""}: typed "${c.typed}"${brand}`);
  console.log("   diff unc same  answer      expected");
  for (const row of r.rows!) {
    rowsAll++; if (row.ok) rowsOk++;
    console.log(` ${row.ok ? " " : "X"} ${pct(row.ch.different)}  ${pct(row.ch.unclear)}  ${pct(row.ch.same)}  ${row.top.padEnd(10)}  ${c.rows[row.name].join("|").padEnd(15)} ${row.name}`);
  }
  if (r.respelled) console.log(`   asked Jev as: "${r.respelled.name}"${r.respelled.brand ? ` (brand "${r.respelled.brand}")` : ""}`);
  const notServed = r.maybe ? `none; decide judges ${r.maybe}` : "none (normal lookup)";
  let servedLine = `   serves: ${r.served ?? notServed}${r.also!.length ? `  (also: ${r.also!.join(", ")})` : ""}`;
  if (c.serves !== undefined) {
    servesAll++;
    const wanted = (n: string | null) => Array.isArray(c.serves) ? (c.serves as Array<string | null>).includes(n) : n === c.serves;
    const good = wanted(r.served);
    if (good) servesOk++;
    // Sent to decide counts apart: decide may still say no. A WRONG food sent
    // there is a miss too, since decide could take it.
    if (good || wanted(r.maybe)) reachOk++;
    if (r.maybe && !wanted(r.maybe)) wrongMaybe++;
    servedLine += good ? "" : wanted(r.maybe) ? "   (to decide)" : `   X expected ${Array.isArray(c.serves) ? c.serves.join(" or ") : c.serves ?? "none"}`;
  }
  console.log(servedLine);
  if (withOld && c.real && rep === 1) {
    const o = await run(c, apiKey, true);
    if (!("error" in o)) {
      const unresolved = o.rows!.filter((x) => x.ch.unclear >= 0.75).length;
      console.log(`   OLD question: same=${o.rows!.map((x) => pct(x.ch.same).trim()).join("/")}  unresolved>=0.75 on ${unresolved} row(s)${unresolved > 1 ? " -> meal BLOCKED" : ""}`);
    }
  }
}
if (PROD) {
  console.log(`\nprod matchMemory, ${servesAll} runs:`);
  for (const k of ["served_right", "served_wrong", "decide_right", "decide_wrong", "lookup_right", "miss"]) {
    console.log(`  ${k.padEnd(13)} ${pipe[k] ?? 0}`);
    for (const b of pipeBad[k] ?? []) console.log(`      ${b}`);
  }
}
if (PIPELINE) {
  const step2 = STEP2 === "score" ? `score >= ${MAYBE_FLOOR}`
    : STEP2 === "both" ? `score >= ${MAYBE_FLOOR}, else choice >= ${PIPE_FLOOR}`
    : `choice >= ${PIPE_FLOOR}`;
  console.log(`\npipeline (serve at ${FLOOR ?? "MEMORY_FLOOR"}, then ${step2} to decide), ${servesAll} runs:`);
  for (const k of ["served_right", "served_wrong", "decide_right", "decide_wrong", "lookup_right", "miss"]) {
    console.log(`  ${k.padEnd(13)} ${pipe[k] ?? 0}`);
    for (const b of pipeBad[k] ?? []) console.log(`      ${b}`);
  }
}
if (CHOICE) {
  console.log(`\nchoice mode, ${servesAll} cases with an expected food:`);
  for (const f of CHOICE_FLOORS) {
    const t = choiceTally[f] ?? { right: 0, wrong: 0, miss: 0 };
    console.log(`  floor ${f}: right ${t.right}  WRONG ${t.wrong}  miss ${t.miss}`);
    for (const w of choiceWrong[f] ?? []) console.log(`      wrong: ${w}`);
  }
}
console.log(`\nrows answered as expected: ${rowsOk}/${rowsAll}`);
console.log(`foods served as expected:  ${servesOk}/${servesAll}`);
console.log(`served or sent to decide: ${reachOk}/${servesAll}   wrong food sent to decide: ${wrongMaybe}`);
// A Jev error skips its case, so the totals above would look complete.
if (failed > 0) {
  console.log(`INCOMPLETE: ${failed} case(s) got no Jev answer`);
  Deno.exit(1);
}
