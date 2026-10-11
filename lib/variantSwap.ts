// One-tap variant swap on the food card.
//
// When Drona answers a line from the user's memory and they also log another
// variant of that food ("chocolate whey" served, "vanilla whey" also logged),
// the server sends that variant already priced from the user's own numbers.
// Tapping it swaps the line here, with no model call and no network, so the
// fix for a wrong pick costs one tap instead of typing "it was vanilla".
//
// Pure and import-free on purpose: deno tests it directly
// (deno test --allow-all lib/variantSwap.test.ts).

export type SwapSource = 'catalog' | 'off' | 'fatsecret' | 'web' | 'estimate' | 'manual';

/** Everything that changes when the user picks another variant. The line's
 *  amount, unit and section stay its own. */
export interface SwapOption {
  food_name: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  source: SwapSource;
  assumption: string | null;
  /** This option is the line Drona first served, the one the user logs most.
   *  Set when a swap turns that line into an option. */
  usual?: boolean;
}

/** The parts of a card line a swap reads and writes. */
export interface SwapLine {
  food_id: string | null;
  food_name: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  source: SwapSource;
  assumption: string | null;
  confidence: 'high' | 'medium' | 'low';
  verified?: boolean;
  alternatives?: SwapOption[];
  /** False once the user swapped to a variant they log less. Absent on the
   *  line as served, which is the one they log most. */
  usual?: boolean;
}

const SOURCES = new Set<SwapSource>(['catalog', 'off', 'fatsecret', 'web', 'estimate', 'manual']);
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? x : 0;
};
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Read the server's `alternatives`, dropping anything malformed. Undefined
 *  when there is nothing usable, so the card draws no chip. */
export function readSwapOptions(raw: unknown): SwapOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.flatMap((a): SwapOption[] => {
    if (!a || typeof a !== 'object') return [];
    const o = a as Record<string, unknown>;
    const name = typeof o.food_name === 'string' ? o.food_name.trim() : '';
    if (!name || !(n(o.grams) > 0)) return [];
    return [{
      food_name: name.slice(0, 120),
      grams: n(o.grams),
      kcal: n(o.kcal),
      protein_g: n(o.protein_g),
      carb_g: n(o.carb_g),
      fat_g: n(o.fat_g),
      fiber_g: o.fiber_g == null ? null : n(o.fiber_g),
      source: SOURCES.has(o.source as SwapSource) ? (o.source as SwapSource) : 'estimate',
      assumption: typeof o.assumption === 'string' && o.assumption.trim() ? o.assumption.trim() : null,
    }];
  }).slice(0, 2);
  return out.length > 0 ? out : undefined;
}

/** An option's numbers at the line's CURRENT weight. The server priced it at
 *  the weight it parsed; the user may have changed the amount since. */
export function optionAt(option: SwapOption, grams: number): SwapOption {
  const f = grams > 0 && option.grams > 0 ? grams / option.grams : 1;
  return {
    ...option,
    grams: r1(option.grams * f),
    kcal: r1(option.kcal * f),
    protein_g: r1(option.protein_g * f),
    carb_g: r1(option.carb_g * f),
    fat_g: r1(option.fat_g * f),
    fiber_g: option.fiber_g == null ? null : r1(option.fiber_g * f),
  };
}

/** Swap a line to its k-th option. The line it replaces becomes an option, so
 *  a wrong tap is undone with one more tap. Out of range returns the line. */
export function swapToAlternative<T extends SwapLine>(line: T, k: number): T {
  const options = line.alternatives ?? [];
  const picked = options[k];
  if (!picked) return line;
  const next = optionAt(picked, line.grams);
  const previous: SwapOption = {
    food_name: line.food_name,
    grams: line.grams,
    kcal: line.kcal,
    protein_g: line.protein_g,
    carb_g: line.carb_g,
    fat_g: line.fat_g,
    fiber_g: line.fiber_g,
    source: line.source,
    assumption: line.assumption,
    usual: line.usual ?? true,
  };
  return {
    ...line,
    food_id: null,
    food_name: next.food_name,
    grams: next.grams,
    kcal: next.kcal,
    protein_g: next.protein_g,
    carb_g: next.carb_g,
    fat_g: next.fat_g,
    fiber_g: next.fiber_g,
    source: next.source,
    assumption: next.assumption,
    // The user's own numbers for a food they named by tapping it.
    confidence: 'high',
    verified: false,
    usual: picked.usual === true,
    alternatives: [previous, ...options.filter((_, i) => i !== k)],
  };
}
