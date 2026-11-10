/**
 * A logged line's portion, as the editor shows it: an AMOUNT of a UNIT
 * ("150 g", "2 roti", "2 x 250 ml bottle"). Two boxes, the same two the line
 * stores, (quantity, serving_label). It used to be three (size, unit, count),
 * and before that "Quantity" beside "Amount"; both made the user do sums.
 *
 * A stored label can carry a number of its own, in two kinds:
 *   - a plain size: "100 g", "1 roti", "1/2 katori". It folds into the
 *     amount, so 1.5 x "100 g" shows as 150 g and 3 x "1/2 katori" as 1.5 katori.
 *   - a number that names the thing: "250 ml bottle". Two of those are two
 *     bottles, not "500 ml bottle", so the label stays whole as the unit.
 * A plain size is a "1", or a number before a measurement or before one word.
 *
 * No imports, so Deno can test it directly. The caller passes the unit check
 * (lib/units.ts isMeasurementUnit).
 */

export interface Portion {
  amount: number; // how much, in `unit`
  unit: string;   // g, ml, slice, roti, 250 ml bottle...
}

// "100 g", "1.5 cup", "1/2 katori", "100g". A leading number, then the rest.
const LEAD = /^(\d+(?:[.,]\d+)?(?:\/\d+)?)\s*([^\d\s/.,].*)$/;

function parseNum(s: string): number {
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    return b ? a / b : NaN;
  }
  return Number(s.replace(',', '.'));
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The label's own size and unit, when its number is a plain size. */
function labelSize(label: string, isMeasurement: (unit: string) => boolean): { size: number; unit: string } | null {
  const m = label.trim().match(LEAD);
  if (!m) return null;
  const size = parseNum(m[1]);
  const rest = m[2].trim();
  if (!(size > 0)) return null;
  if (size === 1 || isMeasurement(rest) || !/\s/.test(rest)) return { size, unit: rest };
  return null;
}

/** Stored (quantity, label) -> the two boxes. */
export function toPortion(
  quantity: number,
  label: string,
  isMeasurement: (unit: string) => boolean,
): Portion {
  const q = quantity > 0 ? quantity : 1;
  const l = label.trim();
  if (isMeasurement(l)) return { amount: q, unit: l };
  const sized = labelSize(l, isMeasurement);
  if (sized) return { amount: r3(q * sized.size), unit: sized.unit };
  return { amount: q, unit: l || 'serving' };
}

/** The two boxes -> stored (quantity, label), in the shape the line already
 *  had where it can, so an untouched line saves back byte for byte. */
export function fromPortion(
  portion: Portion,
  original: { quantity: number; serving_label: string },
  isMeasurement: (unit: string) => boolean,
): { quantity: number; serving_label: string } {
  const unit = portion.unit.trim() || 'serving';
  const amount = portion.amount > 0 ? r3(portion.amount) : 1;
  const was = toPortion(original.quantity, original.serving_label, isMeasurement);
  // Nothing moved: keep the line exactly as written ("0.50 cup" stays so).
  if (r3(was.amount) === amount && was.unit === unit) {
    return { quantity: original.quantity, serving_label: original.serving_label };
  }
  // A measurement is stored as its total: 150 "g", not 1.5 x "100 g".
  if (isMeasurement(unit)) return { quantity: amount, serving_label: unit };
  // Same named serving, new count: keep its exact label ("1 roti", "250 ml
  // bottle"). Only when one of the label is one of the unit, so a "1/2 katori"
  // line moved to 2 reads "2 katori", not "4 x 1/2 katori".
  const sized = labelSize(original.serving_label, isMeasurement);
  const perOne = sized ? sized.size : 1;
  if (was.unit === unit && perOne === 1 && !isMeasurement(original.serving_label.trim())) {
    return { quantity: amount, serving_label: original.serving_label };
  }
  return { quantity: amount, serving_label: unit };
}

/** Normalize a completed unit edit, preserving the amount of food. Call after
 * typing finishes: a temporary "g" while deleting "glass" is not a gram edit. */
export function sizeForUnitChange(
  size: number, count: number, grams: number, previous: string, next: string,
  gramsPerUnit: (unit: string) => number | null,
): number {
  if (previous.trim().toLowerCase() === next.trim().toLowerCase()) return size;
  const weight = gramsPerUnit(next);
  if (weight && grams > 0 && count > 0) {
    const converted = Math.round((grams / weight / count) * 1000) / 1000;
    if (converted > 0) return converted;
  } else if (gramsPerUnit(previous) !== null) return 1;
  return size;
}

