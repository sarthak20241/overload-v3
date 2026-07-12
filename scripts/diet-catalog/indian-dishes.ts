/**
 * "Compute, don't copy" — Indian cooked dishes authored as ingredient breakdowns,
 * NOT copied from IFCT/INDB (which are copyright-restricted). Macros are computed
 * from a clean raw-ingredient base (RAW_INGREDIENTS below, per 100 g, curated
 * facts). The resulting dish rows are our own work product -> bundle-safe.
 *
 * Reference (human, not ingested): INDB recipe compositions + Kaggle "Indian Food
 * 101" ingredient lists are fine to LOOK AT to decide the breakdown; we do not
 * ingest their numbers. See scripts/diet-catalog/README.md.
 *
 * Accuracy note: components are given in their AS-SERVED state — cooked dals/rice/
 * veg (already water-laden), paneer/egg/meat as cooked, oils/ghee as-is. So the
 * per-100 g the build derives (sum of component macros / sum of component grams)
 * reflects the plated dish, not a dry mix. Tempered/fried dishes carry ~±10%
 * estimate error, which is fine for logging (the app flags dishes as estimates).
 */

import type { FoodCategory } from './build';

/** Per-100 g macros for a raw/cooked dish component (curated facts). Fiber included
 *  so computed dishes carry it too (fiber is a must-have nutrient). */
export interface CompMacros { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number }

