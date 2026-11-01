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
// Owner decision 2026-10-11:
//   - Jev judges identity only (is this remembered food what the user means?), never
//     whether another remembered food also fits
//   - several that fit are never a refusal: the one the user logs most, then the
//     most trusted numbers, then the newest; a different variant is named on
//     the card
//   - within one name, the most trusted numbers win, not the newest
//
// Runtime-agnostic (no Deno globals), like ourSources.ts.

import { asChoice, askJev, type JevDeps, type JevQuestion } from "./jev.ts";
import { damerau } from "./textMatch.ts";


export type ParseTierName = "fast" | "thorough" | "precise";

export const MEMORY_DAYS = 10;
/** A safety bound on the list, not a relevance cut: Jev only ever sees the
 *  MEMORY_SHORTLIST closest names. An earlier cap of 30 dropped older foods
 *  before the shortlist ran, and an active logger's Precise "raw chicken
 *  breast" from 6 days back never reached Jev (found on live data, 2026-09-27). */
export const MEMORY_MAX_FOODS = 300;
/** Rows Jev scores per line, closest names first. */
export const MEMORY_SHORTLIST = 10;
/** Jev's chance that a remembered food IS this line, needed to serve it. Below
 *  the catalog match (preciseMatch.MATCH_FLOOR, 0.75) on purpose (owner
 *  decision 2026-10-31): a food this user saved and logged herself is better
 *  evidence than a catalog row, and her branded foods sat at 0.68-0.73 when
 *  she left out a flavour (memory-identity-eval, too-yum cases). */
export const MEMORY_FLOOR = 0.7;
/** Under MEMORY_FLOOR but at least this: not served, but handed to decide (in
 *  Thorough and Precise) to judge from the user's words whether it is the same
 *  food. Quick has no decide call and ignores it. Owner decision 2026-10-31
 *  (memory-identity-eval): with saved brands shown apart, 0.7 serve + 0.6 to
 *  decide served 44 of 60 right, sent no wrong food to decide and missed 2.
 *  A bar of 0.3 here sent "peanut chikki" -> peanuts and gained nothing. When
 *  nothing reaches this floor, the choice question below may still find one. */
export const MEMORY_MAYBE_FLOOR = 0.6;
/** No saved food reached the maybe floor: one choice question asks which saved
 *  food it is, or none, and its top answer goes to decide only when it is a
 *  food with at least this chance (owner decision 2026-10-31). The score asks
 *  about each saved food alone; the choice sees them side by side, which is
 *  what caught "masala tea" -> "Masala chai" (86%). "None" must not be ahead:
 *  taking the best food regardless sent Milk chocolate for "chocolate milk"
 *  (none 67%) and peanuts for "peanut chikki" (none 49%, peanuts 47%). */
export const MEMORY_CHOICE_FLOOR = 0.3;
/** The choice is asked only when some saved food scored at least this, not on
 *  every new food (a second, serial Jev call). In the eval it helped only
 *  where a saved food had scored ("masala tea": 0.91, then blocked by the word
 *  veto); with every score under 0.15 it never found a right food, and once
 *  sent peanuts for "peanut chikki". */
export const MEMORY_CHOICE_MIN_SCORE = 0.3;
/** The choice question's "none" option. */
export const MEMORY_CHOICE_NONE = "None of these saved foods is the food the user means.";
/** A variant of a product that already cleared MEMORY_FLOOR may compete with
 *  it when Jev thinks it more likely the food than not. */
export const VARIANT_FLOOR = 0.5;

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
  /** The brand it is sold under, when known (user_food_cache.brand, from the
   *  parse that logged it). Diary lines carry none. */
  brand?: string | null;
  /** Durable, saved diary evidence loaded from this user’s private cache. */
  persistent?: boolean;
  confirmed_at?: string;
  alias_lookup?: boolean;
  confirmed_aliases?: string[];
}

