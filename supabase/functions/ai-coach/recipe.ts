// build_recipe: a home dish built from the parts the user names
// (.planning/precise-food-logger-plan.md, step 5, sections 5 and 13).
//
//   "a sabji of 60 g low fat paneer, oil and onion"
//
// - Each part goes through the same lookup the parse uses (user memory, the
//   label cache, the catalog, the web): ONE parse per part, so a part's row is
//   never mixed up with another part's. From that row code keeps the numbers
//   per 100 g.
// - Code adds the parts up: per 100 x grams / 100, summed. The model never
//   does arithmetic and never types a number for the dish.
// - A part with no amount: oil, ghee, butter, sugar, jaggery and honey take a
//   usual amount from RECIPE_ASSUMED (1 tsp). Any other part takes the
//   parse's one usual serving. Either way the part is marked `assumed`, the
//   card says so, and the user is asked ONCE ("I assumed 1 tsp oil. Change
//   it?"). The card already carries the assumption, so ignoring the question
//   is a valid answer.
// - The card line keeps its parts (`recipe`), in the shape food memory stores
//   (step 4: user_food_cache.recipe), so "why 210?" has a real answer.
//
// Behind FOOD_BUILD_RECIPE (off by default), later-mode agent only.

import type { AnthropicTool } from "./prompt.ts";
import type { CardLine } from "./foodContext.ts";
import type { MealType, ParsedItem, ParseMealResult } from "./parseMeal.ts";
// The recipe shape is step 4's (food memory): one type for the card line,
// meal_entries.recipe and user_food_cache.recipe.
import { ORIGIN_RANK, originOf, parseRecipe, type RecipePart } from "../_shared/foodOrigin.ts";

export type FoodBuildRecipeMode = "off" | "on";

/** FOOD_BUILD_RECIPE: anything but "on" is off. */
export function parseFoodBuildRecipeMode(raw: string | undefined): FoodBuildRecipeMode {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}

/** Most parts one dish may have. Each part is one parse. */
export const RECIPE_MAX_PARTS = 8;

export const BUILD_RECIPE_TOOL: AnthropicTool = {
  name: "build_recipe",
  description:
    "Make ONE card line for a dish the user made from parts they name. Give the dish's name and each part with the " +
    "user's own amount words (\"60 g\", \"2\", \"1 tbsp\"); leave `amount` out when the user gave none. The app looks up " +
    "each part and adds the parts up, so you never do the arithmetic. With `line_id`, the dish replaces that card line " +
    "(use this to change a part of a dish already built: send all its parts again, the changed one with its new " +
    "amount). Without `line_id`, the dish is added to the card. Each part is one lookup, and a turn holds at most 8 " +
    "lookups in all (edits, additions and dish parts), so a dish of 8 parts uses a whole turn.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The dish, in the user's words, without the parts (e.g. \"tofu stir fry\")." },
      parts: {
        type: "array",
        description: "Every part the user named, one entry each.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The part, with its brand or kind when the user gave one." },
            amount: { type: "string", description: "The user's amount for this part. Omit when they gave none." },
          },
          required: ["name"],
        },
      },
      line_id: { type: "string", description: "The card line this dish replaces, e.g. L2. Omit to add the dish." },
      meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"], description: "Omit for the card's own meal." },
      summary: { type: "string", description: "One short line saying what was built. No em dashes." },
    },
    required: ["name", "parts"],
  },
};

/** Said to a later-message agent that has build_recipe. */
export const RECIPE_NOTE =
  "build_recipe makes one card line for a dish the user made from parts they name (for example a stir fry of 150 g " +
  "tofu, oil and peppers). Use it when the user names a dish's parts, so the line is that dish built from its parts. " +
  "Give each part the user's own amount words, and leave the amount out when they gave none: the app takes a usual " +
  "amount, shows it on the card, and asks the user about it once, so do not ask about that amount yourself. Never " +
  "also put the same parts on the card as lines of their own. Other food in the same message goes on the card in the " +
  "same turn with log_food or add_lines, given only that other food. A card line whose source says recipe lists its " +
  "parts: to change one part, call build_recipe on that line_id with all its parts, the changed one with its new amount.";

// ── Assumed amounts ─────────────────────────────────────────────────────────

/** A part with no amount: the usual amount for one dish, by the part's last
 *  word. Only cooking fats and sweeteners, the parts users leave out. */
