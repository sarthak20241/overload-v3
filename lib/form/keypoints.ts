/**
 * COCO-17 keypoint vocabulary. This is the contract between the pose model and
 * every rule spec, so it must stay stable: rule specs stored in Postgres refer
 * to joints BY NAME, and a renamed joint would silently break saved rules.
 *
 * MoveNet (SinglePose Lightning / Thunder) emits a [1, 1, 17, 3] tensor of
 * (y, x, score) in NORMALISED image coordinates (0..1), y first. We convert to
 * {x, y, score} with x/y still normalised and y growing DOWNWARD (image space).
 */

export const KEYPOINT_NAMES = [
  'nose',
  'leftEye',
  'rightEye',
  'leftEar',
  'rightEar',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'leftHip',
  'rightHip',
  'leftKnee',
  'rightKnee',
  'leftAnkle',
  'rightAnkle',
] as const;

export type KeypointName = (typeof KEYPOINT_NAMES)[number];

/** Index of each joint in the MoveNet output tensor. */
export const KEYPOINT_INDEX = KEYPOINT_NAMES.reduce(
  (acc, name, i) => {
    acc[name] = i;
    return acc;
  },
  {} as Record<KeypointName, number>
);

export interface Keypoint {
  x: number;
  y: number;
  /** Model confidence 0..1. Below MIN_KEYPOINT_SCORE the point is unusable. */
  score: number;
}

/** One inference result: every joint, plus the frame timestamp in ms. */
export interface PoseFrame {
  t: number;
  keypoints: Record<KeypointName, Keypoint>;
}

/**
 * Confidence floor. MoveNet emits plausible-looking coordinates for occluded
 * joints with a low score, so anything under this is treated as MISSING rather
 * than trusted. Chosen at 0.3 to match the MoveNet reference implementation.
 */
export const MIN_KEYPOINT_SCORE = 0.3;

/**
 * Sided joints come in left/right pairs. `SIDE_PAIRS` lets a rule spec say
 * "knee" and let the engine resolve it to the side actually facing the camera.
 */
export const SIDE_PAIRS = {
  shoulder: ['leftShoulder', 'rightShoulder'],
  elbow: ['leftElbow', 'rightElbow'],
  wrist: ['leftWrist', 'rightWrist'],
  hip: ['leftHip', 'rightHip'],
  knee: ['leftKnee', 'rightKnee'],
  ankle: ['leftAnkle', 'rightAnkle'],
  ear: ['leftEar', 'rightEar'],
  eye: ['leftEye', 'rightEye'],
} as const satisfies Record<string, readonly [KeypointName, KeypointName]>;

export type SidedJoint = keyof typeof SIDE_PAIRS;

/**
 * A joint reference inside a rule spec. Either an explicit COCO name
 * ('leftKnee') or a side-agnostic name ('knee') the engine resolves per frame
 * against the detected camera side. Side-agnostic is what rule authors should
 * use: the same squat spec then works whether the user films their left or
 * right side.
 */
export type JointRef = KeypointName | SidedJoint | 'midHip' | 'midShoulder';

export function isSidedJoint(ref: string): ref is SidedJoint {
  return Object.prototype.hasOwnProperty.call(SIDE_PAIRS, ref);
}

export function isKeypointName(ref: string): ref is KeypointName {
  return (KEYPOINT_NAMES as readonly string[]).includes(ref);
}

/** Skeleton edges, for the Skia overlay. Pure presentation, no rule meaning. */
export const SKELETON_EDGES: ReadonlyArray<readonly [KeypointName, KeypointName]> = [
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle'],
];

/**
 * Decode a MoveNet output tensor into a PoseFrame.
 *
 * @param out  Flat Float32Array of length 51: 17 * (y, x, score).
 * @param t    Frame timestamp in ms.
 * @param mirrored  True for the front camera, where the preview is mirrored and
 *                  x must be flipped so "left knee" means the user's left.
 */
export function decodeMoveNet(
  out: ArrayLike<number>,
  t: number,
  mirrored = false
): PoseFrame {
  const keypoints = {} as Record<KeypointName, Keypoint>;
  for (let i = 0; i < KEYPOINT_NAMES.length; i++) {
    const y = out[i * 3];
    const x = out[i * 3 + 1];
    const score = out[i * 3 + 2];
    keypoints[KEYPOINT_NAMES[i]] = {
      x: mirrored ? 1 - x : x,
      y,
      score,
    };
  }
  return { t, keypoints };
}
