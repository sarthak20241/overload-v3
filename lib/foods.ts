/**
 * Shared food catalog + diet domain types for the macro tracker.
 *
 * Mirrors lib/exercises.ts: a static bundled FOOD_LIBRARY (always offline) plus
 * per-user custom rows in the Supabase `foods` table, unioned at read time and
 * deduped by lowercased name. The DB mirrors the two enums below in
 * `foods.food_category` / `foods.serving_unit` CHECK constraints (migration
 * 0046) — keep the allowed-value lists byte-for-byte in sync.
 *
 * Macros are stated per `serving_size` of `serving_unit` (e.g. 100 g, or 1 piece,
 * or 1 bowl). A logged entry computes its macros as `perServing * quantity /
 * serving_size`. See lib/format.ts (to add) for the display formatters.
 *
 * NOTE ON THE LIBRARY BELOW: FOOD_LIBRARY is a HAND-CURATED STARTER SET. Nutrient
 * numbers are facts (not copyrightable), authored by us against public references,
 * so this seed carries no licensing taint. The full catalog (USDA CC0 + Open Food
 * Facts India subset + our computed Indian dishes) is produced by the
 * scripts/diet-catalog pipeline, which will expand/replace this list. See
 * .planning/diet-tracking-plan.md → "Data sourcing".
 */

// ── Enums (mirror the DB CHECK constraints in migration 0046) ────────────────

/** Broad food grouping. Drives catalog browsing + filter pills. */
export type FoodCategory =
  | 'protein'        // chicken, eggs, fish, mutton
  | 'legume'         // dal, rajma, chana, soya
  | 'dairy'          // milk, curd, paneer, cheese
  | 'grain'          // rice, roti, oats, bread, poha
  | 'vegetable'
  | 'fruit'
  | 'fat_oil'        // ghee, oil, butter
  | 'nuts_seeds'     // almonds, peanuts, peanut butter
  | 'prepared_dish'  // cooked dishes: dal tadka, dosa, biryani, paneer dishes
  | 'snack'          // namkeen, biscuits, protein bar
  | 'beverage'       // chai, coffee, juice, soda
  | 'sweet'          // mithai, desserts
  | 'supplement'     // whey, creatine, mass gainer
  | 'condiment'      // chutney, pickle, sauce
  | 'other';

export const FOOD_CATEGORIES: FoodCategory[] = [
  'protein', 'legume', 'dairy', 'grain', 'vegetable', 'fruit', 'fat_oil',
  'nuts_seeds', 'prepared_dish', 'snack', 'beverage', 'sweet', 'supplement',
  'condiment', 'other',
];

export const DEFAULT_FOOD_CATEGORY: FoodCategory = 'other';

/** How a food is portioned. Drives the quantity input in the log/picker. */
export type ServingUnit =
  | 'g'      // grams (default; most raw ingredients per 100 g)
  | 'ml'     // milliliters
  | 'piece'  // 1 egg, 1 roti, 1 banana
  | 'slice'  // bread
  | 'bowl'   // katori: dal, rice, sabzi
  | 'cup'
  | 'glass'  // milk, juice
  | 'tbsp'
  | 'tsp'
  | 'scoop'; // whey, mass gainer

export const SERVING_UNIT_VALUES: ServingUnit[] = [
  'g', 'ml', 'piece', 'slice', 'bowl', 'cup', 'glass', 'tbsp', 'tsp', 'scoop',
];

export const DEFAULT_SERVING_UNIT: ServingUnit = 'g';

/** Provenance of a catalog row. Load-bearing for ODbL: Open Food Facts rows
 * (`off`) must stay segregated + attributed (see Data sourcing). */
export type FoodSource = 'usda' | 'off' | 'curated' | 'user';
export const DEFAULT_FOOD_SOURCE: FoodSource = 'curated';

// ── Descriptor table for serving units (drives the quantity input) ───────────