export const RECIPE_ASSUMED: Record<string, { grams: number; label: string }> = {
  oil: { grams: 5, label: "1 tsp" },
  ghee: { grams: 5, label: "1 tsp" },
  butter: { grams: 5, label: "1 tsp" },
  sugar: { grams: 4, label: "1 tsp" },
  jaggery: { grams: 5, label: "1 tsp" },
  gur: { grams: 5, label: "1 tsp" },
  honey: { grams: 7, label: "1 tsp" },
};

/** Spreads and other foods whose last word is in the table but are not a
 *  cooking fat or a sweetener ("peanut butter", "cocoa butter"). */
const NOT_A_FAT = /\b(?:fish|cod|liver|krill|castor|essential|massage|hair|baby|mineral|beard)\s+oil\b|\b(?:peanut|almond|cashew|nut|cocoa|apple|seed|sunflower seed)\s+butter\b|\bsugar[- ]free\b/i;

/** Words that may come before "butter" or "sugar" and still name the cooking
 *  kind (an allow-list: anything else is some other food). */
const COOKING_KINDS: Record<string, Set<string>> = {
  butter: new Set(["salted", "unsalted", "white", "desi", "amul", "cooking", "table", "homemade", "dairy"]),
  sugar: new Set(["white", "brown", "cane", "caster", "castor", "powdered", "table", "raw", "granulated"]),
};

/** The table's amount for a part with no amount, or null. */
export function assumedAmount(partName: string): { grams: number; label: string } | null {
  const name = partName.toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/\s+/g, " ").trim();
  // "tuna in oil", "peaches in syrup": a food packed in something, not a fat.
  if (!name || NOT_A_FAT.test(name) || /\sin\s/.test(` ${name} `)) return null;
  const words = name.split(" ");
  const last = words.pop() ?? "";
  const hit = RECIPE_ASSUMED[last] ?? null;
  // Butter and sugar name many foods that are not the cooking kind (a spread,
  // a skin cream, date sugar): only the plain word, or one of these before it.
  const kinds = COOKING_KINDS[last];
  if (hit && kinds && !words.every((w) => kinds.has(w))) return null;
  return hit;
}

// ── Checking the call ───────────────────────────────────────────────────────

export interface RecipeAsk {
  name: string;
  parts: { name: string; amount: string | null }[];
}

/** The dish and its parts from the tool input, or the reason it is refused. */
export function readRecipeAsk(input: Record<string, unknown>): RecipeAsk | { error: string } {
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, 100) : "";
  if (!name) return { error: "build_recipe has no dish name." };
  const raw = Array.isArray(input.parts) ? input.parts : [];
  const parts = raw.flatMap((p) => {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const n = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim().slice(0, 100) : "";
    if (!n) return [];
    const a = typeof o.amount === "string" ? o.amount.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    return [{ name: n, amount: a || null }];
  });
  if (!parts.length) return { error: `build_recipe for ${JSON.stringify(name)} has no parts.` };
  if (parts.length > RECIPE_MAX_PARTS) {
    return { error: `build_recipe for ${JSON.stringify(name)} has ${parts.length} parts; at most ${RECIPE_MAX_PARTS}.` };
  }
  return { name, parts };
}

// ── The sum ─────────────────────────────────────────────────────────────────

