// Numbers the user wrote themselves win over every source (owner decision
// 2026-09-28).
//
// WHY. A user logged "62 g raw, skinless chicken breast. Per 100 g: 130 kcal,
// 22.5 g protein ..." and Precise answered 114.7 (a web lookup), Thorough 106
// (USDA). Only Quick kept her 130, and only because its model reads the whole
// message. Her label is the truth for her pack; a lookup can only be a guess
// about someone else's.
//
// The extract call copies what she wrote into `stated` (never estimates it).
// Here, in code, it becomes per-100 numbers. A full panel (kcal + protein +
// carbs + fat) answers the line in every tier with no lookup at all. A partial
// panel keeps what she gave and lets the tier fill only the missing fields.
// The saved line is 'manual', so her memory (userFoodMemory.ts) then serves
// her numbers in every tier next time, even when she does not repeat them.
//
// Pure: no IO, no Deno globals.

export type StatedBasis = "per_100g" | "per_100ml" | "per_serving" | "total";

/** What the extract call copied from the user's text, as written. */
export interface StatedRaw {
  basis: StatedBasis;
  serving_g: number | null;
  kcal: number | null;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
}

/** The same numbers per 100 g (or ml). null = the user did not give it. */
export interface StatedPer100 {
  kcal: number;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  /** All four of kcal, protein, carbs and fat were given. */
  complete: boolean;
  /** The printed serving, when the basis was one ("1 scoop (30 g)"). */
  serving_g: number | null;
  /** How the card describes the source: "130 kcal per 100 g". */
  label: string;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** Read the extract call's `stated` object; null unless it carries kcal. */
export function readStated(raw: unknown): StatedRaw | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const basis = o.basis;
  if (basis !== "per_100g" && basis !== "per_100ml" && basis !== "per_serving" && basis !== "total") return null;
  const kcal = num(o.kcal);
  if (kcal === null) return null;
  return {
    basis,
    serving_g: num(o.serving_g),
    kcal,
    protein_g: num(o.protein_g),
    carb_g: num(o.carb_g),
    fat_g: num(o.fat_g),
    fiber_g: num(o.fiber_g),
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Per-100 numbers from what the user wrote, or null when they cannot be put on
 * a per-100 basis without guessing: a per-serving panel with no serving weight,
 * or a line total with no weight for the line. `lineGrams` is the line's weight
 * when the user typed it (a mass unit), else null.
 */
export function statedPer100(
  s: StatedRaw,
  lineGrams: number | null,
  /** The parser's own ceiling (PLAUSIBLE.maxKcalPer100), passed in so there
   *  is one definition of "no food carries more". */
  maxKcalPer100 = 920,
): StatedPer100 | null {
  let factor: number;
  let label: string;
  let serving: number | null = null;
  if (s.basis === "per_100g" || s.basis === "per_100ml") {
    factor = 1;
    label = `${r1(s.kcal as number)} kcal per 100 ${s.basis === "per_100ml" ? "ml" : "g"}`;
  } else if (s.basis === "per_serving") {
    if (!s.serving_g || s.serving_g <= 0 || s.serving_g > 2000) return null;
    factor = 100 / s.serving_g;
    serving = s.serving_g;
    label = `${r1(s.kcal as number)} kcal per ${r1(s.serving_g)} g`;
  } else {
    if (!lineGrams || lineGrams <= 0) return null;
    factor = 100 / lineGrams;
    label = `${r1(s.kcal as number)} kcal for ${r1(lineGrams)} g`;
  }
  const scale = (v: number | null) => (v === null ? null : r1(v * factor));
  const kcal = r1((s.kcal as number) * factor);
  // Physics, the parser's own ceilings: no food carries more kcal than
  // maxKcalPer100 or more than 100 g of macros per 100 g. A reading past that
  // is a misread basis (per pack taken as per 100 g), not the user's label.
  if (kcal > maxKcalPer100) return null;
  const out = {
    kcal,
    protein_g: scale(s.protein_g),
    carb_g: scale(s.carb_g),
    fat_g: scale(s.fat_g),
    fiber_g: scale(s.fiber_g),
  };
  if ((out.protein_g ?? 0) + (out.carb_g ?? 0) + (out.fat_g ?? 0) > 105) return null;
  return {
    ...out,
    complete: out.protein_g !== null && out.carb_g !== null && out.fat_g !== null,
    serving_g: serving,
    label,
  };
}

/** Fill the fields the user did not give from another per-100 source. */
export function fillStated(
  s: StatedPer100,
  from: { protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null },
): { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null } {
  return {
    kcal: s.kcal,
    protein_g: s.protein_g ?? from.protein_g,
    carb_g: s.carb_g ?? from.carb_g,
    fat_g: s.fat_g ?? from.fat_g,
    fiber_g: s.fiber_g ?? from.fiber_g,
  };
}

/** The card's note: whose numbers these are. */
export function statedNote(s: StatedPer100, filled: "looked up" | "estimated" = "looked up"): string {
  return s.complete ? `Your numbers: ${s.label}` : `Your numbers: ${s.label}, the rest ${filled}`;
}
