// Eval set for the parse_meal pipeline. This is the quality gate from the
// AI-food-logging plan (P0): ~30 real Indian meal phrases plus ~10 branded /
// no-match / decline cases that exercise tiers 2-4 of the fallback ladder.
//
// Assertions are deliberately loose where model variance is legitimate
// (which curated row it picks, exact grams for "1 plate") and tight where
// the math must be right (explicit amounts like "50g" or "500 ml").

export type Tier = "catalog" | "off" | "web" | "estimate";

export interface ItemExpectation {
  // Case-insensitive substring that must appear in some logged item's name.
  nameIncludes: string;
  // Alternate acceptable substrings (same food under another name, e.g.
  // "edamame" vs "soybeans"). Any one match satisfies the expectation.
  nameIncludesAny?: string[];
  // Acceptable resolution tiers for that item. Omit = any.
  tiers?: Tier[];
  // Inclusive bounds on the item's total grams. Omit = not checked.
  gramsBetween?: [number, number];
  // Inclusive bounds on the item's total protein. Omit = not checked.
  proteinBetween?: [number, number];
}

export interface EvalCase {
  id: string;
  text: string;
  hour?: number; // device-local hour passed to the parser
  expect: {
    declined?: boolean;
    minItems?: number;
    maxItems?: number;
    mealType?: "breakfast" | "lunch" | "dinner" | "snack";
    items?: ItemExpectation[];
    // Set when the case only makes sense with tier 3 enabled.
    needsWebSearch?: boolean;
  };
}

