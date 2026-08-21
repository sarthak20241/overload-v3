/**
 * The rule interpreter. Feed it pose frames, it gives you reps, live cues and a
 * final summary. One generic engine drives every exercise, because the
 * exercise-specific part lives entirely in the FormRuleSpec it is constructed
 * with (see ./spec.ts).
 *
 * Deliberately dependency-free and synchronous: the same instance runs against
 * a live camera at 30 fps and against frames decoded from an uploaded video, so
 * the two paths cannot drift apart in what they judge.
 */

import {
  Ema,
  angleAt,
  angleFromHorizontal,
  angleFromVertical,
  horizontalGap,
  meanFinite,
  resolveJoint,
  round1,
  verticalGap,
  detectSide,
  type CameraSide,
} from './geometry';
import { MIN_KEYPOINT_SCORE, type PoseFrame } from './keypoints';
import { testFires, type CueSample, type CueSpec, type FormRuleSpec, type MeasureSpec } from './spec';

export type RepPhase = 'waiting' | 'top' | 'descending' | 'ascending';

/** Per-measure statistics for one completed rep. */
export interface RepMeasureStats {
  atBottom: number;
  atTop: number;
  min: number;
  max: number;
  mean: number;
  range: number;
}

export interface RepResult {
  /** 1-based rep number within the set. */
  n: number;
  startT: number;
  bottomT: number;
  endT: number;
  /** Eccentric (lowering) duration, ms. */
  tempoDownMs: number;
  /** Concentric (lifting) duration, ms. */
  tempoUpMs: number;
  /** Mean keypoint confidence over the rep, 0..1. */
  confidence: number;
  measures: Record<string, RepMeasureStats>;
  /** Ids of cues that fired on this rep. */
  flags: string[];
}

export interface LiveState {
  reps: number;
  phase: RepPhase;
  side: CameraSide;
  /** 0 at the top, 1 at the spec's bottom threshold. Drives the depth bar. */
  depth: number;
  /** Cues from the most recent completed rep, worst first. Max 2. */
  cues: CueSpec[];
  /** True when the view does not match what the spec needs. */
  wrongView: boolean;
  /** True when too many joints are missing to judge anything. */
  lowConfidence: boolean;
}

export interface EngineOptions {
  /**
   * Source frame aspect ratio (width / height) BEFORE the square model resize.
   * Without this every angle is skewed. See geometry.ts.
   */
  aspect?: number;
  /** EMA smoothing factor for measures. Lower is smoother but laggier. */
  alpha?: number;
}

/**
 * Majority vote over a sliding window, so a single bad frame cannot flip the
 * detected camera side mid-rep and swap which knee we are grading.
 */
class SideVoter {
  private readonly window: CameraSide[] = [];

  constructor(private readonly size = 15) {}

  push(v: CameraSide): CameraSide {
    this.window.push(v);
    if (this.window.length > this.size) this.window.shift();
    const counts = new Map<CameraSide, number>();
    for (const s of this.window) counts.set(s, (counts.get(s) ?? 0) + 1);
    // 'unknown' is the absence of a reading, not a reading. Counting it as a
    // candidate lets a partly occluded lifter be graded with no established
    // view at all, and leaves resolveJoint picking whichever of the left/right
    // pair scored higher on each individual frame -- so the driver alternates
    // between two different joints and carries a permanent oscillation.
    let best: CameraSide = 'unknown';
    let bestN = 0;
    for (const [s, n] of counts) {
      if (s === 'unknown') continue;
      if (n > bestN) {
        best = s;
        bestN = n;
      }
    }
    // Only commit to a side once a real majority of the window agrees.
    return bestN * 2 > this.window.length ? best : 'unknown';
  }
}

/**
 * How long a measure may coast on its last real sample before it counts as
 * unavailable. At the ~22 fps the engine is fed, this is about a third of a
 * second: long enough to ride out a hand crossing a knee, short enough that a
 * joint lost for a whole rep stops contributing to that rep's numbers.
 */
const MAX_STALE_FRAMES = 7;

/** Running accumulator for one measure inside the rep currently in progress. */
interface MeasureAcc {
  min: number;
  max: number;
  sum: number;
  n: number;
  atBottom: number;
  atTop: number;
}

function newAcc(): MeasureAcc {
  return { min: Infinity, max: -Infinity, sum: 0, n: 0, atBottom: NaN, atTop: NaN };
}

export class FormEngine {
  private aspect: number;
  private readonly ema = new Map<string, Ema>();
  private readonly sideVoter = new SideVoter();

