/**
 * Turns a finished set into the small payload the coach reasons over.
 *
 * This file is where the cost story lives. A 30 second video is roughly 240
 * frames of 17 joints; sending that anywhere would be both expensive and a
 * privacy problem. Instead we ship per-rep flags, tempo and a handful of
 * rounded aggregates, which lands around a kilobyte regardless of set length.
 * The video and the raw keypoints never leave the phone.
 *
 * The SCORE is computed here, deterministically, not by the model. A number
 * that moves on its own between two identical sets would destroy trust, so the
 * model only ever writes prose about numbers it was handed.
 */

import { round1, type RepResult, type SetAnalysis } from './engine';
import type { CueSpec, FormRuleSpec } from './spec';

export interface RepSummary {
  n: number;
  /** Cue ids that fired on this rep. */
  flags: string[];
  /** The rep-driving measure at its deepest point, rounded. */
  bottom: number | null;
  tempoDownMs: number;
  tempoUpMs: number;
}

export interface MeasureSummary {
  id: string;
  /** Mean across reps of the value at the bottom of each rep. */
  meanBottom: number | null;
  /** Mean across reps of the value at the top of each rep. */
  meanTop: number | null;
  best: number | null;
  worst: number | null;
}

export interface CueSummary {
  id: string;
  /** How many reps tripped this cue. */
  count: number;
  severity: CueSpec['severity'];
  live: string;
  detail: string;
}

export interface FormSummary {
  exerciseName: string;
  pattern: string | null;
  source: 'live' | 'upload';
  repCount: number;
  durationMs: number;
  /** 0..100, computed here, never by the model. */
  score: number;
  /** Mean keypoint confidence, 0..1. */
  confidence: number;
  /** Fraction of frames too unclear to judge, 0..1. */
  unclearFraction: number;
  view: FormRuleSpec['view'];
  detectedSide: SetAnalysis['side'];
  /** True when the camera angle did not match what the rules need. */
  wrongView: boolean;
  reps: RepSummary[];
  measures: MeasureSummary[];
  cues: CueSummary[];
  /** Populated when the set cannot be judged at all. */
  unusableReason: UnusableReason | null;
}

export type UnusableReason = 'wrong_view' | 'too_unclear' | 'no_reps';

/**
 * Penalty weights. A 'bad' cue is a form fault that risks injury or clearly
 * wastes the set; a 'warn' is a quality note. Penalties are per rep, so a
 * single bad rep in twenty barely moves the score while a set that is wrong
 * throughout drops hard.
 */
const PENALTY = { bad: 22, warn: 10 } as const;

/** Below this share of clear frames the set is not worth judging. */
const MIN_CLEAR_FRACTION = 0.6;

export interface SummarizeInput {
  analysis: SetAnalysis;
  spec: FormRuleSpec;
  exerciseName: string;
  pattern: string | null;
  source: 'live' | 'upload';
}

export function summarize({
  analysis,
  spec,
  exerciseName,
  pattern,
  source,
}: SummarizeInput): FormSummary {
  const driver = spec.rep.driver;
  const reps: RepSummary[] = analysis.reps.map((r) => ({
    n: r.n,
    flags: r.flags,
    bottom: round1(r.measures[driver]?.atBottom ?? NaN),
    tempoDownMs: Math.round(r.tempoDownMs),
    tempoUpMs: Math.round(r.tempoUpMs),
  }));

  const measures = spec.measures.map<MeasureSummary>((m) => {
    const bottoms = analysis.reps.map((r) => r.measures[m.id]?.atBottom ?? NaN);
    const tops = analysis.reps.map((r) => r.measures[m.id]?.atTop ?? NaN);
    const mins = analysis.reps.map((r) => r.measures[m.id]?.min ?? NaN);
    const maxs = analysis.reps.map((r) => r.measures[m.id]?.max ?? NaN);
    return {
      id: m.id,
      meanBottom: round1(mean(bottoms)),
      meanTop: round1(mean(tops)),
      best: round1(minOf(mins)),
      worst: round1(maxOf(maxs)),
    };
  });

  const byCue = new Map<string, number>();
  for (const r of analysis.reps) {
    for (const f of r.flags) byCue.set(f, (byCue.get(f) ?? 0) + 1);
  }
  const cues: CueSummary[] = spec.cues
    .filter((c) => byCue.has(c.id))
    .map((c) => ({
      id: c.id,
      count: byCue.get(c.id) ?? 0,
      severity: c.severity,
      live: c.live,
      detail: c.detail,
    }))
    // Worst first, then most frequent, so truncation drops the least important.
    .sort((a, b) =>
      a.severity === b.severity ? b.count - a.count : a.severity === 'bad' ? -1 : 1
    );

  const unclearFraction =
    analysis.framesTotal > 0 ? analysis.framesLowConf / analysis.framesTotal : 1;

  const unusableReason = determineUnusable(analysis, unclearFraction);

  return {
    exerciseName,
    pattern,
    source,
    repCount: analysis.reps.length,
    durationMs: Math.round(analysis.durationMs),
    score: unusableReason ? 0 : scoreOf(analysis.reps, spec),
    confidence: Math.round(analysis.confidenceAvg * 100) / 100,
    unclearFraction: Math.round(unclearFraction * 100) / 100,
    view: analysis.view,
    detectedSide: analysis.side,
    wrongView: analysis.wrongView,
    reps,
    measures,
    cues,
    unusableReason,
  };
}

function determineUnusable(
  analysis: SetAnalysis,
  unclearFraction: number
): UnusableReason | null {
  if (analysis.wrongView) return 'wrong_view';
  if (1 - unclearFraction < MIN_CLEAR_FRACTION) return 'too_unclear';
  if (analysis.reps.length === 0) return 'no_reps';
  return null;
}

/**
 * Deterministic 0..100 form score.
 *
 * Every rep starts at 100 and loses points per cue that fired on it; the set
 * score is the mean. Averaging over reps rather than summing means the score
 * reads as "how good were your reps", not "how long was your set".
 */
export function scoreOf(reps: readonly RepResult[], spec: FormRuleSpec): number {
  if (reps.length === 0) return 0;
  const severityOf = new Map(spec.cues.map((c) => [c.id, c.severity]));
  let total = 0;
  for (const rep of reps) {
    let repScore = 100;
    for (const flag of rep.flags) {
      repScore -= PENALTY[severityOf.get(flag) ?? 'warn'];
    }
    total += Math.max(0, repScore);
  }
  return Math.round(total / reps.length);
}

/**
 * Coach-voice copy for a set we refuse to grade. Said plainly, because an
 * honest "I could not see that" is worth more than invented feedback.
 */
export function unusableMessage(reason: UnusableReason, spec: FormRuleSpec): string {
  switch (reason) {
    case 'wrong_view':
      return `I need a different angle for this one. ${spec.setup}`;
    case 'too_unclear':
      return 'I lost track of you for too much of that set. Try more light, and make sure your whole body is in frame.';
    case 'no_reps':
      return 'I did not catch a full rep in that clip. Start from the top, and give me the whole movement.';
  }
}

function mean(values: readonly number[]): number {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n === 0 ? NaN : sum / n;
}

function minOf(values: readonly number[]): number {
  let best = Infinity;
  for (const v of values) if (Number.isFinite(v) && v < best) best = v;
  return Number.isFinite(best) ? best : NaN;
}

function maxOf(values: readonly number[]): number {
  let best = -Infinity;
  for (const v of values) if (Number.isFinite(v) && v > best) best = v;
  return Number.isFinite(best) ? best : NaN;
}