export const CASES: EvalCase[] = [
  // ── Core Indian meals (tier 1 should dominate) ──────────────────────────
  {
    id: "roti-dal",
    text: "2 roti and dal",
    hour: 13,
    expect: {
      minItems: 2, maxItems: 2, mealType: "lunch",
      items: [
        // The catalog's roti serving is ~68 g (bigger than the 40 g street
        // estimate); accept either basis for 2 rotis.
        { nameIncludes: "roti", gramsBetween: [60, 145] },
        { nameIncludes: "dal" },
      ],
    },
  },
  {
    id: "oats-toned-milk",
    text: "50g oats with 300ml toned milk",
    hour: 8,
    expect: {
      minItems: 2, maxItems: 2, mealType: "breakfast",
      items: [
        { nameIncludes: "oats", gramsBetween: [50, 50] },
        { nameIncludes: "milk", gramsBetween: [300, 300] },
      ],
    },
  },
  {
    id: "whey-scoop",
    text: "1 scoop whey in water",
    hour: 18,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "whey", gramsBetween: [25, 40], proteinBetween: [18, 32] }],
    },
  },
  {
    id: "half-katori-rice",
    text: "half katori rice",
    hour: 14,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "rice", gramsBetween: [50, 100] }],
    },
  },
  {
    id: "idli-sambar",
    text: "2 idli with sambar",
    hour: 9,
    expect: {
      minItems: 2, maxItems: 2, mealType: "breakfast",
      items: [{ nameIncludes: "idli" }, { nameIncludes: "sambar" }],
    },
  },
  {
    id: "dosa-named-meal",
    text: "masala dosa for breakfast",
    hour: 15, // hour says lunch; the text names breakfast and must win
    expect: {
      minItems: 1, mealType: "breakfast",
      items: [{ nameIncludes: "dosa" }],
    },
  },
  {
    id: "paneer-roti",
    text: "paneer bhurji 100g and 2 roti",
    hour: 21,
    expect: {
      minItems: 2, maxItems: 2, mealType: "dinner",
      items: [
        { nameIncludes: "paneer", gramsBetween: [100, 100] },
        { nameIncludes: "roti", gramsBetween: [60, 145] },
      ],
    },
  },
  {
    id: "milk-glass-late",
    text: "1 glass milk",
    hour: 23,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "milk", gramsBetween: [200, 300] }],
    },
  },
  {
    id: "boiled-eggs",
    text: "3 boiled eggs",
    hour: 8,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "egg", gramsBetween: [120, 180], proteinBetween: [15, 24] }],
    },
  },
  {
    id: "chicken-200g",
    text: "chicken breast 200g",
    hour: 13,
    // grams must be exact; protein band is loose ON PURPOSE. The USDA subset
    // has no clean cooked-chicken-breast row (top hits are deli/roasted
    // luncheon variants at ~15-22 g/100g), so we assert "picked a chicken row
    // with the right weight" rather than a specific macro. Adding a curated
    // "Chicken Breast (cooked)" row is a P-data follow-up (see plan).
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "chicken", gramsBetween: [200, 200], proteinBetween: [25, 70] }],
    },
  },
  {
    id: "curd-katori",
    text: "curd 1 katori",
    hour: 13,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "curd", gramsBetween: [100, 200] }],
    },
  },
  {
    id: "soya-chunks",
    text: "100g soya chunks",
    hour: 19,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "soya", gramsBetween: [100, 100], proteinBetween: [30, 60] }],
    },
  },
  {
    id: "shake-two-items",
    text: "protein shake with 500ml milk and 1 scoop whey",
    hour: 17,
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "milk", gramsBetween: [500, 500] },
        { nameIncludes: "whey", gramsBetween: [25, 40] },
      ],
    },
  },
  {
    id: "banana-pb",
    text: "1 banana and 2 tbsp peanut butter",
    hour: 11,
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "banana", gramsBetween: [80, 150] },
        { nameIncludes: "peanut", gramsBetween: [20, 40] },
      ],
    },
  },
  {
    id: "poha-plate",
    text: "poha 1 plate",
    hour: 9,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "poha" }] },
  },
  {
    id: "aloo-paratha-butter",
    text: "2 aloo paratha with butter",
    hour: 9,
    expect: {
      minItems: 2, maxItems: 2,
      items: [{ nameIncludes: "paratha" }, { nameIncludes: "butter" }],
    },
  },
  {
    id: "dal-makhani-jeera-rice",
    text: "dal makhani half katori and jeera rice 1 katori",
    hour: 21,
    expect: {
      minItems: 2, maxItems: 2,
      items: [{ nameIncludes: "dal" }, { nameIncludes: "rice" }],
    },
  },
  {
    id: "almonds-count",
    text: "5 almonds",
    hour: 16,
    expect: {
      minItems: 1, maxItems: 1, mealType: "snack",
      items: [{ nameIncludes: "almond", gramsBetween: [4, 10] }],
    },
  },
  {
    id: "samosa-canteen",
    text: "2 samosas from the office canteen",
    hour: 17,
    expect: {
      minItems: 1, maxItems: 1, mealType: "snack",
      items: [{ nameIncludes: "samosa" }],
    },
  },
  {
    id: "rajma-chawal",
    text: "rajma chawal 1 plate",
    hour: 13,
    expect: { minItems: 1, maxItems: 2 },
  },
  {
    id: "upma-bowl",
    text: "upma 1 bowl",
    hour: 8,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "upma" }] },
  },
  {
    id: "chole-bhature",
    text: "chole with 2 bhature",
    hour: 13,
    expect: { minItems: 2, maxItems: 2 },
  },
  {
    id: "fish-curry-rice",
    text: "fish curry with rice",
    hour: 13,
    expect: {
      // One composite catalog row ("Fish curry with rice") or two separate
      // items are both correct resolutions; both name checks must land.
      minItems: 1, maxItems: 2,
      items: [{ nameIncludes: "fish" }, { nameIncludes: "rice" }],
    },
  },
  {
    id: "veg-salad-olive-oil",
    text: "1 bowl mixed veg salad with olive oil",
    hour: 20,
    expect: { minItems: 1, maxItems: 2 },
  },
  {
    id: "moong-chilla",
    text: "2 moong dal chilla",
    hour: 9,
    expect: { minItems: 1, maxItems: 1 },
  },
  {
    id: "green-tea",
    text: "green tea",
    hour: 16,
    expect: { minItems: 1, maxItems: 1 },
  },
  {
    id: "grilled-sandwich",
    text: "grilled chicken sandwich",
    hour: 12,
    expect: { minItems: 1, maxItems: 1 },
  },
  {
    id: "toast-amul-butter",
    text: "amul butter on 2 toast",
    hour: 8,
    expect: { minItems: 2, maxItems: 2 },
  },
  {
    id: "sprouts-chaat",
    text: "sprouts chaat 1 bowl",
    hour: 17,
    expect: { minItems: 1, maxItems: 1 },
  },
  {
    id: "ghee-rice-rajma",
    text: "1 spoon ghee on rice with rajma",
    hour: 13,
    expect: { minItems: 2, maxItems: 3 },
  },

  // ── Branded / packaged (tiers 2-3 exercisers) ───────────────────────────
  {
    id: "yogabar-50g",
    text: "yogabar multigrain bar 50g",
    hour: 11,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "yoga", gramsBetween: [50, 50], tiers: ["catalog", "off", "web", "estimate"] }],
    },
  },
  {
    id: "maggi-packet",
    text: "maggi 1 packet",
    hour: 17,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "maggi", gramsBetween: [55, 100] }],
    },
  },
  {
    id: "marie-gold",
    text: "britannia marie gold 4 biscuits",
    hour: 16,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "marie" }] },
  },
  {
    id: "amul-kool",
    text: "1 bottle amul kool 200ml",
    hour: 15,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "kool", gramsBetween: [200, 200] }] },
  },
  {
    id: "epigamia-yogurt",
    text: "epigamia greek yogurt strawberry",
    hour: 16,
    expect: { minItems: 1, maxItems: 1 },
  },
  {
    id: "haldiram-bhujia",
    text: "haldiram bhujia 30g",
    hour: 18,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "bhujia", gramsBetween: [30, 30] }] },
  },
  {
    id: "myprotein-whey",
    text: "myprotein impact whey 1 scoop chocolate",
    hour: 18,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "whey", gramsBetween: [20, 35] }] },
  },
  {
    id: "mcaloo-tikki",
    text: "1 mcaloo tikki burger from mcdonalds",
    hour: 20,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "tikki", tiers: ["off", "web", "estimate"] }],
      needsWebSearch: false,
    },
  },

  // ── Non-food: must decline, never log ───────────────────────────────────
  {
    id: "decline-question",
    text: "how much protein should i eat daily",
    hour: 12,
    expect: { declined: true },
  },
  {
    id: "decline-exercise",
    text: "did 20 pushups and a 5k run",
    hour: 7,
    expect: { declined: true },
  },
  {
    id: "decline-chatter",
    text: "feeling tired today man",
    hour: 22,
    expect: { declined: true },
  },

  // ── Household-unit conversion (spoons/cups are food-dependent) ──────────
  // Regression suite for the 2026-07-16 prod miscount: "2 tblspn roasted
  // edameme" logged as 30 g / 130 kcal (one full label serving) when 2 tbsp
  // of dry-roasted edamame is ~12-16 g / ~60-70 kcal. Spoon weights must
  // reflect the food's density, not water's, and roasted must never resolve
  // to a cooked/boiled row.
  {
    id: "edamame-tbsp-regression",
    text: "2 tblspn roasted edameme", // typo preserved from the real log
    hour: 9,
    expect: {
      // meal_type deliberately unasserted: a lone spoonful at 9am reads as
      // breakfast or snack depending on the model's mood; this case is about
      // grams and macros, not meal buckets.
      minItems: 1, maxItems: 1,
      items: [{
        nameIncludes: "edamame",
        nameIncludesAny: ["soybean", "soya bean"],
        gramsBetween: [10, 22],
        proteinBetween: [3, 10],
      }],
    },
  },
  {
    id: "peanut-butter-tbsp",
    text: "2 tbsp peanut butter",
    hour: 8,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "peanut butter", gramsBetween: [24, 44], proteinBetween: [5, 12] }],
    },
  },
  {
    id: "ghee-tsp",
    text: "1 tsp ghee on my roti",
    hour: 13,
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "ghee", gramsBetween: [3, 7] },
        { nameIncludes: "roti", gramsBetween: [30, 75] },
      ],
    },
  },
  {
    id: "chia-tbsp",
    text: "1 tbsp chia seeds in curd",
    hour: 9,
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "chia", gramsBetween: [8, 16] },
        { nameIncludes: "curd", nameIncludesAny: ["dahi", "yogurt"] },
      ],
    },
  },
  {
    id: "cup-cooked-rice",
    text: "1 cup cooked rice",
    hour: 14,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "rice", gramsBetween: [140, 210] }],
    },
  },
  {
    id: "roasted-chana-spoons",
    text: "2 spoons roasted chana",
    hour: 17,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "chana", nameIncludesAny: ["chickpea"], gramsBetween: [10, 30] }],
    },
  },
  {
    id: "honey-tbsp",
    text: "1 tbsp honey in warm water",
    hour: 7,
    expect: {
      minItems: 1,
      items: [{ nameIncludes: "honey", gramsBetween: [14, 25] }],
    },
  },
];
