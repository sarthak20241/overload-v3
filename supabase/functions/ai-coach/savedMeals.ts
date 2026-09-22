// The user's saved meals, inside the meal parser.
//
// The rule this file exists for: when the user names one of their own saved
// meals, they get THEIR numbers. Not an estimate, not a catalog row, not a web
// lookup. They built that meal on purpose, often after weighing it, and any
// other source is a worse answer to a question they already answered.
//
// The model only RECOGNISES the reference ("my oats" is the saved "Oats with
// milk"). Code turns the reference into lines, from the stored rows, so no
// number here is ever generated. Jev was tried first and could not do this job:
// it matched "oats with milk" at 0.84 and "log my oats" at 0.03, because it
// reads names literally. Resolving a short, casual reference is exactly the kind
// of reading the extraction call already does for every food.
//
// Kept free of imports so deno can test it on its own.

export type SavedMealKind = "meal" | "recipe";

export interface SavedMealItemForParse {
  food_id: string | null;
  food_name: string;
  quantity: number;
  serving_unit: string;
  grams: number | null;
  kcal: number;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
}

export interface SavedMealForParse {
  id: string;
  name: string;
  kind: SavedMealKind;
  /** Recipe yield. A recipe's header macros are for the WHOLE batch. */
  servings: number;
  serving_label: string | null;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  items: SavedMealItemForParse[];
}

/** The line shape the parser returns. Declared structurally here so this file
 *  stays import-free; parseMeal.ts's ParsedItem is assignable from it. */
export interface SavedLine {
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
  source: "manual";
  assumption: null;
  confidence: "high";
  meal_type?: "breakfast" | "lunch" | "dinner" | "snack";
}

/** One recognised reference, before it becomes lines. */
export interface SavedHit {
  meal: SavedMealForParse;
  /** How many of it. 1 unless the user gave a count. */
  count: number;
  /** The meal the text tied to this item, if any. */
  mealType: "breakfast" | "lunch" | "dinner" | "snack" | null;
}

/** How many saved meals go into one prompt. Newest first. Past this the list
 *  is mostly noise to the model, and it costs input tokens on every log. */
export const MAX_SAVED_IN_PROMPT = 40;

const MASS_OR_VOLUME = new Set(["g", "gm", "gms", "gram", "grams", "kg", "ml", "l", "litre", "liter", "oz", "lb"]);

/** The block appended to the extraction message. Empty string when there is
 *  nothing saved, so a user with no saved meals sends exactly what they sent
 *  before this existed: same prompt, same behaviour. */
export function savedMealsBlock(saved: SavedMealForParse[]): string {
  const list = saved.slice(0, MAX_SAVED_IN_PROMPT).filter((m) => m.name.trim());
  if (list.length === 0) return "";
  const lines = list.map((m) => {
    const what = m.kind === "recipe"
      ? `recipe, ${fmt(m.servings)} servings`
      : m.items.slice(0, 6).map((i) => i.food_name.trim()).filter(Boolean).join(", ");
    return `- "${m.name.trim()}" (${what}${what ? "; " : ""}${Math.round(m.kcal)} kcal)`;
  });
  return (
    "\n\n<saved_meals>\n" +
    "The user's own saved meals. A reference list, NOT food they ate: take items only from the message above. " +
    "Use one only when the words mean that WHOLE meal, never for a single food that is only part of it.\n" +
    lines.join("\n") +
    "\n</saved_meals>"
  );
}

/** The saved meal an extracted item points at, by the exact name the model
 *  copied. Case and spacing are forgiven; anything else is not a match, because
 *  a near miss here would log the wrong meal under a name the user trusts. */
export function findSavedMeal(ref: unknown, saved: SavedMealForParse[]): SavedMealForParse | null {
  if (typeof ref !== "string") return null;
  const want = norm(ref);
  if (!want) return null;
  return saved.find((m) => norm(m.name) === want) ?? null;
}

/** How many of the saved meal the item stands for. The model mirrors the text,
 *  so "2 bowls of my oats" is quantity 2. A mass or volume unit means the user
 *  gave a weight, which a saved meal cannot be scaled by honestly: one serving.
 *  Capped so a misread number cannot log ten breakfasts. */
export function savedCount(quantity: unknown, unit: unknown): number {
  const q = typeof quantity === "number" && Number.isFinite(quantity) ? quantity : 1;
  const u = typeof unit === "string" ? unit.trim().toLowerCase() : "";
  if (MASS_OR_VOLUME.has(u)) return 1;
  if (q <= 0) return 1;
  return Math.min(q, 10);
}

/** The lines one hit logs. Mirrors logSavedMeal on the client exactly, so the
 *  same saved meal logs the same numbers whichever way it was logged: a MEAL
 *  expands its items times count, a RECIPE is one line at count/yield of the
 *  batch. */
