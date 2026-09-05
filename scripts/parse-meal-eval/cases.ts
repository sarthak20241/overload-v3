// Eval set for the parse_meal pipeline. This is the quality gate from the
// AI-food-logging plan (P0): ~30 real Indian meal phrases plus ~10 branded /
// no-match / decline cases that exercise tiers 2-4 of the fallback ladder.
//
// Assertions are deliberately loose where model variance is legitimate
// (which curated row it picks, exact grams for "1 plate") and tight where
// the math must be right (explicit amounts like "50g" or "500 ml").

export type Tier = "catalog" | "off" | "fatsecret" | "web" | "estimate" | "manual";

export interface ItemExpectation {
  // Case-insensitive substring that must appear in some logged item's name.
  nameIncludes: string;
  // Alternate acceptable substrings (same food under another name, e.g.
  // "edamame" vs "soybeans"). Any one match satisfies the expectation.
  nameIncludesAny?: string[];
  // Substrings that must NOT appear in the matched item's name. Numeric
  // bounds alone cannot catch a wrong preparation state: a cooked-soybean row
  // can land inside a roasted-edamame gram range while being the wrong food.
  nameExcludes?: string[];
  // Acceptable resolution tiers for that item. Omit = any.
  tiers?: Tier[];
  // Inclusive bounds on the item's total grams. Omit = not checked.
  gramsBetween?: [number, number];
  // Inclusive bounds on the item's total protein. Omit = not checked.
  proteinBetween?: [number, number];
  // Inclusive bounds on the item's total kcal. Omit = not checked.
  kcalBetween?: [number, number];
  // The diary section THIS item must land in (plan I8, full-day logging).
  // The meal-level `mealType` above cannot catch a multi-meal message that
  // collapsed into one section; this can. Omit = not checked.
  meal?: "breakfast" | "lunch" | "dinner" | "snack";
}

