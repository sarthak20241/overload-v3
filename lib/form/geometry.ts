/**
 * Angle math over pose keypoints. Pure functions, no React and no native deps,
 * so this file runs identically in the app, in a worklet, and in a Node test.
 *
 * ASPECT CORRECTION, the thing that quietly ruins angle math:
 * MoveNet takes a SQUARE input (256x256) and emits coordinates normalised 0..1
 * on that square. A 16:9 camera frame squeezed into that square makes every
 * horizontal distance shrink by 9/16, which bends every angle. Before any
 * trigonometry we therefore scale x back by the source aspect ratio (w/h).
 * Callers pass `aspect` once; everything downstream works in corrected space.
 */

import {
  MIN_KEYPOINT_SCORE,
  SIDE_PAIRS,
  isKeypointName,
  isSidedJoint,
  type JointRef,
  type Keypoint,
  type KeypointName,
  type PoseFrame,
} from './keypoints';

export interface Vec {
  x: number;
  y: number;
}

export type CameraSide = 'left' | 'right' | 'front' | 'unknown';

/** Radians to degrees. */
const DEG = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Resolve a rule-spec joint reference against a frame.
 *
 * - Explicit COCO names ('leftKnee') resolve directly.
 * - Side-agnostic names ('knee') resolve to the side facing the camera.
 * - 'midHip' / 'midShoulder' are the midpoints, used for torso lines when the
 *   user films from the front and neither side is authoritative.
 *
 * Returns null when the joint is missing or below the confidence floor, which
 * callers MUST treat as "unknown", never as zero.
 */
/**
 * How much better the far limb must score before a front-on view switches to
 * it. Comfortably above MoveNet's frame-to-frame noise, so the choice holds
 * for a whole rep instead of flickering.
 */
const SIDE_SWITCH_MARGIN = 0.15;

export function resolveJoint(
  frame: PoseFrame,
  ref: JointRef,
  side: CameraSide,
  aspect = 1
): Vec | null {
  if (ref === 'midHip' || ref === 'midShoulder') {
    const pair: readonly [KeypointName, KeypointName] =
      ref === 'midHip'
        ? ['leftHip', 'rightHip']
        : ['leftShoulder', 'rightShoulder'];
    const a = frame.keypoints[pair[0]];
    const b = frame.keypoints[pair[1]];
    if (!usable(a) || !usable(b)) return null;
    return { x: ((a.x + b.x) / 2) * aspect, y: (a.y + b.y) / 2 };
  }

  let name: KeypointName | null = null;
  if (isKeypointName(ref)) {
    name = ref;
  } else if (isSidedJoint(ref)) {
    const [left, right] = SIDE_PAIRS[ref];
    if (side === 'left') name = left;
    else if (side === 'right') name = right;
    else if (side === 'unknown') {
      // No established view means no basis for choosing a limb. Picking by
      // this frame's score would make the driver alternate between two
      // DIFFERENT joints from frame to frame -- exactly the oscillation the
      // SideVoter exists to prevent. Report nothing instead; the engine reads
      // that as an unclear frame and declines to grade it.
      return null;
    } else {
      // Front on, both limbs visible. Default to one side and switch only on a
      // clear margin, so keypoint jitter cannot flip the choice mid-rep.
      const l = frame.keypoints[left];
      const r = frame.keypoints[right];
      name = r.score > l.score + SIDE_SWITCH_MARGIN ? right : left;
    }
  }
  if (!name) return null;

  const kp = frame.keypoints[name];
  if (!usable(kp)) return null;
  return { x: kp.x * aspect, y: kp.y };
}

export function usable(kp: Keypoint | undefined): boolean {
  return !!kp && kp.score >= MIN_KEYPOINT_SCORE;
}

/**
 * Interior angle at vertex `b`, in degrees, 0..180.
 * Straight limb = 180, fully folded = 0.
 */
export function angleAt(a: Vec, b: Vec, c: Vec): number {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const magA = Math.hypot(abx, aby);
  const magC = Math.hypot(cbx, cby);
  if (magA === 0 || magC === 0) return NaN;
  return Math.acos(clamp(dot / (magA * magC), -1, 1)) * DEG;
}

/**
 * Angle of segment a->b away from vertical, in degrees, 0..180.
 * 0 = perfectly upright. Image y grows downward, so "up" is (0, -1).
 * Used for torso lean, shin angle, forearm verticality.
 */
export function angleFromVertical(a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const mag = Math.hypot(dx, dy);
  if (mag === 0) return NaN;
  // Compare against "up" = (0, -1); sign-free, we only care about tilt size.
  return Math.acos(clamp(-dy / mag, -1, 1)) * DEG;
}

/** Angle of segment a->b away from horizontal, 0..90. Used for back angle. */
export function angleFromHorizontal(a: Vec, b: Vec): number {
  const v = angleFromVertical(a, b);
  return Number.isNaN(v) ? NaN : Math.abs(90 - v);
}

/** Signed vertical gap b.y - a.y in corrected units. Positive = b is LOWER. */
export function verticalGap(a: Vec, b: Vec): number {
  return b.y - a.y;
}

/** Absolute horizontal gap, corrected units. */
export function horizontalGap(a: Vec, b: Vec): number {
  return Math.abs(b.x - a.x);
}

