/**
 * A logged line's portion, as the editor shows it: a serving SIZE in some
 * UNIT, eaten COUNT times ("100 g" x 1.5, "1 slice" x 2).
 *
 * A line stores only (quantity, serving_label), in two shapes:
 *   - a bare measurement unit: quantity 150, label "g"      -> 150 g
 *   - a named serving:         quantity 2,   label "1 roti" -> 2 x 1 roti
 * The editor used to show those raw, as "Quantity" beside an "Amount" in
 * grams, and on a gram line both boxes read 15. Nobody could tell them apart.
 * These two functions move between the stored shape and the three fields.
 *
 * No imports, so Deno can test it directly. The caller passes the unit check
 * (lib/units.ts isMeasurementUnit).
 */

export interface ServingParts {
  size: number;   // how big one serving is, in `unit`
  unit: string;   // g, ml, slice, tub, roti...
  count: number;  // how many servings were eaten
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

/** Stored (quantity, label) -> the three fields. */
export function splitServing(
  quantity: number,
  label: string,
  isMeasurement: (unit: string) => boolean,
): ServingParts {
  const q = quantity > 0 ? quantity : 1;
  const l = label.trim();
  // "15 x g" is one serving of 15 g, not fifteen servings of one gram.
  if (isMeasurement(l)) return { size: q, unit: l, count: 1 };
  const m = l.match(LEAD);
  if (m) {
    const size = parseNum(m[1]);
    if (size > 0) return { size, unit: m[2].trim(), count: q };
  }
  return { size: 1, unit: l || 'serving', count: q };
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** The three fields -> stored (quantity, label), in the shape the line
 *  already had, so an untouched line saves back byte for byte. */
export function joinServing(
  parts: ServingParts,
  original: { quantity: number; serving_label: string },
  isMeasurement: (unit: string) => boolean,
): { quantity: number; serving_label: string } {
  const unit = parts.unit.trim();
  const size = parts.size > 0 ? parts.size : 1;
  const count = parts.count > 0 ? parts.count : 1;
  const was = splitServing(original.quantity, original.serving_label, isMeasurement);
  // Nothing moved: keep the line exactly as written ("0.50 cup" stays so).
  if (was.size === size && was.unit === unit && was.count === count) {
    return { quantity: original.quantity, serving_label: original.serving_label };
  }
  // A gram line stays a gram line: 100 g x 1.5 is stored as 150 "g".
  if (isMeasurement(unit)) {
    return { quantity: Math.round(size * count * 1000) / 1000, serving_label: unit };
  }
  // Same serving, new count: keep its exact label.
  if (was.size === size && was.unit === unit && !isMeasurement(original.serving_label.trim())) {
    return { quantity: count, serving_label: original.serving_label };
  }
  // "slice" with no number reads fine as one serving; anything else says its size.
  const bare = size === 1 && !LEAD.test(original.serving_label.trim()) && was.size === 1;
  return { quantity: count, serving_label: bare ? unit : `${fmt(size)} ${unit}` };
}
