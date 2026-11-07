// Where a food line's numbers came from, said plainly (Precise plan, step 4).
//
// "manual" used to mean six things: numbers the user typed, a diary line the
// agent copied, a line kept through a correction, a saved meal's line, a save
// card's line, and a line from memory. Memory trusted "manual" most, so a
// catalog row or a guess, copied once, became a top-trust fact.
//
// Now every line carries an `origin`:
//   user_typed  the user wrote the numbers (in the message, the card editor,
//               the edit sheet, a quick add)
//   label       a product label: web, Open Food Facts, FatSecret
//   catalog     our catalog row
//   recipe      a sum of named parts (see RecipePart)
//   guess       our estimate
//   unknown     an old line with no proof of where it came from
// and a copy (from the diary, memory, a saved meal, a card kept through a
// correction) KEEPS the origin it had and says where it was copied from in
// `copied_from`. Only user_typed gets top trust; unknown is trusted like a
// guess, below catalog, and is never promoted.
//
// `source` stays on the wire for apps that predate this: there "manual" means
// "the numbers are fixed, do not look them up again", nothing about trust.
// Trust reads `origin`, or, for a line without one, `originOf`'s safe reading
// of the old fields.
//
// Shared by the app (lib/foodOrigin.ts) and the edge function. Runtime
// agnostic: no Deno or React Native globals.

export const FOOD_ORIGINS = ["user_typed", "label", "catalog", "recipe", "guess", "unknown"] as const;
export type FoodOrigin = typeof FOOD_ORIGINS[number];

/** Where a copied line came from. Free text on the database side; these are
 *  the values the code writes. */
export const COPIED_FROM = ["diary", "memory", "saved_meal", "card", "correction"] as const;
export type CopiedFrom = typeof COPIED_FROM[number];

/** Trust, highest first. The plan's source order (section 5): user typed,
 *  label, catalog, recipe sum, guess. `unknown` sits with guess. Mirrored in
 *  SQL by food_memory_private.origin_rank (migration 20261107120000). */
export const ORIGIN_RANK: Record<FoodOrigin, number> = {
  user_typed: 5,
  label: 4,
  catalog: 3,
  recipe: 2,
  guess: 1,
  unknown: 1,
};

export function isFoodOrigin(v: unknown): v is FoodOrigin {
  return typeof v === "string" && (FOOD_ORIGINS as readonly string[]).includes(v);
}

/** The note the server writes on a line carrying numbers the user typed in the
 *  message (statedNumbers.ts statedNote). Proof of user_typed on an old line. */
const USER_NUMBERS_NOTE = /^your numbers\b/i;

/**
 * The origin of a line, from its own `origin` when it has one, else a safe
 * reading of the old fields. Old apps still send source "manual" for every
 * kind of copy: that alone is never proof the user typed the numbers, so it
 * reads as `unknown`. Only the server's own "Your numbers" note proves it.
 */
export function originOf(line: {
  origin?: unknown;
  source?: unknown;
  food_id?: unknown;
  assumption?: unknown;
  note?: unknown;
}): FoodOrigin {
  if (isFoodOrigin(line.origin)) return line.origin;
  const note = typeof line.assumption === "string" ? line.assumption : typeof line.note === "string" ? line.note : "";
  switch (line.source) {
    case "catalog":
      return "catalog";
    case "off":
    case "fatsecret":
    case "web":
      return "label";
    case "estimate":
      return "guess";
    case "manual":
      return USER_NUMBERS_NOTE.test(note.trim()) ? "user_typed" : "unknown";
    case null:
    case undefined:
      // The app's own food search writes no source: a picked catalog row has
      // a food_id. Anything else has no proof.
      return typeof line.food_id === "string" && line.food_id ? "catalog" : "unknown";
    default:
      return "unknown";
  }
}

/** A copy of `line`: same origin, plus where it was copied from. An origin the
 *  line already had wins over anything the copy would suggest. */
export function asCopy<T extends { origin?: unknown; source?: unknown; food_id?: unknown; assumption?: unknown }>(
  line: T,
  from: CopiedFrom,
): T & { origin: FoodOrigin; copied_from: CopiedFrom } {
  return { ...line, origin: originOf(line), copied_from: from };
}

/** Is `next` allowed to replace `current` as the numbers memory serves? A
 *  lower origin never replaces a higher one; it waits as a lower version
 *  (plan section 5 and 6). Equal ranks: the newer wins. Mirrored in SQL by
 *  food_memory_private.write_snapshot. */
export function mayReplace(current: FoodOrigin, next: FoodOrigin): boolean {
  return ORIGIN_RANK[next] >= ORIGIN_RANK[current];
}

// ---------------------------------------------------------------- recipes

/**
 * One part of a home dish. The `recipe` column (meal_entries, user_food_cache,
 * the memory versions) holds a JSON array of these, in the order the user
 * named them:
 *
 *   [{ "name": "Milky Mist low fat paneer", "grams": 60,
 *      "per100": { "kcal": 180, "protein_g": 25, "carb_g": 5, "fat_g": 6.5 },
 *      "source": "label" }, ...]
 *
 * - name: the part, as the user said it or the row it matched
 * - grams: how much of it is in the WHOLE dish the line describes (> 0)
 * - per100: the part's numbers per 100 g, or null when not known yet
 * - source: the part's own origin (a FoodOrigin), optional
 *
 * The dish's weight is the sum of its parts' grams. The food line's own
 * kcal/protein/carb/fat stay the numbers of record; the recipe says how they
 * were made and lets one part be rescaled ("60 g paneer this time").
 */
