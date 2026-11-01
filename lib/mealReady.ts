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

/** Where a landed parse is shown, and when. `meal_ready_shown` fires at that
 *  moment, not when the parse lands: a toast held for the app's return is
 *  not seen until the app is back, and never if a newer one replaces it.
 *   - result: the full-screen result opens now;
 *   - box: a reply, failure or logged meal shows above the food box now;
 *   - toast: the toast, now or on the return. */
export interface ShowPlan { via: 'result' | 'box' | 'toast'; when: 'now' | 'on_return' }

export function showPlan(kind: ReadyKind, how: Arrival): ShowPlan {
  if (how === 'show') return { via: kind === 'review' ? 'result' : 'box', when: 'now' };
  return { via: 'toast', when: how === 'tell_later' ? 'on_return' : 'now' };
}

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

const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n);

/** A line the result screen can draw: it adds up and rounds these numbers
 *  on every render, so one bad line would crash it on every launch, the
 *  restore being the first thing the screen does. */
function isReadyItem(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const it = x as Record<string, unknown>;
  return typeof it.food_name === 'string' && typeof it.serving_label === 'string'
    && num(it.quantity) && num(it.grams) && num(it.kcal)
    && num(it.protein_g) && num(it.carb_g) && num(it.fat_g)
    && (it.fiber_g == null || num(it.fiber_g));
}

function isReadyShape(x: unknown): x is ReadyShape {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  const meal = f.meal as Record<string, unknown> | undefined;
  return f.status === 'review'
    && typeof f.raw === 'string'
    && typeof f.mealType === 'string' && f.mealType in MEAL_WORD
    && !!meal && Array.isArray(meal.items) && meal.items.length > 0
    && meal.items.every(isReadyItem);
}

/** The waiting result, ready for storage. */
export function packReady<T extends ReadyShape>(flow: T, now: number = Date.now()): string {
  const p: Packed<T> = { v: VERSION, at: now, flow };
  return JSON.stringify(p);
}

/** The waiting result as Add starts writing it. Stored before the write, so
 *  an app killed after the write lands, but before the store is cleared,
 *  does not bring the meal back as if it had never been added. */
export function packAdding<T extends ReadyShape>(flow: T, now: number = Date.now()): string {
  return packReady({ ...flow, adding: true }, now);
}

/** The note on a meal that was being added when the app closed. Its lines
 *  may be in the diary already, so Add is no longer a safe tap by itself. */
export const MAYBE_ADDED_NOTICE =
  'The app closed while this was going in, so it may already be in your diary. Check your meals before you add it again.';

/** A stored result to show again, or null when there is none, it is too old,
 *  or it is not a shape this build can draw. Never throws. A meal stored
 *  mid-Add comes back with MAYBE_ADDED_NOTICE in place of any other note. */
export function unpackReady<T extends ReadyShape>(raw: string | null | undefined, now: number = Date.now()): T | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Packed<unknown>;
    if (!p || p.v !== VERSION || typeof p.at !== 'number') return null;
    if (now - p.at > READY_MAX_AGE_MS || p.at > now + 60_000) return null;
    if (!isReadyShape(p.flow)) return null;
    const { adding, ...flow } = p.flow as ReadyShape & { adding?: unknown };
    return (adding === true ? { ...flow, notice: MAYBE_ADDED_NOTICE, proposal: null } : flow) as unknown as T;
  } catch {
    return null;
  }
}

/** The parts of the screen's flow the store reads. Loose on purpose: the
 *  screen's own union is wider and stays in nutrition.tsx. */
export interface StoreFlow {
  status: string;
  raw?: string;
  meal?: { items: unknown[] } | null;
  mealType?: string;
  message?: string;
  [k: string]: unknown;
}

export type StoreStep =
  | { kind: 'skip' }
  | { kind: 'keep' }
  | { kind: 'clear' }
  | { kind: 'save'; flow: ReadyShape & Record<string, unknown> };

/** What the stored meal should do after the screen's flow changes.
 *
 *  - skip: no account yet, or this account's stored meal has not been read
 *    back. Writing now could overwrite it, or file the last account's meal
 *    under the new one's key.
 *  - save: a meal is waiting for the user. A failed Add counts too: the meal
 *    is still theirs to add, so it is stored as waiting, with the failure as
 *    its note.
 *  - clear: the card is finished, but only once no Add is still writing.
 *    The flow goes idle the moment Add is tapped, before the write lands, so
 *    clearing then would lose the meal to a write that fails or an app that
 *    dies mid-write.
 *  - keep: anything in between (a correction being read, a reply, a
 *    "Just log it" send) leaves the stored meal as it is. */
