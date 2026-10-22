/**
 * One number per metric, everywhere. The plan rows on the Goal and phase
 * screens and the hero on each pillar screen all read a metric through
 * `metricHeadline`, so they can never disagree:
 *
 * - With a job reading (the weekly check's last whole week): that value,
 *   labelled "last week", with the job's status word.
 * - Without one: the same live number on every screen ("so far this week"
 *   for sessions; the sleep average over the nights that exist, saying how
 *   many when fewer than four), and no status word, because the job has
 *   not judged it yet. "Due" shows only where a reading is owed and no live
 *   source stands in.
 *
 * Live, this-week progress beyond that lives only in the week visuals
 * (the day circles, the sleep bars), which carry it already.
 *
 * Pure, so `lib/phaseMetricHeadline.test.ts` covers it under deno.
 */
import { formatMetricValue, type MetricStatus, type PhaseMetricRow } from './phaseMetrics';

/** The live values a screen can read without the weekly job. */
export interface LiveReadings {
  /** Finished workouts since Monday, local. */
  sessionsThisWeek: number;
  /** Mean hours over the last seven nights that have a value, one decimal; null with none. */
  sleepAvg: number | null;
  /** How many of those nights have a value. */
  sleepNights: number;
}

export interface MetricHeadline {
  /** The number, or '' when there is none to show. */
  num: string;
  /** What the number is of, so `${num} ${rest}` reads as one line. */
  rest: string;
  /** A shorter `rest` for a one-line row subtitle, when the full one runs long. */
  restShort?: string;
  /** The status word to show, or null when the number is live and the job has not judged it. */
  status: MetricStatus | null;
}

/** The headline as one line: "3 of 4 sessions last week". */
export function headlineText(h: MetricHeadline, short = false): string {
  const rest = short && h.restShort ? h.restShort : h.rest;
  return h.num ? `${h.num} ${rest}` : rest;
}

export function metricHeadline(m: PhaseMetricRow, live: LiveReadings | null): MetricHeadline {
  const t = formatMetricValue(m.kind, m.target_value, m.unit);
  const unit = m.unit ? ` ${m.unit}` : '';
  const cur = m.current_value;
  if (cur != null) {
    const v = formatMetricValue(m.kind, cur, m.unit);
    const status = m.status;
    switch (m.kind) {
      case 'sessions_per_week': return { num: v, rest: `of ${t} sessions last week`, status };
      case 'cardio_sessions': return { num: v, rest: `of ${t} cardio last week`, status };
      case 'protein_days': return { num: v, rest: 'of 7 protein days last week', restShort: 'of 7 last week', status };
      case 'sleep_hours': return { num: v, rest: 'h a night last week', status };
      case 'steps': return { num: v, rest: 'steps a day last week', restShort: 'steps/day last week', status };
      case 'sets_per_muscle': return { num: v, rest: `of ${t} sets last week`, status };
      default: return { num: `${v}${unit}`, rest: m.direction === 'hold' ? 'now' : `of ${t}${unit}`, status };
    }
  }
  // No job reading yet.
  if (m.kind === 'sessions_per_week' && live) {
    return { num: String(live.sessionsThisWeek), rest: `of ${t} sessions so far this week`, status: null };
  }
  if (m.kind === 'sleep_hours' && live?.sleepAvg != null) {
    const n = live.sleepNights;
    const rest = n < 4 ? `h a night from ${n} night${n === 1 ? '' : 's'}` : 'h a night, last 7 nights';
    return { num: formatMetricValue('sleep_hours', live.sleepAvg), rest, status: null };
  }
  const due = m.status === 'due';
  if (m.kind === 'custom') return { num: '', rest: 'Not logged yet', status: null };
  if ((m.kind === 'steps' || m.kind === 'sleep_hours') && due) return { num: '', rest: 'Needs Health sync', status: null };
  if (m.kind === 'lift_e1rm' && m.status === 'set') return { num: '', rest: 'Log the lift to start', status: null };
  return { num: '', rest: 'No reading yet', status: due ? 'due' : null };
}

/** The live readings from what a screen already loaded (either part may be missing). */
export function liveFrom(week: { count: number } | null, nights: { hours: number | null }[]): LiveReadings {
  const slept = nights.filter((n) => n.hours != null);
  const sum = slept.reduce((a, n) => a + (n.hours ?? 0), 0);
  return {
    sessionsThisWeek: week?.count ?? 0,
    sleepAvg: slept.length > 0 ? Math.round((sum / slept.length) * 10) / 10 : null,
    sleepNights: slept.length,
  };
}