/** A remembered food: the newest eligible entry for a name, as per 100 g. */
export interface MemoryFood {
  key: string;
  name: string;
  /** The brand it is sold under, when known. Shown to Jev apart from the name
   *  (brandApart), never merged into it. */
  brand?: string | null;
  food_id: string | null;
  per100: { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null };
  /** One unit of what the user logged it in ("1 piece" = 50 g), when it was
   *  not a weight. */
  serving: { label: string; grams: number } | null;
  source: string | null;
  /** The tier this food may serve down to (see level()). */
  level: ParseTierName;
  /** How much its numbers are trusted (entryTrust). Absent on hand-built
   *  foods, which then rank by their level. */
  trust?: number;
  times: number;
  last_logged_at: string;
  confirmed_aliases?: string[];
  /** Set by the decision only: other remembered foods that are also what the
   *  user's words describe but a different variant ("vanilla whey" beside
   *  "chocolate whey"), named on the card so the user can say which it was. */
  also?: string[];
  /** The remembered rows behind `also`, so the card can offer each as a
   *  one-tap swap priced from the user's own numbers (memoryAlternatives). */
  alsoFoods?: MemoryFood[];
}

const RANK: Record<ParseTierName, number> = { fast: 1, thorough: 2, precise: 3 };

/** How high a tier an entry's numbers may serve. */
export function entryLevel(e: Pick<MemoryEntry, "tier" | "source" | "logged_via">): ParseTierName {
  if (e.source === "manual" || e.logged_via === "manual") return "precise";
  if (e.tier === "precise" || e.tier === "thorough" || e.tier === "fast") return e.tier;
  return "fast";
}

/**
 * How much an entry's numbers are trusted, highest first: numbers the user
 * typed or edited herself (4), then Precise (3), Thorough (2), Quick (1).
 * Owner decision 2026-10-11: within one food this, not recency, picks the
 * numbers. Newest-wins let a Quick guess of 6.3 kcal/100 g replace the user's own
 * 12.5 for cucumber (live, 2026-10-04).
 */
export function entryTrust(e: Pick<MemoryEntry, "tier" | "source" | "logged_via">): number {
  if (e.source === "manual" || e.logged_via === "manual") return 4;
  return RANK[entryLevel(e)];
}

/** A remembered food's trust; hand-built foods without one rank by level. */
const trustOf = (f: MemoryFood) => f.trust ?? RANK[f.level];

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
 * one per name carrying the most trusted numbers (entryTrust, newest on a tie),
 * frequent foods first, then recent ones, capped. Entries without a weight
 * cannot give a per-100 and are left out.
 */