export function savedMealLines(hit: SavedHit): SavedLine[] {
  const { meal, count } = hit;
  const base = { source: "manual" as const, assumption: null, confidence: "high" as const };
  const withMeal = hit.mealType ? { meal_type: hit.mealType } : {};

  if (meal.kind === "recipe" || meal.items.length === 0) {
    const f = meal.kind === "recipe" && meal.servings > 0 ? count / meal.servings : count;
    return [{
      food_id: null,
      food_name: meal.name.trim(),
      quantity: r1(count),
      serving_label: meal.serving_label?.trim() || "serving",
      grams: 0,
      kcal: r0(meal.kcal * f),
      protein_g: r1(meal.protein_g * f),
      carb_g: r1(meal.carb_g * f),
      fat_g: r1(meal.fat_g * f),
      fiber_g: null,
      ...base,
      ...withMeal,
    }];
  }

  return meal.items.map((it) => ({
    food_id: it.food_id,
    food_name: it.food_name,
    quantity: r1(it.quantity * count),
    serving_label: it.serving_unit || "serving",
    grams: it.grams && it.grams > 0 ? r1(it.grams * count) : 0,
    kcal: r0(it.kcal * count),
    protein_g: r1((it.protein_g ?? 0) * count),
    carb_g: r1((it.carb_g ?? 0) * count),
    fat_g: r1((it.fat_g ?? 0) * count),
    fiber_g: it.fiber_g == null ? null : r1(it.fiber_g * count),
    ...base,
    ...withMeal,
  }));
}

/** What Drona says about the saved part. Plain, and true: these are the
 *  user's own numbers and the line says so. */
export function savedDronaLine(hits: SavedHit[], rest: string | null): string {
  const names = [...new Set(hits.map((h) => h.meal.name.trim()))];
  const named = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const kcal = hits.reduce((s, h) => s + savedMealLines(h).reduce((a, l) => a + l.kcal, 0), 0);
  const lead = `Your saved ${named}, with your own numbers. ${Math.round(kcal)} kcal.`;
  const tail = rest && rest.trim() ? ` ${rest.trim()}` : "";
  return (lead + tail).slice(0, 240);
}

interface MergeableResult {
  parsed: {
    meal_type: "breakfast" | "lunch" | "dinner" | "snack";
    items: Array<{ meal_type?: string }>;
    drona_line: string;
    corrects_previous?: boolean;
  } | null;
  declined: { message: string; cleared?: boolean } | null;
}

/**
 * Put the saved lines into a finished parse.
 *
 * Saved lines go FIRST: they are the part of the meal the user was most exact
 * about. A decline turns into a result when saved lines exist, because the rest
 * of the message being unloggable ("my oats, and thanks!") must not cost the
 * meal they did name.
 */
export function mergeSavedLines<R extends MergeableResult>(
  result: R,
  hits: SavedHit[],
  fallbackMeal: "breakfast" | "lunch" | "dinner" | "snack",
): R {
  if (hits.length === 0) return result;
  const mealType = result.parsed?.meal_type ?? fallbackMeal;
  const lines = hits.flatMap((h) =>
    savedMealLines(h).map((l) => ({ ...l, meal_type: l.meal_type ?? mealType }))
  );

  if (!result.parsed || result.parsed.items.length === 0) {
    return {
      ...result,
      parsed: {
        meal_type: lines[0]?.meal_type ?? mealType,
        items: lines,
        drona_line: savedDronaLine(hits, null),
        corrects_previous: false,
      },
      declined: null,
    };
  }

  return {
    ...result,
    parsed: {
      ...result.parsed,
      items: [...lines, ...result.parsed.items],
      drona_line: savedDronaLine(hits, result.parsed.drona_line),
    },
  };
}

/** A saved meal to OFFER, never to log: the item names one food that is part
 *  of a saved meal ("oats", saved "Oats with milk"). Decision 1A: search the
 *  food as asked, and let the user swap with one tap. Every word of the food
 *  must appear in the meal's name or one of its items, so "chicken" does not
 *  offer "Chicken biryani" when it is only in the name by accident of a longer
 *  word. Newest saved meal first, which is the order they arrive in. */
export function suggestSavedMeal(foodName: string, saved: SavedMealForParse[]): SavedMealForParse | null {
  const want = words(foodName);
  if (want.length === 0) return null;
  for (const m of saved) {
    const have = new Set([m.name, ...m.items.map((i) => i.food_name)].flatMap(words));
    if (want.every((w) => have.has(w))) return m;
  }
  return null;
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").replace(/^"|"$/g, "");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function r0(n: number): number {
  return Math.round(Number.isFinite(n) ? n : 0);
}

function r1(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 10) / 10;
}
