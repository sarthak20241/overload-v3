/**
 * Which calendar day a food log lands on, when it is not the day on screen.
 *
 * Two ways to log ahead: step the diary forward (‹ ›, the week strip, the
 * calendar), or say the day in the food box ("2 eggs for tomorrow"). Both
 * stop at MAX_FUTURE_LOG_DAYS, so a typo in a month name cannot park a meal
 * a year out where nobody will ever see it.
 *
 * The food box reader is deliberately narrow. It only moves a log FORWARD,
 * and only on a phrase that cannot mean anything else:
 *   - "tomorrow" (and its usual misspellings), "day after tomorrow"
 *   - a weekday with a lead-in: "for friday", "on friday", "next friday"
 *   - a day + month name: "14 oct", "on the 14th of october", "for oct 14th"
 *     (month first needs the "on"/"for": "oct 12 eggs" is twelve eggs)
 * Numeric dates are not read: "2/3 cup" is a fraction, not February 3rd.
 * A bare weekday is not read either: "from sunday's batch" is about food
 * made on Sunday, not a log for next Sunday. A weekday in a message that
 * also talks in the past ("had this on monday") is left alone, because a
 * past day cannot be logged from text and the forward reading would be wrong.
 *
 * No imports, so Deno can test it directly: deno test lib/logDay.test.ts
 */

/** How far ahead a log may land, counted in days after today. */
export const MAX_FUTURE_LOG_DAYS = 30;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * The day a "<day> only" goal lands on for the day on screen. A future day is
 * its own; today or a past day is today, since a past day keeps the goal it
 * had. One rule for the goal sheet and the screen that seeds it.
 */
export function goalDayFor(view: Date, now: Date = new Date()): Date {
  return startOfDay(view) > startOfDay(now) ? view : now;
}

/** The last day a log may land on: today + MAX_FUTURE_LOG_DAYS, local time. */
export function latestLogDay(now: Date = new Date()): Date {
  return addDays(startOfDay(now), MAX_FUTURE_LOG_DAYS);
}

export interface LogDayPhrase {
  /** The local day the phrase names, at 00:00. */
  date: Date;
  /** The words that named it, as typed. */
  phrase: string;
  /** The message without them, for the parser. Empty when the message was
   *  only the day ("for tomorrow"). */
  rest: string;
}

const TOMORROW = String.raw`(?:tomorrow|tomorow|tommorow|tommorrow|tmrw|tmr|2moro|2morrow)`;
const LEAD = String.raw`(?:(?:for|on)\s+)?`;
const POSSESSIVE = String.raw`(?:['’]s)?`;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
// Longest first, so "september" is not read as "sep" + "tember".
const MONTH = `(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')})`;
const ORDINAL = String.raw`(?:st|nd|rd|th)?`;

/** Words that put a message in the past. A weekday next to them names a day
 *  already gone, and this reader only moves logs forward. */
const PAST = /\b(?:had|ate|eaten|drank|drunk|was|were|last|ago|yesterday|earlier|previous)\b/i;

/**
 * The day a food-box message names, if it names one this app can log to:
 * today through latestLogDay(now). Null when it names none, or names a day
 * outside that window (a past date, a date months out).
 */
export function readLogDayPhrase(text: string, now: Date = new Date()): LogDayPhrase | null {
  const today = startOfDay(now);
  const latest = latestLogDay(now);
  const found = (m: RegExpExecArray, date: Date): LogDayPhrase | null =>
    date < today || date > latest ? null : { date, phrase: m[0].trim(), rest: without(text, m) };

  let m = new RegExp(String.raw`\b${LEAD}(?:the\s+)?day\s+after\s+${TOMORROW}${POSSESSIVE}(?![\w'’])`, 'i').exec(text);
  if (m) return found(m, addDays(today, 2));

  m = new RegExp(String.raw`\b${LEAD}${TOMORROW}${POSSESSIVE}(?![\w'’])`, 'i').exec(text);
  if (m) return found(m, addDays(today, 1));

  // "14 oct", "the 14th of october"
  m = new RegExp(String.raw`\b${LEAD}(?:the\s+)?(\d{1,2})${ORDINAL}\s+(?:of\s+)?${MONTH}\.?(?![\w'’])`, 'i').exec(text);
  if (m) {
    const date = nextDate(Number(m[1]), MONTHS[m[2].toLowerCase()], today);
    if (date) return found(m, date);
  }
  // "on oct 14", "for october 14th". The lead-in is required here: without it
  // "oct 12 eggs" or "dec 3 rotis" would read the count as a day.
  m = new RegExp(String.raw`\b(?:for|on)\s+${MONTH}\.?\s+(?:the\s+)?(\d{1,2})${ORDINAL}(?![\w'’])`, 'i').exec(text);
  if (m) {
    const date = nextDate(Number(m[2]), MONTHS[m[1].toLowerCase()], today);
    if (date) return found(m, date);
  }

  if (!PAST.test(text)) {
    m = new RegExp(String.raw`\b(for|on|next|this|coming|this\s+coming)\s+(${WEEKDAYS.join('|')})${POSSESSIVE}(?![\w'’])`, 'i').exec(text);
    if (m) {
      const target = WEEKDAYS.indexOf(m[2].toLowerCase());
      let ahead = (target - today.getDay() + 7) % 7;
      // "for monday" said on a Monday means the next one. "this monday" said
      // on a Monday is today.
      if (ahead === 0 && m[1].toLowerCase() !== 'this') ahead = 7;
      return found(m, addDays(today, ahead));
    }
  }
  return null;
}

/** The next `month`/`day` on or after `today`, this year or next. Null for a
 *  day the month does not have ("31 feb"). */
function nextDate(day: number, month: number, today: Date): Date | null {
  for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
    const d = new Date(year, month, day);
    if (d.getMonth() !== month || d.getDate() !== day) return null;
    if (d >= today) return d;
  }
  return null;
}

/** `text` with the match cut out and the seams tidied: no doubled spaces, no
 *  space before punctuation, no dangling comma or dash at either end. */
function without(text: string, m: RegExpExecArray): string {
  const cut = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
  const tidy = cut
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:.!?])/g, '$1')
    .replace(/^[\s,;:.\-–—]+/, '')
    .replace(/[\s,;:\-–—]+$/, '')
    .trim();
  return /[\p{L}\p{N}]/u.test(tidy) ? tidy : '';
}
