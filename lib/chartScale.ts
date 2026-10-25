/**
 * The x scale of the Goal screen's metric chart (components/program/
 * PhaseMetricChart.tsx), pure so `deno test lib/chartScale.test.ts` covers it.
 *
 * Program weeks to pixels, in two pieces: first reading to now, then now to
 * the program's end. With two or more readings, the readings get at least
 * HISTORY_SHARE of the width (a few days of weigh-ins in a long program still
 * read as a line, not a stub). With one reading or none there is nothing to
 * widen: the dot sits at the left edge and the rest of the width runs to the
 * program's end, where the goal ring is.
 */

/** The share of the width the readings so far get, at least. */
export const HISTORY_SHARE = 0.58;

export interface ScaleInput {
  /** Left and right pixel edges of the plot. */
  x0: number;
  x1: number;
  /** Program weeks: the first reading, the latest reading, the program's end. */
  xStart: number;
  xNow: number;
  xEnd: number;
  /** How many readings there are. */
  readings: number;
}

export function metricXScale({ x0, x1, xStart, xNow, xEnd, readings }: ScaleInput): (w: number) => number {
  const linearShare = (xNow - xStart) / (xEnd - xStart);
  const share = readings >= 2 ? Math.max(HISTORY_SHARE, linearShare) : linearShare;
  const xMid = x0 + (x1 - x0) * share;
  return (w: number) => {
    const c = Math.max(xStart, Math.min(xEnd, w));
    // Up to now: the readings' piece (all at the left edge when there is one).
    if (c <= xNow) return xNow <= xStart ? x0 : x0 + (xMid - x0) * (c - xStart) / (xNow - xStart);
    // After now: on to the program's end, whatever the number of readings.
    return xMid + (x1 - xMid) * (c - xNow) / Math.max(1e-9, xEnd - xNow);
  };
}