export interface EvalCase {
  id: string;
  text: string;
  hour?: number; // device-local hour passed to the parser
  /** A follow-up typed while `text`'s result is still on screen. The harness
   *  parses `text` first (unscored), feeds its items back as previousItems,
   *  then scores the follow-up — the same shape the app sends. */
  followUp?: string;
  /** Assert how the follow-up was classified: true = corrects the pending
   *  meal (replaces it), false = new food (client appends). */
  expectCorrection?: boolean;
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
    // The count has to reach the grams. This case asserted only the NAME, so
    // it passed at 40 g (10 g a biscuit) while Fast was reading "4 biscuits"
    // as one lump. A Marie Gold is ~4.7 g, so four are ~19 g; the ceiling here
    // is 8 g a biscuit, already generous against the decide prompt's own
    // "1 small packaged biscuit ~5-10 g".
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "marie", gramsBetween: [12, 32] }],
    },
  },
  // ── Piece-count PROBES: foods no prompt names ───────────────────────────
  // The fast prompt deliberately carries no per-food weights (see
  // FAST_EXTRACT_RULES). These three exist to keep that honest: none of them
  // appears in any prompt, so they measure whether the model can apply
  // "find one piece, multiply by the count" to a food it was never handed.
  // If a future prompt edit passes the biscuit cases but fails these, that
  // edit taught the answers instead of the rule.
  {
    id: "probe-count-monaco",
    text: "3 monaco biscuits",
    hour: 17,
    // A Monaco is ~4.4 g, so three are ~13 g. Ceiling is 8 g a cracker.
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "monaco", nameIncludesAny: ["biscuit", "cracker"], gramsBetween: [8, 24] }],
    },
  },
  {
    id: "probe-count-cashews",
    text: "6 cashews",
    hour: 16,
    // A cashew is ~1.5 g, so six are ~9 g.
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "cashew", gramsBetween: [5, 16] }],
    },
  },
  {
    id: "probe-count-rusk",
    text: "2 rusk with tea",
    hour: 8,
    // A rusk is ~11 g, so two are ~22 g. Paired with tea so the case also
    // covers a count sitting next to a household measure.
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "rusk", nameIncludesAny: ["toast"], gramsBetween: [12, 34] },
        { nameIncludes: "chai", nameIncludesAny: ["tea"] },
      ],
    },
  },
  {
    // The 2026-08-28 production trace, verbatim. Both rows carry only a "100 g"
    // basis serving, so this is the exact input that logged 200 g / 966 kcal
    // and 100 g / 316 kcal. The conversion guard fixed the multiplication; this
    // case guards the number the model itself now has to supply.
    // One Oreo is ~11 g, so two are ~22 g; an Amul slice is ~20 g.
    id: "oreo-and-cheese-slice",
    text: "2 oreo biscuits and 1 amul cheese slice",
    hour: 9,
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "oreo", gramsBetween: [14, 34], kcalBetween: [60, 170] },
        { nameIncludes: "cheese", gramsBetween: [12, 30], kcalBetween: [40, 110] },
      ],
    },
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
      // catalog is now a legitimate (best) tier: a prior parse's OFF/estimate
      // backfill seeded the row, which is exactly how the catalog compounds.
      items: [{ nameIncludes: "tikki", tiers: ["catalog", "off", "web", "estimate"] }],
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
        // The original bug resolved a roasted food against a cooked row, and
        // the gram range alone cannot tell the two apart.
        nameExcludes: ["cooked", "boiled"],
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
      items: [{
        nameIncludes: "chana",
        nameIncludesAny: ["chickpea"],
        nameExcludes: ["cooked", "boiled"],
        gramsBetween: [10, 30],
      }],
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

  // ── Indian beverage defaults ────────────────────────────────────────────
  // Regression for the 2026-07-18 prod log: "Half cup tea" matched
  // "Tea, hot, herbal" at 1.2 kcal (confidence high). Unqualified tea for
  // this audience is MILK chai: ~45 kcal/100 ml, so half a cup is ~25-60
  // kcal, never ~1.
  {
    id: "tea-milk-default",
    text: "Half cup tea and 2 good day biscuit", // exact prod input
    hour: 17,
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "chai", nameIncludesAny: ["tea"], gramsBetween: [50, 130], kcalBetween: [20, 80] },
        // 2 biscuits, so the grams must show TWO. The old ceiling of 250 kcal
        // and no gram bound let a 40 g lump through (20 g a biscuit).
        {
          nameIncludes: "good day",
          nameIncludesAny: ["goodday", "biscuit", "cookie"],
          gramsBetween: [8, 24],
          kcalBetween: [40, 130],
        },
      ],
    },
  },
  // ── Follow-up corrections (a meal is still on screen) ───────────────────
  // The user's own scenario: "samosa" resolves to a bigger serving than they
  // ate, and they say so instead of discarding and retyping.
  {
    id: "refine-samosa-small",
    text: "a samosa",
    followUp: "actually it was a small one",
    hour: 17,
    expectCorrection: true,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "samosa", gramsBetween: [15, 45], kcalBetween: [45, 140] }],
    },
  },
  {
    id: "refine-quantity",
    text: "2 roti and dal",
    followUp: "make it 3 rotis",
    hour: 13,
    expectCorrection: true,
    expect: {
      // Both lines come back: the corrected roti and the untouched dal.
      minItems: 2, maxItems: 2,
      items: [{ nameIncludes: "roti", gramsBetween: [90, 220] }, { nameIncludes: "dal" }],
    },
  },
  {
    // The dangerous one: an ADDITION must not be read as a correction, or the
    // food already reviewed gets silently rewritten.
    id: "followup-adds-not-corrects",
    text: "a samosa",
    followUp: "and a dosa",
    hour: 17,
    expectCorrection: false,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "dosa" }],
    },
  },
  {
    id: "black-tea-stays-plain",
    text: "1 cup black tea no sugar",
    hour: 8,
    expect: {
      minItems: 1,
      items: [{ nameIncludes: "tea", kcalBetween: [0, 15] }],
    },
  },
  // ── Product qualifiers must survive extraction (regression, 2026-08-22) ────
  // The extract step used to compress names to 1-3 words and "drop filler
  // adjectives", which stripped the words that identify WHICH product: "milky
  // mist low fat paneer" was searched as "paneer" and silently logged FULL FAT
  // (283 kcal/100g against the real 190). Ranking cannot fix this, the wrong
  // query never returns the right row. These cases guard the fix.
  {
    id: "qualifier-skimmed-not-toned",
    text: "200 ml amul skimmed milk",
    hour: 8,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "milk", gramsBetween: [200, 200], kcalBetween: [50, 110] }],
    },
  },
  {
    id: "qualifier-high-protein-paneer",
    text: "35g milky mist high protein paneer",
    hour: 10,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "paneer", gramsBetween: [35, 35] }],
    },
  },

  // ── Whole egg must beat its neighbours (the 2026-08-20 yolk mislog) ───────
  {
    id: "eggs-whole-not-yolk",
    text: "2 whole eggs",
    hour: 8,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{
        nameIncludes: "egg",
        // Yolk is 347 kcal/100g and white is 43: both sit outside this band,
        // so a wrong part fails loudly instead of looking plausible.
        nameExcludes: ["yolk", "white", "duck", "quail", "turkey"],
        kcalBetween: [120, 200], proteinBetween: [10, 16],
      }],
    },
  },

  // ── Bare units display the amount they logged (fixed 2026-08-22) ──────────
  {
    id: "bare-ml-quantity",
    text: "250ml toned milk",
    hour: 8,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "milk", gramsBetween: [250, 250], kcalBetween: [90, 180] }],
    },
  },

  // ── Real inputs mined from parse_traces ──────────────────────────────────
  {
    id: "log-mixed-units-bowl",
    text: "2 rotis and a bowl of dal",
    hour: 13,
    expect: { minItems: 2, maxItems: 2, mealType: "lunch" },
  },
  {
    id: "log-branded-us-bar",
    text: "2 whole eggs and a quest protein bar",
    hour: 9,
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "egg", nameExcludes: ["yolk", "white"] },
        { nameIncludes: "protein bar", proteinBetween: [15, 25] },
      ],
    },
  },
  {
    id: "log-scoop-whey",
    text: "250ml toned milk and 1 scoop whey protein",
    hour: 17,
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "milk", gramsBetween: [250, 250] },
        { nameIncludes: "whey", proteinBetween: [18, 30] },
      ],
    },
  },
  {
    id: "log-freeform-multi-meal",
    // Observed DECLINED once and parsed 4 items another time. It is food, so a
    // decline is a bug; this pins the non-decline.
    text: "In the morning i ate Yogabar kesar pista oats with milk double toned and in snacks i had 24 gm peanuts",
    hour: 11,
    expect: { declined: false, minItems: 2 },
  },
  {
    id: "log-typo-tolerant",
    text: "2 whle eggs and a quest protien bar",
    hour: 9,
    expect: { minItems: 2, maxItems: 2, items: [{ nameIncludes: "egg", nameExcludes: ["yolk"] }] },
  },
  {
    id: "log-oats-and-milk-500",
    text: "kesar pista oats yogabar 70g and 500 ml double toned milk",
    hour: 8,
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "oats", gramsBetween: [70, 70] },
        { nameIncludes: "milk", gramsBetween: [500, 500], kcalBetween: [180, 380] },
      ],
    },
  },
  {
    id: "log-biscuits-and-chai",
    text: "2 good day biscuits and chai half cup",
    hour: 17,
    // Asserted only that two items came back, so a 40 g biscuit lump passed.
    expect: {
      minItems: 2, maxItems: 2,
      items: [
        { nameIncludes: "biscuit", nameIncludesAny: ["good day", "goodday", "cookie"], gramsBetween: [8, 24] },
        { nameIncludes: "chai", nameIncludesAny: ["tea"], gramsBetween: [50, 130] },
      ],
    },
  },
  {
    id: "log-question-declines",
    text: "Are you sure about the calories",
    hour: 14,
    expect: { declined: true },
  },

  // [I6a] Removing the ONLY line. Flagged in review of PR #121: the existing
  // delete case removes one of TWO items, so the empty-result path was never
  // exercised. extract correctly returns no items here, which used to hit the
  // generic "that did not look like food" decline - shown next to the line the
  // user had just deleted, because a decline keeps the card.
  {
    id: "audit-delete-only-item",
    text: "50g tofu",
    hour: 13,
    followUp: "remove the tofu",
    expectCorrection: true,
    expect: { declined: true },
  },

  // ── Audit-derived cases (2026-08-22 prompt/schema audit) ─────────────────
  // Each case asserts DESIRED behavior. Ones tagged [I6*]/[I8] are expected to
  // FAIL until that improvement lands; they are the gate for it, not noise.

  // Qualifier survival (the low-fat-paneer class; fixed 2026-08-21, keep guarded).
  {
    id: "audit-low-fat-paneer",
    text: "50g milky mist low fat paneer",
    hour: 9,
    expect: {
      minItems: 1, maxItems: 1,
      // Milky Mist High Protein Low Fat Paneer is 190 kcal/100 g, so 50 g is
      // ~95. Full-fat paneer is 265-283/100 g, landing 132-142 - which is what
      // ships today when the "low fat" qualifier is dropped. I11/I11b gate.
      // (Merged with the former qualifier-low-fat-paneer, which asserted the
      // same fact through a looser band.)
      items: [{ nameIncludes: "paneer", gramsBetween: [50, 50], kcalBetween: [80, 120] }],
    },
  },
  {
    id: "audit-double-toned-300",
    text: "amul double toned milk 300ml",
    hour: 8,
    expect: {
      minItems: 1, maxItems: 1,
      // FSSAI fixes these by composition, which is exactly why the qualifier is
      // not droppable. Derived from the standard's fat/SNF and checked against
      // Atwater and real labels (migration 0106 seeds exactly these rows):
      //   skimmed 0.5% -> 38.5   double toned 1.5% -> 47.1
      //   toned 3.0%   -> 58.6   full cream 6.0%   -> 87.6  kcal/100 ml
      // So 300 ml double toned is ~141. An earlier version of this comment said
      // "~42" and set the band to [90,140]; that figure was wrong and the band
      // excluded the correct answer by one kcal. Amul Taaza Toned, the row that
      // used to win, lands 174. I11/I11b gate.
      // (Replaced the former qualifier-double-toned-milk, whose band [110,230]
      // and "~55-60 kcal/100ml" comment described TONED milk - it PASSED on the
      // wrong product and would have certified this bug as correct.)
      items: [{ nameIncludes: "milk", gramsBetween: [300, 300], kcalBetween: [125, 155] }],
    },
  },
  {
    id: "audit-roti-medium-size",
    text: "roti medium size",
    hour: 13,
    // Size words belong in unit, not name; must not derail the roti match.
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "roti" }] },
  },

  // [I6a] Deletion by text. Impossible today (nets restore, qty clamp).
  {
    id: "audit-delete-by-text",
    text: "100g paneer and 50g tofu",
    hour: 13,
    followUp: "remove the tofu",
    expectCorrection: true,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "paneer" }] },
  },
  // [I6b] Challenge + fix must keep the fix.
  {
    id: "audit-challenge-plus-fix",
    text: "150g paneer",
    hour: 13,
    followUp: "that seems high, make it 100g",
    expectCorrection: true,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "paneer", gramsBetween: [100, 100] }] },
  },
  // [I6c] Correction mixed with addition.
  {
    id: "audit-correction-plus-addition",
    text: "2 roti and dal",
    hour: 13,
    followUp: "make the roti 3 and add a dosa",
    expectCorrection: true,
    expect: {
      minItems: 3, maxItems: 3,
      items: [
        { nameIncludes: "roti", gramsBetween: [105, 230] },
        { nameIncludes: "dal" },
        { nameIncludes: "dosa" },
      ],
    },
  },
  // [I8] Full-day logging (user-requested FEATURE: one message, several meals).
  {
    id: "audit-multi-meal-day",
    text: "breakfast was 2 eggs, lunch was dal chawal",
    hour: 20,
    // Per-item sections are the whole point (I8). Before `meal` existed this
    // case passed with both lines in one section, which is the bug.
    expect: {
      minItems: 2,
      items: [
        { nameIncludes: "egg", meal: "breakfast" },
        { nameIncludes: "dal", nameIncludesAny: ["rajma", "chawal", "rice"], meal: "lunch" },
      ],
    },
  },
  {
    // Three meals, casual phrasing: "evening" is snacks, "at night" is dinner.
    id: "audit-multi-meal-three",
    text: "had 2 idli with sambar in the morning, rajma chawal for lunch and a bowl of upma at night",
    hour: 22,
    expect: {
      minItems: 3,
      items: [
        { nameIncludes: "idli", meal: "breakfast" },
        { nameIncludes: "rajma", meal: "lunch" },
        { nameIncludes: "upma", meal: "dinner" },
      ],
    },
  },
  {
    // ONE meal named for everything: must go to meal_type_from_text, and
    // every line to that section - the per-item field must not fragment it.
    id: "audit-one-meal-named-twice",
    text: "for lunch I had 2 rotis with sabzi and a glass of buttermilk",
    hour: 20,
    expect: {
      minItems: 2,
      mealType: "lunch",
      items: [
        { nameIncludes: "roti", meal: "lunch" },
        { nameIncludes: "buttermilk", nameIncludesAny: ["chaas", "chaach"], meal: "lunch" },
      ],
    },
  },
  // [I6e] Mentioned food is not eaten food.
  {
    id: "audit-asked-not-eaten",
    text: "should I eat a protein bar after my workout?",
    hour: 18,
    expect: { declined: true },
  },
  {
    id: "audit-skipped-meal",
    text: "skipped breakfast today",
    hour: 11,
    expect: { declined: true },
  },
  {
    id: "audit-craving",
    text: "craving pizza right now",
    hour: 16,
    expect: { declined: true },
  },

  // Ambiguities from the same audit.
  {
    id: "audit-no-sugar-tea",
    text: "1 cup milk tea",
    hour: 17,
    followUp: "no sugar in the tea",
    expectCorrection: true,
    // Unsugared milk tea for a cup: the sugared row (~70-110) must not survive.
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "tea", kcalBetween: [10, 75] }] },
  },
  {
    id: "audit-hindi-doodh",
    text: "1 glass doodh and 2 roti",
    hour: 8,
    expect: {
      minItems: 2, maxItems: 2,
      items: [{ nameIncludes: "milk", nameIncludesAny: ["doodh"] }, { nameIncludes: "roti" }],
    },
  },
  {
    id: "audit-range-quantity",
    text: "2-3 rotis with sabzi",
    hour: 13,
    expect: { minItems: 2, items: [{ nameIncludes: "roti", gramsBetween: [80, 215] }] },
  },
  {
    id: "audit-half-glass",
    text: "half glass milk",
    hour: 21,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "milk", gramsBetween: [90, 160] }] },
  },
  {
    id: "audit-compound-amount",
    text: "half packet (35g) maggi",
    hour: 17,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "maggi", gramsBetween: [35, 35] }] },
  },
  {
    id: "audit-brand-typo",
    text: "milkymist paneer 50g",
    hour: 9,
    expect: { minItems: 1, maxItems: 1, items: [{ nameIncludes: "paneer", gramsBetween: [50, 50] }] },
  },

  // ── Candidate acceptability (I11) ────────────────────────────────────────
  // Droppable qualifiers: the generic row IS correct, must NOT become estimate.
  {
    id: "accept-brand-on-commodity",
    text: "200ml amul toned milk",
    hour: 8,
    // Toned milk is grade-standardized: a generic Toned Milk row is right.
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "milk", tiers: ["catalog", "off", "fatsecret"],
                gramsBetween: [200, 200], kcalBetween: [90, 145] }],
    },
  },
  {
    id: "accept-provenance-words",
    text: "100g fresh homemade curd",
    hour: 13,
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludesAny: ["curd", "dahi", "yogurt"], nameIncludes: "curd",
                tiers: ["catalog", "off", "fatsecret"] }],
    },
  },
  // Non-droppable qualifiers: a row without them is NOT acceptable.
  {
    id: "accept-grade-double-toned",
    text: "500ml double toned milk",
    hour: 8,
    // Double toned ~1.5% fat (~42 kcal/100ml). A Toned row (58) reads ~38% high.
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "milk", gramsBetween: [500, 500], kcalBetween: [150, 240] }],
    },
  },
  {
    id: "accept-brand-on-formulated",
    text: "1 quest protein bar",
    hour: 17,
    // Generic "protein bar" averages over 180-250 kcal products: not acceptable.
    // Either the real Quest row, or an estimate - never a generic bar row.
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "bar", kcalBetween: [170, 230], proteinBetween: [17, 24] }],
    },
  },
  {
    id: "accept-dish-not-ingredient",
    text: "1 katori paneer butter masala",
    hour: 20,
    // The gravy, oil and cream are most of the calories: plain Paneer is wrong.
    expect: {
      minItems: 1, maxItems: 1,
      items: [{ nameIncludes: "paneer", nameExcludes: ["milky mist"], kcalBetween: [200, 500] }],
    },
  },
];