export const RAW_INGREDIENTS: Record<string, CompMacros> = {
  // grains / starch (cooked unless noted; flours are dry, used in small amounts)
  rice_cooked:       { kcal: 130, protein_g: 2.7, carb_g: 28,  fat_g: 0.3, fiber_g: 0.4 },
  brown_rice_cooked: { kcal: 123, protein_g: 2.7, carb_g: 26,  fat_g: 1,   fiber_g: 1.6 },
  poha_cooked:       { kcal: 130, protein_g: 2.4, carb_g: 27,  fat_g: 1,   fiber_g: 0.8 },
  rava_cooked:       { kcal: 130, protein_g: 2.5, carb_g: 26,  fat_g: 1.5, fiber_g: 1 },
  wheat_flour:       { kcal: 340, protein_g: 13,  carb_g: 72,  fat_g: 2.5, fiber_g: 11 },
  maida:             { kcal: 350, protein_g: 10,  carb_g: 76,  fat_g: 1,   fiber_g: 2.7 }, // refined flour
  besan:             { kcal: 387, protein_g: 22,  carb_g: 58,  fat_g: 7,   fiber_g: 11 },
  // pulses (cooked)
  toor_dal_cooked:   { kcal: 121, protein_g: 7.2, carb_g: 20,  fat_g: 0.4, fiber_g: 3 },
  moong_dal_cooked:  { kcal: 105, protein_g: 7,   carb_g: 19,  fat_g: 0.4, fiber_g: 2 },
  masoor_dal_cooked: { kcal: 116, protein_g: 9,   carb_g: 20,  fat_g: 0.4, fiber_g: 4 },
  urad_dal_cooked:   { kcal: 120, protein_g: 8,   carb_g: 20,  fat_g: 0.5, fiber_g: 4 },
  chana_dal_cooked:  { kcal: 130, protein_g: 8,   carb_g: 22,  fat_g: 1.5, fiber_g: 4 },
  chickpeas_cooked:  { kcal: 164, protein_g: 8.9, carb_g: 27,  fat_g: 2.6, fiber_g: 7.6 },
  rajma_cooked:      { kcal: 127, protein_g: 8.7, carb_g: 22,  fat_g: 0.5, fiber_g: 6 },
  // protein (cooked)
  paneer:            { kcal: 265, protein_g: 18,  carb_g: 1.2, fat_g: 20,  fiber_g: 0 },
  chicken_cooked:    { kcal: 165, protein_g: 31,  carb_g: 0,   fat_g: 3.6, fiber_g: 0 },
  mutton_cooked:     { kcal: 143, protein_g: 27,  carb_g: 0,   fat_g: 3,   fiber_g: 0 },
  egg_boiled:        { kcal: 155, protein_g: 13,  carb_g: 1.1, fat_g: 11,  fiber_g: 0 },
  fish_cooked:       { kcal: 105, protein_g: 22,  carb_g: 0,   fat_g: 2,   fiber_g: 0 },
  soya_chunks_cooked:{ kcal: 100, protein_g: 13,  carb_g: 8,   fat_g: 0.5, fiber_g: 3 },
  // dairy / fats / nuts
  ghee:              { kcal: 900, protein_g: 0,   carb_g: 0,   fat_g: 100, fiber_g: 0 },
  oil:               { kcal: 884, protein_g: 0,   carb_g: 0,   fat_g: 100, fiber_g: 0 },
  butter:            { kcal: 717, protein_g: 0.9, carb_g: 0.1, fat_g: 81,  fiber_g: 0 },
  cream:             { kcal: 195, protein_g: 2.8, carb_g: 3.4, fat_g: 19,  fiber_g: 0 },
  milk:              { kcal: 62,  protein_g: 3.2, carb_g: 4.8, fat_g: 3.4, fiber_g: 0 },
  curd:              { kcal: 60,  protein_g: 3.1, carb_g: 4.7, fat_g: 3.3, fiber_g: 0 },
  coconut:           { kcal: 354, protein_g: 3.3, carb_g: 15,  fat_g: 33,  fiber_g: 9 },
  cashew:            { kcal: 553, protein_g: 18,  carb_g: 30,  fat_g: 44,  fiber_g: 3 },
  peanuts_roasted:   { kcal: 567, protein_g: 26,  carb_g: 16,  fat_g: 49,  fiber_g: 8 },
  // vegetables (cooked/raw as used)
  onion:             { kcal: 40,  protein_g: 1.1, carb_g: 9,   fat_g: 0.1, fiber_g: 1.7 },
  tomato:            { kcal: 18,  protein_g: 0.9, carb_g: 3.9, fat_g: 0.2, fiber_g: 1.2 },
  potato_boiled:     { kcal: 87,  protein_g: 1.9, carb_g: 20,  fat_g: 0.1, fiber_g: 1.8 },
  spinach_cooked:    { kcal: 23,  protein_g: 2.9, carb_g: 3.8, fat_g: 0.4, fiber_g: 2.4 },
  cauliflower:       { kcal: 25,  protein_g: 1.9, carb_g: 5,   fat_g: 0.3, fiber_g: 2 },
  green_peas:        { kcal: 84,  protein_g: 5.4, carb_g: 14,  fat_g: 0.4, fiber_g: 5.5 },
  okra:              { kcal: 33,  protein_g: 1.9, carb_g: 7,   fat_g: 0.2, fiber_g: 3.2 },
  carrot:            { kcal: 41,  protein_g: 0.9, carb_g: 10,  fat_g: 0.2, fiber_g: 2.8 },
  brinjal:           { kcal: 25,  protein_g: 1,   carb_g: 6,   fat_g: 0.2, fiber_g: 3 },
  // sweeteners
  sugar:             { kcal: 387, protein_g: 0,   carb_g: 100, fat_g: 0,   fiber_g: 0 },
  jaggery:           { kcal: 383, protein_g: 0,   carb_g: 98,  fat_g: 0.1, fiber_g: 0 },
  khoya:             { kcal: 420, protein_g: 15,  carb_g: 25,  fat_g: 26,  fiber_g: 0 }, // mawa (reduced milk)
  // extra veg / bases for the regional dishes
  mustard_greens_cooked: { kcal: 27, protein_g: 2.6, carb_g: 4.7, fat_g: 0.5, fiber_g: 3.5 }, // sarson
  puffed_rice:       { kcal: 402, protein_g: 7.5, carb_g: 89,  fat_g: 0.5, fiber_g: 0.5 }, // murmura
  sev:               { kcal: 550, protein_g: 14,  carb_g: 45,  fat_g: 35,  fiber_g: 6 },   // fried besan noodles
  capsicum:          { kcal: 20,  protein_g: 0.9, carb_g: 4.6, fat_g: 0.2, fiber_g: 1.7 },
  // water absorbed by dough/batter and retained after cooking — 0 macros, but it
  // dilutes the per-100 g so dough dishes (parathas) aren't computed as dry flour.
  water:             { kcal: 0,   protein_g: 0,   carb_g: 0,   fat_g: 0,   fiber_g: 0 },
};

