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
  /** popular Indian FMCG/packaged brands — SCOPED to countries:en:india (else global
   *  megabrands like Nestlé pull 10k non-India SKUs). Includes both `haldiram` and
   *  `haldiram's` (OFF stores them as separate brand tags). */
  fmcgBrands: [
    'amul', 'britannia', 'mtr', 'haldiram', "haldiram's", 'mother dairy', 'nestle', 'kelloggs',
    'parle', 'itc', 'sunfeast', 'bingo', 'patanjali', 'dabur', 'cadbury', 'mondelez', 'maggi',
    'bikaji', 'lays', 'kurkure', 'saffola', 'fortune', 'aashirvaad', 'tata', 'tropicana', 'real',
    'paper boat', 'bisleri', 'mdh', 'everest', 'too yumm', "kwality wall's", 'gowardhan', 'epigamia',
  ],
  /** restaurant / QSR chains — kept GLOBAL (OFF has ~0 India-tagged chain items; its
   *  chain data is US/EU menus). English-filtered like gym brands. NOTE: India-specific
   *  menu items (McAloo Tikki, McSpicy Paneer) are NOT in OFF; those need a curated
   *  source (official chain nutrition) if we want them. */
  restaurantBrands: [
    "mcdonald's", 'kfc', 'burger king', 'subway', 'starbucks', 'dunkin', 'taco bell',
    'pizza hut', "domino's", 'wow momo',
  ],
};

/**
 * Supplement / health-brand sweep for the BULK Open Food Facts export
 * (scripts/diet-catalog/ingest-off-supplements.ts). When OFF's search API is down
 * we stream the full `openfoodfacts-products.jsonl.gz` dump and keep any product
 * that matches EITHER a supplement CATEGORY tag (captures every brand at once) OR a
 * known supplement/health BRAND tag (rescues rows the community mis-categorised).
 * Same ODbL segregation as OFF_FILTER: kept rows are source='off'.
 *
 * Category-first is deliberate: "all health and supplement brands" is really "all
 * products in the supplement categories" — the brand list only widens the net and
 * lets us region-tag India D2C brands. Pure 0-calorie supplements (plain creatine,
 * most vitamins/minerals) are dropped downstream by the complete-macro + kcal>0
 * plausibility guard — they carry no macros worth logging in a diet diary.
 */
export const SUPPLEMENT_FILTER = {
  /** categories_tags — any match includes the product (OFF stores these lang-prefixed) */
  categoryTags: [
    'en:dietary-supplements', 'en:food-supplements', 'en:sports-nutrition',
    'en:bodybuilding-supplements', 'en:protein-powders', 'en:whey-proteins',
    'en:whey-protein', 'en:plant-proteins', 'en:pea-proteins', 'en:soy-proteins',
    'en:caseins', 'en:protein-shakes', 'en:protein-drinks', 'en:mass-gainers',
    'en:gainers', 'en:weight-gainers', 'en:meal-replacement', 'en:meal-replacements',
    'en:protein-bars', 'en:high-protein-bars', 'en:sports-bars', 'en:energy-bars',
    'en:creatine', 'en:bcaa', 'en:amino-acids', 'en:pre-workout',
    'en:workout-supplements', 'en:electrolytes', 'en:multivitamins', 'en:vitamins',
  ],
  /** brands_tags — normalized (lowercase, spaces/apostrophes -> '-'); matched against
   *  the product's brands_tags. Global + Indian supplement & health-nutrition brands. */
  brands: [
    // --- global sports-nutrition / protein ---
    'optimum nutrition', 'myprotein', 'dymatize', 'muscletech', 'bsn', 'cellucor',
    'gaspari nutrition', 'universal nutrition', 'ronnie coleman', 'rule one proteins',
    'rule 1', 'scitec nutrition', 'gnc', 'isopure', 'ultimate nutrition', 'labrada',
    'bpi sports', 'quest nutrition', 'ghost', 'transparent labs', 'jym', 'redcon1',
    'mutant', 'allmax nutrition', 'applied nutrition', 'grenade', 'phd nutrition',
    'sci-mx', 'usn', 'bulk', 'bulk powders', 'foodspring', 'esn', 'prozis',
    'biotechusa', 'weider', 'scivation', 'xtend', 'evlution nutrition', 'evl',
    'kaged', 'nutrex research', 'pescience', 'six star', 'body fortress',
    'premier protein', 'muscle milk', 'cytosport', 'fairlife', 'orgain', 'vega',
    'sunwarrior', 'huel', 'soylent', "ka'chava", 'now sports', 'now foods',
    // --- global health / vitamins / wellness ---
    'garden of life', "nature's bounty", 'centrum', 'nature made', 'solgar',
    'herbalife', 'amway', 'nutrilite', 'gnc live well',
    // --- india sports-nutrition / protein ---
    'muscleblaze', 'avvatar', 'bigmuscles nutrition', 'bigmuscles', 'as-it-is',
    'asitis', 'as-it-is nutrition', 'atom', 'the whole truth', 'nakpro', 'healthkart',
    'hk vitals', 'musclexp', 'myfitfuel', 'proburst', 'ripped up nutrition',
    'nutrify', 'wellcore', 'beast life', 'truebasics', 'true basics', 'sinew nutrition',
    'steadfast nutrition', 'absolute nutrition', 'endura mass', 'nutrabay',
    // --- india health / wellness / nutrition drinks ---
    'fast&up', 'fast and up', 'wellbeing nutrition', 'oziva', 'kapiva', 'plix',
    'carbamide forte', 'inlife', 'boldfit', 'gritzo', 'unived', 'protinex', 'ensure',
    'horlicks', 'bournvita', 'complan', 'pediasure', 'yfit',
  ],
};
