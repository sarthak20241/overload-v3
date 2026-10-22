/**
 * The food box tour: a one-time guided walk through logging a meal by typing
 * it, for a user whose recent diary (the last four weeks the screen already
 * loads) has no meal Drona read. Someone who typed meals long ago and has
 * been away may get it too; that is accepted, it is one tip they can skip.
 *
 * Why it exists: a new user (2026-10-21) logged 13 foods through about 45
 * manual searches, several of which found nothing, and never touched the box
 * that would have taken the whole lunch in one sentence. The box was on screen
 * the whole time; nothing said what it was for.
 *
 * It guides with the user's own taps on their own meal. Nothing is pre-filled
 * and nothing is logged for them, so following it can never put a food in the
 * diary that they did not eat.
 *
 * Pure: no imports, so lib/foodBoxTour.test.ts runs it under Deno. The screen
 * (app/(app)/nutrition.tsx) feeds it events and draws what the step says.
 */

/** 'type': point at the box. 'write': they are in it. 'reading': Drona is
 *  reading, nothing to say. 'retry': Drona could not read it. 'review': the
 *  card is up. 'done': finished, skipped or left. */
export type TourStep = 'type' | 'write' | 'reading' | 'retry' | 'review' | 'done';

export type TourEvent =
  | 'focused'      // the user tapped into the food box
  | 'sent'         // the user sent words to Drona
  | 'review'       // a parsed meal is on the card, waiting for Add
  | 'declined'     // Drona answered without a meal (could not read it)
  | 'added'        // the user added the reviewed meal to their day
  | 'auto_logged'; // "Just log it" was on, so the send itself logged

export function tourNext(step: TourStep, event: TourEvent): TourStep {
  switch (step) {
    case 'type':
      if (event === 'focused') return 'write';
      if (event === 'sent') return 'reading';
      return step;
    case 'write':
    case 'retry':
      return event === 'sent' ? 'reading' : step;
    case 'reading':
      if (event === 'review') return 'review';
      if (event === 'declined') return 'retry';
      if (event === 'auto_logged') return 'done';
      return step;
    case 'review':
      if (event === 'added') return 'done';
      // A follow-up ("make it a small one") is read like a first send.
      if (event === 'sent') return 'reading';
      return step;
    case 'done':
      return step;
  }
}

/** What the user has logged recently, as much as the gate needs. */
export interface LoggedLine { logged_via?: string | null }

export interface TourGate {
  signedIn: boolean;
  /** Stored "already shown". null = storage has not answered yet. */
  done: boolean | null;
  /** The diary on screen is today. A past day is for looking back. */
  isToday: boolean;
  /** The day has loaded, so the screen is not about to jump under the tip. */
  dayReady: boolean;
  /** Nothing is being read or reviewed in the box right now. */
  flowIdle: boolean;
  /** `history` came from the server, not just a cold cache. An empty list
   *  before that is "not here yet", never "has not typed a meal". */
  historyLoaded: boolean;
  history: LoggedLine[];
}

const usesDrona = (history: LoggedLine[]) => history.some((l) => (l.logged_via ?? '').startsWith('ai'));

/** Offer the tour only to someone with no typed meal in recent history: a
 *  line Drona read is logged_via 'ai' (review then Add) or 'ai_auto' ("Just
 *  log it"). */
export function shouldOfferTour(g: TourGate): boolean {
  if (!g.signedIn || g.done !== false || !g.isToday || !g.dayReady || !g.flowIdle || !g.historyLoaded) return false;
  return !usesDrona(g.history);
}

/** Why a showing tour should stop, or null to keep going. Only while it is
 *  pointing at the box: once a meal is being read or reviewed, it is the
 *  user's own meal mid-way, and their own Add is what puts an 'ai' line in
 *  history. */
export function tourEndReason(
  step: TourStep,
  now: { isToday: boolean; history: LoggedLine[] },
): 'not_today' | 'uses_drona' | null {
  if (step !== 'type' && step !== 'write' && step !== 'retry') return null;
  if (!now.isToday) return 'not_today';
  if (usesDrona(now.history)) return 'uses_drona';
  return null;
}

/** Drona speaks. Short, one idea each, no em dashes. */
export const TOUR_COPY: Record<'type' | 'write' | 'retry' | 'review' | 'done', { title: string; body: string }> = {
  type: {
    title: 'Just tell me what you ate',
    body: 'Tap here and type your meal the way you would say it. I will find the foods and the numbers.',
  },
  write: {
    title: 'Write it in your own words',
    body: 'Add amounts if you know them, like "200 g rice and 2 boiled eggs". Then tap the arrow.',
  },
  retry: {
    title: 'Try it with the food and how much',
    body: 'Something like "2 boiled eggs and a cup of tea" works best. Then tap the arrow.',
  },
  review: {
    title: 'Check it, then add it',
    body: 'Tap a line to fix the amount. When it looks right, add it to your day.',
  },
  done: {
    title: 'That is all it takes',
    body: 'Next time, just type what you ate.',
  },
};
