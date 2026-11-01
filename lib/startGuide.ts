/**
 * The dashboard's getting-started checklist: five first things, each opening
 * the screen where it is done, each ticking itself off from real data where
 * there is any. Pure on purpose (no imports) so `deno test` reaches it; the
 * reads and the card live in components/home/StartGuideCard.tsx.
 *
 * Why a checklist and not a spotlight tour: new users mostly logged food by
 * hand and never found the AI food box, the AI modes, their phases or the
 * weight log (2026-10-31). A list says what exists and lets them go in any
 * order; a tour that points at moving layout breaks the first time a screen
 * changes.
 */

export type StartStepId = 'workout' | 'ai_food' | 'modes' | 'phases' | 'weight';

export interface StartStep {
  id: StartStepId;
  title: string;
  /** One line, in Drona's voice, saying where it is and why it matters. */
  tip: string;
}

export const START_STEPS: readonly StartStep[] = [
  { id: 'workout', title: "Start today's workout", tip: 'Your phase 1 session is on the Today card. Tap it and go.' },
  { id: 'ai_food', title: 'Log a meal with Drona', tip: 'Type what you ate in the food box, like "2 eggs and toast". I do the rest.' },
  { id: 'modes', title: 'Pick how I log food', tip: 'Tap the mode chip in the food box. Quick or Precise.' },
  { id: 'phases', title: 'See your phases', tip: 'Every phase of your program, in order, ending at your goal.' },
  { id: 'weight', title: 'Log your weight', tip: 'One weigh-in a few times a week keeps your plan honest.' },
];

/** The card shows for this long after sign-up, then gets out of the way. */
export const START_GUIDE_DAYS = 21;

export interface StartGuideFacts {
  /** False until the reads below have settled. */
  ready: boolean;
  /** Ms since the account was created, or null when unknown. */
  accountAgeMs: number | null;
  /** The user tapped Hide. */
  dismissed: boolean;
  workoutsLogged: number;
  aiMealLogged: boolean;
  /** The user has chosen a food logging mode at least once. */
  modePicked: boolean;
  weightLogged: boolean;
  /** Steps the user opened from this card (the ones with no data of their own). */
  opened: ReadonlySet<StartStepId>;
}

export function stepDone(id: StartStepId, f: StartGuideFacts): boolean {
  switch (id) {
    case 'workout': return f.workoutsLogged > 0;
    case 'ai_food': return f.aiMealLogged;
    case 'modes': return f.modePicked || f.opened.has('modes');
    case 'phases': return f.opened.has('phases');
    case 'weight': return f.weightLogged;
  }
}

export interface StartGuideView {
  steps: Array<StartStep & { done: boolean }>;
  doneCount: number;
  /** The first step not done: the one the card points at. */
  nextId: StartStepId | null;
}

/** What the card shows, or null when it should not show at all. */
export function startGuideView(f: StartGuideFacts): StartGuideView | null {
  if (!f.ready || f.dismissed) return null;
  // A long-time user does not need a getting-started list; an unknown age
  // (no Clerk date) also stays quiet rather than nagging everyone.
  if (f.accountAgeMs == null || f.accountAgeMs < 0) return null;
  if (f.accountAgeMs > START_GUIDE_DAYS * 24 * 60 * 60 * 1000) return null;
  const steps = START_STEPS.map((s) => ({ ...s, done: stepDone(s.id, f) }));
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;
  return { steps, doneCount, nextId: steps.find((s) => !s.done)?.id ?? null };
}

export function startGuideOpenedKey(userId: string): string {
  return `overload:start_guide_opened::${userId}`;
}

export function startGuideDismissedKey(userId: string): string {
  return `overload:start_guide_dismissed::${userId}`;
}

/** Read the opened-steps list back; anything unknown is dropped. */
export function parseOpened(raw: string | null): Set<StartStepId> {
  const ids = new Set<StartStepId>();
  if (!raw) return ids;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) {
      for (const x of v) if (START_STEPS.some((s) => s.id === x)) ids.add(x as StartStepId);
    }
  } catch { /* nothing opened */ }
  return ids;
}