/**
 * Which way is the user facing?
 *
 * Side-on, the two shoulders (and two hips) project almost on top of each
 * other, so their horizontal spread collapses relative to torso height. Facing
 * the camera, the spread is wide. We compare shoulder spread to torso length,
 * which is scale-invariant and works at any distance from the phone.
 *
 * Then the NOSE breaks the left/right tie: filming the user's left side puts
 * the nose to the left of the shoulder line in image space.
 */
export function detectSide(frame: PoseFrame, aspect = 1): CameraSide {
  const ls = frame.keypoints.leftShoulder;
  const rs = frame.keypoints.rightShoulder;
  const lh = frame.keypoints.leftHip;
  const rh = frame.keypoints.rightHip;
  if (!usable(ls) || !usable(rs) || !usable(lh) || !usable(rh)) return 'unknown';

  const shoulderSpread = Math.abs(ls.x - rs.x) * aspect;
  // Torso SIZE, not torso height. Using the vertical gap alone would collapse
  // to nearly zero for any lying exercise (bench press, push-up), making a
  // side-on lifter look front-on and getting the whole set refused.
  const midShoulderX = ((ls.x + rs.x) / 2) * aspect;
  const midShoulderY = (ls.y + rs.y) / 2;
  const midHipX = ((lh.x + rh.x) / 2) * aspect;
  const midHipY = (lh.y + rh.y) / 2;
  const torso = Math.hypot(midHipX - midShoulderX, midHipY - midShoulderY);
  if (torso < 1e-4) return 'unknown';

  const ratio = shoulderSpread / torso;
  // Empirical: side-on sits near 0.1-0.3, front-on near 0.8-1.4. The gap is
  // wide, so 0.45 separates them without flickering mid-rep.
  if (ratio > 0.45) return 'front';

  const nose = frame.keypoints.nose;
  if (!usable(nose)) return 'unknown';
  // Nose left of the shoulder column => we are looking at the user's left side.
  return nose.x * aspect < midShoulderX ? 'left' : 'right';
}

/**
 * Exponential moving average for one scalar signal.
 *
 * Raw per-frame angles jitter by several degrees, which would false-trigger
 * both rep edges and cue thresholds. Alpha 0.35 removes that jitter while
 * staying responsive enough for a fast rep (the lag is roughly two frames).
 * NaN inputs (a missing joint) pass through without poisoning the state.
 *
 * The smoothing is anchored to TIME, not to sample count. A fixed per-sample
 * alpha means the filter is 3.7x more aggressive at the upload path's 6 fps
 * than at the live path's ~22, which flattens the peaks of the rep: measured
 * on a clean deep squat, the live path counted 3 reps and scored 100 while the
 * same motion at 6 fps counted 1 and fired "Sit deeper". Two paths grading one
 * lift differently is exactly what lib/form/videoFrames.ts promises cannot
 * happen, so alpha is interpreted at NOMINAL_DT_MS and rescaled by the real
 * gap between samples.
 */
/** The live path's frame interval; the cadence alpha is quoted against. */
const NOMINAL_DT_MS = 45;
export class Ema {
  private value: number | null = null;
  private staleFrames = 0;
  private readonly tau: number;

  /**
   * `alpha` is the weight a new sample gets at NOMINAL_DT_MS. It is converted
   * to a time constant so the smoothing is per unit time rather than per
   * sample, which is the only way one engine can grade two cadences alike.
   */
  constructor(alpha = 0.35) {
    const a = clamp(alpha, 0.01, 0.999);
    this.tau = -NOMINAL_DT_MS / Math.log(1 - a);
  }

  /**
   * @param dtMs Time since the previous sample. Omitted means nominal.
   */
  push(v: number, dtMs: number = NOMINAL_DT_MS): number {
    if (Number.isNaN(v)) {
      this.staleFrames++;
      return this.value ?? NaN;
    }
    this.staleFrames = 0;
    if (this.value === null) {
      this.value = v;
      return this.value;
    }
    // More elapsed time means the old value is less relevant, so a sparse
    // stream follows the signal harder. At the nominal step this reduces
    // exactly to the old fixed-alpha behaviour.
    const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : NOMINAL_DT_MS;
    const a = 1 - Math.exp(-dt / this.tau);
    this.value = a * v + (1 - a) * this.value;
    return this.value;
  }

  /**
   * Frames since the last real sample; 0 means fresh.
   *
   * Holding the last value across a brief occlusion is the point of the EMA,
   * but a caller that cannot tell "unchanged" from "unavailable" will fold the
   * same stale number into min, max, mean and range for as long as the joint
   * stays hidden. Confidence gating does not catch this: meanKeypointScore
   * samples shoulders, hips, knees and elbows, so a lost ankle or wrist never
   * raises it.
   */
  get stale(): number {
    return this.staleFrames;
  }

  get current(): number {
    return this.value ?? NaN;
  }

  reset() {
    this.value = null;
    this.staleFrames = 0;
  }
}

/** Mean of the finite values only. NaN when nothing is finite. */
export function meanFinite(values: readonly number[]): number {
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

/** Round to one decimal, or null when not finite. Keeps payloads small. */
export function round1(v: number): number | null {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}
