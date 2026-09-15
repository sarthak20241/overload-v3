/**
 * Bodyweight in the database is always kilograms; the kg/lbs switch only
 * changes what the user types and sees.
 *
 * user_profiles.weight_kg and goal_weight_kg are read as kilograms by the
 * coach context, the onboarding protein and calorie targets, and goal plans.
 * Profile used to save the raw typed number, so "165" on lbs became 165 kg.
 *
 * toKg / fromKg / KG_PER_LB match lib/bodyweightLog.ts on the
 * claude/user-plan-disobedience-b282bf branch (the daily_metrics weight log),
 * so the two agree to the hundredth. When both land, keep one copy.
 *
 * Pure: no imports. Unit-tested in weightUnit.test.ts.
 */

export type WeightUnit = 'kg' | 'lbs';

export const KG_PER_LB = 0.45359237;

/** Outside this range the value is a half-typed number or a slip, not a weigh-in. */
const MIN_KG = 20;
const MAX_KG = 400;

const round1 = (n: number) => Math.round(n * 10) / 10;
// Stored kg keep two decimals: at one, 165 lbs goes in as 74.8 kg and comes back as 164.9.
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A typed value in the user's unit, as kilograms to 0.01. Null when no scale would show it. */
export function toKg(value: number, unit: WeightUnit): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const kg = round2(unit === 'lbs' ? value * KG_PER_LB : value);
  return kg >= MIN_KG && kg <= MAX_KG ? kg : null;
}

/** Stored kilograms in the user's display unit, to 0.1. */
export function fromKg(kg: number, unit: WeightUnit): number {
  return round1(unit === 'lbs' ? kg / KG_PER_LB : kg);
}

/**
 * A stored weight as the text for an input in the user's unit. Empty when
 * nothing is saved. PostgREST can send numeric columns as strings.
 */
export function formatWeight(kg: number | string | null | undefined, unit: WeightUnit): string {
  const n = Number(kg);
  if (kg == null || !Number.isFinite(n) || n <= 0) return '';
  return String(fromKg(n, unit));
}

/**
 * What to save for the text in a weight input. `{ kg: null }` clears the
 * value (the field is empty); `null` means do not save (a half-typed "7" or
 * something that is not a number).
 */
export function parseWeightInput(text: string, unit: WeightUnit): { kg: number | null } | null {
  if (text.trim() === '') return { kg: null };
  const kg = toKg(Number(text.trim().replace(',', '.')), unit);
  return kg == null ? null : { kg };
}

// ─── The device weight log ──────────────────────────────────────────────────
// lib/bodyStats.ts keeps a weight history on the phone (guests, and every user
// until the daily_metrics series lands). Each entry is the number as typed; it
// used to carry no unit, so a switch from lbs to kg read 180 lbs as 180 kg and
// the goal bar showed 92% done for someone who had not moved.

/** A history entry and the unit its number was typed in. */
export interface UnitWeightEntry {
  date: string;
  weight: number;
  unit?: WeightUnit;
}

/**
 * The log with every weight in `unit`. An entry typed in the other unit goes
 * through kilograms at the same rounding as the Profile field, so the history
 * and the field agree (180 lbs shows as 81.7 kg in both). An entry with no unit
 * is taken as already in `unit`; stampLegacyUnits gives old entries one.
 */
export function weightLogInUnit<T extends UnitWeightEntry>(log: T[] | null | undefined, unit: WeightUnit): T[] {
  return (log ?? []).map((e) => {
    if (!e.unit || e.unit === unit) return e;
    const kg = round2(e.unit === 'lbs' ? e.weight * KG_PER_LB : e.weight);
    return { ...e, weight: fromKg(kg, unit), unit };
  });
}

/**
 * Gives entries saved before units were recorded the unit in use now, the best
 * guess available (the log never said). Done once: `changed` tells the caller
 * to save it back, after which a unit switch converts them like any other.
 */
export function stampLegacyUnits<T extends UnitWeightEntry>(
  log: T[] | null | undefined,
  unit: WeightUnit,
): { log: T[]; changed: boolean } {
  if (!Array.isArray(log)) return { log: [], changed: false };
  let changed = false;
  const out = log.map((e) => {
    if (e.unit === 'kg' || e.unit === 'lbs') return e;
    changed = true;
    return { ...e, unit };
  });
  return { log: out, changed };
}