  private phase: RepPhase = 'waiting';
  private side: CameraSide = 'unknown';
  private acc = new Map<string, MeasureAcc>();
  private repStartT = NaN;
  private repBottomT = NaN;
  /** Most extreme driver value seen so far in the current descent. */
  private bottomDriver = NaN;
  private confSum = 0;
  private confN = 0;
  /** Same running mean, but scoped to the rep in progress. */
  private repConfSum = 0;
  private repConfN = 0;

  private readonly reps: RepResult[] = [];
  /**
   * The cues the live badge shows, already trimmed to the two it can display.
   * Stored pre-sliced and only reassigned when the fired set actually changes,
   * because the screen dedups renders by comparing this array by reference —
   * slicing on every push would allocate a fresh array ~20 times a second and
   * defeat the guard entirely.
   */
  private liveCues: CueSpec[] = [];
  private frames = 0;
  private lowConfFrames = 0;
  private firstT = NaN;
  private lastT = NaN;

  constructor(
    private readonly spec: FormRuleSpec,
    opts: EngineOptions = {}
  ) {
    this.aspect = opts.aspect ?? 1;
    for (const m of spec.measures) this.ema.set(m.id, new Ema(opts.alpha ?? 0.35));
    this.resetAcc();
  }

  /**
   * Correct the frame aspect ratio once the camera has reported it.
   *
   * Nothing knows the sensor's shape until the first frame arrives, and every
   * angle depends on it, so the engine is built with a placeholder and told the
   * real value before it grades anything.
   */
  setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) this.aspect = aspect;
  }

  /** Feed one inference result. Returns the state to render this frame. */
  push(frame: PoseFrame): LiveState {
    this.frames++;
    if (Number.isNaN(this.firstT)) this.firstT = frame.t;
    this.lastT = frame.t;

    const conf = meanKeypointScore(frame);
    this.confSum += conf;
    this.confN++;
    this.repConfSum += conf;
    this.repConfN++;

    this.side = this.sideVoter.push(detectSide(frame, this.aspect));
    const wrongView = this.isWrongView();

    // An unestablished side is missing information, not a wrong camera angle,
    // so it reads as low confidence: the honest prompt is "step back so I can
    // see all of you", not an accusation about how the phone is placed. It also
    // has to stop the rep machine, because with no side every joint lookup
    // falls back to whichever of the left/right pair scored higher on THIS
    // frame, and the driver ends up alternating between two different joints.
    // Not conditioned on spec.view: an 'any' spec still resolves sided joints,
    // so it needs a committed side just as much as a 'side' one does.
    const sideUnknown = this.side === 'unknown';
    const lowConf = conf < MIN_KEYPOINT_SCORE || sideUnknown;
    if (lowConf) this.lowConfFrames++;

    // Evaluate + smooth every measure for this frame.
    const values = new Map<string, number>();
    for (const m of this.spec.measures) {
      const raw = evalMeasure(m, frame, this.side, this.aspect);
      const ema = this.ema.get(m.id)!;
      const smoothed = ema.push(raw);
      // Riding out a frame or two of occlusion is what the EMA is for. Beyond
      // that the value is a memory, not a measurement, and folding it into the
      // aggregates would report a joint that has not been seen in a second as
      // if it were holding perfectly still.
      values.set(m.id, ema.stale > MAX_STALE_FRAMES ? NaN : smoothed);
    }

    const driver = values.get(this.spec.rep.driver) ?? NaN;
    if (Number.isFinite(driver) && !lowConf && !wrongView) {
      this.advance(driver, values, frame.t);
    }

    return {
      reps: this.reps.length,
      phase: this.phase,
      side: this.side,
      depth: this.depthOf(driver),
      cues: this.liveCues,
      wrongView,
      lowConfidence: lowConf,
    };
  }

  /** Close the set and produce the payload the coach reasons over. */
  finish(): SetAnalysis {
    return {
      reps: this.reps,
      side: this.side,
      confidenceAvg: this.confN ? this.confSum / this.confN : 0,
      framesTotal: this.frames,
      framesLowConf: this.lowConfFrames,
      durationMs: Number.isFinite(this.firstT) ? Math.max(0, this.lastT - this.firstT) : 0,
      view: this.spec.view,
      wrongView: this.isWrongView(),
    };
  }

  get repCount(): number {
    return this.reps.length;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private isWrongView(): boolean {
    if (this.spec.view === 'any') return false;
    if (this.side === 'unknown') return false; // not enough info to accuse
    if (this.spec.view === 'front') return this.side !== 'front';
    return this.side !== 'left' && this.side !== 'right';
  }

  /** 0 at the top threshold, 1 at the bottom threshold, clamped. */
  private depthOf(driver: number): number {
    if (!Number.isFinite(driver)) return 0;
    const { top, bottom } = this.spec.rep;
    const span = bottom - top;
    if (span === 0) return 0;
    const p = (driver - top) / span;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  private isDown(v: number): boolean {
    const { downIncreases, bottom } = this.spec.rep;
    return downIncreases ? v >= bottom : v <= bottom;
  }

  private isUp(v: number): boolean {
    const { downIncreases, top } = this.spec.rep;
    return downIncreases ? v <= top : v >= top;
  }

  /** Is `v` further down than the deepest point seen so far this rep? */
  private isDeeper(v: number): boolean {
    if (!Number.isFinite(this.bottomDriver)) return true;
    return this.spec.rep.downIncreases ? v > this.bottomDriver : v < this.bottomDriver;
  }

  private resetAcc() {
    this.acc = new Map();
    for (const m of this.spec.measures) this.acc.set(m.id, newAcc());
    this.bottomDriver = NaN;
    this.repBottomT = NaN;
    this.repConfSum = 0;
    this.repConfN = 0;
  }

  private accumulate(values: Map<string, number>) {
    for (const [id, v] of values) {
      if (!Number.isFinite(v)) continue;
      const a = this.acc.get(id);
      if (!a) continue;
      if (v < a.min) a.min = v;
      if (v > a.max) a.max = v;
      a.sum += v;
      a.n++;
    }
  }

  /**
   * The rep phase machine.
   *
   * waiting -> top      once the user is standing/locked out, so we never count
   *                     the walk-out as half a rep
   * top -> descending   first frame past the top threshold
   * descending -> ascending  once the bottom threshold is crossed
   * ascending -> top    back above the top threshold: rep complete
   *
   * The gap between `top` and `bottom` is the hysteresis band. A wobble inside
   * it changes nothing, which is what keeps a grinding rep from counting twice.
   */
  private advance(driver: number, values: Map<string, number>, t: number) {
    switch (this.phase) {
      case 'waiting':
        if (this.isUp(driver)) {
          this.phase = 'top';
          this.repStartT = t;
          this.resetAcc();
        }
        return;

      case 'top':
        if (!this.isUp(driver)) {
          this.phase = 'descending';
          this.repStartT = t;
          this.resetAcc();
          this.accumulate(values);
        }
        return;

      case 'descending': {
        this.accumulate(values);
        if (this.isDeeper(driver)) {
          this.bottomDriver = driver;
          this.repBottomT = t;
          this.snapshotBottom(values);
        }
        if (this.isDown(driver)) {
          this.phase = 'ascending';
          return;
        }
        // Back to standing without ever reaching the bottom: a re-grip, a
        // adjustment, a false start. Without this the machine stays parked in
        // `descending`, and the abandoned dip plus every second of standing
        // still gets folded into the NEXT rep -- reporting an eight second
        // eccentric for a rep that took under a second, and diluting every
        // mean-sampled cue below its threshold.
        if (this.isUp(driver)) {
          this.phase = 'top';
          this.repStartT = t;
          this.resetAcc();
          return;
        }
        // Abandoned rep: they went down and just stayed there.
        if (t - this.repStartT > this.spec.rep.maxRepMs) {
          this.phase = 'waiting';
          this.resetAcc();
        }
        return;
      }

      case 'ascending': {
        this.accumulate(values);
        if (this.isDeeper(driver)) {
          this.bottomDriver = driver;
          this.repBottomT = t;
          this.snapshotBottom(values);
        }
        if (this.isUp(driver)) {
          this.snapshotTop(values);
          this.completeRep(t);
          this.phase = 'top';
          this.repStartT = t;
          this.resetAcc();
          return;
        }
        if (t - this.repStartT > this.spec.rep.maxRepMs) {
          this.phase = 'waiting';
          this.resetAcc();
        }
        return;
      }
    }
  }

  private snapshotBottom(values: Map<string, number>) {
    for (const [id, v] of values) {
      const a = this.acc.get(id);
      if (a && Number.isFinite(v)) a.atBottom = v;
    }
  }

  private snapshotTop(values: Map<string, number>) {
    for (const [id, v] of values) {
      const a = this.acc.get(id);
      if (a && Number.isFinite(v)) a.atTop = v;
    }
  }

  private completeRep(endT: number) {
    const durationMs = endT - this.repStartT;
    // Too fast to be a rep: a bounce or a tracking glitch. Drop it silently
    // rather than inflating the count.
    if (durationMs < this.spec.rep.minRepMs) return;

    const measures: Record<string, RepMeasureStats> = {};
    for (const [id, a] of this.acc) {
      measures[id] = {
        atBottom: a.atBottom,
        atTop: a.atTop,
        min: a.n ? a.min : NaN,
        max: a.n ? a.max : NaN,
        mean: a.n ? a.sum / a.n : NaN,
        range: a.n ? a.max - a.min : NaN,
      };
    }

    const flags: string[] = [];
    const fired: CueSpec[] = [];
    for (const cue of this.spec.cues) {
      const stats = measures[cue.measure];
      if (!stats) continue;
      const value = sampleOf(stats, cue.sample);
      if (testFires(cue.test, value)) {
        flags.push(cue.id);
        fired.push(cue);
      }
    }
    // Worst first, so the two-cue live badge always shows the real problem.
    fired.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'bad' ? -1 : 1));
    // Reuse the previous array when the same cues fired again, so the screen's
    // reference-equality render guard keeps holding across unchanged reps.
    const nextLive = fired.slice(0, 2);
    if (!sameCues(this.liveCues, nextLive)) this.liveCues = nextLive;

    const bottomT = Number.isFinite(this.repBottomT) ? this.repBottomT : this.repStartT;
    this.reps.push({
      n: this.reps.length + 1,
      startT: this.repStartT,
      bottomT,
      endT,
      tempoDownMs: Math.max(0, bottomT - this.repStartT),
      tempoUpMs: Math.max(0, endT - bottomT),
      // Scoped to this rep, per RepResult.confidence's contract. The
      // session-wide mean lives on SetAnalysis.confidenceAvg.
      confidence: this.repConfN ? this.repConfSum / this.repConfN : 0,
      measures,
      flags,
    });
  }
}

