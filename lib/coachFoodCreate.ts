/**
 * Drona creating a food or meal from what you said.
 *
 * The return path for the `create_custom_food` and `create_custom_meal` tools.
 * Like `edit_active_workout`, the model never writes: the tool input arrives as
 * a structured payload, this module turns it into something concrete, and the
 * user's tap is what actually saves.
 *
 * Everything here is pure, so the rules that decide what a card is allowed to
 * claim are testable without mounting a chat.
 *
 * The model is not trusted with arithmetic. It proposes numbers; the totals
 * shown on the card and written to the row are recomputed here from the lines,
 * because a meal whose header disagrees with its own items is a bug the user
 * discovers weeks later in their diary.
 */

import {
  createSavedMeal,
  logSavedMeal,
  type ParsedMealItem,
} from '@/lib/dietData';
import type { MealType } from '@/lib/foods';

/** Which macros on a line are Drona's estimate rather than the user's words.
 *  Carried all the way to the card because an unmarked guess reads to the user
 *  as a number they gave. */
export type EstimatedField = 'kcal' | 'protein_g' | 'carb_g' | 'fat_g';

export interface CoachFoodLine {
  name: string;
  quantity: number;
  servingLabel: string;
  /** Null when the thing has no sensible weight (a scoop, a glass). The entry
   *  then carries only its numbers, which is exactly what quick add does. */
  grams: number | null;
  kcal: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  estimated: boolean;
}

export interface CoachFoodCreate {
  /** 'food' is one thing with no parts; 'meal' is a named dish with ingredients.
   *  Kept because the card says different things about each. */
  kind: 'food' | 'meal';
  name: string;
  summary: string;
  lines: CoachFoodLine[];
  /** Recomputed from `lines`, never taken from the model. */
  totals: { kcal: number; proteinG: number; carbG: number; fatG: number };
  /** Which of the TOP-LEVEL macros Drona filled in. Only meaningful for a
   *  single food; a meal marks estimates per line instead. */
  estimated: EstimatedField[];
  logNow: boolean;
  mealType: MealType | null;
}

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};
const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Clamp a macro into something a food could actually contain. The model is
 *  generating these, and a stray 30000 would sail into the diary and wreck a
 *  day's totals. Generous on purpose: this catches nonsense, not big meals. */
const macro = (v: unknown): number => Math.min(Math.max(r1(num(v)), 0), 2000);
const kcal = (v: unknown): number => Math.min(Math.max(r0(num(v)), 0), 20000);

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return s.slice(0, 80) || fallback;
}

function readMealType(v: unknown): MealType | null {
  return typeof v === 'string' && (MEAL_TYPES as string[]).includes(v) ? (v as MealType) : null;
}

function readEstimated(v: unknown): EstimatedField[] {
  if (!Array.isArray(v)) return [];
  const ok: EstimatedField[] = ['kcal', 'protein_g', 'carb_g', 'fat_g'];
  return ok.filter((f) => v.includes(f));
}

/**
 * Normalize a `create_custom_food` or `create_custom_meal` tool input.
 *
 * Returns null when there is nothing worth showing, which the caller treats as
 * "the model said something we cannot act on" and leaves as plain chat text.
 * That is deliberately the same shape as the workout edit path: a card that
 * cannot do anything is worse than no card.
 */
export function parseCoachFoodCreate(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
): CoachFoodCreate | null {
  if (!input || typeof input !== 'object') return null;
  const isMeal = toolName === 'create_custom_meal';
  if (!isMeal && toolName !== 'create_custom_food') return null;

  const name = cleanName(input.name, isMeal ? 'Saved meal' : 'Quick add');
  const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, 300) : '';
  const logNow = input.log_now === true;
  const mealType = readMealType(input.meal_type);

  let lines: CoachFoodLine[];
  let estimated: EstimatedField[] = [];

  if (isMeal) {
    const raw = Array.isArray(input.items) ? input.items : [];
    lines = raw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .slice(0, 30)
      .map((o) => {
        // A weight of 0 is "no weight given", which is a real state (a scoop, a
        // glass) and NOT the same as 0 grams. It must reach the row as null,
        // because meal_entries' CHECK wants null-or-positive.
        const g = o.grams === null || o.grams === undefined ? null : num(o.grams);
        return {
          name: cleanName(o.name, 'Item'),
          quantity: num(o.quantity) > 0 ? r1(num(o.quantity)) : 1,
          servingLabel: cleanName(o.serving_label, 'serving').slice(0, 40),
          grams: g !== null && g > 0 ? r1(g) : null,
          kcal: kcal(o.kcal),
          proteinG: macro(o.protein_g),
          carbG: macro(o.carb_g),
          fatG: macro(o.fat_g),
          estimated: o.estimated === true,
        };
      })
      // A line with no name and no calories is noise, not food.
      .filter((l) => l.name.length > 0);
    if (lines.length === 0) return null;
  } else {
    const k = kcal(input.kcal);
    // Calories are the number the whole entry hangs on. Without them there is
    // nothing to save and nothing to show.
    if (k <= 0) return null;
    estimated = readEstimated(input.estimated);
    lines = [{
      name,
      quantity: 1,
      servingLabel: cleanName(input.serving_label, 'serving').slice(0, 40),
      // Quick adds carry no weight on purpose: the typed numbers ARE the
      // numbers, with nothing to rescale them against.
      grams: null,
      kcal: k,
      proteinG: macro(input.protein_g),
      carbG: macro(input.carb_g),
      fatG: macro(input.fat_g),
      estimated: estimated.length > 0,
    }];
  }

  const totals = lines.reduce(
    (a, l) => ({
      kcal: a.kcal + l.kcal,
      proteinG: a.proteinG + l.proteinG,
      carbG: a.carbG + l.carbG,
      fatG: a.fatG + l.fatG,
    }),
    { kcal: 0, proteinG: 0, carbG: 0, fatG: 0 },
  );

  return {
    kind: isMeal ? 'meal' : 'food',
    name,
    summary,
    lines,
    totals: {
      kcal: r0(totals.kcal),
      proteinG: r1(totals.proteinG),
      carbG: r1(totals.carbG),
      fatG: r1(totals.fatG),
    },
    estimated,
    logNow,
    mealType,
  };
}

