/**
 * The spotlight tours: the screen goes dark and a lit hole opens around one
 * real control, with a short tip beside it (components/spotlight/ draws it).
 *
 * Onboarding tours, for accounts made on or after SPOTLIGHT_FROM, for their
 * first 14 days (existing users never get them), each shown once:
 *  - the intro: three stops on the dashboard the first time the user lands
 *    there (today's workout, log food, Goal). A tap anywhere moves on.
 *  - hints: one stop, the first time the user reaches that screen for real
 *    (the first set of a workout, the food box, the Goal screen's phase). The
 *    lit control stays live, so the user does the real thing. Hints wait
 *    until the intro has ended.
 *
 * Release tours ("what's new"), for an OTA that adds or moves something: one
 * or more stops on the screen where it lives, shown once to accounts made
 * before the release, within `release.days` of it. To add one:
 *  1. lib/spotlight.ts: add its id to ReleaseTourId, any new control to
 *     SpotlightTargetId, and the tour to RELEASE_TOURS with
 *     `release: { on: '<ship date, YYYY-MM-DD>' }`, its steps and copy.
 *  2. The screen: `const ref = useSpotlightTarget('<target>')` on a plain
 *     View around the control, and `useSpotlightTour('<id>', ready)`. If the
 *     lit control opens another screen, call the returned done() first.
 *  3. Dev: EXPO_PUBLIC_SPOTLIGHT_DEMO=1 shows it on any account.
 *
 * Pure on purpose (no imports) so `deno test` reaches it.
 *
 * Copy rules (tested): curly apostrophes, no em dashes, a title fits one line
 * and a body fits two.
 */

export type OnboardingTourId = 'intro' | 'workout_set' | 'food_box' | 'goal_plan' | 'set_types' | 'food_modes';
/** One per "what's new" tour. None yet: the first OTA that needs one adds it. */
export type ReleaseTourId = never;
export type SpotlightTourId = OnboardingTourId | ReleaseTourId;
export type SpotlightTargetId =
  | 'today_card' | 'log_food' | 'goal_button' | 'active_set' | 'food_box' | 'phase_card'
  | 'set_type' | 'log_mode';
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
  /**
   * A follow-up hint: waits until this tour has ended, so the user learns one
   * thing at a time (set types after the first set, Quick/Precise after the
   * food box).
   */
  after?: SpotlightTourId;
  /**
   * Set on a "what's new" tour: the OTA's ship date (YYYY-MM-DD, UTC) and how
   * many days after it the tour may still show (default 30). Only accounts
   * made before that date get it: to everyone newer it is not new.
   */
  release?: { on: string; days?: number };
}

export const SPOTLIGHT_TITLE_MAX = 28;
export const SPOTLIGHT_BODY_MAX = 64;
/** Onboarding tours: accounts older than this skip them. */
export const SPOTLIGHT_MAX_ACCOUNT_DAYS = 14;
/**
 * Onboarding tours reach only accounts made on or after this date, so people
 * who already use the app never get the beginner tour (owner, 2026-11-18).
 */
export const SPOTLIGHT_FROM = '2026-11-18';
export const SPOTLIGHT_FROM_MS = Date.parse(`${SPOTLIGHT_FROM}T00:00:00Z`);
/** How long a release tour may still show after its OTA, unless it says. */
export const RELEASE_TOUR_DAYS = 30;

const DAY_MS = 86_400_000;

/** "What's new" tours, one per OTA that needs one (see the header). */
export const RELEASE_TOURS: Record<ReleaseTourId, SpotlightTour> = {};

const ONBOARDING_TOURS: Record<OnboardingTourId, SpotlightTour> = {
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
  // Follow-ups: shown once the basic hint is done, so never on a first visit.
  set_types: {
    id: 'set_types',
    kind: 'hint',
    after: 'workout_set',
    steps: [
      { target: 'set_type', shape: 'pill', title: 'Warm-ups and drop sets', body: 'Tap the set number to mark it a warm-up, drop set or failure.' },
    ],
  },
  food_modes: {
    id: 'food_modes',
    kind: 'hint',
    after: 'food_box',
    steps: [
      { target: 'log_mode', shape: 'circle', title: 'Quick or Precise', body: 'Quick is a fast estimate. Precise reads labels on packaged food.' },
    ],
  },
};

export const TOURS: Record<SpotlightTourId, SpotlightTour> = { ...ONBOARDING_TOURS, ...RELEASE_TOURS };

/**
 * Whether a tour may start now. Always: one at a time, each once. Then
 * onboarding tours: new accounts only (see SPOTLIGHT_FROM), and hints after
 * the intro. Release tours: accounts from before the release, in its window.
 * `demo` (dev only) skips the date rules but keeps the order.
 */
export function canStart(
  tour: SpotlightTour,
  o: {
    seen: ReadonlySet<string>;
    active: SpotlightTourId | null;
    createdAtMs: number | null | undefined;
    nowMs: number;
    demo?: boolean;
  },
): boolean {
  if (o.active) return false;
  if (o.seen.has(tour.id)) return false;

  if (tour.release) {
    if (o.demo) return true;
    const on = Date.parse(`${tour.release.on}T00:00:00Z`);
    if (!Number.isFinite(on) || o.createdAtMs == null || !Number.isFinite(o.createdAtMs)) return false;
    if (o.createdAtMs >= on) return false;
    // Inside the window only: never before the release (an early dismiss
    // would use it up), never after it closes.
    return o.nowMs >= on && o.nowMs <= on + (tour.release.days ?? RELEASE_TOUR_DAYS) * DAY_MS;
  }

  // A hint waits until the intro has ended (finished or skipped), and a
  // follow-up until the hint before it has.
  if (tour.id !== 'intro' && !o.seen.has('intro')) return false;
  if (tour.after && !o.seen.has(tour.after)) return false;
  if (o.demo) return true;
  // Unknown date: the account is not loaded yet, so wait.
  if (o.createdAtMs == null || !Number.isFinite(o.createdAtMs)) return false;
  if (o.createdAtMs < SPOTLIGHT_FROM_MS) return false;
  const age = accountAgeDays(o.createdAtMs, o.nowMs);
  return age != null && age <= SPOTLIGHT_MAX_ACCOUNT_DAYS;
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
  return Math.max(0, (nowMs - createdAtMs) / DAY_MS);
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
export function countsAsSeen(how: SpotlightEnd): boolean {
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
    return new Set(v.filter((x): x is SpotlightTourId => typeof x === 'string' && Object.prototype.hasOwnProperty.call(TOURS, x)));
  } catch {
    return new Set();
  }
}

/**
 * What to store: the stored list plus this session's. Saving the union means
 * a failed or stale read can never wipe tours seen before.
 */
export function mergeSeen(storedRaw: string | null | undefined, mine: ReadonlySet<string>): SpotlightTourId[] {
  const all = parseSeen(storedRaw);
  for (const id of mine) if (Object.prototype.hasOwnProperty.call(TOURS, id)) all.add(id as SpotlightTourId);
  return [...all];
}