export interface SetAnalysis {
  reps: RepResult[];
  side: CameraSide;
  confidenceAvg: number;
  framesTotal: number;
  framesLowConf: number;
  durationMs: number;
  view: FormRuleSpec['view'];
  wrongView: boolean;
}

/** Same cues, in the same order? Compared by id: specs are immutable. */
function sameCues(a: CueSpec[], b: CueSpec[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

function sampleOf(stats: RepMeasureStats, sample: CueSample): number {
  switch (sample) {
    case 'bottom':
      return stats.atBottom;
    case 'top':
      return stats.atTop;
    case 'min':
      return stats.min;
    case 'max':
      return stats.max;
    case 'mean':
      return stats.mean;
    case 'range':
      return stats.range;
  }
}

/**
 * Torso length in corrected units, used to normalise gap measures so that
 * thresholds do not depend on how far the user stands from the phone.
 */
function torsoLength(frame: PoseFrame, side: CameraSide, aspect: number): number {
  const sh = resolveJoint(frame, 'midShoulder', side, aspect) ?? resolveJoint(frame, 'shoulder', side, aspect);
  const hp = resolveJoint(frame, 'midHip', side, aspect) ?? resolveJoint(frame, 'hip', side, aspect);
  if (!sh || !hp) return NaN;
  const d = Math.hypot(sh.x - hp.x, sh.y - hp.y);
  return d > 1e-4 ? d : NaN;
}

/** Compute one measure for one frame. NaN whenever a required joint is missing. */
export function evalMeasure(
  m: MeasureSpec,
  frame: PoseFrame,
  side: CameraSide,
  aspect: number
): number {
  if (m.kind === 'jointAngle') {
    const a = resolveJoint(frame, m.at[0], side, aspect);
    const b = resolveJoint(frame, m.at[1], side, aspect);
    const c = resolveJoint(frame, m.at[2], side, aspect);
    if (!a || !b || !c) return NaN;
    return angleAt(a, b, c);
  }

  const from = resolveJoint(frame, m.from, side, aspect);
  const to = resolveJoint(frame, m.to, side, aspect);
  if (!from || !to) return NaN;

  switch (m.kind) {
    case 'segmentVertical':
      return angleFromVertical(from, to);
    case 'segmentHorizontal':
      return angleFromHorizontal(from, to);
    case 'verticalGap': {
      const torso = torsoLength(frame, side, aspect);
      return Number.isNaN(torso) ? NaN : verticalGap(from, to) / torso;
    }
    case 'horizontalGap': {
      const torso = torsoLength(frame, side, aspect);
      return Number.isNaN(torso) ? NaN : horizontalGap(from, to) / torso;
    }
  }
}

/** Mean confidence across the joints that actually matter for lifting. */
function meanKeypointScore(frame: PoseFrame): number {
  const kp = frame.keypoints;
  return meanFinite([
    kp.leftShoulder.score,
    kp.rightShoulder.score,
    kp.leftHip.score,
    kp.rightHip.score,
    kp.leftKnee.score,
    kp.rightKnee.score,
    kp.leftElbow.score,
    kp.rightElbow.score,
  ]);
}

export { round1 };
