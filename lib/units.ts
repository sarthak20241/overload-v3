/**
 * Universal unit conversions (pure math, identical for every food).
 *
 * These are the unit classes that DON'T depend on the food: mass (g/kg/oz/lb) and
 * volume (ml/l/cup/tbsp/tsp). Food-SPECIFIC portions (1 egg, 1 roti, 1 katori,
 * 1 scoop) are NOT here, because their gram weight is intrinsic to the food and
 * lives in that food's `servings` list (see lib/foods.ts). Volume converts to
 * mass only via a per-food density, which the resolver handles.
 */

/** grams per 1 unit of mass. */
export const MASS_UNITS: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
};

/** ml per 1 unit of volume (US customary). */
export const VOLUME_UNITS: Record<string, number> = {
  ml: 1,
  l: 1000,
  cup: 236.588,
  tbsp: 14.7868,
  tsp: 4.92892,
};

export function isMassUnit(unit: string): boolean {
  return unit in MASS_UNITS;
}

export function isVolumeUnit(unit: string): boolean {
  return unit in VOLUME_UNITS;
}

/** Convert a mass quantity to grams. Returns NaN for a non-mass unit. */
export function massToGrams(qty: number, unit: string): number {
  return qty * (MASS_UNITS[unit] ?? NaN);
}

/** Convert a volume quantity to milliliters. Returns NaN for a non-volume unit. */
export function volumeToMl(qty: number, unit: string): number {
  return qty * (VOLUME_UNITS[unit] ?? NaN);
}
