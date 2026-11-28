/**
 * Session length: how long one workout may take.
 *
 * Onboarding asks it (the "session" step) and saves it to
 * user_profiles.session_minutes. The server holds every built session to it
 * (supabase/functions/ai-coach/sessionTime.ts). The coach form opens on the
 * range that holds it, so a build from the form keeps the user's own number.
 *
 * Pure on purpose (no imports), so `deno test lib/sessionLength.test.ts`
 * reaches it.
 */

export interface SessionLengthOption {
  minutes: number;
  title: string;
  sub: string;
  icon: 'zap' | 'clock' | 'watch' | 'sun' | 'battery-charging';
}

/** The onboarding choices, shortest first. 20 minutes was dropped 2026-11-28 (owner); Custom still takes it. */
export const SESSION_LENGTH_OPTIONS: SessionLengthOption[] = [
  { minutes: 30, title: '30 minutes', sub: 'Quick but complete', icon: 'clock' },
  { minutes: 45, title: '45 minutes', sub: 'A normal session', icon: 'watch' },
  { minutes: 60, title: '60 minutes', sub: 'Room for more work', icon: 'sun' },
  { minutes: 90, title: '90 minutes', sub: 'Long sessions', icon: 'battery-charging' },
];

/** Pre-selected on the onboarding step, like the other single-select steps. */
export const DEFAULT_SESSION_MINUTES = 45;

/** The coach form's session dropdown. The server reads these exact words. */
export const COACH_FORM_SESSION_OPTIONS = ['20-30 min', '30-45 min', '45-60 min', '60-75 min', '75-90 min'];

/** The value user_profiles.session_minutes accepts (its check is 10 to 180), or null. */
export function sessionMinutesValue(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const m = Math.round(v);
  return m >= 10 && m <= 180 ? m : null;
}

/**
 * The Custom choice on the onboarding step: any whole minute the database
 * takes (user_profiles.session_minutes checks 10 to 180), picked on a wheel.
 */
export const CUSTOM_SESSION_MIN = 10;
export const CUSTOM_SESSION_MAX = 180;

/** True when the time is one of the onboarding cards, not a Custom one. */
export function isPresetSessionMinutes(minutes: unknown): boolean {
  return SESSION_LENGTH_OPTIONS.some((o) => o.minutes === minutes);
}

/** The Custom card's second line: the custom time once one is set. */
export function customSessionSub(minutes: unknown): string {
  const m = sessionMinutesValue(minutes);
  return m != null && !isPresetSessionMinutes(m) ? `${m} minutes` : 'Set your own minutes';
}

/**
 * The coach form's opening choice for a saved session length: the range that
 * holds it, so the server keeps the exact number (a profile time inside the
 * form's range wins). A custom time no range holds (under 20, over 90) opens
 * as itself, "15 min", which the server reads as that exact limit. No saved
 * length: the old 45-60 min default.
 */
export function coachFormSessionOption(minutes: unknown): string {
  const m = sessionMinutesValue(minutes);
  if (m == null) return '45-60 min';
  if (m < 20 || m > 90) return `${m} min`;
  if (m <= 30) return '20-30 min';
  if (m <= 45) return '30-45 min';
  if (m <= 60) return '45-60 min';
  if (m <= 75) return '60-75 min';
  return '75-90 min';
}

/** The coach form's dropdown: the ranges, plus a custom time no range holds, in order. */
export function coachFormSessionChoices(minutes: unknown): string[] {
  const opening = coachFormSessionOption(minutes);
  if (COACH_FORM_SESSION_OPTIONS.includes(opening)) return COACH_FORM_SESSION_OPTIONS;
  const m = sessionMinutesValue(minutes) ?? 0;
  return m < 20 ? [opening, ...COACH_FORM_SESSION_OPTIONS] : [...COACH_FORM_SESSION_OPTIONS, opening];
}

/**
 * The coach form's session range to send, or null to send none (the server
 * then keeps the saved time, sessionTime.sessionCap). The range goes out only
 * when it can be trusted: the user picked it, the saved time was read and the
 * form opened on it, or there is no account to have a saved time. A read
 * still running, or one that failed, sends nothing: the untouched default
 * would otherwise turn a saved 20 into a 60 minute cap.
 */
export function formSessionRange(s: {
  picked: boolean;
  read: 'pending' | 'ok' | 'failed' | 'none';
  value: string;
}): string | null {
  if (s.picked) return s.value;
  return s.read === 'ok' || s.read === 'none' ? s.value : null;
}
