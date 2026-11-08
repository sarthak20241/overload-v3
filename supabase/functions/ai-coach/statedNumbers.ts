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

// ── Totals: numbers for a whole line or a whole meal ────────────────────────
//
// WHY. Per-100 is not the only way people give numbers. The same user wrote
// "roughly 500 cal for dinner having 12g protein, rest fats and carbs (chicken
// curry, poha, rice, salad and watermelon)" and Precise logged 905 kcal and
// 50 g protein: the numbers were for the meal, not for one food, so nothing
// read them. And "daliya, roughly 80 cal, 1g protein" is a total for one line
// with no weight, which statedPer100 rightly refuses to turn into per-100.
//
// A line total is applied to the line itself, never divided by a guessed
// weight: the line's numbers ARE the user's, whatever it weighs. A meal total
// over several foods is split across them (owner decision 2026-10-11): every
// food stays its own line, each scaled to its share so the meal adds up to the
// user's total. Those shares are our arithmetic, not the user's numbers, so the
// parser saves them at the lowest trust: the user's memory may reuse one only
// in Quick and only when nothing better exists.

/** Numbers the user wrote as a total, for one line or for the whole meal. */
export interface StatedTotal {
  kcal: number | null;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
}

/** No line or meal anyone logs carries more. A bigger number is a misread
 *  (a day's total, a pack's), not the user's meal. */
const MAX_TOTAL_KCAL = 5000;
const MAX_TOTAL_MACRO_G = 500;

function boundedTotal(t: StatedTotal): StatedTotal | null {
  if (t.kcal === null && t.protein_g === null && t.carb_g === null && t.fat_g === null) return null;
  if (t.kcal !== null && t.kcal > MAX_TOTAL_KCAL) return null;
  for (const v of [t.protein_g, t.carb_g, t.fat_g, t.fiber_g]) if (v !== null && v > MAX_TOTAL_MACRO_G) return null;
  return t;
}

/** Read the extract call's `stated_meal_total`; null unless it carries a number. */
export function readStatedTotal(raw: unknown): StatedTotal | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return boundedTotal({
    kcal: num(o.kcal),
    protein_g: num(o.protein_g),
    carb_g: num(o.carb_g),
    fat_g: num(o.fat_g),
    fiber_g: num(o.fiber_g),
  });
}

/**
 * The line total a `stated` panel gives when it cannot go per-100: a total
 * with no typed weight ("1 bar, 200 kcal"), or a per-serving panel with no
 * serving weight, times the servings eaten ("2 scoops, 120 kcal a scoop").
 * null for everything statedPer100 already handles.
 */
export function statedLineTotal(s: StatedRaw, quantity: number, massUnit: boolean): StatedTotal | null {
  let k: number;
  if (s.basis === "total") {
    if (massUnit) return null; // a typed weight: statedPer100 owns it
    k = 1;
  } else if (s.basis === "per_serving" && !s.serving_g && !massUnit) {
    k = quantity > 0 ? quantity : 1;
  } else return null;
  const m = (v: number | null) => (v === null ? null : r1(v * k));
  return boundedTotal({ kcal: m(s.kcal), protein_g: m(s.protein_g), carb_g: m(s.carb_g), fat_g: m(s.fat_g), fiber_g: m(s.fiber_g) });
}

/** "Your numbers: 500 kcal, 12 g protein for the meal, the rest estimated". */
export function totalNote(t: StatedTotal, scope: "line" | "meal"): string {
  const parts: string[] = [];
  if (t.kcal !== null) parts.push(`${r1(t.kcal)} kcal`);
  if (t.protein_g !== null) parts.push(`${r1(t.protein_g)} g protein`);
  if (t.carb_g !== null) parts.push(`${r1(t.carb_g)} g carbs`);
  if (t.fat_g !== null) parts.push(`${r1(t.fat_g)} g fat`);
  const all = t.protein_g !== null && t.carb_g !== null && t.fat_g !== null;
  return `Your numbers: ${parts.join(", ")} for ${scope === "meal" ? "the meal" : "this line"}${all ? "" : ", the rest estimated"}`;
}

