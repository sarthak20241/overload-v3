/**
 * The dashboard's log-food button and the small hint pill beside it. Pure on
 * purpose (no imports) so `deno test` reaches it; the reads and the button
 * live in components/home/HomeLogButton.tsx.
 *
 * Why it exists: new users mostly logged food by hand and never found the AI
 * food box on Nutrition (2026-10-31). The button puts that box one tap from
 * home; the pill says what the button is for until the user has the habit.
 */

/** How the button logs. Text only today; voice and camera join this list and
 *  the button grows a small menu once there is more than one. */
export type HomeLogMode = 'text';

/** After this many taps the user knows the button; the pill stops. */
export const HOME_LOG_HINT_MAX_TAPS = 3;

export const HOME_LOG_HINT_FIRST = 'Log your first meal';
export const HOME_LOG_HINT_NEXT = 'Log your next meal';

/** Per user, so a second account on the phone starts fresh. */
export function homeLogTapsKey(userId: string): string {
  return `overload.homeLogTaps.${userId}`;
}

/** The stored tap count; anything unreadable counts as none. */
export function parseTaps(raw: string | null): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export interface HomeLogHintFacts {
  /** False until the food reads below have settled: no pill that flips text. */
  ready: boolean;
  /** Any food logged on any day. */
  everLogged: boolean;
  /** Any food logged today. */
  loggedToday: boolean;
  /** Taps on the button so far. */
  taps: number;
}

/** The pill's words, or null when it should not show. */
export function homeLogHint(f: HomeLogHintFacts): string | null {
  if (!f.ready) return null;
  if (f.loggedToday) return null;
  if (f.taps >= HOME_LOG_HINT_MAX_TAPS) return null;
  return f.everLogged ? HOME_LOG_HINT_NEXT : HOME_LOG_HINT_FIRST;
}
