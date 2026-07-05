/**
 * Allow-lists that keep the generated catalog small + high-quality (a curated
 * few-hundred-item library, not the multi-GB raw dumps). See README.md.
 */

import type { FoodCategory, BaseUnit } from './build';

/**
 * USDA FoodData Central rows to include. Matched by case-insensitive name
 * substring against the SR Legacy / Foundation description, mapped to our
 * category + serving. Keep to clean generic ingredients + gym staples; the raw
 * Indian-staple values mostly come from our curated list instead.
 */
export interface UsdaPick {
  /** clean display name for our catalog (USDA descriptions are too verbose) */
  name: string;
  /** lowercased substring matched against the USDA description; the shortest
   * matching description wins (heuristic for "most generic"). */
  match: string;
  food_category: FoodCategory;
  /** 'g' for solids (default), 'ml' for liquids. USDA nutrients are per 100 g. */
  base_unit?: BaseUnit;
}

// All per 100 g (USDA basis). Matches tuned to real SR Legacy descriptions.
// Names that collide with the curated starter lose to it (curated > usda in the
// merge), so these mainly add BREADTH beyond the hand-curated list.
export const USDA_ALLOWLIST: UsdaPick[] = [
  // Protein
  { name: 'Chicken Breast (cooked)', match: 'chicken, broilers or fryers, breast, meat only, cooked, roasted', food_category: 'protein' },
  { name: 'Chicken Thigh (cooked)', match: 'chicken, broilers or fryers, thigh, meat only, cooked, roasted', food_category: 'protein' },
  { name: 'Egg (whole, raw)', match: 'egg, whole, raw, fresh', food_category: 'protein' },
  { name: 'Salmon (cooked)', match: 'fish, salmon, atlantic, farmed, cooked, dry heat', food_category: 'protein' },
  { name: 'Tuna (canned in water)', match: 'fish, tuna, light, canned in water, drained solids', food_category: 'protein' },
  { name: 'Tofu (firm)', match: 'tofu, firm, prepared with calcium sulfate', food_category: 'protein' },
  { name: 'Shrimp (cooked)', match: 'crustaceans, shrimp, cooked', food_category: 'protein' },
  // Legumes
  { name: 'Lentils (cooked)', match: 'lentils, mature seeds, cooked, boiled, without salt', food_category: 'legume' },
  { name: 'Chickpeas (cooked)', match: 'chickpeas (garbanzo beans, bengal gram), mature seeds, cooked, boiled, without salt', food_category: 'legume' },
  { name: 'Kidney Beans (cooked)', match: 'beans, kidney, red, mature seeds, cooked, boiled, without salt', food_category: 'legume' },
  // Dairy
  { name: 'Whole Milk', match: 'milk, whole, 3.25% milkfat, without added vitamin a and vitamin d', food_category: 'dairy' },
  { name: 'Cheddar Cheese', match: 'cheese, cheddar', food_category: 'dairy' },
  { name: 'Cottage Cheese (lowfat)', match: 'cheese, cottage, lowfat, 2% milkfat', food_category: 'dairy' },
  { name: 'Greek Yogurt (plain, nonfat)', match: 'yogurt, greek, plain, nonfat', food_category: 'dairy' },
  // Grains
  { name: 'White Rice (cooked)', match: 'rice, white, long-grain, regular, cooked', food_category: 'grain' },
  { name: 'Brown Rice (cooked)', match: 'rice, brown, long-grain, cooked', food_category: 'grain' },
  { name: 'Oats (dry)', match: 'cereals, oats, regular and quick, not fortified, dry', food_category: 'grain' },
  { name: 'Whole Wheat Bread', match: 'bread, whole-wheat, commercially prepared', food_category: 'grain' },
  { name: 'Whole Wheat Flour (atta)', match: 'wheat flour, whole-grain', food_category: 'grain' },
  // Vegetables
  { name: 'Broccoli (raw)', match: 'broccoli, raw', food_category: 'vegetable' },
  { name: 'Spinach (raw)', match: 'spinach, raw', food_category: 'vegetable' },
  { name: 'Potato (boiled)', match: 'potatoes, boiled, cooked in skin, flesh, without salt', food_category: 'vegetable' },
  { name: 'Sweet Potato (cooked)', match: 'sweet potato, cooked, baked in skin, flesh, without salt', food_category: 'vegetable' },
  // Fruit
  { name: 'Banana', match: 'bananas, raw', food_category: 'fruit' },
  { name: 'Apple', match: 'apples, raw, with skin', food_category: 'fruit' },
  // Nuts & seeds
  { name: 'Almonds', match: 'nuts, almonds, dry roasted, without salt added', food_category: 'nuts_seeds' },
  { name: 'Peanuts', match: 'peanuts, all types, dry-roasted, without salt', food_category: 'nuts_seeds' },
  { name: 'Walnuts', match: 'nuts, walnuts, english', food_category: 'nuts_seeds' },
  { name: 'Peanut Butter', match: 'peanut butter, smooth style, with salt', food_category: 'nuts_seeds' },
  // Fats
  { name: 'Olive Oil', match: 'oil, olive, salad or cooking', food_category: 'fat_oil' },
  { name: 'Butter', match: 'butter, salted', food_category: 'fat_oil' },
];

/**
 * Open Food Facts inclusion filter for the India subset. We bundle branded SKUs
 * that (a) are sold in India OR are global gym brands, and (b) have a complete
 * macro panel. Everything kept here is tagged source='off' (segregated, ODbL).
 */
export const OFF_FILTER = {
  /** keep products whose countries_tags includes one of these */
  countries: ['en:india'],
  /** ...OR whose brand matches one of these global gym brands regardless of country */
  gymBrands: [
    'optimum nutrition', 'muscleblaze', 'myprotein', 'gnc', 'isopure',
    'avvatar', 'bigmuscles', 'asitis', 'as-it-is', 'the whole truth',
  ],
  /** drop products missing any of these nutriment fields (per 100 g) */
  requireNutriments: ['energy-kcal_100g', 'proteins_100g', 'carbohydrates_100g', 'fat_100g'],
  /** also keep popular Indian FMCG brands for packaged staples */
  fmcgBrands: ['amul', 'britannia', 'mtr', 'haldiram', 'mother dairy', 'nestle', 'kelloggs'],
};