/** One part after its lookup: the row's numbers per 100 g, and its weight. */
export interface PartFound {
  name: string;
  grams: number;
  per100: { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null };
  source: string;
  /** The amount was not the user's: "1 tsp" from the table, or "40 g". */
  assumed: string | null;
  /** FOOD_WARM_MEMORY: the amount came from the user's last log of this dish
   *  (food memory's recipe), not from the table. Never also `assumed`. */
  remembered?: boolean;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** A part's own numbers at its weight. */
export function partTotals(p: PartFound): { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null } {
  const f = p.grams / 100;
  return {
    kcal: p.per100.kcal * f,
    protein_g: p.per100.protein_g * f,
    carb_g: p.per100.carb_g * f,
    fat_g: p.per100.fat_g * f,
    fiber_g: p.per100.fiber_g === null ? null : p.per100.fiber_g * f,
  };
}

/** The note on a recipe line: its parts, in a few words. It rides in the
 *  line's `assumption`, which the app already sends back (160 characters), so
 *  the agent sees the parts even from an app that drops `recipe`. */
export function recipeNote(parts: PartFound[], missing: string[] = []): string {
  // The assumed amounts go first: the note is cut at 160 characters, and the
  // ask-once check reads them (recipeQuestion), so they must never be the cut.
  const assumed = parts.filter((p) => p.assumed).map((p) => `${p.assumed} ${p.name}`);
  const remembered = parts.filter((p) => p.remembered && !p.assumed).map((p) => `${Math.round(p.grams)} g ${p.name}`);
  const each = parts.map((p) => `${Math.round(p.grams)} g ${p.name}`);
  const note = [
    assumed.length ? `Assumed ${assumed.join(", ")}.` : null,
    remembered.length ? `From your last log: ${remembered.join(", ")}.` : null,
    missing.length ? `Not found: ${missing.join(", ")}.` : null,
    `Parts: ${each.join(", ")}.`,
  ].filter(Boolean).join(" ");
  return note.length <= 160 ? note : `${note.slice(0, 157)}...`;
}

/** Parts the parse could not find, past which a dish is not put on the card:
 *  its total would be too far under. One missing part lands, named, at low
 *  confidence, unless it is the dish's main part (buildRecipe). */
export const RECIPE_MAX_MISSING = 1;

/**
 * The dish as one card line. Code adds the parts up: every number on the line
 * is the sum of each part's per 100 x grams / 100. Nothing comes from a model.
 */
export function sumRecipe(name: string, parts: PartFound[], meal: MealType, missing: string[] = []): ParsedItem {
  const t = { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 };
  let fiber: number | null = null;
  // One part with no fiber figure makes the dish's fiber unknown: a partial
  // sum would read as the whole dish's and under-report it.
  let fiberUnknown = false;
  for (const p of parts) {
    const x = partTotals(p);
    t.kcal += x.kcal;
    t.protein_g += x.protein_g;
    t.carb_g += x.carb_g;
    t.fat_g += x.fat_g;
    if (x.fiber_g !== null) fiber = (fiber ?? 0) + x.fiber_g;
    else fiberUnknown = true;
  }
  const grams = parts.reduce((n, p) => n + p.grams, 0);
  const recipe: RecipePart[] = parts.map((p) => ({
    name: p.name,
    grams: r1(p.grams),
    per100: { kcal: r1(p.per100.kcal), protein_g: r1(p.per100.protein_g), carb_g: r1(p.per100.carb_g), fat_g: r1(p.per100.fat_g) },
    // The part's own origin: label, catalog, guess, ... (step 4's words).
    source: originOf({ source: p.source }),
    ...(p.assumed ? { assumed: true } : {}),
  }));
  return {
    food_id: null,
    food_name: name,
    quantity: 1,
    serving_label: "serving",
    grams: r1(grams),
    kcal: r1(t.kcal),
    protein_g: r1(t.protein_g),
    carb_g: r1(t.carb_g),
    fat_g: r1(t.fat_g),
    fiber_g: fiber === null || fiberUnknown ? null : r1(fiber),
    source: "recipe",
    origin: "recipe",
    assumption: recipeNote(parts, missing),
    // A recipe sum sits below the catalog in the source order. A part that is
    // itself a guess, or a part not found, makes it low. An assumed amount
    // does not: the card says it and the user is asked once (recipeQuestion).
    confidence: parts.some((p) => p.source === "estimate") || missing.length ? "low" : "medium",
    meal_type: meal,
    recipe,
  };
}

/** One part's row from its parse: the numbers per 100 g. Several items for one
 *  part (a parse that split it) are taken together. Null when the parse found
 *  no food, or no weight to divide by. */
export function per100FromParse(r: ParseMealResult | null): (PartFound["per100"] & { grams: number; source: string; label: string }) | null {
  // Only items with a weight: one with none would add calories and no grams.
  const items = (r?.parsed?.items ?? []).filter((i) => i.grams > 0);
  const grams = items.reduce((n, i) => n + i.grams, 0);
  if (!items.length || grams <= 0) return null;
  const sum = (k: "kcal" | "protein_g" | "carb_g" | "fat_g") => items.reduce((n, i) => n + (Number(i[k]) || 0), 0);
  // Fiber only when every item has a figure: a missing one would count as 0
  // while its grams stay in the divisor.
  const fibers = items.map((i) => i.fiber_g);
  const fiber = fibers.some((f) => f === null || f === undefined) ? null : fibers.reduce<number>((n, f) => n + (f ?? 0), 0);
  const per = (v: number) => (v / grams) * 100;
  const one = items[0];
  return {
    kcal: per(sum("kcal")),
    protein_g: per(sum("protein_g")),
    carb_g: per(sum("carb_g")),
    fat_g: per(sum("fat_g")),
    fiber_g: fiber === null ? null : per(fiber),
    grams,
    // A part made of a few items with different sources reads as the weakest
    // (step 4's origin order: label above catalog above guess).
    source: items.reduce((w, i) => (ORIGIN_RANK[originOf({ source: i.source })] < ORIGIN_RANK[originOf({ source: w })] ? i.source : w), one.source),
    label: items.length === 1 ? `${one.quantity} ${one.serving_label}`.trim() : `${Math.round(grams)} g`,
  };
}

/** What each part is looked up as: the user's amount, else the table's grams,
 *  else the name alone (the parse then takes one usual serving). */
export function partLookupText(p: { name: string; amount: string | null }): {
  text: string;
  /** Our grams (the table's), or null when the parse decides them. */
  grams: number | null;
  /** The amount is not the user's. */
  assumed: boolean;
  /** How the table says the assumed amount ("1 tsp"); null otherwise. */
  label: string | null;
} {
  if (p.amount) return { text: `${p.amount} ${p.name}`, grams: null, assumed: false, label: null };
  const t = assumedAmount(p.name);
  if (t) return { text: `${t.grams} g ${p.name}`, grams: t.grams, assumed: true, label: t.label };
  // Not in the table: the parse takes one usual serving, and buildRecipe says
  // that serving's weight ("40 g") as the assumption.
  return { text: p.name, grams: null, assumed: true, label: null };
}

/** A part's words, for matching it to a remembered part: lower case, plurals
 *  folded. */
const partWords = (s: string) => key(s).split(" ").filter(Boolean).map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));

