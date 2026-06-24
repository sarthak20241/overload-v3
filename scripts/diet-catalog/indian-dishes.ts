/**
 * "Compute, don't copy" — Indian cooked dishes authored as ingredient breakdowns,
 * NOT copied from IFCT/INDB (which are copyright-restricted). Macros are computed
 * from a clean raw-ingredient base (RAW_INGREDIENTS below, per 100 g, curated
 * facts). The resulting dish rows are our own work product -> bundle-safe.
 *
 * Reference (human, not ingested): INDB recipe compositions + Kaggle "Indian Food
 * 101" ingredient lists are fine to LOOK AT to decide the breakdown; we do not
 * ingest their numbers. See scripts/diet-catalog/README.md.
 */

import type { FoodCategory, Macros } from './build';

/** Per-100 g macros for raw dish components (curated facts). Extend as needed. */
export const RAW_INGREDIENTS: Record<string, Macros> = {
  // grains / pulses (cooked unless noted)
  rice_cooked: { kcal: 130, protein_g: 2.7, carb_g: 28, fat_g: 0.3 },
  toor_dal_cooked: { kcal: 121, protein_g: 7.2, carb_g: 20, fat_g: 0.4 },
  moong_dal_cooked: { kcal: 105, protein_g: 7, carb_g: 19, fat_g: 0.4 },
  rajma_cooked: { kcal: 127, protein_g: 8.7, carb_g: 22, fat_g: 0.5 },
  wheat_flour: { kcal: 340, protein_g: 13, carb_g: 72, fat_g: 2.5 },
  // protein
  paneer: { kcal: 265, protein_g: 18, carb_g: 1.2, fat_g: 20 },
  chicken_cooked: { kcal: 165, protein_g: 31, carb_g: 0, fat_g: 3.6 },
  // fats
  ghee: { kcal: 900, protein_g: 0, carb_g: 0, fat_g: 100 },
  oil: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 },
  butter: { kcal: 717, protein_g: 0.9, carb_g: 0.1, fat_g: 81 },
  cream: { kcal: 195, protein_g: 2.8, carb_g: 3.4, fat_g: 19 },
  // aromatics / veg (low macro, but real)
  onion: { kcal: 40, protein_g: 1.1, carb_g: 9, fat_g: 0.1 },
  tomato: { kcal: 18, protein_g: 0.9, carb_g: 3.9, fat_g: 0.2 },
  // negligible: spices, salt, water -> omit (rounding noise)
};

export interface DishDef {
  name: string;
  food_category: FoodCategory; // 'prepared_dish'
  /** Component grams that make up ONE serving (a bowl) of the dish. */
  ingredients: { ingredient: keyof typeof RAW_INGREDIENTS; grams: number }[];
}

/**
 * Dish breakdowns per serving. Grams are realistic single-serving estimates
 * (one katori / one bowl / one piece). Tune against references during build.
 */
export const DISHES: DishDef[] = [
  {
    name: 'Dal Tadka', food_category: 'prepared_dish',
    ingredients: [
      { ingredient: 'toor_dal_cooked', grams: 150 },
      { ingredient: 'ghee', grams: 8 },
      { ingredient: 'onion', grams: 20 },
      { ingredient: 'tomato', grams: 20 },
    ],
  },
  {
    name: 'Paneer Butter Masala', food_category: 'prepared_dish',
    ingredients: [
      { ingredient: 'paneer', grams: 80 },
      { ingredient: 'butter', grams: 10 },
      { ingredient: 'cream', grams: 25 },
      { ingredient: 'tomato', grams: 60 },
      { ingredient: 'onion', grams: 30 },
    ],
  },
  {
    name: 'Chicken Biryani', food_category: 'prepared_dish',
    ingredients: [
      { ingredient: 'rice_cooked', grams: 180 },
      { ingredient: 'chicken_cooked', grams: 90 },
      { ingredient: 'oil', grams: 12 },
      { ingredient: 'onion', grams: 30 },
    ],
  },
  {
    name: 'Rajma Chawal', food_category: 'prepared_dish',
    ingredients: [
      { ingredient: 'rajma_cooked', grams: 120 },
      { ingredient: 'rice_cooked', grams: 150 },
      { ingredient: 'oil', grams: 8 },
      { ingredient: 'onion', grams: 25 },
      { ingredient: 'tomato', grams: 25 },
    ],
  },
  // Add: chole, dosa, idli, sambar, paratha, palak paneer, egg curry, ...
];

/** Sum a dish's component macros into its per-serving macros (computed, ours). */
export function computeDish(dish: DishDef): Macros {
  return dish.ingredients.reduce<Macros>(
    (acc, c) => {
      const per100 = RAW_INGREDIENTS[c.ingredient];
      const f = c.grams / 100;
      return {
        kcal: acc.kcal + per100.kcal * f,
        protein_g: acc.protein_g + per100.protein_g * f,
        carb_g: acc.carb_g + per100.carb_g * f,
        fat_g: acc.fat_g + per100.fat_g * f,
      };
    },
    { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
  );
}
