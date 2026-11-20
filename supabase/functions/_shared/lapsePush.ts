// The "food logging went quiet" push (drona-push). Rules only, no model.
//
// Who: someone who logged food steadily (STEADY_MIN of the STEADY_WINDOW days
// up to their last log) and has now missed LAPSE_MIN_MISSED whole local days.
// When: inside SEND_FROM_HOUR..SEND_UNTIL_HOUR of their own clock, never at night.
// How often: once per lapse (the lapse is keyed by the last logged day, and
// push_sends is unique on it), and never twice inside COOLDOWN_DAYS.
// Not for people gone longer than LAPSE_MAX_GAP days: a first run must not wake
// everyone who left months ago.
//
// Pure: no imports. Unit-tested in lapsePush.test.ts.

export const STEADY_WINDOW = 14;
export const STEADY_MIN = 8;
/** Whole local days with no food log before the push goes. */
export const LAPSE_MIN_MISSED = 2;
/** Days since the last log past which Drona stays quiet. */
export const LAPSE_MAX_GAP = 10;
export const COOLDOWN_DAYS = 7;
/** Local hours the push may go: from 10:00 up to (not at) 20:00. */
export const SEND_FROM_HOUR = 10;
export const SEND_UNTIL_HOUR = 20;

export type LapseFacts = {
  /** The user's local day, YYYY-MM-DD. */
  today: string;
  /** The user's local hour, 0-23. */
  hour: number;
  /** Local days with a food log (any order, repeats fine). */
  days: string[];
  /** When the last food-lapse push went, or null. */
  lastPushAt: string | null;
  /** Now, as an ISO moment. */
  now: string;
};

export type LapseDecision = {
  send: boolean;
  reason: "send" | "no_logs" | "not_lapsed" | "too_old" | "not_steady" | "cooldown" | "quiet_hours";
  /** The last logged day: one push per value. */
  lapseKey: string | null;
  missedDays: number;
};

const DAY_MS = 86_400_000;
const dayNum = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

export function decideFoodLapse(f: LapseFacts): LapseDecision {
  const nums = [...new Set(f.days)].map(dayNum).filter(Number.isFinite);
  if (nums.length === 0) return { send: false, reason: "no_logs", lapseKey: null, missedDays: 0 };
  const last = Math.max(...nums);
  const lapseKey = new Date(last * DAY_MS).toISOString().slice(0, 10);
  const today = dayNum(f.today);
  const missedDays = today - last - 1;
  const out = (reason: LapseDecision["reason"]): LapseDecision => ({ send: reason === "send", reason, lapseKey, missedDays });

  if (missedDays < LAPSE_MIN_MISSED) return out("not_lapsed");
  if (today - last > LAPSE_MAX_GAP) return out("too_old");
  const steady = nums.filter((n) => n > last - STEADY_WINDOW && n <= last).length;
  if (steady < STEADY_MIN) return out("not_steady");
  if (f.lastPushAt && Date.parse(f.now) - Date.parse(f.lastPushAt) < COOLDOWN_DAYS * DAY_MS) return out("cooldown");
  if (f.hour < SEND_FROM_HOUR || f.hour >= SEND_UNTIL_HOUR) return out("quiet_hours");
  return out("send");
}

// Coach voice: kind, short, no numbers, nothing about what they ate or weigh.
const WORDS: { title: string; body: string }[] = [
  {
    title: "Drona here",
    body: "Your food log has been quiet for a couple of days. No need to fill the gap. Log your next meal and we pick up from there.",
  },
  {
    title: "Quick check-in from Drona",
    body: "Busy few days? It happens to everyone. One meal logged today is all it takes to get going again.",
  },
  {
    title: "Drona checking in",
    body: "Skip the missed days, they don't need catching up. Just log what you eat next and I'll take it from there.",
  },
];

/** The same lapse always gets the same words, so a retry never reads as a second message. */
export function lapseWords(userId: string, lapseKey: string): { title: string; body: string } {
  let h = 0;
  for (const c of `${userId}|${lapseKey}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return WORDS[h % WORDS.length];
}

/** What rides in the push's data: the app opens Nutrition on tap. */
export function pushTarget(): { type: "food_lapse"; screen: "nutrition" } {
  return { type: "food_lapse", screen: "nutrition" };
}
