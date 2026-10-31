/**
 * A meal Drona is still working out, and the moment it is ready.
 *
 * Send opens a calm wait sheet on Nutrition, but nothing ties the user to it:
 * they can close the sheet, switch tabs or put the phone down and the parse
 * keeps going. When it lands, one of three things happens (arrivalAction):
 *   - they are watching (the sheet or the result is up on Nutrition, app in
 *     front): the full-screen result opens;
 *   - they are somewhere else in the app: a toast says it is ready, and a tap
 *     opens the result;
 *   - the app is in the background: the same toast waits for the next time
 *     the app comes to the front.
 * Either way the result waits on Nutrition until it is added or discarded.
 *
 * A waiting result also outlives the app process (packReady / unpackReady):
 * a meal the user has not added yet is work they would otherwise retype.
 *
 * The inline amount steppers live here too (stepAmount / scaleLine): one tap
 * on - or + changes how much was eaten, and every number on the line moves
 * with it.
 *
 * No imports, so Deno can test it directly: deno test lib/mealReady.test.ts
 */

/** Same union as lib/foods MealType, kept local so this file stays import-free. */
export type ReadyMealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface Watching {
  /** The wait sheet is up. */
  sheetOpen: boolean;
  /** The full-screen result is up (a correction is being read). */
  resultOpen: boolean;
  /** Nutrition is the screen in front. */
  screenFocused: boolean;
  /** The app itself is in front. */
  appActive: boolean;
}

export type Arrival = 'show' | 'tell' | 'tell_later';

/** What to do when a parse lands. Closing the sheet is the user saying "not
 *  now", so a closed sheet on Nutrition still gets the toast rather than a
 *  screen that jumps up over the diary. */
export function arrivalAction(w: Watching): Arrival {
  if (!w.appActive) return 'tell_later';
  if (w.screenFocused && (w.sheetOpen || w.resultOpen)) return 'show';
  return 'tell';
}

/** What the landed parse turned out to be. */
export type ReadyKind = 'review' | 'logged' | 'reply' | 'error';

const MEAL_WORD: Record<ReadyMealType, string> = {
  breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'snack',
};

/** The toast's words. `meals` is every section the meal goes to: one names
 *  it ("Your lunch"), more than one says meals. */
export function readyLine(kind: ReadyKind, meals: ReadyMealType[]): string {
  const uniq = [...new Set(meals)];
  const what = uniq.length === 1 ? `Your ${MEAL_WORD[uniq[0]]}` : uniq.length > 1 ? 'Your meals' : 'Your food';
  switch (kind) {
    case 'review': return `${what} ${uniq.length > 1 ? 'are' : 'is'} ready to check.`;
    case 'logged': return `${what} ${uniq.length > 1 ? 'are' : 'is'} in your diary.`;
    case 'reply': return 'Drona has a question about your food.';
    case 'error': return 'Drona could not read that one.';
  }
}

/** The toast's button. */
export function readyAction(kind: ReadyKind): string {
  switch (kind) {
    case 'review': return 'Check';
    case 'logged': return 'View';
    case 'reply':
    case 'error': return 'Open';
  }
}

// ── Keeping a waiting result across an app restart ──────────────────────────

/** A result nobody added in a day is no longer about what they just ate. */
export const READY_MAX_AGE_MS = 24 * 60 * 60_000;

const VERSION = 1;

interface Packed<T> { v: number; at: number; flow: T }

/** The minimum a stored result needs to be shown again. */
export interface ReadyShape {
  status: 'review';
  raw: string;
  meal: { items: unknown[] };
  mealType: string;
}

function isReadyShape(x: unknown): x is ReadyShape {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  const meal = f.meal as Record<string, unknown> | undefined;
  return f.status === 'review'
    && typeof f.raw === 'string'
    && typeof f.mealType === 'string' && f.mealType in MEAL_WORD
    && !!meal && Array.isArray(meal.items) && meal.items.length > 0;
}

/** The waiting result, ready for storage. */
export function packReady<T extends ReadyShape>(flow: T, now: number = Date.now()): string {
  const p: Packed<T> = { v: VERSION, at: now, flow };
  return JSON.stringify(p);
}

/** A stored result to show again, or null when there is none, it is too old,
 *  or it is not a shape this build can draw. Never throws. */
export function unpackReady<T extends ReadyShape>(raw: string | null | undefined, now: number = Date.now()): T | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Packed<unknown>;
    if (!p || p.v !== VERSION || typeof p.at !== 'number') return null;
    if (now - p.at > READY_MAX_AGE_MS || p.at > now + 60_000) return null;
    return isReadyShape(p.flow) ? (p.flow as T) : null;
  } catch {
    return null;
  }
}

// ── The inline amount steppers ──────────────────────────────────────────────

/** One - or + on a line's amount. A bare measurement ("150 g") moves in
 *  steps that suit its size; a named serving ("2 x 1 roti") moves by a half.
 *  Never below one step: zero of a food is a Remove, not an amount. */
export function stepAmount(quantity: number, isMeasurement: boolean, dir: 1 | -1): number {
  const q = quantity > 0 ? quantity : 1;
  const step = isMeasurement ? (q >= 500 ? 50 : q >= 100 ? 10 : 5) : 0.5;
  // Snap to the step grid first, so 1.3 servings goes to 1.5 or 1, not 1.8.
  const snapped = dir > 0 ? Math.floor(q / step + 1e-9) * step + step : Math.ceil(q / step - 1e-9) * step - step;
  return Math.max(step, Math.round(snapped * 1000) / 1000);
}

/** The numbers a line carries that scale with how much was eaten. */
export interface AmountLine {
  quantity: number;
  grams: number;
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The line at a new amount. Every number moves by the same ratio, the way
 *  the editor's own portion change does, so the line stays the same food
 *  with the same receipts (source, notes, swap options priced by grams). */
export function scaleLine<T extends AmountLine>(line: T, quantity: number): T {
  if (!(quantity > 0) || !(line.quantity > 0) || quantity === line.quantity) return line;
  const k = quantity / line.quantity;
  return {
    ...line,
    quantity,
    grams: r1(line.grams * k),
    kcal: Math.round(line.kcal * k),
    protein_g: r1(line.protein_g * k),
    carb_g: r1(line.carb_g * k),
    fat_g: r1(line.fat_g * k),
    fiber_g: line.fiber_g == null ? null : r1(line.fiber_g * k),
  };
}
