/**
 * Synthetic pose generator.
 *
 * The form engine has to be trustworthy before a single native dependency is
 * installed, and filming real squats is not a unit test. So we drive a simple
 * 2D stick-figure kinematic model through a known rep pattern and assert the
 * engine reads back exactly what we put in: this many reps, this depth, this
 * fault. Bugs in the phase machine or the angle math show up here in
 * milliseconds instead of on a gym floor.
 */

import { KEYPOINT_NAMES, type Keypoint, type KeypointName, type PoseFrame } from '../../lib/form/keypoints';

const RAD = Math.PI / 180;

interface Vec {
  x: number;
  y: number;
}

/** Segment lengths as a fraction of frame height. Roughly human proportions. */
const SEG = {
  shin: 0.15,
  thigh: 0.16,
  torso: 0.22,
  upperArm: 0.12,
  forearm: 0.11,
  head: 0.07,
};

export interface SquatPose {
  /** 0 = standing, 1 = deepest the model goes. */
  depth: number;
  /** Extra forward torso tilt in degrees, on top of the natural lean. */
  extraLean?: number;
}

/**
 * Build a side-view squat skeleton facing +x (image right), which means the
 * camera sees the lifter's RIGHT side. Joint positions are derived from
 * segment angles, so every angle the engine measures is a known quantity.
 */
export function squatSkeleton({ depth, extraLean = 0 }: SquatPose): Record<KeypointName, Keypoint> {
  const d = Math.max(0, Math.min(1, depth));

  const ankle: Vec = { x: 0.5, y: 0.9 };
  // Shin travels forward over the foot as the lifter descends.
  const shinAngle = d * 25 * RAD;
  const knee: Vec = {
    x: ankle.x + SEG.shin * Math.sin(shinAngle),
    y: ankle.y - SEG.shin * Math.cos(shinAngle),
  };
  // Thigh rotates back and down; past 90 degrees the hip sits below the knee.
  const thighAngle = d * 100 * RAD;
  const hip: Vec = {
    x: knee.x - SEG.thigh * Math.sin(thighAngle),
    y: knee.y - SEG.thigh * Math.cos(thighAngle),
  };
  const torsoAngle = (d * 40 + extraLean) * RAD;
  const shoulder: Vec = {
    x: hip.x + SEG.torso * Math.sin(torsoAngle),
    y: hip.y - SEG.torso * Math.cos(torsoAngle),
  };
  // Bar on the back: hands just behind and above the shoulder.
  const elbow: Vec = { x: shoulder.x - SEG.upperArm * 0.6, y: shoulder.y + SEG.upperArm * 0.8 };
  const wrist: Vec = { x: elbow.x + SEG.forearm * 0.2, y: elbow.y - SEG.forearm * 0.9 };
  // Nose ahead of the shoulder line, which is what marks this as a side view.
  const nose: Vec = { x: shoulder.x + SEG.head, y: shoulder.y - SEG.head * 0.5 };

  return build({ ankle, knee, hip, shoulder, elbow, wrist, nose });
}

/**
 * Side-view horizontal press (bench or push-up), driven by elbow angle.
 * `openness` 0 = arms folded at the chest, 1 = locked out.
 */
export function pressSkeleton(openness: number, hipAngleDeg = 178): Record<KeypointName, Keypoint> {
  const o = Math.max(0, Math.min(1, openness));
  const shoulder: Vec = { x: 0.5, y: 0.5 };
  // Elbow angle sweeps 70 (folded) to 175 (locked).
  const elbowAngle = (70 + o * 105) * RAD;
  const elbow: Vec = { x: shoulder.x + SEG.upperArm * 0.2, y: shoulder.y + SEG.upperArm };
  // Place the wrist so the shoulder-elbow-wrist angle equals elbowAngle.
  const upperDir = Math.atan2(shoulder.y - elbow.y, shoulder.x - elbow.x);
  const wristDir = upperDir - elbowAngle;
  const wrist: Vec = {
    x: elbow.x + SEG.forearm * Math.cos(wristDir),
    y: elbow.y + SEG.forearm * Math.sin(wristDir),
  };
  // Body laid out horizontally; hipAngle controls sag for the push-up case.
  const hip: Vec = { x: shoulder.x - SEG.torso, y: shoulder.y + 0.02 };
  const sag = (180 - hipAngleDeg) * RAD;
  const knee: Vec = {
    x: hip.x - SEG.thigh * Math.cos(sag),
    y: hip.y + SEG.thigh * Math.sin(sag),
  };
  const ankle: Vec = { x: knee.x - SEG.shin, y: knee.y };
  const nose: Vec = { x: shoulder.x + SEG.head, y: shoulder.y - SEG.head * 0.3 };
  return build({ ankle, knee, hip, shoulder, elbow, wrist, nose });
}