export function readyStoreStep(
  flow: StoreFlow,
  ctx: { key: string | null; restoredKey: string | null; adding: boolean },
): StoreStep {
  if (!ctx.key || ctx.restoredKey !== ctx.key) return { kind: 'skip' };
  if (flow.status === 'review' && isReadyShape(flow)) return { kind: 'save', flow: flow as ReadyShape & Record<string, unknown> };
  if (flow.status === 'error' && flow.meal && Array.isArray(flow.meal.items) && flow.meal.items.length > 0) {
    const { message, clientId: _c, logDate: _l, ...rest } = flow;
    const waiting: Record<string, unknown> = { ...rest, status: 'review', notice: message ?? null };
    if (isReadyShape(waiting)) return { kind: 'save', flow: waiting as unknown as ReadyShape & Record<string, unknown> };
  }
  if (flow.status === 'idle' || flow.status === 'create') return ctx.adding ? { kind: 'keep' } : { kind: 'clear' };
  return { kind: 'keep' };
}

// ── The inline amount steppers ──────────────────────────────────────────────

/** One - or + on a line's amount. A bare measurement ("150 g") moves in
 *  steps that suit its size; a named serving ("2 x 1 roti") moves by a half.
 *  Never below one step: zero of a food is a Remove, not an amount. An
 *  amount already at or under one step stays put on -, since rising to the
 *  step (3 g to 5 g) is a + the user never asked for. */
export function stepAmount(quantity: number, isMeasurement: boolean, dir: 1 | -1): number {
  const q = quantity > 0 ? quantity : 1;
  const step = isMeasurement ? (q >= 500 ? 50 : q >= 100 ? 10 : 5) : 0.5;
  // Snap to the step grid first, so 1.3 servings goes to 1.5 or 1, not 1.8.
  const snapped = dir > 0 ? Math.floor(q / step + 1e-9) * step + step : Math.ceil(q / step - 1e-9) * step - step;
  const next = Math.max(step, Math.round(snapped * 1000) / 1000);
  return dir < 0 && next >= q ? q : next;
}

/** The numbers a line carries that scale with how much was eaten. */
export interface AmountNumbers {
  quantity: number;
  grams: number;
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null;
}

/** A line that can be stepped. `amount_base` is the line as first seen, so
 *  every step scales from it and - after + lands on the same numbers. */
export interface AmountLine extends AmountNumbers {
  amount_base?: AmountNumbers;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function snapshot(l: AmountNumbers): AmountNumbers {
  return {
    quantity: l.quantity, grams: l.grams, kcal: l.kcal,
    protein_g: l.protein_g, carb_g: l.carb_g, fat_g: l.fat_g, fiber_g: l.fiber_g,
  };
}

/** The base at a quantity. Back at the base's own quantity it is the base,
 *  exactly, not a rounded copy of it. */
function at(base: AmountNumbers, quantity: number): AmountNumbers {
  if (quantity === base.quantity) return snapshot(base);
  const k = quantity / base.quantity;
  return {
    quantity,
    grams: r1(base.grams * k),
    kcal: Math.round(base.kcal * k),
    protein_g: r1(base.protein_g * k),
    carb_g: r1(base.carb_g * k),
    fat_g: r1(base.fat_g * k),
    fiber_g: base.fiber_g == null ? null : r1(base.fiber_g * k),
  };
}

/** The stored base still describes this line: the line's numbers are what
 *  the base gives at the line's quantity. An edit, a swap or a correction
 *  changes the numbers, and the base then starts over from the new line. */
function baseFits(line: AmountNumbers, base: AmountNumbers): boolean {
  if (!(base.quantity > 0)) return false;
  const want = at(base, line.quantity);
  return want.grams === line.grams && want.kcal === line.kcal && want.protein_g === line.protein_g
    && want.carb_g === line.carb_g && want.fat_g === line.fat_g && want.fiber_g === line.fiber_g;
}

/** The line at a new amount. Every number moves by the same ratio, the way
 *  the editor's own portion change does, so the line stays the same food
 *  with the same receipts (source, notes, swap options priced by grams).
 *  Scaled from the line as first seen, not from the last rounded step, so
 *  + then - returns the original numbers. */
export function scaleLine<T extends AmountLine>(line: T, quantity: number): T {
  if (!(quantity > 0) || !(line.quantity > 0) || quantity === line.quantity) return line;
  const base = line.amount_base && baseFits(line, line.amount_base) ? line.amount_base : snapshot(line);
  return { ...line, ...at(base, quantity), amount_base: base };
}

/** The Add button. A meal for any day but today says which day, so a meal
 *  restored the morning after is never added to yesterday silently. */
export function addLabel(destination: string, dayLabel: string): string {
  return dayLabel === 'Today' ? `Add to ${destination}` : `Add to ${destination} · ${dayLabel}`;
}

/** The account a restored meal belongs to, after the signed-in key changes.
 *  Any change, a sign-out included, means this account's meal has not been
 *  read back yet: signing back in as the same account must not find "already
 *  read" and clear the store while the read is still out. */
export function settleRestoredKey(restoredKey: string | null, key: string | null): string | null {
  return restoredKey === key ? restoredKey : null;
}