export interface RecipePart {
  name: string;
  grams: number;
  per100?: { kcal: number; protein_g: number; carb_g: number; fat_g: number } | null;
  source?: FoodOrigin;
}

const MAX_PARTS = 20;

/** A clean recipe from untrusted JSON, or null when it is not one. Every part
 *  needs a name and a weight; per100 is kept only when all four numbers are
 *  sane. */
export function parseRecipe(raw: unknown): RecipePart[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PARTS) return null;
  const out: RecipePart[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") return null;
    const r = p as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 120) : "";
    const grams = typeof r.grams === "number" ? r.grams : Number(r.grams);
    if (!name || !Number.isFinite(grams) || grams <= 0 || grams > 5000) return null;
    const part: RecipePart = { name, grams };
    const per = r.per100 as Record<string, unknown> | null | undefined;
    if (per && typeof per === "object") {
      const n = (k: string) => (typeof per[k] === "number" ? per[k] as number : NaN);
      const v = { kcal: n("kcal"), protein_g: n("protein_g"), carb_g: n("carb_g"), fat_g: n("fat_g") };
      if (Object.values(v).every((x) => Number.isFinite(x) && x >= 0) && v.kcal <= 920) part.per100 = v;
      else part.per100 = null;
    }
    if (isFoodOrigin(r.source)) part.source = r.source;
    out.push(part);
  }
  return out;
}

export function recipeGrams(recipe: RecipePart[]): number {
  return recipe.reduce((s, p) => s + p.grams, 0);
}

const STOP = new Set(["of", "and", "with", "the", "a", "some", "little", "low", "fat", "made", "in", "g", "gm", "gms", "gram", "grams"]);
const words = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d/.test(w))
    .map((w) => w.replace(/(es|s)$/, ""));

/** The grams the user gave for one named part ("60g paneer", "paneer 60 g"),
 *  matched to a recipe part by its words. One match only: two parts that fit
 *  the same words, or two weights for one part, is no answer. */
export function statedPartGrams(
  recipe: RecipePart[],
  text: string,
): { part: number; grams: number } | null {
  const found: { part: number; grams: number }[] = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(?:g|gm|gms|grams?)\b(?:\s+of)?\s+([a-z][a-z ]{1,40}?)(?=[,.;)]|\s+(?:and|with|\+)\b|$)|\b([a-z]+)\s+(\d+(?:[.,]\d+)?)\s*(?:g|gm|gms|grams?)\b/gi;
  for (const m of text.matchAll(re)) {
    const grams = Number((m[1] ?? m[4]).replace(",", "."));
    const said = words(m[2] ?? m[3] ?? "");
    if (!(grams > 0) || said.length === 0) continue;
    const fits = recipe
      .map((p, i) => ({ i, w: words(p.name) }))
      .filter(({ w }) => said.every((s) => w.includes(s)) || w.every((s) => said.includes(s)));
    if (fits.length === 1) found.push({ part: fits[0].i, grams });
  }
  const parts = new Set(found.map((f) => f.part));
  if (found.length === 0 || parts.size !== found.length) return null;
  return found.length === 1 ? found[0] : null;
}

/**
 * The recipe with one part at `grams` and every other part unchanged: what
 * "60 g paneer this time" means for a remembered dish. Returns the new parts
 * and the dish's new weight. The paneer changes; the oil and onion do not.
 */
export function withPartGrams(recipe: RecipePart[], part: number, grams: number): { recipe: RecipePart[]; grams: number } {
  const next = recipe.map((p, i) => (i === part ? { ...p, grams } : p));
  return { recipe: next, grams: recipeGrams(next) };
}

/** The dish's numbers per 100 g from its parts, when every part has per100.
 *  Code adds them up; the model never does. */
export function recipePer100(recipe: RecipePart[]): { kcal: number; protein_g: number; carb_g: number; fat_g: number } | null {
  if (!recipe.every((p) => p.per100)) return null;
  const total = recipeGrams(recipe);
  if (!(total > 0)) return null;
  const sum = (k: "kcal" | "protein_g" | "carb_g" | "fat_g") =>
    recipe.reduce((s, p) => s + (p.per100![k] * p.grams) / 100, 0) * 100 / total;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return { kcal: r1(sum("kcal")), protein_g: r1(sum("protein_g")), carb_g: r1(sum("carb_g")), fat_g: r1(sum("fat_g")) };
}

// ------------------------------------------------------------ dish names

/**
 * The dish name without a recipe written into it. The model used to put the
 * parts into the name ("Milky Mist low fat paneer sabji (65 g paneer, onion,
 * tomato, little oil)"), and each wording became its own memory row: one dish,
 * many rows. A trailing bracket is a recipe when it lists 2+ parts and either
 * gives a weight for one of them ("20 g paneer") or lists 3+ parts. Anything
 * else stays: "(cooked)", "(half)", "(jhol, estimated)", "(200 ml)".
 * Mirrored in SQL by food_memory_private.dish_name.
 */
export function dishName(name: string): string {
  const m = name.match(/^(.*\S)\s*\(([^()]*)\)\s*$/);
  if (!m) return name.trim();
  const items = m[2].split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length < 2) return name.trim();
  const weighed = items.some((s) => /^\d+(?:[.,]\d+)?\s*(?:g|gm|gms|grams?)\s+[a-z]/i.test(s));
  return weighed || items.length >= 3 ? m[1].trim() : name.trim();
}
