/**
 * The math behind the onboarding weight wheels (components/onboarding/
 * BodyPickers WeightWheel): a whole-number wheel, a one-decimal wheel, and a
 * unit wheel beside them. Pure, so it is tested (lib/weightWheel.test.ts).
 */

export const LBS_PER_KG = 2.20462;

export type WeightUnit = 'kg' | 'lbs';

/**
 * The wheels' range, per display unit. The lbs top is 441, not 440: 200 kg is
 * 440.9 lbs, and a lower top would clamp it, so kg -> lbs -> kg would drift.
 */
export const WEIGHT_WHEEL: Record<WeightUnit, { min: number; max: number }> = {
  kg: { min: 30, max: 200 },
  lbs: { min: 66, max: 441 },
};

/** 72.5 -> whole 72, tenth 5. Values carry one decimal. */
export function splitWeight(value: number): { whole: number; tenth: number } {
  const whole = Math.floor(value + 1e-6);
  const tenth = Math.min(9, Math.max(0, Math.round((value - whole) * 10)));
  return { whole, tenth };
}

/** The two wheels back into one value, kept inside the scale. */
export function joinWeight(whole: number, tenth: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round((whole + tenth / 10) * 10) / 10));
}

/** The decimal wheel's top: none past the top of the scale (200.0 kg is the last stop). */
export function tenthsMax(whole: number, max: number): number {
  return whole >= max ? 0 : 9;
}

/**
 * What a wheel shows for a weight kept in kg: one decimal, inside that unit's
 * wheel. A unit switch starts from the kept kg, not from the other unit's
 * rounded number, so flipping back and forth never drifts.
 */
export function displayFromKg(kg: number, unit: WeightUnit): number {
  const { min, max } = WEIGHT_WHEEL[unit];
  const raw = unit === 'lbs' ? kg * LBS_PER_KG : kg;
  return Math.min(max, Math.max(min, Math.round(raw * 10) / 10));
}

/** A wheel's value back to kg, unrounded. */
export function kgFromDisplay(value: number, unit: WeightUnit): number {
  return unit === 'lbs' ? value / LBS_PER_KG : value;
}