/** Scale an unrounded nutrition snapshot; rounding belongs only in UI fields. */
export function scaleServingNutrition<T extends { kcal: number; protein: number; carb: number; fat: number }>(basis: T, ratio: number) {
  return { kcal: basis.kcal * ratio, protein: basis.protein * ratio,
    carb: basis.carb * ratio, fat: basis.fat * ratio };
}

/**
 * A count for display. A tenth is fine from one up ("1.5 x bowl"), but below
 * one it rounds a real amount to nothing: 0.04 of a "100 g" scoop read
 * "0 x 100 g" next to 16 kcal. Below one we keep two places, and an amount
 * too small even for that says so instead of claiming zero.
 */
export function formatCount(n: number): string {
  if (!(n > 0)) return '0';
  if (n >= 1) return String(Math.round(n * 10) / 10);
  const two = Math.round(n * 100) / 100;
  return two > 0 ? String(two) : '<0.01';
}

/**
 * How a logged portion reads under a food name.
 *
 * A MEASUREMENT already carries the amount: "150 g", never "150 x g".
 * A serving that is itself a measurement ("100 g", "250 ml") folds into one:
 * 0.16 x "100 g" reads "16 g" and 2 x "100 g" reads "200 g", which is what
 * the user ate, with no multiplication left for them to do.
 * A NAMED portion (bowl, egg, roti) keeps the multiplier, "2 x bowl", and
 * stands alone at one.
 *
 * No pluralisation: serving labels come from third-party catalogues in
 * whatever form they were entered, so guessing a plural would mangle as many
 * as it fixed.
 */
export function servingText(
  quantity: number,
  label: string,
  isMeasurement: (unit: string) => boolean,
): string {
  const l = label.trim();
  if (isMeasurement(l)) return `${formatCount(quantity)} ${l}`;
  const m = l.match(LEAD);
  if (m && isMeasurement(m[2].trim())) {
    const size = parseNum(m[1]);
    if (size > 0) return `${formatCount(quantity * size)} ${m[2].trim()}`;
  }
  const qty = formatCount(quantity);
  return qty === '1' ? l : `${qty} × ${l}`;
}

// Units whose amount IS the line's grams (ml lines store their ml as grams).
const GRAM_UNITS = new Set(['g', 'gm', 'gms', 'gram', 'grams']);
const ML_UNITS = new Set(['ml', 'mls']);
// The server's label pattern, not LEAD: "1/2 g" and "1,5 g" are left alone on
// both sides, so a saved line reads the way a new parse of it would.
const WEIGHT_LABEL = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/;

/**
 * A line whose weight label disagrees with its grams: 15 x "100 g" with 15 g
 * behind it, or 100 "g" with 130 g. The food log wrote these, and the card
 * read "1500 g". The grams are what the numbers were worked out from, so they
 * win: 15 "g".
 *
 * The same rules as the server's amountMatchesGrams (ai-coach/parseMeal.ts,
 * tested in amountMatchesGrams.test.ts): change both together, so a saved
 * line reads the way a new parse would: a bare "g" moves when more
 * than 10% off, a stated weight or ml when more than half again either way. A
 * ml line a little off its grams is density, not this bug.
 */
export function fixWeightLabel(
  quantity: number,
  label: string,
  grams: number,
): { quantity: number; serving_label: string } {
  const keep = { quantity, serving_label: label };
  if (!(grams > 0) || !(quantity > 0)) return keep;
  const asGrams = (unit: string) => ({ quantity: Math.round(grams * 10) / 10, serving_label: unit });
  const off = (amount: number, tolerance: number) => {
    const ratio = amount / grams;
    return ratio > 1 + tolerance || ratio < 1 / (1 + tolerance);
  };
  const l = label.trim().toLowerCase();
  if (GRAM_UNITS.has(l)) return off(quantity, 0.1) ? asGrams('g') : keep;
  if (ML_UNITS.has(l)) return off(quantity, 0.5) ? asGrams('ml') : keep;
  const m = l.match(WEIGHT_LABEL);
  if (!m) return keep;
  const size = Number(m[1]);
  const unit = GRAM_UNITS.has(m[2]) ? 'g' : ML_UNITS.has(m[2]) ? 'ml' : null;
  if (!unit || !(size > 0)) return keep;
  return off(quantity * size, 0.5) ? asGrams(unit) : keep;
}