/** Expand a side-view joint set into all 17 COCO keypoints. */
function build(j: {
  ankle: Vec;
  knee: Vec;
  hip: Vec;
  shoulder: Vec;
  elbow: Vec;
  wrist: Vec;
  nose: Vec;
}): Record<KeypointName, Keypoint> {
  // Side on, the left and right joints project nearly on top of each other.
  // A small offset keeps detectSide out of the 'front' bucket while staying
  // far below the 0.45 shoulder-spread-to-torso ratio that means front view.
  const dx = 0.012;
  const kp = {} as Record<KeypointName, Keypoint>;
  const put = (name: KeypointName, v: Vec, score = 0.9) => {
    kp[name] = { x: v.x, y: v.y, score };
  };
  put('nose', j.nose);
  put('leftEye', { x: j.nose.x - 0.01, y: j.nose.y - 0.01 });
  put('rightEye', { x: j.nose.x + 0.01, y: j.nose.y - 0.01 });
  put('leftEar', { x: j.nose.x - 0.03, y: j.nose.y });
  put('rightEar', { x: j.nose.x - 0.02, y: j.nose.y });
  put('leftShoulder', { x: j.shoulder.x - dx, y: j.shoulder.y });
  put('rightShoulder', { x: j.shoulder.x + dx, y: j.shoulder.y });
  put('leftElbow', { x: j.elbow.x - dx, y: j.elbow.y });
  put('rightElbow', { x: j.elbow.x + dx, y: j.elbow.y });
  put('leftWrist', { x: j.wrist.x - dx, y: j.wrist.y });
  put('rightWrist', { x: j.wrist.x + dx, y: j.wrist.y });
  put('leftHip', { x: j.hip.x - dx, y: j.hip.y });
  put('rightHip', { x: j.hip.x + dx, y: j.hip.y });
  put('leftKnee', { x: j.knee.x - dx, y: j.knee.y });
  put('rightKnee', { x: j.knee.x + dx, y: j.knee.y });
  put('leftAnkle', { x: j.ankle.x - dx, y: j.ankle.y });
  put('rightAnkle', { x: j.ankle.x + dx, y: j.ankle.y });
  return kp;
}

/**
 * Deterministic pseudo-random noise. A fixed seed keeps the suite repeatable
 * while still proving the smoothing survives realistic keypoint jitter.
 */
export function makeNoise(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

export interface RepSequenceOptions {
  reps: number;
  /** Peak value of the depth/openness parameter for each rep. */
  peak: number;
  /** Frames per rep. 30 fps and a 2s rep is 60. */
  framesPerRep?: number;
  fps?: number;
  /** Keypoint jitter in normalised units. 0.004 is roughly real MoveNet noise. */
  jitter?: number;
  seed?: number;
  extraLean?: number;
  /** Frames of standing still before and after the set. */
  padFrames?: number;
}

/**
 * A full set: pad, then N smooth reps following a cosine so velocity is zero at
 * both ends (a real lifter does not teleport), then pad.
 */
export function squatSequence(opts: RepSequenceOptions): PoseFrame[] {
  const {
    reps,
    peak,
    framesPerRep = 60,
    fps = 30,
    jitter = 0,
    seed = 1,
    extraLean = 0,
    padFrames = 15,
  } = opts;
  const rnd = makeNoise(seed);
  const frames: PoseFrame[] = [];
  let t = 0;
  const dt = 1000 / fps;

  const push = (depth: number) => {
    const kp = squatSkeleton({ depth, extraLean });
    if (jitter > 0) applyJitter(kp, rnd, jitter);
    frames.push({ t, keypoints: kp });
    t += dt;
  };

  for (let i = 0; i < padFrames; i++) push(0);
  for (let r = 0; r < reps; r++) {
    for (let f = 0; f < framesPerRep; f++) {
      // Cosine from 0 up to peak and back to 0 across the rep.
      const phase = (f / framesPerRep) * 2 * Math.PI;
      push((peak * (1 - Math.cos(phase))) / 2);
    }
  }
  for (let i = 0; i < padFrames; i++) push(0);
  return frames;
}

export function pressSequence(opts: RepSequenceOptions & { hipAngleDeg?: number }): PoseFrame[] {
  const {
    reps,
    peak,
    framesPerRep = 60,
    fps = 30,
    jitter = 0,
    seed = 1,
    padFrames = 15,
    hipAngleDeg = 178,
  } = opts;
  const rnd = makeNoise(seed);
  const frames: PoseFrame[] = [];
  let t = 0;
  const dt = 1000 / fps;

  const push = (openness: number) => {
    const kp = pressSkeleton(openness, hipAngleDeg);
    if (jitter > 0) applyJitter(kp, rnd, jitter);
    frames.push({ t, keypoints: kp });
    t += dt;
  };

  // Press starts locked out (openness 1) and descends, so invert the wave.
  for (let i = 0; i < padFrames; i++) push(1);
  for (let r = 0; r < reps; r++) {
    for (let f = 0; f < framesPerRep; f++) {
      const phase = (f / framesPerRep) * 2 * Math.PI;
      push(1 - (peak * (1 - Math.cos(phase))) / 2);
    }
  }
  for (let i = 0; i < padFrames; i++) push(1);
  return frames;
}

function applyJitter(
  kp: Record<KeypointName, Keypoint>,
  rnd: () => number,
  amount: number
) {
  for (const name of KEYPOINT_NAMES) {
    kp[name] = {
      x: kp[name].x + rnd() * amount,
      y: kp[name].y + rnd() * amount,
      score: kp[name].score,
    };
  }
}

/** Drop a joint below the confidence floor, simulating occlusion. */
export function occlude(frames: PoseFrame[], joint: KeypointName, from: number, to: number) {
  for (let i = from; i < Math.min(to, frames.length); i++) {
    frames[i].keypoints[joint] = { ...frames[i].keypoints[joint], score: 0.05 };
  }
}