/** The macro fields a line carries. */
export interface LineMacros {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
}

/** What is left of a meal total once the lines that already carry the user's
 *  own numbers are taken out. null when those lines already exceed it. */
export function remainingTotal(t: StatedTotal, fixed: LineMacros[]): StatedTotal | null {
  const less = (v: number | null, pick: (l: LineMacros) => number | null) => {
    if (v === null) return null;
    return r1(v - fixed.reduce((a, l) => a + (pick(l) ?? 0), 0));
  };
  const out = {
    kcal: less(t.kcal, (l) => l.kcal),
    protein_g: less(t.protein_g, (l) => l.protein_g),
    carb_g: less(t.carb_g, (l) => l.carb_g),
    fat_g: less(t.fat_g, (l) => l.fat_g),
    fiber_g: less(t.fiber_g, (l) => l.fiber_g),
  };
  for (const v of Object.values(out)) if (v !== null && v < 0) return null;
  return out;
}

/**
 * The line with the user's totals. Every number the user gave is kept exactly.
 * The macros they did not give take what energy is left of their kcal, in the
 * same proportion the line already had, so the line still adds up (4/4/9) and
 * "rest fats and carbs" means the rest. With no kcal given, the kcal moves by
 * the energy of the macros they changed. Fiber, when not given, moves with the
 * carbs it is part of, and never exceeds them.
 */
export function honourLineTotals<T extends LineMacros>(line: T, t: StatedTotal): T {
  const P = t.protein_g ?? line.protein_g;
  const C = t.carb_g ?? line.carb_g;
  const F = t.fat_g ?? line.fat_g;
  let out = { protein_g: P, carb_g: C, fat_g: F };
  let kcal: number;
  if (t.kcal !== null) {
    kcal = t.kcal;
    const missing = ([["protein_g", 4], ["carb_g", 4], ["fat_g", 9]] as const)
      .filter(([k]) => t[k] === null);
    if (missing.length) {
      const given = 4 * (t.protein_g ?? 0) + 4 * (t.carb_g ?? 0) + 9 * (t.fat_g ?? 0);
      const left = Math.max(0, t.kcal - given);
      const energy = missing.map(([k, a]) => Math.max(0, line[k]) * a);
      const sum = energy.reduce((a, b) => a + b, 0);
      out = { ...out };
      missing.forEach(([k, a], i) => {
        const share = sum > 0 ? energy[i] / sum : 1 / missing.length;
        out[k] = left * share / a;
      });
    }
  } else {
    kcal = Math.max(0, line.kcal + 4 * (P - line.protein_g) + 4 * (C - line.carb_g) + 9 * (F - line.fat_g));
  }
  const carbs = r1(out.carb_g);
  let fiber = t.fiber_g ?? line.fiber_g;
  if (t.fiber_g === null && fiber !== null && line.carb_g > 0) fiber = Math.min(carbs, fiber * (out.carb_g / line.carb_g));
  return {
    ...line,
    kcal: r1(kcal),
    protein_g: r1(out.protein_g),
    carb_g: carbs,
    fat_g: r1(out.fat_g),
    fiber_g: fiber === null ? null : r1(fiber),
  };
}

/**
 * A meal total split across its lines, in code (the model only copies the
 * numbers). Each line takes the share of the kcal it already had, and of each
 * macro the user gave, the share of that macro it already had; honourLineTotals
 * then fits the rest of each line. Rounding is settled on the biggest line, so
 * the lines add up to the user's numbers exactly. `ratio` is each line's new
 * kcal over its old: the caller scales grams and quantity by it, so every food
 * keeps a believable density and the meal reads as smaller portions.
 */