/** The card's own line about what the tap will do. Written here rather than in
 *  the component so it is testable, and so the card can never promise something
 *  the apply path does not do. */
export function createActionLabel(c: CoachFoodCreate, fallbackMeal: MealType): string {
  if (!c.logNow) return 'Save to My Meals';
  const meal = c.mealType ?? fallbackMeal;
  const pretty = meal === 'snack' ? 'Snacks' : meal.charAt(0).toUpperCase() + meal.slice(1);
  return `Save and log to ${pretty}`;
}

/** A create as the item shape createSavedMeal already speaks, so a Drona-made
 *  meal is indistinguishable from one built by hand or parsed from text. */
function toParsedItems(c: CoachFoodCreate, mealType: MealType): ParsedMealItem[] {
  return c.lines.map((l) => ({
    food_id: null,
    food_name: l.name,
    quantity: l.quantity,
    serving_label: l.servingLabel,
    // 0 reads downstream as "weightless", which createSavedMeal already maps to
    // a null grams_logged. Keeping that contract here means the Drona path and
    // the quick-add path write identical rows.
    grams: l.grams ?? 0,
    kcal: l.kcal,
    protein_g: l.proteinG,
    carb_g: l.carbG,
    fat_g: l.fatG,
    fiber_g: null,
    source: 'manual',
    assumption: null,
    confidence: 'high',
    meal_type: mealType,
  }));
}

export interface CoachFoodCreateResult {
  savedMealId: string | null;
  logged: boolean;
  error?: string;
}

/**
 * Apply the card: always save, and log too when the user was reporting a meal.
 *
 * Save first, log second, and never the other way round. If the save fails there
 * is nothing to log; if the LOG fails the meal is still in My Meals, which is
 * the recoverable half. A partial success says so rather than reporting a
 * failure that silently kept something.
 */
export async function applyCoachFoodCreate(
  supabase: Parameters<typeof createSavedMeal>[0],
  c: CoachFoodCreate,
  fallbackMeal: MealType,
  date?: Date,
): Promise<CoachFoodCreateResult> {
  const mealType = c.mealType ?? fallbackMeal;
  const saved = await createSavedMeal(supabase, {
    name: c.name,
    kind: 'meal',
    servings: 1,
    serving_label: null,
    items: toParsedItems(c, mealType),
  });
  if (saved.error || !saved.id) {
    return { savedMealId: null, logged: false, error: saved.error ?? 'Could not save that one' };
  }
  if (!c.logNow) return { savedMealId: saved.id, logged: false };

  const logged = await logSavedMeal(
    supabase,
    { id: saved.id, name: c.name, kind: 'meal', servings: 1, serving_label: null,
      kcal: c.totals.kcal, protein_g: c.totals.proteinG, carb_g: c.totals.carbG, fat_g: c.totals.fatG,
      items: c.lines.map((l, i) => ({
        food_id: null, food_name: l.name, quantity: l.quantity, serving_unit: l.servingLabel,
        grams_logged: l.grams, kcal: l.kcal, protein_g: l.proteinG, carb_g: l.carbG, fat_g: l.fatG,
        fiber_g: null, position: i,
      })), created_at: new Date().toISOString() },
    mealType,
    1,
    date,
    'drona_create',
  );
  if (logged.error) {
    // Saved but not logged. Say exactly that: "could not save" would be a lie
    // about a row that is sitting in their My Meals.
    return { savedMealId: saved.id, logged: false, error: 'Saved it, but could not log it just now' };
  }
  return { savedMealId: saved.id, logged: true };
}
