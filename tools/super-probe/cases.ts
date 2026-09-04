// Held-out probe set for SUPER mode (Phase 7).
//
// WHY THIS EXISTS. Super's whole pitch is "more accurate on packaged foods the
// catalog has never seen". Before this file that claim rested on ONE case (the
// canonical Milky Mist paneer in tools/super-canonical-case.ts). One success is
// not an accuracy number, and shipping a tier on it would be dressing up a
// single data point.
//
// ── WHERE THE GROUND TRUTH COMES FROM ──────────────────────────────────────
// Every expected value below is an Open Food Facts row already loaded in this
// project's `foods` table (source='off'), which OFF transcribes from a photo of
// the actual pack. That matters for three reasons:
//
//   1. It is not model recall. Values sourced from what an LLM "remembers" would
//      measure Super against a hallucination and call the agreement accuracy.
//   2. It is not a calorie aggregator. Super searches the open web and reads
//      sites like fatsecret / mynetdiary / nutritionix; scoring it against those
//      same sites would be circular. A pack label is upstream of all of them.
//   3. The probe runs with the catalog DISABLED (searchFoods returns []), so
//      Super cannot read the very rows it is being scored against. It has to go
//      find the product on the web and get back to the label on its own.
//
// ── WHY THE TOLERANCES ARE WIDE ────────────────────────────────────────────
// Pack labels genuinely disagree with themselves. In the OFF rows for these
// products: Britannia Bourbon appears at both 488 and 494 kcal, Marie Gold at
// 445 and 453, Good Day Butter at 494 and 500 - different pack sizes and print
// runs of the same product. Cadbury Bournville spans 523-544 across variants.
// So a tolerance tighter than that variation would fail Super for being right.
//
// The errors this probe exists to catch are not 5% errors. They are:
//   - the wrong product entirely (a different brand's biscuit)
//   - per-serving numbers reported as per-100g (the classic; off by 3-5x)
//   - invention when the web turns up nothing
// Those land at 2x-10x. +/-15% separates them from label noise cleanly, and the
// runner also reports median absolute % error so the headline is not a single
// pass/fail that hides a systematic lean.
//
// ── HELD-OUT ───────────────────────────────────────────────────────────────
// Every product here was checked against scripts/parse-meal-eval/cases.ts and
// appears in NONE of it. Deliberately excluded for that reason: Oreo, Amul
// butter, Amul Kool, Amul cheese slices, Britannia Marie Gold, Good Day,
// Monaco, Maggi, Haldiram bhujia, Epigamia, Yogabar, Milky Mist. If you add a
// case, grep the eval corpus first - a probe that leaks into the prompt or the
// eval stops measuring generalisation. See the no-eval-overfit rule.
//
// NOTHING IN THIS FILE MAY BE PUT IN A PROMPT.

export interface Range {
  /** Inclusive low/high of the acceptable band, before tolerance is applied. */
  lo: number;
  hi: number;
}

export interface ProbeCase {
  id: string;
  /** What a user would actually type. Quantity is deliberately 100 g so the
   *  answer is directly comparable to the per-100g label with no unit maths in
   *  the way - this probe measures LOOKUP accuracy, not portion estimation. */
  text: string;
  /** Substring that must appear in the returned food name, case-insensitive.
   *  Catches the "found a different product" failure that numeric bounds miss:
   *  a wrong biscuit can easily land inside another biscuit's calorie band. */
  nameIncludes: string[];
  /** Per-100g truth from the OFF pack label. A range where OFF itself carries
   *  more than one value for the product. */
  kcal: Range;
  protein_g: Range;
  carb_g: Range;
  fat_g: Range;
  /** Lower-case tokens that must ALL appear in the row's precise_cache key.
   *  The key is built from the EXTRACTED name and brand, not from `text`, so it
   *  cannot be computed here - the model decides how much of the product name to
   *  keep. These tokens are picked to survive that: brand plus one core word the
   *  model will not drop. Used only to clear and read back the row. */
  keyTokens: string[];
  /** Free text: which OFF rows this came from, so the provenance is auditable
   *  and a future reader can re-derive it rather than trusting this file. */
  truthNote: string;
}