/**
 * The remembered part a part with no amount stands for (FOOD_WARM_MEMORY):
 * the same name, else the one part whose words hold all of the other's
 * ("paneer" and "low fat paneer"). Two that fit, or none: null, so the part
 * takes the table's amount as before. Only a part with a weight counts.
 */
export function rememberedPart(recipe: RecipePart[] | null | undefined, name: string): RecipePart | null {
  const parts = (recipe ?? []).filter((p) => p.grams > 0);
  const k = key(name);
  const same = parts.filter((p) => key(p.name) === k);
  if (same.length === 1) return same[0];
  if (same.length > 1) return null;
  const said = partWords(name);
  if (!said.length) return null;
  const fits = parts.filter((p) => {
    const w = partWords(p.name);
    return said.every((x) => w.includes(x)) || w.every((x) => said.includes(x));
  });
  return fits.length === 1 ? fits[0] : null;
}

/** A part's amount in grams when the user said it in grams ("50 g"), else
 *  null. Not ml: a millilitre weighs as much as a gram only for water. */
function statedGrams(amount: string | null): number | null {
  const m = amount?.trim().match(/^(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)$/i);
  return m ? Number(m[1]) : null;
}

/**
 * Build the dish: one parse per part, all at once, through `parse` (the same
 * lookup the pipeline uses). A part the parse cannot find is left out and
 * named; a dish with no part found is null.
 */
export async function buildRecipe(
  ask: RecipeAsk,
  meal: MealType,
  parse: (text: string) => Promise<ParseMealResult>,
  /** FOOD_WARM_MEMORY: the parts of this same dish in the user's food memory
   *  (rememberedRecipe). A part sent with no amount takes its remembered
   *  grams instead of an assumed amount; a part with an amount keeps the
   *  user's; a remembered part the agent did not send is not added. */
  remembered: RecipePart[] | null = null,
): Promise<{
  item: ParsedItem | null;
  missing: string[];
  /** Missing because the lookup itself failed (a timeout), not because no
   *  food matched: said apart, so the user is not told the food does not exist. */
  errored: string[];
  results: (ParseMealResult | null)[];
}> {
  const looked = await Promise.all(ask.parts.map(async (p) => {
    const mem = !p.amount && remembered ? rememberedPart(remembered, p.name) : null;
    const q: ReturnType<typeof partLookupText> & { remembered?: boolean } = mem
      ? { text: `${r1(mem.grams)} g ${p.name}`, grams: mem.grams, assumed: false, label: null, remembered: true }
      : partLookupText(p);
    let r: ParseMealResult | null = null;
    let failed = false;
    try {
      r = await parse(q.text);
    } catch {
      r = null;
      failed = true;
    }
    return { p, q, r, failed, row: per100FromParse(r) };
  }));
  const found: PartFound[] = [];
  const missing: string[] = [];
  for (const { p, q, row } of looked) {
    if (!row) {
      missing.push(p.name);
      continue;
    }
    // The table's grams win over the parse's: the parse only supplied the row.
    const grams = q.grams ?? row.grams;
    found.push({
      name: p.name,
      grams,
      per100: { kcal: row.kcal, protein_g: row.protein_g, carb_g: row.carb_g, fat_g: row.fat_g, fiber_g: row.fiber_g },
      source: row.source,
      assumed: q.assumed ? q.label ?? `${Math.round(grams)} g` : null,
      ...(q.remembered ? { remembered: true } : {}),
    });
  }
  // A missing part the user weighed at least as heavy as every part found is
  // the dish's main part: without it the total is far under, so no dish. Only
  // a weight in grams counts here ("2 eggs" has no grams before a lookup): a
  // main part given in pieces or cups and not found still lands, at low
  // confidence and named on the card.
  const heaviest = Math.max(0, ...found.map((p) => p.grams));
  const mainMissing = looked.some(({ p, row }) => !row && (statedGrams(p.amount) ?? 0) >= heaviest && heaviest > 0);
  const ok = found.length > 0 && missing.length <= RECIPE_MAX_MISSING && !mainMissing;
  const errored = looked.filter((x) => x.failed).map((x) => x.p.name);
  return { item: ok ? sumRecipe(ask.name, found, meal, missing) : null, missing, errored, results: looked.map((x) => x.r) };
}