export function buildMemory(
  entries: MemoryEntry[],
  tier: ParseTierName,
  now: Date = new Date(),
  days = MEMORY_DAYS,
): MemoryFood[] {
  const since = now.getTime() - days * 86_400_000;
  const byKey = new Map<string, { newest: MemoryEntry; times: number; brand: string | null }>();
  for (const e of entries) {
    const at = Date.parse(e.logged_at);
    if (!Number.isFinite(at) || (!e.persistent && at < since)) continue;
    if (!e.food_name?.trim() || !(e.grams && e.grams > 0) || !(e.kcal >= 0)) continue;
    if (!servesTier(entryLevel(e), tier)) continue;
    const key = memoryKey(e.food_name);
    if (!key) continue;
    const brand = e.brand?.trim() || null;
    const got = byKey.get(key);
    if (!got) byKey.set(key, { newest: e, times: 1, brand });
    else {
      got.times++;
      // Any row's brand names the food: diary lines carry none, the saved row does.
      if (!got.brand) got.brand = brand;
      const [t, kept] = [entryTrust(e), entryTrust(got.newest)];
      const newer = Date.parse(e.confirmed_at ?? e.logged_at) > Date.parse(got.newest.confirmed_at ?? got.newest.logged_at);
      if (t > kept || (t === kept && newer)) got.newest = e;
    }
  }
  const foods: MemoryFood[] = [...byKey.entries()].map(([key, { newest: e, times, brand }]) => {
    const f = 100 / (e.grams as number);
    const unit = (e.serving_unit ?? "").trim();
    const perUnit = e.quantity && e.quantity > 0 ? (e.grams as number) / e.quantity : null;
    return {
      key,
      name: e.food_name.trim(),
      ...(brand ? { brand } : {}),
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
      trust: entryTrust(e),
      times,
      last_logged_at: e.logged_at,
      confirmed_aliases: e.confirmed_aliases ?? [],
    };
  });
  const newestFirst = (a: MemoryFood, b: MemoryFood) => Date.parse(b.last_logged_at) - Date.parse(a.last_logged_at);
  const frequent = foods.filter((f) => f.times >= 2).sort((a, b) => b.times - a.times || newestFirst(a, b));
  const recent = foods.filter((f) => f.times < 2).sort(newestFirst);
  const pinned = new Set(entries.filter((e) => e.alias_lookup).map((e) => memoryKey(e.food_name)));
  const ordered = [...frequent, ...recent];
  return [
    ...ordered.filter((f) => pinned.has(f.key)),
    ...ordered.filter((f) => !pinned.has(f.key)).slice(0, Math.max(0, MEMORY_MAX_FOODS - pinned.size)),
  ];
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
    .map((f) => ({ f, s: Math.max(nameSimilarity(f.name, line), ...(f.confirmed_aliases ?? []).map((a) => nameSimilarity(a, line))) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.f);
}

/**
 * Jev judges IDENTITY only (owner decision 2026-10-11): is this one remembered
 * food a food the user's words describe? Never whether another remembered food
 * also fits. That used to be part of "same" ("no other remembered product
 * equally fits"), so one food saved as "cucumber", "cucumbers" and "Cucumber,
 * raw" scored "unresolved" on all three, and the meal was refused with "more
 * than one saved match" (live, 2026-10-05..09). Choosing between several that
 * fit, and whose numbers to use, is decideMemory's job, in code.
 *
 * Keep the input and candidate names IN each question: references alone
 * confused Jev in the multi-row regression.
 *
 * No word-order sentence (owner decision 2026-10-31): Jev tells "milk
 * chocolate" from "chocolate milk" without one (memory-identity-eval, order-*
 * cases), and dropping it raised the rows that should match (84.5 to 86.3 avg)
 * with no wrong row reaching 0.6. preciseMatch.ts keeps its own: there the
 * same cut cost one right match.
 */
export const MEMORY_LEVELS = [
  "Different: the core food is another food, or a detail the user DID write (brand, flavour, preparation, fat level, variant) conflicts with the candidate.",
  "Unclear: the user's words are too vague to tell whether they mean this food.",
  "Same: a food the user's words describe. The candidate may carry details the user did not write; those are compatible. It does not matter whether other foods would also fit.",
];
export const MEMORY_RULE =
  "Judge one thing: is the candidate, a food this user logged before, a food the user's words describe? " +
  "Judge intended identity, not exact wording. " +
  "Missing words such as protein, product-line words, flavour, or full brand spelling are unspecified, not contradictory. " +
  "When the candidate names a flavour, brand, fat level or product line the user did not write, that detail is compatible: the user simply did not say it. " +
  "A dish, snack or drink made from the food is a different food, even when its name contains the food. " +
  "Punctuation, plurals, possessives, abbreviation and obvious spelling errors may be shorthand. A partial brand may name the full one. " +
  "The core food or ingredient must be the same. Different ingredients or plant species are different foods even when both are seeds, nuts, grains or milk. " +
  "Every flavour, brand, preparation, fat level and other variant the user DID write must agree. " +
  "An explicit different flavour or brand, or raw versus cooked, is a conflict. " +
  "Do not prefer protein products merely because the user logged them. " +
  "Quantities do not affect food identity. Score the candidate using the ordered criteria.";

/** The line as the user named it, brand first when extract split it out and
 *  the name does not already carry it: "Amul" + "toned milk". */
export function memoryInputName(line: { name: string; brand: string | null }): string {
  return line.brand && !memoryKey(line.name).includes(memoryKey(line.brand))
    ? `${line.brand} ${line.name}` : line.name;
}

/** One choice over the shortlist: which saved food (m1..mN, each with its brand
 *  apart) the user's words describe, or none. The same rule as the score, said
 *  for a choice. */
export function memoryChoiceQuestion(line: { name: string; brand: string | null }, foods: MemoryFood[]): JevQuestion {
  const body = MEMORY_RULE
    .replace("Judge one thing: is the candidate, a food this user logged before, a food the user's words describe? ", "")
    .replace(" Score the candidate using the ordered criteria.", "");
  const criteria: Record<string, string> = {};
  foods.forEach((f, i) => { criteria[`m${i + 1}`] = brandApart(f.name, f.brand ?? null); });
  criteria.none = MEMORY_CHOICE_NONE;
  return {
    type: "choice",
    instructions: "Which of these foods, each one this user logged before, is the food the user's words describe? " +
      body + ` Answer none when no candidate is that food. Input food: ${memoryInputName(line)}.`,
    criteria,
  };
}

/** One identity question per remembered food, keyed m1..mN in list order. */
export function memoryQuestions(line: { name: string; brand: string | null }, foods: MemoryFood[]): Record<string, JevQuestion> {
  return Object.fromEntries(foods.map((f, i) => [`m${i + 1}`, {
    type: "score",
    instructions: MEMORY_RULE + ` Input food: ${memoryInputName(line)}. Candidate previously logged by this user: ${brandApart(f.name, f.brand ?? null)}.`,
    criteria: MEMORY_LEVELS,
  }]));
}

export type MemoryDecision =
  | { food: MemoryFood; confidence: number }
  | { food: null; reason: "no_foods" | "no_answer" | "below_floor"; confidence: number };

/** A name's words, singular: "Cucumbers, raw" -> {cucumber, raw}. */
function nameWords(name: string): Set<string> {
  return new Set(nameWordList(name));
}

/** A name's words in order, plurals folded ("cucumbers" -> "cucumber"). */
function nameWordList(name: string): string[] {
  return memoryKey(name).split(" ").filter(Boolean).map((w) =>
    w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y`
      : w.length > 4 && w.endsWith("oes") ? w.slice(0, -2)
      : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1)
      : w
  );
}

/**
 * Two remembered foods that are different variants of one product rather than
 * one food under two names: they share a word and each adds one of its own
 * ("chocolate whey", "vanilla whey"). "Cucumber, raw" beside "cucumbers" is one
 * food (only one side adds a word); "Veggies" beside "vegetables" is a synonym
 * (no shared word). Used for two things: naming the other variant on the card,
 * and letting a variant just under the floor compete with its sibling
 * (decideMemory). It never decides identity: Jev's score still has to admit a
 * row first.
 */
function differentVariants(a: string, b: string): boolean {
  const x = nameWords(a), y = nameWords(b);
  const shared = [...x].some((w) => y.has(w));
  return shared && [...x].some((w) => !y.has(w)) && [...y].some((w) => !x.has(w));
}

/**
 * The user's words already pick between two variants: they contain a word
 * that tells them apart ("vanilla whey" against chocolate and vanilla whey).
 * Then habit must not choose for them.
 */
function namesVariant(typed: string, a: string, b: string): boolean {
  const t = nameWords(typed), x = nameWords(a), y = nameWords(b);
  return [...t].some((w) => x.has(w) !== y.has(w));
}

/** The user's words name a sibling variant of `a` and not `a` itself: typed
 *  "vanilla whey" rules out "chocolate whey" when vanilla whey is remembered,
 *  whatever Jev scored the chocolate row. */
function ruledOutByWords(typed: string, a: string, all: string[]): boolean {
  const t = nameWords(typed), x = nameWords(a);
  return all.some((b) => differentVariants(a, b) && [...nameWords(b)].some((w) => !x.has(w) && t.has(w)));
}

/** The remembered name is what the user typed, word for word (plurals aside). */
function sameWords(typed: string, a: string): boolean {
  // In order: "chocolate milk" is not "milk chocolate". Whether two names are
  // the same FOOD is Jev's call; this only says the words are literally the same.
  const t = nameWordList(typed), x = nameWordList(a);
  return t.length > 0 && t.length === x.length && t.every((w, i) => w === x[i]);
}

/**
 * The food to serve, from Jev's per-row chance that it IS what the user means.
 * Below the floor nothing is served, and the normal sources answer. Several
 * above it are never a refusal (owner decision 2026-10-11): the one the user logs
 * most wins, then the most trusted numbers (entryTrust), then the newest. A
 * different variant that also fits is named on the card, so the user can say which
 * it was. `typed` is what the user wrote. When it names a variant, no other
 * variant competes, whatever its score. A row whose name is exactly what the
 * user typed goes before habit: "oats" logged once beats "protein oats" logged
 * ten times, because the extra word may be a different product.
 */
export function decideMemory(
  foods: MemoryFood[],
  scores: Array<number | null>,
  floor = MEMORY_FLOOR,
  typed = "",
  /** Rule out a variant the typed words name against (ruledOutByWords). Off
   *  for a confirmed alias: the user already said which row these words mean. */
  veto = true,
): MemoryDecision {
  if (foods.length === 0) return { food: null, reason: "no_foods", confidence: 0 };
  if (scores.every((s) => s === null)) return { food: null, reason: "no_answer", confidence: 0 };
  const names = foods.map((f) => f.name);
  const scored = foods.map((f, i) => ({ f, p: scores[i] ?? 0 }))
    .filter((x) => !veto || !typed || !ruledOutByWords(typed, x.f.name, names));
  const passing = scored.filter((x) => x.p >= floor);
  if (passing.length === 0) {
    return { food: null, reason: "below_floor", confidence: Math.max(...scores.map((s) => s ?? 0)) };
  }
  // A variant whose sibling cleared the floor: the product is established, so
  // which variant is habit, not identity. Jev put "chocolate whey" at 0.73 and
  // "vanilla whey" at 0.91 for "whey" (real Jev, 2026-10-11); without this the
  // one the user rarely logs won and the other was not even named. Not when their own
  // words already chose between the two: "vanilla whey" must not become the
  // chocolate one they log more.
  const family = scored.filter((x) =>
    x.p >= floor ||
    (x.p >= VARIANT_FLOOR && passing.some((y) =>
      differentVariants(x.f.name, y.f.name) && !namesVariant(typed, x.f.name, y.f.name)
    ))
  );
  const exact = (x: { f: MemoryFood }) => (typed && sameWords(typed, x.f.name) ? 1 : 0);
  const [best, ...rest] = family.sort((a, b) =>
    exact(b) - exact(a) ||
    b.f.times - a.f.times ||
    trustOf(b.f) - trustOf(a.f) ||
    Date.parse(b.f.last_logged_at) - Date.parse(a.f.last_logged_at)
  );
  const seen = new Set<string>();
  const alsoFoods = rest.filter((x) => differentVariants(x.f.name, best.f.name))
    .filter((x) => !seen.has(x.f.name) && !!seen.add(x.f.name))
    .slice(0, 2)
    .map((x) => x.f);
  return { food: { ...best.f, also: alsoFoods.map((f) => f.name), alsoFoods }, confidence: best.p };
}

export interface MemoryMatch {
  food: MemoryFood | null;
  confidence: number;
  /** No food served, but this one scored MEMORY_MAYBE_FLOOR or more: decide
   *  is asked whether it is the same food. `confidence` is its score. */
  maybe?: MemoryFood | null;
  trace: Record<string, unknown>;
}

const squash = (s: string) => memoryKey(s).replace(/ /g, "");

/**
 * A saved food as Jev reads it: its brand out of the name and in brackets,
 * "Kesar pista oats (Yogabar)". Saved names copy whatever wording logged them,
 * and a brand left inside one can read as part of the food: "Kesar pista oats
 * yogabar" scored 0.11 for "kesar pista oats" (an oats "bar"), the bracketed
 * form 0.94-0.99 (memory-identity-eval, owner decision 2026-10-31). The brand's
 * words are found in any spacing ("yogabar" for "Yoga Bar"). A name that is only
 * the brand, or no brand, is left as it is.
 */
export function brandApart(name: string, brand: string | null): string {
  const b = brand?.trim();
  if (!b || squash(b).length < 2) return name;
  const target = squash(b);
  const words = name.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j <= Math.min(words.length, i + 4); j++) {
      if (squash(words.slice(i, j).join(" ")) !== target) continue;
      const rest = [...words.slice(0, i), ...words.slice(j)].join(" ")
        .replace(/^[\s!,:;.-]+|[\s,:;-]+$/g, "").replace(/\s{2,}/g, " ").trim();
      return rest ? `${rest} (${b})` : name;
    }
  }
  return `${name} (${b})`;
}
/** A brand group shorter than this is never respelled: one letter off a short
 *  word ("oat", "dahi") is usually another word. */
const RESPELL_MIN_CHARS = 5;

/**
 * The line as Jev should read it: a brand typed one letter off from how one of
 * the user's saved foods spells it ("too yum" for "Too Yumm!") is written the
 * saved way, in the brand field and in the name. Null when nothing changes.
 *
 * Why: Jev reads a brand the user wrote as a detail that must agree, and a
 * one-letter slip read as maybe another company. Spelled as saved, the same
 * line scored 0.77 instead of 0.51 (memory-identity-eval, 2026-10-31).
 *
 * Exactly one edit, never two: rival brands sit two letters apart (Bikano and
 * Bikaji, textMatch.ts). Only the leading words of a saved name are compared,
 * where a brand is written, and a saved food's own brand when it has one. With
 * no brand field, a single typed word is compared with saved brands only: one
 * word one letter from a saved name's first word is usually another food
 * ("mango" and "Mange tout"). Only for Jev: the alias key, the
 * shortlist and the card keep what the user typed.
 */
export function respellForJev(
  line: { name: string; brand: string | null },
  foods: MemoryFood[],
): { name: string; brand: string | null } | null {
  const typedWords = memoryKey(line.name).split(" ").filter(Boolean);
  // The words to respell: the brand field, else the name's first one to three.
  // `names`: whether a saved name's leading words may be the spelling, or only
  // a saved brand (a single unbranded word).
  const groups = line.brand?.trim()
    ? [{ typed: line.brand.trim(), names: true }]
    : [1, 2, 3].filter((k) => k <= typedWords.length).map((k) => ({ typed: typedWords.slice(0, k).join(" "), names: k >= 2 }));
  const spellings = new Map<string, { typed: string; saved: string }>();
  for (const { typed, names } of groups) {
    const t = squash(typed);
    if (t.length < RESPELL_MIN_CHARS) continue;
    for (const f of foods) {
      const savedWords = f.name.split(/\s+/).filter(Boolean);
      // The saved brand, when known, is a spelling too, wherever the name puts it.
      const spellingsOf = [
        ...(names ? [1, 2, 3].filter((j) => j <= savedWords.length).map((j) => savedWords.slice(0, j).join(" ")) : []),
        ...(f.brand?.trim() ? [f.brand.trim()] : []),
      ];
      for (const raw of spellingsOf) {
        const saved = raw.replace(/[^\p{L}\p{N}' ]+/gu, "").trim();
        const s = squash(saved);
        if (s === t) return null; // already spelled as saved
        if (s.length >= RESPELL_MIN_CHARS && damerau(s, t, 1) === 1) spellings.set(s, { typed, saved });
      }
    }
  }
  if (spellings.size !== 1) return null; // none, or saved foods disagree
  const { typed, saved } = [...spellings.values()][0];
  // Replace the typed words in the name wherever they appear, in any case.
  const words = typed.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const inName = new RegExp(`(^|[^\\p{L}\\p{N}])${words.join("[^\\p{L}\\p{N}]+")}(?=$|[^\\p{L}\\p{N}])`, "iu");
  const name = line.name.replace(inName, (_m, lead: string) => `${lead}${saved}`);
  const brand = line.brand?.trim() ? saved : line.brand;
  // The words matched only once folded (an accent, say) and the raw name
  // could not take them: nothing changed, so the trace must not say respelled.
  if (name === line.name && brand === line.brand) return null;
  return { name, brand };
}

/** Ask Jev whether one of the user's remembered foods is this line. Never
 *  throws; any failure is "no match" and the tier runs as it would have. */
export async function matchMemory(
  jev: JevDeps,
  foods: MemoryFood[],
  line: { name: string; brand: string | null },
  /** choice: false skips the choice question. Quick has no decide step to
   *  judge its answer, so there the call would be wasted. */
  opts: { choice?: boolean } = {},
): Promise<MemoryMatch> {
  const lookup = memoryInputName(line);
  const trace: Record<string, unknown> = { item: line.name, lookup_name: lookup, remembered: foods.length, policy: "identity-v2" };
  const decided = (d: MemoryDecision & { food: MemoryFood }) => ({
    match: d.food.name.slice(0, 60), kcal: d.food.per100.kcal, level: d.food.level,
    logged: d.food.last_logged_at.slice(0, 10), conf: Math.round(d.confidence * 100) / 100,
    ...(d.food.also?.length ? { also: d.food.also } : {}),
  });
  try {
    // Confirmed aliases resolve before a top-N cut and without model calls.
    // One alias on several foods is chosen like any other tie, never refused.
    const exact = foods.filter((f) => (f.confirmed_aliases ?? []).some((a) => memoryKey(a) === memoryKey(lookup)));
    if (exact.length > 0) {
      trace.path = "confirmed_alias";
      // The typed words still rank first: two rows under one alias ("cucumber"
      // and "Cucumber, raw", both confirmed as "cucumber") otherwise tie on
      // times and trust, and the newer one won by a millisecond.
      const d = decideMemory(exact, exact.map(() => 1), MEMORY_FLOOR, lookup, false);
      if (d.food) {
        trace.decision = decided(d as MemoryDecision & { food: MemoryFood });
        return { food: d.food, confidence: 1, trace };
      }
      trace.alias_unresolved = d.reason ?? "no_food";
    }
    trace.path = "jev";
    const list = shortlist(foods, lookup);
    trace.shortlist = list.length;
    if (list.length === 0) {
      trace.decision = { match: null, reason: "no_foods" };
      return { food: null, confidence: 0, trace };
    }
    // Jev reads the brand as her saved foods spell it (respellForJev).
    const respelled = respellForJev(line, list);
    const asked = respelled ?? line;
    if (respelled) trace.respelled = { name: asked.name, brand: asked.brand };
    // The other remembered foods are deliberately NOT in the state: Jev judges
    // each one alone, so a second name for the same food cannot pull an answer
    // from "same" to "unclear".
    const res = await askJev(
      { foods: [{ id: "f1", name: asked.name, brand: asked.brand }] },
      memoryQuestions(asked, list),
      jev,
    ).catch(() => null);
    const chances = list.map((_, i) => {
      if (!res?.ok) return null;
      const a = res.response.answers[`m${i + 1}`] as { type?: string; probabilities?: Record<string, number> } | undefined;
      if (a?.type !== "score") return null;
      const p = a.probabilities ?? {};
      return { different: p["0"] ?? 0, unclear: p["1"] ?? 0, same: p["2"] ?? 0 };
    });
    const scores = chances.map((c) => (c === null ? null : c.same));
    const r2 = (n: number) => Math.round(n * 100) / 100;
    // All three chances, not just "same": the answer that decides is not always
    // the one that serves.
    trace.rows = list.map((f, i) => ({
      name: f.name.slice(0, 60), kcal: f.per100.kcal, level: f.level,
      score: scores[i] === null ? null : r2(scores[i] as number),
      ...(chances[i] ? { different: r2(chances[i]!.different), unclear: r2(chances[i]!.unclear), same: r2(chances[i]!.same) } : {}),
    }));
    const d = decideMemory(list, scores, MEMORY_FLOOR, lookup);
    if (!d.food) {
      trace.decision = { match: null, reason: res && !res.ok ? `jev_${res.failure}` : d.reason, conf: r2(d.confidence) };
      // Not sure enough to serve: the same choice at the maybe floor is handed
      // to decide, which reads the user's words and says same or different.
      const m = res?.ok ? decideMemory(list, scores, MEMORY_MAYBE_FLOOR, lookup) : null;
      if (m?.food) {
        trace.maybe = { name: m.food.name.slice(0, 60), conf: r2(m.confidence) };
        return { food: null, confidence: m.confidence, maybe: m.food, trace };
      }
      // Nothing in the band: ask once which saved food it is, side by side.
      // Only after real scores: a Jev that answered nothing is not asked again.
      const best = Math.max(0, ...scores.map((x) => x ?? 0));
      if (opts.choice !== false && res?.ok && scores.some((x) => x !== null) && best < MEMORY_CHOICE_MIN_SCORE) {
        trace.choice = { skipped: "low_scores", best: r2(best) };
      } else if (opts.choice !== false && res?.ok && scores.some((x) => x !== null)) {
        const c = await askJev(
          { foods: [{ id: "f1", name: asked.name, brand: asked.brand }] },
          { pick: memoryChoiceQuestion(asked, list) },
          jev,
        ).catch(() => null);
        const a = c?.ok ? asChoice(c.response.answers.pick) : null;
        if (a) {
          const ranked = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]);
          const [topKey, topP] = ranked[0] ?? ["none", 0];
          const pick = topKey === "none" ? null : list[Number(topKey.slice(1)) - 1] ?? null;
          trace.choice = {
            pick: pick?.name.slice(0, 60) ?? "none", p: r2(topP), none: r2(a.probabilities?.none ?? 0),
          };
          if (pick && topP >= MEMORY_CHOICE_FLOOR) {
            trace.maybe = { name: pick.name.slice(0, 60), conf: r2(topP), from: "choice" };
            return { food: null, confidence: topP, maybe: pick, trace };
          }
        } else {
          trace.choice = { failed: c && !c.ok ? c.failure : "no_answer" };
        }
      }
      return { food: null, confidence: d.confidence, trace };
    }
    trace.decision = decided(d);
    return { food: d.food, confidence: d.confidence, trace };
  } catch (e) {
    trace.decision = { match: null, reason: "threw", error: String(e).slice(0, 120) };
    return { food: null, confidence: 0, trace };
  }
}

/** The card's note for a line answered from memory: "Same as you logged on
 *  Sep 26", on the user's own calendar when their zone is known. */
/** The note's sentence naming the other variants. One builder, so a build
 *  that draws the swap chip can remove exactly this (parseMeal forSwapChips). */
export function alsoSentence(names: string[]): string {
  return names.length ? ` You also log ${names.join(" and ")}; if it was that, just say so.` : "";
}

export function memoryNote(food: MemoryFood, timeZone?: string | null): string {
  // A different variant that also fits: name it, so a wrong pick costs the user one
  // sentence ("it was the vanilla") instead of a refused meal.
  const also = alsoSentence(food.also ?? []);
  const d = new Date(food.last_logged_at);
  if (!Number.isFinite(d.getTime())) return also ? `Same as you logged before.${also}` : "Same as you logged before";
  let day: string;
  try {
    day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: timeZone || "UTC" }).format(d);
  } catch {
    day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
  }
  return also ? `Same as you logged on ${day}.${also}` : `Same as you logged on ${day}`;
}