export function splitTotal<T extends LineMacros>(lines: T[], t: StatedTotal): { line: T; ratio: number }[] {
  if (lines.length === 0) return [];
  const total = (pick: (l: LineMacros) => number) => lines.reduce((a, l) => a + Math.max(0, pick(l)), 0);
  const kcal0 = total((l) => l.kcal);
  const shareOf = (pick: (l: LineMacros) => number) => {
    const s = total(pick);
    return lines.map((l) => (s > 0 ? Math.max(0, pick(l)) / s : kcal0 > 0 ? Math.max(0, l.kcal) / kcal0 : 1 / lines.length));
  };
  const w = shareOf((l) => l.kcal), wp = shareOf((l) => l.protein_g), wc = shareOf((l) => l.carb_g);
  const wf = shareOf((l) => l.fat_g), wfi = shareOf((l) => l.fiber_g ?? 0);
  const part = (v: number | null, s: number) => (v === null ? null : v * s);
  const out = lines.map((l, i) => honourLineTotals(l, {
    kcal: part(t.kcal, w[i]),
    protein_g: part(t.protein_g, wp[i]),
    carb_g: part(t.carb_g, wc[i]),
    fat_g: part(t.fat_g, wf[i]),
    fiber_g: part(t.fiber_g, wfi[i]),
  }));
  // Settle rounding on the biggest line so the sums are the user's numbers.
  const big = out.reduce((b, l, i) => (l.kcal > out[b].kcal ? i : b), 0);
  for (const k of ["kcal", "protein_g", "carb_g", "fat_g"] as const) {
    if (t[k] === null) continue;
    const drift = r1((t[k] as number) - out.reduce((a, l) => a + l[k], 0));
    if (drift !== 0) out[big] = { ...out[big], [k]: r1(Math.max(0, out[big][k] + drift)) };
  }
  return out.map((line, i) => ({ line, ratio: lines[i].kcal > 0 ? line.kcal / lines[i].kcal : 1 }));
}

/** The card note on a line scaled to fit a meal total. */
export function shareNote(t: StatedTotal, scope: "meal" | "foods" = "meal"): string {
  const parts: string[] = [];
  if (t.kcal !== null) parts.push(`${r1(t.kcal)} kcal`);
  if (t.protein_g !== null) parts.push(`${r1(t.protein_g)} g protein`);
  if (t.carb_g !== null) parts.push(`${r1(t.carb_g)} g carbs`);
  if (t.fat_g !== null) parts.push(`${r1(t.fat_g)} g fat`);
  return `Scaled to fit your ${scope === "foods" ? "total for these foods" : "meal total"}: ${parts.join(", ")}`;
}

// ── The portion behind the user's numbers ───────────────────────────────────
//
// "150 cals of atta bread" names the energy and no weight. The kcal is the
// user's; the weight is ours to find. A food keeps its own density (the label,
// the catalog row or the estimate it was priced from), so the portion is the
// one that carries the user's numbers at that density: 150 kcal of a 252 kcal
// per 100 g bread is about 60 g. Keeping the looked-up weight instead (a
// label's "1 piece (40 g)", a 100 g default) and only swapping the kcal gives
// a food no label prints (2026-11-08: 150 kcal in 40 g, 375 per 100 g).

/** Words that name energy, not a portion. "150 kcal" of a food is its energy:
 *  never 150 portions. kJ converts at 4.184. */
const ENERGY_UNITS: Record<string, number> = {
  kcal: 1, kcals: 1, cal: 1, cals: 1, calorie: 1, calories: 1, kilocalorie: 1, kilocalories: 1,
  kj: 1 / 4.184, kjs: 1 / 4.184, kilojoule: 1 / 4.184, kilojoules: 1 / 4.184,
};

/** The kcal an amount names when its unit is energy ("150", "kcal" = 150),
 *  else null. */
