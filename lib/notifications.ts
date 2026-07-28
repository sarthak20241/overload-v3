/**
 * Thin wrapper around `expo-notifications` that gracefully degrades when the
 * native module isn't in the binary (Expo Go, older dev clients). Mirrors the
 * lazy-require pattern in lib/revenuecat.ts: callers get a uniform API and
 * never need "is the module here?" checks.
 *
 * v1 scope is deliberately tiny: the paywall funnel's day-5 trial reminder.
 * The reminder screen PROMISES a notification two days before the trial
 * converts ("I'll remind you before you pay"), so this is a product
 * commitment, not a nice-to-have: scheduleTrialReminder() is called the
 * moment a trial purchase verifies, and cancelTrialReminder() if the user's
 * tier flips to a non-trial purchase or the sub is cancelled client-side.
 *
 * Local scheduling (not server push) on purpose: no push infra exists yet,
 * the phone that bought the trial is the phone that needs the nudge, and a
 * local notification survives offline. If the user deletes the app the
 * reminder dies with it, which Apple's own day-5 trial email covers.
 */

const TRIAL_REMINDER_ID = 'overload-trial-day5';
const TRIAL_REMINDER_DAY = 5; // fire on day 5 of a 7-day trial

// Loosely typed on purpose (same as lib/revenuecat.ts): the module may not
// be installed yet, and `typeof import(...)` would fail typecheck until it is.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedModule: any | null | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadNotifications(): any | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedModule = require('expo-notifications');
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/** True when the native module is present (dev build / store build). */
export function isNotificationsAvailable(): boolean {
  return loadNotifications() !== null;
}

/**
 * Ask for notification permission. Returns true when granted (or already
 * granted), false when denied or when the module is missing. Safe to call
 * repeatedly: the OS prompt only ever shows once.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const N = loadNotifications();
  if (!N) return false;
  try {
    const existing = await N.getPermissionsAsync();
    if (existing.granted) return true;
    if (!existing.canAskAgain) return false;
    const asked = await N.requestPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}

/**
 * Schedule the day-5 "your trial converts in 2 days" reminder, replacing any
 * previously scheduled one. No-ops (returning false) without the module or
 * permission, so callers never branch.
 */
export async function scheduleTrialReminder(): Promise<boolean> {
  const N = loadNotifications();
  if (!N) return false;
  try {
    const perms = await N.getPermissionsAsync();
    if (!perms.granted) return false;
    await N.cancelScheduledNotificationAsync(TRIAL_REMINDER_ID).catch(() => {});
    await N.scheduleNotificationAsync({
      identifier: TRIAL_REMINDER_ID,
      content: {
        title: 'Two days left on your trial',
        body:
          "Drona here. Your trial converts in two days. Staying is one tap of nothing; leaving is two taps in Settings. Either way, you were warned like I promised.",
      },
      trigger: {
        // SDK 53 time-interval trigger. Seconds from now to day 5.
        type: N.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: TRIAL_REMINDER_DAY * 24 * 60 * 60,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Cancel the pending day-5 reminder (tier flipped to paid, sub cancelled). */
export async function cancelTrialReminder(): Promise<void> {
  const N = loadNotifications();
  if (!N) return;
  try {
    await N.cancelScheduledNotificationAsync(TRIAL_REMINDER_ID);
  } catch {
    /* nothing to cancel */
  }
}