/** The parts of the user's remembered dish with this name (food memory's
 *  recipe, matched by memoryKey, which drops a recipe written into a name),
 *  or null when memory has no such dish with parts. */
export function rememberedRecipe(
  foods: { key: string; recipe?: RecipePart[] | null }[] | null | undefined,
  dish: string,
  keyOf: (name: string) => string,
): RecipePart[] | null {
  const k = keyOf(dish);
  if (!k) return null;
  return (foods ?? []).find((f) => f.key === k && (f.recipe?.length ?? 0) > 0)?.recipe ?? null;
}

// ── The one question ────────────────────────────────────────────────────────

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** How an assumed part's amount is said: the table's ("1 tsp"), else grams. */
function labelOf(part: RecipePart): string {
  return assumedAmount(part.name)?.label ?? `${Math.round(part.grams)} g`;
}

/** The words code asks with. Fixed, so an earlier turn can be checked for it. */
export function assumedPhrase(label: string, part: string): string {
  return `I assumed ${label} ${part}`;
}

/**
 * The ONE question for this message's recipes: the assumed parts the user was
 * not asked about yet, at most two named, one sentence. Already asked means:
 * an earlier Drona turn holds the same "I assumed ..." words, or the card
 * already has this dish built with that part assumed (its `recipe`, or its
 * note from an app that drops `recipe`). Null when there is nothing to ask.
 */
export function recipeQuestion(
  built: ParsedItem[],
  card: CardLine[],
  turns: { role: "user" | "drona"; text: string }[] | undefined,
): string | null {
  const said = (turns ?? []).filter((t) => t.role === "drona").map((t) => ` ${key(t.text)} `);
  const asked = (dish: string, part: RecipePart): boolean => {
    // "1 tsp ghee", not "I assumed 1 tsp ghee": a second part follows "and".
    const phrase = ` ${key(`${labelOf(part)} ${part.name}`)} `;
    if (said.some((t) => t.includes(phrase) && t.includes(" i assumed "))) return true;
    return card.some((l) => {
      if (key(l.food_name) !== key(dish)) return false;
      if (l.recipe?.some((q) => q.assumed && key(q.name) === key(part.name))) return true;
      // An app that drops `recipe` keeps the note: its "Assumed ..." part.
      const head = l.assumption ? ` ${key(l.assumption).split(" parts ")[0]} ` : "";
      return head.startsWith(" assumed ") && head.includes(phrase);
    });
  };
  const open: string[] = [];
  for (const item of built) {
    for (const part of item.recipe ?? []) {
      if (!part.assumed || asked(item.food_name, part)) continue;
      open.push(`${labelOf(part)} ${part.name}`);
    }
  }
  const named = [...new Set(open)].slice(0, 2);
  if (!named.length) return null;
  return `I assumed ${named.join(" and ")}. Change ${named.length === 1 ? "it" : "them"}?`;
}

// ── From the app ────────────────────────────────────────────────────────────

/** A recipe line's parts as the app sent them back, checked by step 4's
 *  parseRecipe (every part needs a name and a weight, else none are kept).
 *  Only a line whose source is "recipe" keeps parts: a line changed since (an
 *  edit, a new source) would carry old parts that no longer add up to it. */
// The parts' per-100 numbers come from the app: the user's own card, checked
// by parseRecipe (sane, non-negative). They explain a line; they never price
// anything new.
export function readRecipeParts(raw: unknown, source: unknown): RecipePart[] | undefined {
  if (source !== "recipe") return undefined;
  return parseRecipe(raw) ?? undefined;
}