export function energyUnitKcal(quantity: number, unit: string | null | undefined): number | null {
  const k = ENERGY_UNITS[(unit ?? "").trim().toLowerCase().replace(/\.$/, "")];
  return k !== undefined && Number.isFinite(quantity) && quantity > 0 ? r1(quantity * k) : null;
}

/** How much a line's portion must change to carry the user's numbers at its
 *  own density: their kcal over its kcal, or with no kcal given, the energy of
 *  the macros they gave over the same macros' energy on the line. null when
 *  the line has nothing to measure against (0 kcal, no such macros). */
export function statedPortionRatio(line: LineMacros, t: StatedTotal): number | null {
  let ratio: number | null = null;
  if (t.kcal !== null) {
    ratio = line.kcal > 0 ? t.kcal / line.kcal : null;
  } else {
    const parts = ([["protein_g", 4], ["carb_g", 4], ["fat_g", 9]] as const).filter(([k]) => t[k] !== null);
    const given = parts.reduce((a, [k, w]) => a + (t[k] as number) * w, 0);
    const had = parts.reduce((a, [k, w]) => a + Math.max(0, line[k]) * w, 0);
    ratio = parts.length && had > 0 ? given / had : null;
  }
  return ratio !== null && Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/** How far the user's numbers may move a line's portion, either way. */
const MAX_PORTION_RATIO = 10;

/** A line that can be weighed: its amount as shown and its grams. */
export interface PortionLine extends LineMacros {
  quantity: number;
  serving_label: string;
  grams: number;
}

const WEIGHT_IN_LABEL = /\s*\(\s*\d+(?:\.\d+)?\s*(?:g|gm|gms|grams?|ml)\s*\)/gi;
const LIQUID_LABELS = new Set(["ml", "millilitre", "milliliter", "millilitres", "milliliters"]);
const WEIGHT_LABELS = new Set(["g", "gm", "gms", "gram", "grams", ...LIQUID_LABELS]);

/** A unit that is itself a weight or volume ("g", "ml"): its quantity IS the
 *  grams, so it is never a count to keep while the grams move. */
export function isWeightLabel(label: string): boolean {
  return WEIGHT_LABELS.has(label.trim().toLowerCase());
}

/**
 * The line carrying the user's numbers at a portion that fits them. Every
 * number the user gave is kept exactly (honourLineTotals); the macros they did
 * not give come from the line's own food at that portion. The grams follow the
 * ratio. `amountTyped` says whether the user named an amount ("2 slices"):
 * that amount stays and only the weight moves, with any weight printed in the
 * label dropped, since it no longer holds. With no amount named, the line is
 * shown by weight ("60 g"). A line with nothing to measure against keeps its
 * portion and simply takes the numbers.
 */
export function fitPortionToStated<T extends PortionLine>(line: T, t: StatedTotal, amountTyped: boolean): T {
  // A weight the user typed ("100 g, 150 kcal") is theirs as much as the kcal:
  // both stay, and the line simply takes their numbers.
  if (amountTyped && isWeightLabel(line.serving_label)) return honourLineTotals(line, t);
  const ratio = statedPortionRatio(line, t);
  // Far past what any portion moves by, the line's own numbers are the
  // problem (a trace-kcal default, a misread), not a density to trust: the
  // line takes the user's numbers and keeps its portion.
  if (ratio === null || !(line.grams > 0) || Math.abs(ratio - 1) < 0.01 || ratio > MAX_PORTION_RATIO || ratio < 1 / MAX_PORTION_RATIO) {
    return honourLineTotals(line, t);
  }
  const m = (v: number) => v * ratio;
  const scaled: T = {
    ...line,
    kcal: m(line.kcal),
    protein_g: m(line.protein_g),
    carb_g: m(line.carb_g),
    fat_g: m(line.fat_g),
    fiber_g: line.fiber_g === null ? null : m(line.fiber_g),
  };
  const grams = r1(line.grams * ratio);
  const unit = line.serving_label.trim().toLowerCase();
  const portion = amountTyped && energyUnitKcal(line.quantity, line.serving_label) === null
    ? { quantity: line.quantity, serving_label: line.serving_label.replace(WEIGHT_IN_LABEL, "").trim() || line.serving_label }
    : { quantity: grams, serving_label: LIQUID_LABELS.has(unit) ? "ml" : "g" };
  return { ...honourLineTotals(scaled, t), ...portion, grams };
}

/**
 * The user's own numbers on a card line, read back off the note totalNote
 * wrote ("Your numbers: 150 kcal for this line, the rest estimated"), or off
 * an amount whose unit is energy ("150 kcal"). Cards carry no other record of
 * which numbers are the user's, so an edit can keep them. null when neither.
 */
export function userNumbersOnLine(l: { quantity: number; serving_label: string; assumption?: string | null }): StatedTotal | null {
  const kcal = energyUnitKcal(l.quantity, l.serving_label);
  if (kcal !== null) return { kcal, protein_g: null, carb_g: null, fat_g: null, fiber_g: null };
  const m = /^Your numbers: (.+?) for (?:this line|the meal)\b/.exec(l.assumption ?? "");
  if (!m) return null;
  const read = (re: RegExp) => {
    const x = re.exec(m[1]);
    return x ? Number(x[1]) : null;
  };
  return boundedTotal({
    kcal: read(/(\d+(?:\.\d+)?) kcal/),
    protein_g: read(/(\d+(?:\.\d+)?) g protein/),
    carb_g: read(/(\d+(?:\.\d+)?) g carbs/),
    fat_g: read(/(\d+(?:\.\d+)?) g fat/),
    fiber_g: null,
  });
}

/**
 * An extracted amount whose unit is energy ("150 cals of atta bread" read as
 * 150 x "kcal") moved to where it belongs: the user's own kcal for the line,
 * with no amount named (1 serving), so the portion is found from the food.
 * The user's own numbers, when the model also copied them, win.
 */
export function energyAmountAsStated(
  quantity: number,
  unit: string,
  stated: StatedRaw | null,
): { quantity: number; unit: string; stated: StatedRaw | null } {
  const kcal = energyUnitKcal(quantity, unit);
  if (kcal === null) return { quantity, unit, stated };
  return {
    quantity: 1,
    unit: "serving",
    // The model's own copy of the user's numbers wins; the energy amount fills
    // in its kcal when that copy has none.
    // Filled that way it is a line total: the energy amount was never a
    // per-100 or per-serving figure.
    stated: stated
      ? (stated.kcal !== null ? stated : { ...stated, basis: "total", serving_g: null, kcal })
      : { basis: "total", serving_g: null, kcal, protein_g: null, carb_g: null, fat_g: null, fiber_g: null },
  };
}

/** Does a card line show an amount the user named ("2 slice"), rather than
 *  the no-amount default (1 "serving", "1 serving (50 g)") or an energy read
 *  as an amount ("150 kcal")? */
export function lineAmountNamed(l: { quantity: number; serving_label: string }): boolean {
  if (energyUnitKcal(l.quantity, l.serving_label) !== null) return false;
  const label = l.serving_label.trim().toLowerCase().replace(WEIGHT_IN_LABEL, "").trim();
  return !(l.quantity === 1 && (label === "serving" || label === "1 serving"));
}

/** The numbers in a total, said plainly: "150 kcal, 12 g protein". */
export function totalParts(t: StatedTotal): string {
  const parts: string[] = [];
  if (t.kcal !== null) parts.push(`${r1(t.kcal)} kcal`);
  if (t.protein_g !== null) parts.push(`${r1(t.protein_g)} g protein`);
  if (t.carb_g !== null) parts.push(`${r1(t.carb_g)} g carbs`);
  if (t.fat_g !== null) parts.push(`${r1(t.fat_g)} g fat`);
  return parts.join(", ");
}