export interface ServingUnitDef {
  value: ServingUnit;
  /** Short label shown next to the quantity (e.g. "g", "bowl"). */
  label: string;
  /** Plural for counts > 1 where it reads better ("pieces", "bowls"). */
  plural: string;
  /** ± stepper increment for the quantity input. */
  step: number;
  /** Keyboard for the quantity cell. */
  keyboardType: 'numeric' | 'decimal-pad';
}

/** Authoritative serving-unit descriptors — one source for the picker + the entry row. */
export const SERVING_UNITS: ServingUnitDef[] = [
  { value: 'g', label: 'g', plural: 'g', step: 10, keyboardType: 'numeric' },
  { value: 'ml', label: 'ml', plural: 'ml', step: 10, keyboardType: 'numeric' },
  { value: 'piece', label: 'piece', plural: 'pieces', step: 1, keyboardType: 'decimal-pad' },
  { value: 'slice', label: 'slice', plural: 'slices', step: 1, keyboardType: 'decimal-pad' },
  { value: 'bowl', label: 'bowl', plural: 'bowls', step: 1, keyboardType: 'decimal-pad' },
  { value: 'cup', label: 'cup', plural: 'cups', step: 1, keyboardType: 'decimal-pad' },
  { value: 'glass', label: 'glass', plural: 'glasses', step: 1, keyboardType: 'decimal-pad' },
  { value: 'tbsp', label: 'tbsp', plural: 'tbsp', step: 1, keyboardType: 'decimal-pad' },
  { value: 'tsp', label: 'tsp', plural: 'tsp', step: 1, keyboardType: 'decimal-pad' },
  { value: 'scoop', label: 'scoop', plural: 'scoops', step: 1, keyboardType: 'decimal-pad' },
];

const SERVING_UNIT_BY_VALUE: Record<ServingUnit, ServingUnitDef> = Object.fromEntries(
  SERVING_UNITS.map((u) => [u.value, u]),
) as Record<ServingUnit, ServingUnitDef>;

/** Normalize any (possibly-missing or unknown) value to a valid ServingUnit. */
export function servingUnitOf(v: string | null | undefined): ServingUnit {
  return v && v in SERVING_UNIT_BY_VALUE ? (v as ServingUnit) : DEFAULT_SERVING_UNIT;
}

export function servingUnitDef(v: string | null | undefined): ServingUnitDef {
  return SERVING_UNIT_BY_VALUE[servingUnitOf(v)];
}

/** Normalize any value to a valid FoodCategory. */
export function foodCategoryOf(v: string | null | undefined): FoodCategory {
  return v && (FOOD_CATEGORIES as string[]).includes(v) ? (v as FoodCategory) : DEFAULT_FOOD_CATEGORY;
}

// ── Macro maths ──────────────────────────────────────────────────────────────

export interface Macros {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
}

/**
 * Macros for `quantity` of a food whose per-serving macros are stated for
 * `serving_size`. e.g. chicken at 165 kcal / 100 g, quantity 150 g -> 247 kcal.
 * Rounding is left to the formatters (lib/format.ts roundMacros) — keep this pure.
 */
export function scaleMacros(perServing: Macros, quantity: number, servingSize: number): Macros {
  const f = servingSize > 0 ? quantity / servingSize : 0;
  return {
    kcal: perServing.kcal * f,
    protein_g: perServing.protein_g * f,
    carb_g: perServing.carb_g * f,
    fat_g: perServing.fat_g * f,
  };
}

