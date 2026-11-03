/**
 * The sign-up tour: five full-screen film scenes that play right after a new
 * account is made, on top of the Goal screen while phase 1 builds underneath
 * (components/onboarding/SignupTour.tsx draws it). Pure on purpose (no
 * imports) so `deno test` reaches it.
 *
 * Copy rules (tested): curly apostrophes, since the headline face draws a
 * straight one as a tick; no em dashes; a headline fits two lines, the grey line
 * under it fits two more. The last scene makes no promise that the plan is
 * done, because the build may still be running when it shows.
 */

export type TourSceneId = 'welcome' | 'train' | 'eat' | 'adapt' | 'plan';

export interface TourScene {
  id: TourSceneId;
  /** White line. */
  title: string;
  /** Grey line under it, same size. */
  sub: string;
}

export const TOUR_TITLE_MAX = 32;
export const TOUR_SUB_MAX = 44;
/** How long a scene shows before the next one, unless the user taps. */
export const TOUR_SCENE_MS = 4500;

/** The five scenes, for a user called `firstName` (null when unknown). */
export function tourScenes(firstName: string | null, phaseLine: string | null): TourScene[] {
  const name = firstName?.trim().split(/\s+/)[0] ?? '';
  return [
    { id: 'welcome', title: name ? `You’re in, ${name}.` : 'You’re in.', sub: 'I’m building your first week now.' },
    { id: 'train', title: 'Every set counts.', sub: 'Log weight and reps in one tap.' },
    { id: 'eat', title: 'Just say what you ate.', sub: 'I work out the calories and protein.' },
    { id: 'adapt', title: 'I adjust as you go.', sub: 'Your plan changes when you do.' },
    { id: 'plan', title: 'Now, your phase 1.', sub: phaseLine?.trim() || 'Built from your answers.' },
  ];
}

/** The grey line on the last scene: "Build the base. 4 weeks." */
export function phaseLineFor(name: string | null | undefined, weeks: number | null | undefined): string | null {
  const n = name?.trim();
  if (!n) return null;
  const w = weeks != null && Number.isFinite(weeks) && weeks > 0 ? Math.round(weeks) : null;
  const head = /[.!?]$/.test(n) ? n : `${n}.`;
  // A no-break space keeps "4 weeks" on one line when the phrase wraps.
  return w ? `${head} ${w}\u00a0${w === 1 ? 'week' : 'weeks'}.` : head;
}

/** Where a tap lands: the left third goes back, the rest goes on. */
export function tapStep(x: number, width: number): -1 | 1 {
  return width > 0 && x < width / 3 ? -1 : 1;
}

/** The scene after a step, or 'done' past the last one. Back stops at the first. */
export function nextScene(index: number, step: -1 | 1, count: number): number | 'done' {
  const to = index + step;
  if (to < 0) return 0;
  if (to >= count) return 'done';
  return to;
}
