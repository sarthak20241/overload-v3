/**
 * Pose model plumbing: what shape of input the model wants, and how to read its
 * output back as keypoints.
 *
 * Everything here is derived from the loaded model's own tensor metadata rather
 * than hardcoded, because the MoveNet family ships several variants that differ
 * in exactly the ways that would silently corrupt the result: Lightning takes
 * 192x192 where Thunder takes 256x256, and the quantised builds take uint8
 * where the float builds take float32. Reading the spec off the model means
 * dropping in a different .tflite file just works, and a genuinely incompatible
 * model fails loudly instead of producing garbage angles.
 *
 * Pure functions only, so the whole thing is testable without a device.
 */

import { KEYPOINT_NAMES } from './keypoints';

/** Mirrors react-native-fast-tflite's Tensor, without importing the native module. */
export interface ModelTensor {
  name: string;
  dataType: string;
  shape: number[];
}

/** What the resizer must be configured to produce. */
export interface InputSpec {
  width: number;
  height: number;
  /** Resizer dataType. Narrower than the model's, which is the point. */
  dataType: 'uint8' | 'float32';
}

export type InputSpecResult =
  | { ok: true; spec: InputSpec }
  | { ok: false; reason: string };

/**
 * Work out how to feed this model.
 *
 * MoveNet's input is NHWC: [1, height, width, 3]. Anything else is not a
 * single-person pose model we know how to drive, and we say so rather than
 * guessing.
 */
export function deriveInputSpec(input: ModelTensor | undefined): InputSpecResult {
  if (!input) return { ok: false, reason: 'model exposes no input tensor' };

  const shape = input.shape;
  if (shape.length !== 4 || shape[0] !== 1 || shape[3] !== 3) {
    return {
      ok: false,
      reason: `expected an input shaped [1, height, width, 3], got [${shape.join(', ')}]`,
    };
  }

  const height = shape[1];
  const width = shape[2];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32) {
    return { ok: false, reason: `input resolution ${width}x${height} is not usable` };
  }

  // The resizer can emit uint8 or float32. Quantised models want uint8; the
  // float builds want float32. Everything else is a model we cannot drive.
  let dataType: InputSpec['dataType'];
  switch (input.dataType) {
    case 'uint8':
      dataType = 'uint8';
      break;
    case 'int8':
      // The resizer emits 0..255; an int8 tensor reads those same bytes as
      // -128..127, so every pixel above mid grey arrives negative. Feeding it
      // anyway would produce confident nonsense rather than an obvious
      // failure, and there is no signed output format to ask the resizer for.
      return { ok: false, reason: 'int8 input models are not supported' };
    case 'float32':
    case 'float16':
      dataType = 'float32';
      break;
    default:
      return { ok: false, reason: `unsupported input dataType "${input.dataType}"` };
  }

  return { ok: true, spec: { width, height, dataType } };
}

/** 17 keypoints, 3 values each (y, x, score). */
export const MOVENET_OUTPUT_LENGTH = KEYPOINT_NAMES.length * 3;

export type OutputCheck = { ok: true } | { ok: false; reason: string };

/**
 * Confirm the model emits single-person MoveNet keypoints.
 *
 * Checked once at load rather than per frame: a multi-person model would emit
 * [1, 6, 56] and every angle downstream would be nonsense, so this is the
 * cheapest place to catch the wrong file.
 */
export function checkOutputShape(output: ModelTensor | undefined): OutputCheck {
  if (!output) return { ok: false, reason: 'model exposes no output tensor' };
  const total = output.shape.reduce((a, b) => a * b, 1);
  if (total !== MOVENET_OUTPUT_LENGTH) {
    return {
      ok: false,
      reason: `expected ${MOVENET_OUTPUT_LENGTH} output values (17 keypoints), got ${total} from shape [${output.shape.join(', ')}]`,
    };
  }
  // Everything downstream reads these as coordinates and scores already
  // normalised to 0..1. A quantised output is raw integers needing the tensor's
  // scale and zero point applied, which nothing here does -- so scores would
  // arrive as 0..255, every joint would look confident including the
  // hallucinated ones, and the overlay would draw off screen. Refusing the file
  // is the honest outcome; silently grading it is not.
  if (output.dataType !== 'float32') {
    return {
      ok: false,
      reason: `output must be float32, got ${output.dataType}. Quantised MoveNet builds are not supported.`,
    };
  }
  return { ok: true };
}

/**
 * View the model's raw output buffer as numbers.
 *
 * fast-tflite hands back ArrayBuffers whose element type matches the output
 * tensor, so a float model read as uint8 would give 51 meaningless bytes. The
 * dataType decides the view.
 */
export function viewOutput(buffer: ArrayBuffer, dataType: string): ArrayLike<number> | null {
  // float32 only, matching checkOutputShape. Quantised buffers are deliberately
  // NOT viewed: without the tensor's scale and zero point they are integers
  // masquerading as normalised coordinates.
  return dataType === 'float32' ? new Float32Array(buffer) : null;
}

/**
 * The camera's aspect ratio as the model saw it.
 *
 * The resizer squeezes a wide frame into a square input, so x and y come back
 * on different physical scales. Passing this into the engine is what undoes
 * that; see geometry.ts. Returns 1 when the frame dimensions are unknown, which
 * is the no-correction case.
 */
export function aspectOf(frameWidth: number, frameHeight: number): number {
  if (!frameWidth || !frameHeight) return 1;
  return frameWidth / frameHeight;
}
