/**
 * When the app asks for push permission, and where a tapped server push lands.
 *
 * The ask comes after a food log on the person's second logging day: they have
 * seen what logging gives them, and the nudge Drona sends (a quiet food log)
 * only means something to someone who logs. Never on first open. A soft
 * Drona ask goes first (ASK_COPY), so a "Not now" keeps the one-shot OS
 * prompt for later. Permission already granted (trial reminder, a kept Drona
 * build) just saves the token.
 *
 * Pure: no imports. Unit-tested in lib/pushAsk.test.ts. The wiring is in
 * lib/pushRegistration.ts.
 */

/** Food days kept for the ask; only "two or more" matters. */
const KEEP_DAYS = 14;
/** After a "Not now", Drona asks again this many days later. */
export const REASK_AFTER_DAYS = 30;

export type PushPerm = 'granted' | 'undetermined' | 'denied' | 'missing';
export type AskDecision = 'sync' | 'ask' | 'wait' | 'never';

export function noteFoodDay(days: string[], day: string): string[] {
  const next = days.includes(day) ? days : [...days, day];
  return [...next].sort().slice(-KEEP_DAYS);
}

export function askDecision(a: { days: string[]; askedAt: string | null; perm: PushPerm; now: string }): AskDecision {
  if (a.perm === 'granted') return 'sync';
  if (a.perm !== 'undetermined') return 'never';
  if (new Set(a.days).size < 2) return 'wait';
  if (a.askedAt && Date.parse(a.now) - Date.parse(a.askedAt) < REASK_AFTER_DAYS * 86_400_000) return 'wait';
  return 'ask';
}

/** The screen a tapped server push opens, or null when the push is not one of these. */
export function pushRoute(data: Record<string, unknown>): '/nutrition' | null {
  if (data.type === 'food_lapse') return '/nutrition';
  return null;
}

export const ASK_COPY = {
  title: 'Mind if I check in?',
  body: "If your food log goes quiet for a few days, I'll send one short nudge. Never at night, never about the numbers.",
  yes: 'Sure',
  no: 'Not now',
} as const;
