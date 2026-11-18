/**
 * The spotlight tours: the screen goes dark and a lit hole opens around one
 * real control, with a short tip beside it (components/spotlight/ draws it).
 *
 * Two kinds, each shown once per account:
 *  - the intro: three stops on the dashboard the first time a new user lands
 *    there (today's workout, log food, Goal). A tap anywhere moves on.
 *  - hints: one stop, the first time the user reaches that screen for real
 *    (the first set of a workout, the food box, the Goal screen's phase). The
 *    lit control stays live, so the user does the real thing.
 *
 * Pure on purpose (no imports) so `deno test` reaches it.
 *
 * Copy rules (tested): curly apostrophes, no em dashes, a title fits one line
 * and a body fits two.
 */

export type SpotlightTourId = 'intro' | 'workout_set' | 'food_box' | 'goal_plan';
export type SpotlightTargetId = 'today_card' | 'log_food' | 'goal_button' | 'active_set' | 'food_box' | 'phase_card';
/** How the lit hole hugs the control. */
export type SpotlightShape = 'card' | 'pill' | 'circle';

export interface SpotlightStep {
  target: SpotlightTargetId;
  shape: SpotlightShape;
  title: string;
  body: string;
}

export interface SpotlightTour {
  id: SpotlightTourId;
  /** 'intro': taps anywhere move on. 'hint': the lit control stays live. */
  kind: 'intro' | 'hint';
  steps: SpotlightStep[];
}

export const SPOTLIGHT_TITLE_MAX = 28;
export const SPOTLIGHT_BODY_MAX = 64;
/** Accounts older than this never see a tour: they already know the app. */
export const SPOTLIGHT_MAX_ACCOUNT_DAYS = 14;

export const TOURS: Record<SpotlightTourId, SpotlightTour> = {
  intro: {
    id: 'intro',
    kind: 'intro',
    steps: [
      { target: 'today_card', shape: 'card', title: 'Today’s workout', body: 'Your plan for today, always up top. Tap it to start.' },
      { target: 'log_food', shape: 'circle', title: 'Log what you eat', body: 'Just say it. I work out the calories and protein.' },
      { target: 'goal_button', shape: 'pill', title: 'Your goal and plan', body: 'The road to your goal, one phase at a time.' },
    ],
  },
  workout_set: {
    id: 'workout_set',
    kind: 'hint',
    steps: [
      // The tip ends when the keyboard opens, so it says everything up front:
      // the tick first, then the optional edit.
      { target: 'active_set', shape: 'card', title: 'Log your first set', body: 'Tap the tick to log it. Tap a number first to change it.' },
    ],
  },
  food_box: {
    id: 'food_box',
    kind: 'hint',
    steps: [
      { target: 'food_box', shape: 'pill', title: 'Type what you ate', body: 'Like “2 eggs and toast”. I do the rest.' },
    ],
  },
  goal_plan: {
    id: 'goal_plan',
    kind: 'hint',
    steps: [
      { target: 'phase_card', shape: 'card', title: 'Your plan, in phases', body: 'Tap the phase to see what this week asks of you.' },
    ],
  },
};

/** Whether a tour may start now. Only one at a time, and the intro comes first. */
export function canStart(
  id: SpotlightTourId,
  o: { seen: ReadonlySet<string>; active: SpotlightTourId | null; accountAgeDays: number | null },
): boolean {
  if (o.active) return false;
  if (o.seen.has(id)) return false;
  // A hint waits until the intro has ended (finished or skipped).
  if (id !== 'intro' && !o.seen.has('intro')) return false;
  // Unknown age: the account is not loaded yet, so wait.
  if (o.accountAgeDays == null || !Number.isFinite(o.accountAgeDays)) return false;
  if (o.accountAgeDays > SPOTLIGHT_MAX_ACCOUNT_DAYS) return false;
  return true;
}

/**
 * Whether a screen may try its tour yet: this account's seen list is read and
 * the account's date is known (the dev demo needs no date). Screens re-try
 * when this turns true, so a slow cold start never loses the intro.
 */
export function dataLoaded(o: { seenLoaded: boolean; createdAtMs: number | null | undefined; demo: boolean }): boolean {
  if (!o.seenLoaded) return false;
  return o.demo || (o.createdAtMs != null && Number.isFinite(o.createdAtMs));
}

/** Whole days since the account was made, or null when unknown. */
export function accountAgeDays(createdAtMs: number | null | undefined, nowMs: number): number | null {
  if (createdAtMs == null || !Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
  return Math.max(0, (nowMs - createdAtMs) / 86_400_000);
}

export interface Rect { x: number; y: number; width: number; height: number }
export interface Hole extends Rect { r: number }

/** Room between the control and the lit edge. */
export const HOLE_PAD = 8;

/** The lit hole around a measured control. */
export function holeFor(rect: Rect, shape: SpotlightShape, pad = HOLE_PAD): Hole {
  if (shape === 'circle') {
    const d = Math.max(rect.width, rect.height) + pad * 2;
    return {
      x: rect.x + rect.width / 2 - d / 2,
      y: rect.y + rect.height / 2 - d / 2,
      width: d,
      height: d,
      r: d / 2,
    };
  }
  const width = rect.width + pad * 2;
  const height = rect.height + pad * 2;
  const r = shape === 'pill' ? height / 2 : Math.min(22, height / 2);
  return { x: rect.x - pad, y: rect.y - pad, width, height, r };
}

/**
 * A control's window position, moved into the overlay's own space. They match
 * on iOS; on Android edge-to-edge or a status bar can shift the overlay, and
 * the hole would sit off by that much.
 */
export function toOverlay(rect: Rect, origin: { x: number; y: number }): Rect {
  return { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height };
}

/** The control is measured, has a size, and sits fully inside the screen. */
export function onScreen(rect: Rect | null, screenW: number, screenH: number): boolean {
  if (!rect) return false;
  if (!(rect.width > 0 && rect.height > 0)) return false;
  return rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= screenW + 1 && rect.y + rect.height <= screenH + 1;
}

/** Put the tip on the side of the hole with more room. */
export function tipSide(hole: Rect, screenH: number): 'above' | 'below' {
  const above = hole.y;
  const below = screenH - (hole.y + hole.height);
  return below >= above ? 'below' : 'above';
}

/** How a tour ended. 'interrupted': something else took the screen (a popup). */
export type SpotlightEnd = 'finished' | 'skipped' | 'used' | 'outside' | 'left' | 'interrupted';

/**
 * Whether an end uses the tour up. Only the user's own answer does: Next to
 * the end, Skip, Got it, a tap on the dark area, or using the lit control
 * (a screen whose lit control opens another screen reports 'used' first).
 * A tour cut short by a popup, or left behind, shows again next visit.
 */
export function countsAsSeen(_kind: 'intro' | 'hint', how: SpotlightEnd): boolean {
  return how !== 'interrupted' && how !== 'left';
}

/** The step after `index`, or 'done' past the last. */
export function nextStep(index: number, count: number): number | 'done' {
  return index + 1 >= count ? 'done' : index + 1;
}

/** Where the seen tours are kept, per account. */
export function seenKey(userId: string): string {
  return `overload.spotlight.v1.${userId}`;
}

/** The stored list, read defensively: anything odd reads as nothing seen. */
export function parseSeen(raw: string | null | undefined): Set<SpotlightTourId> {
  if (!raw) return new Set();
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return new Set();
    return new Set(v.filter((x): x is SpotlightTourId => typeof x === 'string' && x in TOURS));
  } catch {
    return new Set();
  }
}