export const PROBE_CASES: ProbeCase[] = [
  // ── Dairy and fresh (low kcal - the band where a per-serving mix-up is most
  //    obvious, because 100 g of dahi cannot be 250 kcal) ────────────────────
  {
    id: "amul-masti-dahi",
    text: "100g Amul Masti Dahi",
    nameIncludes: ["dahi", "curd", "yogurt", "yoghurt"],
    kcal: { lo: 62, hi: 65 }, protein_g: { lo: 4, hi: 4 },
    carb_g: { lo: 4.4, hi: 4.6 }, fat_g: { lo: 3.1, hi: 3.1 },
    truthNote: "OFF 8901262201124 (62/4/4.4/3.1); 'Amul Masti' 8901262200622 at 65/4/4.6/3.1.",
    keyTokens: ["amul", "dahi"],
  },
  {
    id: "amul-lassi",
    text: "100g Amul Lassi",
    nameIncludes: ["lassi"],
    kcal: { lo: 87, hi: 89 }, protein_g: { lo: 2, hi: 2.2 },
    carb_g: { lo: 14, hi: 14.5 }, fat_g: { lo: 2, hi: 2.2 },
    truthNote: "OFF 8901262200189 (89/2.1/14.5/2.1) and 8901262151696 (87/2/14/2).",
    keyTokens: ["amul", "lassi"],
  },
  {
    id: "amul-buttermilk",
    text: "100g Amul Buttermilk",
    nameIncludes: ["buttermilk", "chaas", "chaach"],
    kcal: { lo: 23, hi: 29 }, protein_g: { lo: 1.3, hi: 1.5 },
    carb_g: { lo: 1.8, hi: 2.5 }, fat_g: { lo: 0.7, hi: 1.5 },
    truthNote: "OFF 8901262201995 (23/1.3/2.5/0.7); Masti Spiced 8901262200196 at 29/1.5/1.8/1.5.",
    keyTokens: ["amul", "buttermilk"],
  },
  {
    id: "amul-fresh-cream",
    text: "100g Amul Fresh Cream",
    nameIncludes: ["cream"],
    kcal: { lo: 247, hi: 247 }, protein_g: { lo: 2, hi: 2 },
    carb_g: { lo: 3.5, hi: 3.5 }, fat_g: { lo: 25, hi: 25 },
    truthNote: "OFF 8901262151863.",
    keyTokens: ["amul", "cream"],
  },
  {
    id: "amul-malai-paneer",
    text: "100g Amul Malai Paneer",
    nameIncludes: ["paneer"],
    kcal: { lo: 312, hi: 312 }, protein_g: { lo: 20, hi: 20 },
    carb_g: { lo: 4, hi: 4 }, fat_g: { lo: 24, hi: 24 },
    truthNote: "OFF 8901262180146 and 8901262180115, identical.",
    keyTokens: ["amul", "paneer"],
  },

  // ── Biscuits (the category the piece-count bug lived in; all ~450-510) ─────
  {
    id: "britannia-bourbon",
    text: "100g Britannia Bourbon biscuits",
    nameIncludes: ["bourbon"],
    kcal: { lo: 488, hi: 494 }, protein_g: { lo: 2.7, hi: 5 },
    carb_g: { lo: 72, hi: 72.7 }, fat_g: { lo: 20, hi: 20.3 },
    truthNote: "OFF 8901262139206-equivalent 8901063139206 (488/2.7/72/20) and 8901063139336 (494/5/72.7/20.3). Protein genuinely differs between the two printed panels.",
    keyTokens: ["bourbon"],
  },
  {
    id: "britannia-nutrichoice-digestive",
    text: "100g Britannia NutriChoice Digestive biscuits",
    nameIncludes: ["nutri", "digestive"],
    kcal: { lo: 497, hi: 497 }, protein_g: { lo: 8.6, hi: 8.6 },
    carb_g: { lo: 68.4, hi: 68.4 }, fat_g: { lo: 21, hi: 21 },
    truthNote: "OFF 8901063142466.",
    keyTokens: ["digestive"],
  },
  {
    id: "britannia-little-hearts",
    text: "100g Britannia Little Hearts biscuits",
    nameIncludes: ["little heart"],
    kcal: { lo: 486, hi: 486 }, protein_g: { lo: 7.4, hi: 7.4 },
    carb_g: { lo: 70, hi: 70 }, fat_g: { lo: 19.5, hi: 19.5 },
    truthNote: "OFF 8901063019140 and 8901063019027, identical.",
    keyTokens: ["heart"],
  },
  {
    id: "britannia-jim-jam",
    text: "100g Britannia Jim Jam biscuits",
    nameIncludes: ["jim jam", "jimjam"],
    kcal: { lo: 483, hi: 483 }, protein_g: { lo: 5, hi: 5 },
    carb_g: { lo: 73, hi: 76 }, fat_g: { lo: 19, hi: 19 },
    truthNote: "OFF 8901063029217 / 8901063029279 / 8901063029286.",
    keyTokens: ["jam"],
  },
  {
    id: "britannia-tiger-glucose",
    text: "100g Britannia Tiger glucose biscuits",
    nameIncludes: ["tiger"],
    kcal: { lo: 457, hi: 457 }, protein_g: { lo: 7.5, hi: 7.5 },
    carb_g: { lo: 76.6, hi: 76.6 }, fat_g: { lo: 13.4, hi: 13.4 },
    truthNote: "OFF 8901063163287.",
    keyTokens: ["tiger"],
  },

  // ── Fried namkeen / chips (high fat - catches a lean toward generic 'snack'
  //    numbers, since these run 520-590 and a generic chip guess is ~530) ────
  {
    id: "bingo-tedhe-medhe",
    text: "100g Bingo Tedhe Medhe",
    nameIncludes: ["tedhe"],
    kcal: { lo: 546, hi: 551 }, protein_g: { lo: 5.5, hi: 7.7 },
    carb_g: { lo: 52.9, hi: 57.3 }, fat_g: { lo: 32.8, hi: 35.2 },
    truthNote: "OFF 8901725118914 (546) and Chatpata Twist 8901725011017 (551).",
    keyTokens: ["tedhe"],
  },
  {
    id: "bingo-mad-angles-masala",
    text: "100g Bingo Mad Angles Mmmmm Masala",
    nameIncludes: ["mad angle"],
    kcal: { lo: 538, hi: 538 }, protein_g: { lo: 6.6, hi: 6.6 },
    carb_g: { lo: 57.7, hi: 57.7 }, fat_g: { lo: 32.1, hi: 32.1 },
    truthNote: "OFF 8901725120375.",
    keyTokens: ["angle"],
  },
  {
    id: "balaji-chaat-chaska",
    text: "100g Balaji Wafers Chaat Chaska",
    nameIncludes: ["balaji", "chaat chaska"],
    kcal: { lo: 545, hi: 545 }, protein_g: { lo: 7.4, hi: 7.4 },
    carb_g: { lo: 53.5, hi: 53.5 }, fat_g: { lo: 32.2, hi: 32.2 },
    truthNote: "OFF Balaji Wafers Chaat Chaska.",
    keyTokens: ["balaji"],
  },
  {
    id: "bikano-navratan-mixture",
    text: "100g Bikano Navratan mixture",
    nameIncludes: ["navratan", "mixture"],
    kcal: { lo: 590, hi: 590 }, protein_g: { lo: 14.6, hi: 14.6 },
    carb_g: { lo: 42.1, hi: 42.1 }, fat_g: { lo: 40.4, hi: 40.4 },
    truthNote: "OFF 8901414000827.",
    keyTokens: ["navratan"],
  },

  // ── Confectionery ─────────────────────────────────────────────────────────
  {
    id: "cadbury-5-star",
    text: "100g Cadbury 5 Star",
    nameIncludes: ["5 star", "5star", "five star"],
    kcal: { lo: 447, hi: 447 }, protein_g: { lo: 3.3, hi: 3.3 },
    carb_g: { lo: 72.7, hi: 72.7 }, fat_g: { lo: 15.9, hi: 15.9 },
    truthNote: "OFF Cadbury 5star.",
    keyTokens: ["cadbury", "star"],
  },
  {
    id: "cadbury-gems",
    text: "100g Cadbury Gems",
    nameIncludes: ["gems"],
    kcal: { lo: 468, hi: 468 }, protein_g: { lo: 3.6, hi: 3.6 },
    carb_g: { lo: 75.1, hi: 75.1 }, fat_g: { lo: 17.5, hi: 17.5 },
    truthNote: "OFF Cadbury gems.",
    keyTokens: ["cadbury", "gems"],
  },
];