/** Sum a list of macro rows (e.g. all entries in a meal, or a day). */
export function sumMacros(rows: Macros[]): Macros {
  return rows.reduce<Macros>(
    (acc, m) => ({
      kcal: acc.kcal + m.kcal,
      protein_g: acc.protein_g + m.protein_g,
      carb_g: acc.carb_g + m.carb_g,
      fat_g: acc.fat_g + m.fat_g,
    }),
    { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
  );
}

// ── Entity shapes (server-row mirrors; kept here, not lib/types.ts, to avoid
//    touching the set-types-modified file — move to lib/types.ts once that lands) ──

/** A catalog food (static library entry or a `foods` row). Macros per serving_size. */
export interface FoodDef {
  name: string;
  food_category: FoodCategory;
  serving_unit: ServingUnit;
  /** The reference serving the macros below are stated for, in serving_unit. */
  serving_size: number;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  brand?: string;
  source?: FoodSource;
}

/** A `foods` table row (FoodDef + server/identity fields). */
export interface Food extends FoodDef {
  id: string;
  barcode?: string | null;
  image_url?: string | null;
  created_by?: string | null; // null = global
}

/** Meal types — a logged eating occasion. Mirrors the DB CHECK in migration 0047. */
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/** A logged meal (analog of a `workouts` row). */
export interface Meal {
  id: string;
  user_id?: string;
  logged_at: string; // ISO; the real event time, captured at log, not sync
  meal_type: MealType;
  note?: string | null;
  client_id?: string | null; // offline idempotency
  entries?: MealEntry[];
}

/**
 * One food within a meal (analog of a `workout_sets` row). Macros + food_name are
 * DENORMALIZED snapshots so history is immutable, the log renders without a join,
 * and offline-created custom foods (no server id yet) still display.
 */
export interface MealEntry {
  id: string;
  meal_id: string;
  food_id?: string | null; // null after the catalog food is deleted (set null)
  food_name: string;
  quantity: number;
  serving_unit: ServingUnit;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  position: number;
}

/** Daily calorie/macro goals (nullable columns on user_profiles, migration 0048). */
export interface NutritionTargets {
  daily_calorie_target?: number | null;
  protein_target_g?: number | null;
  carb_target_g?: number | null;
  fat_target_g?: number | null;
}

// ── Search ───────────────────────────────────────────────────────────────────

/** Search foods by name, category, or brand (mirrors searchExercises). */
export function searchFoods(query: string, library = FOOD_LIBRARY): FoodDef[] {
  const q = query.toLowerCase().trim();
  if (!q) return library;
  return library.filter(
    (f) =>
      f.name.toLowerCase().includes(q) ||
      f.food_category.toLowerCase().includes(q) ||
      (f.brand ? f.brand.toLowerCase().includes(q) : false),
  );
}

// ── Starter library (hand-curated; expanded by scripts/diet-catalog) ─────────
// Macros are approximate, per the stated serving_size + serving_unit. India-first
// + gym staples. source: 'curated' = authored by us (facts, no license taint).

export const FOOD_LIBRARY: FoodDef[] = [
  // Protein
  { name: 'Chicken Breast (cooked)', food_category: 'protein', serving_unit: 'g', serving_size: 100, kcal: 165, protein_g: 31, carb_g: 0, fat_g: 3.6, source: 'curated' },
  { name: 'Egg (whole)', food_category: 'protein', serving_unit: 'piece', serving_size: 1, kcal: 78, protein_g: 6.3, carb_g: 0.6, fat_g: 5.3, source: 'curated' },
  { name: 'Egg White', food_category: 'protein', serving_unit: 'piece', serving_size: 1, kcal: 17, protein_g: 3.6, carb_g: 0.2, fat_g: 0.1, source: 'curated' },
  { name: 'Rohu Fish (cooked)', food_category: 'protein', serving_unit: 'g', serving_size: 100, kcal: 97, protein_g: 17, carb_g: 0, fat_g: 1.4, source: 'curated' },
  { name: 'Mutton (cooked)', food_category: 'protein', serving_unit: 'g', serving_size: 100, kcal: 250, protein_g: 25, carb_g: 0, fat_g: 16, source: 'curated' },
  { name: 'Tofu', food_category: 'protein', serving_unit: 'g', serving_size: 100, kcal: 76, protein_g: 8, carb_g: 1.9, fat_g: 4.8, source: 'curated' },
  { name: 'Soya Chunks (dry)', food_category: 'protein', serving_unit: 'g', serving_size: 100, kcal: 345, protein_g: 52, carb_g: 33, fat_g: 0.5, source: 'curated' },
  // Legumes
  { name: 'Toor Dal (cooked)', food_category: 'legume', serving_unit: 'bowl', serving_size: 1, kcal: 115, protein_g: 7, carb_g: 18, fat_g: 1.5, source: 'curated' },
  { name: 'Rajma (cooked)', food_category: 'legume', serving_unit: 'g', serving_size: 100, kcal: 127, protein_g: 8.7, carb_g: 22, fat_g: 0.5, source: 'curated' },
  { name: 'Chana / Chickpeas (cooked)', food_category: 'legume', serving_unit: 'g', serving_size: 100, kcal: 164, protein_g: 9, carb_g: 27, fat_g: 2.6, source: 'curated' },
  { name: 'Moong Dal (cooked)', food_category: 'legume', serving_unit: 'bowl', serving_size: 1, kcal: 105, protein_g: 7, carb_g: 19, fat_g: 0.4, source: 'curated' },
  // Dairy
  { name: 'Paneer', food_category: 'dairy', serving_unit: 'g', serving_size: 100, kcal: 265, protein_g: 18, carb_g: 1.2, fat_g: 20, source: 'curated' },
  { name: 'Toned Milk', food_category: 'dairy', serving_unit: 'glass', serving_size: 1, kcal: 120, protein_g: 8, carb_g: 12, fat_g: 4, source: 'curated' },
  { name: 'Curd / Dahi', food_category: 'dairy', serving_unit: 'g', serving_size: 100, kcal: 60, protein_g: 3.1, carb_g: 4.7, fat_g: 3.3, source: 'curated' },
  { name: 'Greek Yogurt', food_category: 'dairy', serving_unit: 'g', serving_size: 100, kcal: 59, protein_g: 10, carb_g: 3.6, fat_g: 0.4, source: 'curated' },
  // Grains
  { name: 'White Rice (cooked)', food_category: 'grain', serving_unit: 'g', serving_size: 100, kcal: 130, protein_g: 2.7, carb_g: 28, fat_g: 0.3, source: 'curated' },
  { name: 'Brown Rice (cooked)', food_category: 'grain', serving_unit: 'g', serving_size: 100, kcal: 123, protein_g: 2.7, carb_g: 26, fat_g: 1, source: 'curated' },
  { name: 'Roti / Chapati', food_category: 'grain', serving_unit: 'piece', serving_size: 1, kcal: 120, protein_g: 3, carb_g: 18, fat_g: 3.7, source: 'curated' },
  { name: 'Oats (dry)', food_category: 'grain', serving_unit: 'g', serving_size: 40, kcal: 150, protein_g: 5, carb_g: 27, fat_g: 2.5, source: 'curated' },
  { name: 'Bread (white)', food_category: 'grain', serving_unit: 'slice', serving_size: 1, kcal: 75, protein_g: 2.6, carb_g: 14, fat_g: 1, source: 'curated' },
  { name: 'Poha (cooked)', food_category: 'grain', serving_unit: 'bowl', serving_size: 1, kcal: 250, protein_g: 5, carb_g: 45, fat_g: 6, source: 'curated' },
  // Vegetables
  { name: 'Spinach / Palak', food_category: 'vegetable', serving_unit: 'g', serving_size: 100, kcal: 23, protein_g: 2.9, carb_g: 3.6, fat_g: 0.4, source: 'curated' },
  { name: 'Broccoli', food_category: 'vegetable', serving_unit: 'g', serving_size: 100, kcal: 34, protein_g: 2.8, carb_g: 7, fat_g: 0.4, source: 'curated' },
  { name: 'Potato (boiled)', food_category: 'vegetable', serving_unit: 'g', serving_size: 100, kcal: 87, protein_g: 1.9, carb_g: 20, fat_g: 0.1, source: 'curated' },
  { name: 'Sweet Potato', food_category: 'vegetable', serving_unit: 'g', serving_size: 100, kcal: 86, protein_g: 1.6, carb_g: 20, fat_g: 0.1, source: 'curated' },
  // Fruit
  { name: 'Banana', food_category: 'fruit', serving_unit: 'piece', serving_size: 1, kcal: 105, protein_g: 1.3, carb_g: 27, fat_g: 0.4, source: 'curated' },
  { name: 'Apple', food_category: 'fruit', serving_unit: 'piece', serving_size: 1, kcal: 95, protein_g: 0.5, carb_g: 25, fat_g: 0.3, source: 'curated' },
  // Fats & oils
  { name: 'Ghee', food_category: 'fat_oil', serving_unit: 'tsp', serving_size: 1, kcal: 45, protein_g: 0, carb_g: 0, fat_g: 5, source: 'curated' },
  { name: 'Cooking Oil', food_category: 'fat_oil', serving_unit: 'tbsp', serving_size: 1, kcal: 124, protein_g: 0, carb_g: 0, fat_g: 14, source: 'curated' },
  // Nuts & seeds
  { name: 'Almonds', food_category: 'nuts_seeds', serving_unit: 'g', serving_size: 100, kcal: 579, protein_g: 21, carb_g: 22, fat_g: 50, source: 'curated' },
  { name: 'Peanuts', food_category: 'nuts_seeds', serving_unit: 'g', serving_size: 100, kcal: 567, protein_g: 26, carb_g: 16, fat_g: 49, source: 'curated' },
  { name: 'Peanut Butter', food_category: 'nuts_seeds', serving_unit: 'tbsp', serving_size: 1, kcal: 95, protein_g: 4, carb_g: 3, fat_g: 8, source: 'curated' },
  // Prepared dishes (computed-style starters; the pipeline expands this set)
  { name: 'Dal Tadka', food_category: 'prepared_dish', serving_unit: 'bowl', serving_size: 1, kcal: 180, protein_g: 9, carb_g: 20, fat_g: 7, source: 'curated' },
  { name: 'Idli', food_category: 'prepared_dish', serving_unit: 'piece', serving_size: 1, kcal: 58, protein_g: 2, carb_g: 12, fat_g: 0.4, source: 'curated' },
  { name: 'Plain Dosa', food_category: 'prepared_dish', serving_unit: 'piece', serving_size: 1, kcal: 133, protein_g: 2.7, carb_g: 18, fat_g: 5, source: 'curated' },
  { name: 'Paneer Butter Masala', food_category: 'prepared_dish', serving_unit: 'bowl', serving_size: 1, kcal: 320, protein_g: 12, carb_g: 14, fat_g: 24, source: 'curated' },
  { name: 'Chicken Biryani', food_category: 'prepared_dish', serving_unit: 'bowl', serving_size: 1, kcal: 350, protein_g: 18, carb_g: 42, fat_g: 12, source: 'curated' },
  { name: 'Rajma Chawal', food_category: 'prepared_dish', serving_unit: 'bowl', serving_size: 1, kcal: 330, protein_g: 11, carb_g: 58, fat_g: 6, source: 'curated' },
  // Supplements (generic; brand-specific rows come from Open Food Facts)
  { name: 'Whey Protein (1 scoop)', food_category: 'supplement', serving_unit: 'scoop', serving_size: 1, kcal: 120, protein_g: 24, carb_g: 3, fat_g: 1.5, source: 'curated' },
  { name: 'Mass Gainer (1 scoop)', food_category: 'supplement', serving_unit: 'scoop', serving_size: 1, kcal: 360, protein_g: 15, carb_g: 70, fat_g: 3, source: 'curated' },
  // Beverages
  { name: 'Chai (with milk & sugar)', food_category: 'beverage', serving_unit: 'cup', serving_size: 1, kcal: 90, protein_g: 2, carb_g: 13, fat_g: 3, source: 'curated' },
  { name: 'Black Coffee', food_category: 'beverage', serving_unit: 'cup', serving_size: 1, kcal: 2, protein_g: 0.3, carb_g: 0, fat_g: 0, source: 'curated' },
];