export interface DishDef {
  name: string;
  food_category: FoodCategory; // usually 'prepared_dish'
  /** Component grams that make up ONE realistic plated serving. */
  ingredients: { ingredient: keyof typeof RAW_INGREDIENTS; grams: number }[];
  /** Default serving label (grams = sum of ingredient grams). Defaults to "1 serving". */
  serving?: string;
}

/**
 * Dish breakdowns per serving. Grams are realistic single-serving estimates
 * (one katori / one plate / one piece). Names avoid the lib/foods.ts staples
 * (Paneer, Roti, Idli, Dosa, dals, Curd, Milk, Soya Chunks, Whey) to prevent
 * catalog collisions; the seed also DO-NOTHINGs on name conflict.
 */
export const DISHES: DishDef[] = [
  // ── dals & legumes ──
  { name: 'Dal Tadka', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'toor_dal_cooked', grams: 150 }, { ingredient: 'ghee', grams: 8 },
    { ingredient: 'onion', grams: 20 }, { ingredient: 'tomato', grams: 20 } ] },
  { name: 'Dal Makhani', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'urad_dal_cooked', grams: 130 }, { ingredient: 'rajma_cooked', grams: 20 },
    { ingredient: 'butter', grams: 12 }, { ingredient: 'cream', grams: 18 },
    { ingredient: 'tomato', grams: 30 }, { ingredient: 'onion', grams: 15 } ] },
  { name: 'Chana Dal', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'chana_dal_cooked', grams: 150 }, { ingredient: 'ghee', grams: 6 },
    { ingredient: 'onion', grams: 20 }, { ingredient: 'tomato', grams: 20 } ] },
  { name: 'Sambar', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'toor_dal_cooked', grams: 90 }, { ingredient: 'carrot', grams: 20 },
    { ingredient: 'onion', grams: 20 }, { ingredient: 'tomato', grams: 20 }, { ingredient: 'oil', grams: 6 } ] },
  { name: 'Chole (Chana Masala)', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'chickpeas_cooked', grams: 160 }, { ingredient: 'oil', grams: 10 },
    { ingredient: 'onion', grams: 40 }, { ingredient: 'tomato', grams: 40 } ] },
  { name: 'Rajma Masala', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'rajma_cooked', grams: 150 }, { ingredient: 'oil', grams: 10 },
    { ingredient: 'onion', grams: 30 }, { ingredient: 'tomato', grams: 30 } ] },
  { name: 'Kadhi', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'curd', grams: 150 }, { ingredient: 'besan', grams: 20 },
    { ingredient: 'oil', grams: 8 }, { ingredient: 'onion', grams: 10 } ] },
  { name: 'Soya Chunk Curry', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'soya_chunks_cooked', grams: 120 }, { ingredient: 'oil', grams: 10 },
    { ingredient: 'onion', grams: 30 }, { ingredient: 'tomato', grams: 30 } ] },

  // ── paneer & veg gravies ──
  { name: 'Paneer Butter Masala', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'paneer', grams: 80 }, { ingredient: 'butter', grams: 10 },
    { ingredient: 'cream', grams: 25 }, { ingredient: 'tomato', grams: 60 }, { ingredient: 'onion', grams: 30 } ] },
  { name: 'Palak Paneer', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'paneer', grams: 60 }, { ingredient: 'spinach_cooked', grams: 120 },
    { ingredient: 'cream', grams: 15 }, { ingredient: 'oil', grams: 8 },
    { ingredient: 'onion', grams: 20 }, { ingredient: 'tomato', grams: 20 } ] },
  { name: 'Matar Paneer', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'paneer', grams: 60 }, { ingredient: 'green_peas', grams: 50 },
    { ingredient: 'oil', grams: 10 }, { ingredient: 'onion', grams: 25 }, { ingredient: 'tomato', grams: 40 } ] },
  { name: 'Aloo Gobi', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'potato_boiled', grams: 100 }, { ingredient: 'cauliflower', grams: 80 },
    { ingredient: 'oil', grams: 12 }, { ingredient: 'onion', grams: 20 }, { ingredient: 'tomato', grams: 20 } ] },
  { name: 'Bhindi Masala', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'okra', grams: 150 }, { ingredient: 'oil', grams: 15 },
    { ingredient: 'onion', grams: 20 }, { ingredient: 'tomato', grams: 20 } ] },
  { name: 'Baingan Bharta', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'brinjal', grams: 150 }, { ingredient: 'oil', grams: 12 },
    { ingredient: 'onion', grams: 30 }, { ingredient: 'tomato', grams: 30 } ] },
  { name: 'Aloo Matar', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'potato_boiled', grams: 100 }, { ingredient: 'green_peas', grams: 60 },
    { ingredient: 'oil', grams: 10 }, { ingredient: 'onion', grams: 20 }, { ingredient: 'tomato', grams: 25 } ] },
  { name: 'Mixed Veg Curry', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'potato_boiled', grams: 50 }, { ingredient: 'cauliflower', grams: 40 },
    { ingredient: 'green_peas', grams: 30 }, { ingredient: 'carrot', grams: 30 },
    { ingredient: 'oil', grams: 10 }, { ingredient: 'onion', grams: 20 }, { ingredient: 'tomato', grams: 25 } ] },

  // ── non-veg gravies ──
  { name: 'Chicken Curry', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'chicken_cooked', grams: 120 }, { ingredient: 'oil', grams: 12 },
    { ingredient: 'onion', grams: 40 }, { ingredient: 'tomato', grams: 40 } ] },
  { name: 'Mutton Curry', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'mutton_cooked', grams: 120 }, { ingredient: 'oil', grams: 15 },
    { ingredient: 'onion', grams: 40 }, { ingredient: 'tomato', grams: 30 } ] },
  { name: 'Egg Curry', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'egg_boiled', grams: 100 }, { ingredient: 'oil', grams: 10 },
    { ingredient: 'onion', grams: 40 }, { ingredient: 'tomato', grams: 40 } ] },
  { name: 'Fish Curry', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'fish_cooked', grams: 120 }, { ingredient: 'oil', grams: 10 },
    { ingredient: 'onion', grams: 30 }, { ingredient: 'tomato', grams: 30 }, { ingredient: 'coconut', grams: 15 } ] },

  // ── rice plates ──
  { name: 'Chicken Biryani', food_category: 'prepared_dish', serving: '1 plate', ingredients: [
    { ingredient: 'rice_cooked', grams: 180 }, { ingredient: 'chicken_cooked', grams: 90 },
    { ingredient: 'oil', grams: 12 }, { ingredient: 'onion', grams: 30 } ] },
  { name: 'Veg Pulao', food_category: 'prepared_dish', serving: '1 plate', ingredients: [
    { ingredient: 'rice_cooked', grams: 180 }, { ingredient: 'carrot', grams: 20 },
    { ingredient: 'green_peas', grams: 20 }, { ingredient: 'oil', grams: 10 }, { ingredient: 'onion', grams: 20 } ] },
  { name: 'Jeera Rice', food_category: 'prepared_dish', serving: '1 plate', ingredients: [
    { ingredient: 'rice_cooked', grams: 180 }, { ingredient: 'ghee', grams: 10 } ] },
  { name: 'Curd Rice', food_category: 'prepared_dish', serving: '1 plate', ingredients: [
    { ingredient: 'rice_cooked', grams: 150 }, { ingredient: 'curd', grams: 120 }, { ingredient: 'oil', grams: 5 } ] },
  { name: 'Rajma Chawal', food_category: 'prepared_dish', serving: '1 plate', ingredients: [
    { ingredient: 'rajma_cooked', grams: 120 }, { ingredient: 'rice_cooked', grams: 150 },
    { ingredient: 'oil', grams: 8 }, { ingredient: 'onion', grams: 25 }, { ingredient: 'tomato', grams: 25 } ] },

  // ── tiffin / breakfast ──
  { name: 'Poha', food_category: 'prepared_dish', serving: '1 plate', ingredients: [
    { ingredient: 'poha_cooked', grams: 200 }, { ingredient: 'oil', grams: 8 },
    { ingredient: 'onion', grams: 25 }, { ingredient: 'peanuts_roasted', grams: 10 }, { ingredient: 'green_peas', grams: 15 } ] },
  { name: 'Upma', food_category: 'prepared_dish', serving: '1 plate', ingredients: [
    { ingredient: 'rava_cooked', grams: 200 }, { ingredient: 'oil', grams: 10 },
    { ingredient: 'onion', grams: 25 }, { ingredient: 'peanuts_roasted', grams: 8 } ] },
  { name: 'Aloo Paratha', food_category: 'prepared_dish', serving: '1 paratha', ingredients: [
    { ingredient: 'wheat_flour', grams: 60 }, { ingredient: 'water', grams: 20 },
    { ingredient: 'potato_boiled', grams: 60 }, { ingredient: 'oil', grams: 10 } ] },
  { name: 'Plain Paratha', food_category: 'prepared_dish', serving: '1 paratha', ingredients: [
    { ingredient: 'wheat_flour', grams: 60 }, { ingredient: 'water', grams: 28 }, { ingredient: 'oil', grams: 10 } ] },

  // ── South Indian ──
  { name: 'Masala Dosa', food_category: 'prepared_dish', serving: '1 dosa', ingredients: [
    { ingredient: 'rice_cooked', grams: 90 }, { ingredient: 'urad_dal_cooked', grams: 20 },
    { ingredient: 'potato_boiled', grams: 100 }, { ingredient: 'oil', grams: 12 }, { ingredient: 'onion', grams: 25 } ] },
  { name: 'Medu Vada', food_category: 'prepared_dish', serving: '2 vada', ingredients: [
    { ingredient: 'urad_dal_cooked', grams: 100 }, { ingredient: 'oil', grams: 15 } ] },
  { name: 'Uttapam', food_category: 'prepared_dish', serving: '1 uttapam', ingredients: [
    { ingredient: 'rice_cooked', grams: 90 }, { ingredient: 'urad_dal_cooked', grams: 20 },
    { ingredient: 'onion', grams: 30 }, { ingredient: 'tomato', grams: 20 }, { ingredient: 'oil', grams: 8 } ] },
  { name: 'Pongal', food_category: 'prepared_dish', serving: '1 bowl', ingredients: [
    { ingredient: 'rice_cooked', grams: 150 }, { ingredient: 'moong_dal_cooked', grams: 60 }, { ingredient: 'ghee', grams: 12 } ] },
  { name: 'Lemon Rice', food_category: 'prepared_dish', serving: '1 plate', ingredients: [
    { ingredient: 'rice_cooked', grams: 180 }, { ingredient: 'oil', grams: 10 }, { ingredient: 'peanuts_roasted', grams: 10 } ] },
  { name: 'Rasam', food_category: 'prepared_dish', serving: '1 bowl', ingredients: [
    { ingredient: 'toor_dal_cooked', grams: 40 }, { ingredient: 'tomato', grams: 50 }, { ingredient: 'oil', grams: 5 } ] },
  { name: 'Bisi Bele Bath', food_category: 'prepared_dish', serving: '1 bowl', ingredients: [
    { ingredient: 'rice_cooked', grams: 120 }, { ingredient: 'toor_dal_cooked', grams: 80 },
    { ingredient: 'carrot', grams: 20 }, { ingredient: 'green_peas', grams: 20 }, { ingredient: 'ghee', grams: 10 } ] },

  // ── Gujarati ──
  { name: 'Dhokla', food_category: 'snack', serving: '1 plate', ingredients: [
    { ingredient: 'besan', grams: 70 }, { ingredient: 'curd', grams: 40 }, { ingredient: 'water', grams: 60 }, { ingredient: 'oil', grams: 6 } ] },
  { name: 'Thepla', food_category: 'prepared_dish', serving: '2 thepla', ingredients: [
    { ingredient: 'wheat_flour', grams: 60 }, { ingredient: 'besan', grams: 15 }, { ingredient: 'curd', grams: 20 },
    { ingredient: 'water', grams: 15 }, { ingredient: 'oil', grams: 10 } ] },
  { name: 'Undhiyu', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'potato_boiled', grams: 60 }, { ingredient: 'green_peas', grams: 40 }, { ingredient: 'brinjal', grams: 40 },
    { ingredient: 'besan', grams: 20 }, { ingredient: 'oil', grams: 15 }, { ingredient: 'coconut', grams: 15 } ] },

  // ── Punjabi / North ──
  { name: 'Butter Chicken', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'chicken_cooked', grams: 120 }, { ingredient: 'butter', grams: 12 }, { ingredient: 'cream', grams: 25 },
    { ingredient: 'tomato', grams: 50 }, { ingredient: 'cashew', grams: 10 } ] },
  { name: 'Tandoori Chicken', food_category: 'protein', serving: '2 pieces', ingredients: [
    { ingredient: 'chicken_cooked', grams: 130 }, { ingredient: 'curd', grams: 20 }, { ingredient: 'oil', grams: 8 } ] },
  { name: 'Kadai Paneer', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'paneer', grams: 80 }, { ingredient: 'capsicum', grams: 30 }, { ingredient: 'oil', grams: 12 },
    { ingredient: 'onion', grams: 30 }, { ingredient: 'tomato', grams: 40 } ] },
  { name: 'Shahi Paneer', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'paneer', grams: 80 }, { ingredient: 'cream', grams: 25 }, { ingredient: 'cashew', grams: 12 },
    { ingredient: 'tomato', grams: 40 }, { ingredient: 'butter', grams: 8 } ] },
  { name: 'Malai Kofta', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'paneer', grams: 60 }, { ingredient: 'potato_boiled', grams: 40 }, { ingredient: 'cream', grams: 25 },
    { ingredient: 'cashew', grams: 12 }, { ingredient: 'oil', grams: 10 }, { ingredient: 'tomato', grams: 30 } ] },
  { name: 'Sarson Ka Saag', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'mustard_greens_cooked', grams: 150 }, { ingredient: 'spinach_cooked', grams: 40 }, { ingredient: 'butter', grams: 10 } ] },
  { name: 'Egg Bhurji', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'egg_boiled', grams: 120 }, { ingredient: 'oil', grams: 10 }, { ingredient: 'onion', grams: 30 }, { ingredient: 'tomato', grams: 30 } ] },
  { name: 'Chicken Keema', food_category: 'prepared_dish', serving: '1 katori', ingredients: [
    { ingredient: 'chicken_cooked', grams: 120 }, { ingredient: 'green_peas', grams: 30 }, { ingredient: 'oil', grams: 12 },
    { ingredient: 'onion', grams: 30 }, { ingredient: 'tomato', grams: 30 } ] },

  // ── street food ──
  { name: 'Pav Bhaji', food_category: 'prepared_dish', serving: '1 plate', ingredients: [
    { ingredient: 'potato_boiled', grams: 100 }, { ingredient: 'green_peas', grams: 30 }, { ingredient: 'cauliflower', grams: 30 },
    { ingredient: 'tomato', grams: 40 }, { ingredient: 'onion', grams: 20 }, { ingredient: 'butter', grams: 15 } ] },
  { name: 'Vada Pav', food_category: 'prepared_dish', serving: '1 piece', ingredients: [
    { ingredient: 'wheat_flour', grams: 55 }, { ingredient: 'water', grams: 25 }, { ingredient: 'potato_boiled', grams: 80 },
    { ingredient: 'besan', grams: 20 }, { ingredient: 'oil', grams: 15 } ] },
  { name: 'Samosa', food_category: 'snack', serving: '1 piece', ingredients: [
    { ingredient: 'wheat_flour', grams: 50 }, { ingredient: 'water', grams: 20 }, { ingredient: 'potato_boiled', grams: 70 },
    { ingredient: 'green_peas', grams: 20 }, { ingredient: 'oil', grams: 20 } ] },
  { name: 'Aloo Tikki', food_category: 'snack', serving: '2 pieces', ingredients: [
    { ingredient: 'potato_boiled', grams: 120 }, { ingredient: 'besan', grams: 15 }, { ingredient: 'oil', grams: 12 } ] },
  { name: 'Bhel Puri', food_category: 'snack', serving: '1 plate', ingredients: [
    { ingredient: 'puffed_rice', grams: 60 }, { ingredient: 'sev', grams: 20 }, { ingredient: 'potato_boiled', grams: 30 },
    { ingredient: 'onion', grams: 20 }, { ingredient: 'tomato', grams: 15 } ] },
  { name: 'Dahi Vada', food_category: 'snack', serving: '2 pieces', ingredients: [
    { ingredient: 'urad_dal_cooked', grams: 80 }, { ingredient: 'curd', grams: 100 }, { ingredient: 'oil', grams: 10 } ] },

  // ── sweet ──
  { name: 'Kheer', food_category: 'sweet', serving: '1 katori', ingredients: [
    { ingredient: 'milk', grams: 200 }, { ingredient: 'rice_cooked', grams: 30 },
    { ingredient: 'sugar', grams: 25 }, { ingredient: 'cashew', grams: 5 } ] },
  { name: 'Gulab Jamun', food_category: 'sweet', serving: '2 pieces', ingredients: [
    { ingredient: 'khoya', grams: 60 }, { ingredient: 'maida', grams: 15 }, { ingredient: 'sugar', grams: 40 }, { ingredient: 'ghee', grams: 15 } ] },
  { name: 'Jalebi', food_category: 'sweet', serving: '3 pieces', ingredients: [
    { ingredient: 'maida', grams: 50 }, { ingredient: 'sugar', grams: 45 }, { ingredient: 'oil', grams: 15 }, { ingredient: 'water', grams: 20 } ] },
  { name: 'Gajar Halwa', food_category: 'sweet', serving: '1 katori', ingredients: [
    { ingredient: 'carrot', grams: 120 }, { ingredient: 'milk', grams: 60 }, { ingredient: 'khoya', grams: 20 },
    { ingredient: 'sugar', grams: 30 }, { ingredient: 'ghee', grams: 12 } ] },
  { name: 'Besan Ladoo', food_category: 'sweet', serving: '2 pieces', ingredients: [
    { ingredient: 'besan', grams: 60 }, { ingredient: 'sugar', grams: 40 }, { ingredient: 'ghee', grams: 30 } ] },
  { name: 'Rasgulla', food_category: 'sweet', serving: '2 pieces', ingredients: [
    { ingredient: 'paneer', grams: 60 }, { ingredient: 'sugar', grams: 40 }, { ingredient: 'water', grams: 40 } ] },
  { name: 'Mishti Doi', food_category: 'sweet', serving: '1 katori', ingredients: [
    { ingredient: 'curd', grams: 150 }, { ingredient: 'jaggery', grams: 30 } ] },
];

/** Sum a dish's component macros (computed, ours). */
export function computeDish(dish: DishDef): CompMacros {
  return dish.ingredients.reduce<CompMacros>(
    (acc, c) => {
      const per100 = RAW_INGREDIENTS[c.ingredient];
      const f = c.grams / 100;
      return {
        kcal: acc.kcal + per100.kcal * f,
        protein_g: acc.protein_g + per100.protein_g * f,
        carb_g: acc.carb_g + per100.carb_g * f,
        fat_g: acc.fat_g + per100.fat_g * f,
        fiber_g: acc.fiber_g + per100.fiber_g * f,
      };
    },
    { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: 0 },
  );
}
