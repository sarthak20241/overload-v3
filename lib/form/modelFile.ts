/**
 * Where the pose model comes from.
 *
 * The model is fetched on first use into the app's document directory rather
 * than bundled with `require()`. Three reasons, in order of how much they
 * matter:
 *
 *   1. App size. MoveNet Thunder is roughly 12 MB. Bundling it taxes every
 *      download of the app, including the large majority of users who never
 *      open a form check.
 *   2. The binary stays out of git, where a multi-megabyte blob would sit in
 *      history forever.
 *   3. A bundled `require()` of a file that is not committed breaks the Metro
 *      bundle for the WHOLE app, not just this screen. Anyone checking out the
 *      branch without the model could not start the dev server at all.
 *
 * Downloaded once, then reused forever. Nothing here runs unless the user
 * actually opens a form check.
 */

import { Directory, File, Paths } from 'expo-file-system';

/**
 * MoveNet SinglePose Thunder, float16 (~12 MB).
 *
 * Kaggle Models and TFHub both require authentication now, so the model is
 * served from a public GitHub mirror of the official release. Pinned to
 * version 4 so the thresholds in lib/form/patterns.ts stay valid.
 */
export const POSE_MODEL_URL =
  'https://raw.githubusercontent.com/Kazuhito00/MoveNet-Python-Example/main/tflite/lite-model_movenet_singlepose_thunder_tflite_float16_4.tflite';

const MODEL_DIR = 'pose';
const MODEL_NAME = 'movenet_thunder.tflite';

/**
 * Sanity bounds on the downloaded file. The float16 Thunder build is about
 * 12 MB; anything wildly outside this is a captive-portal HTML page or a
 * truncated download, and loading it would fail deep inside the TFLite runtime
 * with an unhelpful message.
 */
const MIN_BYTES = 2_000_000;
const MAX_BYTES = 40_000_000;

export type ModelFileState =
  | { status: 'ready'; uri: string }
  | { status: 'error'; message: string };

function modelFile(): File {
  return new File(new Directory(Paths.document, MODEL_DIR), MODEL_NAME);
}

/** Is the model already on disk and plausible? */
export function isPoseModelReady(): boolean {
  try {
    const file = modelFile();
    if (!file.exists) return false;
    const size = file.size ?? 0;
    return size >= MIN_BYTES && size <= MAX_BYTES;
  } catch {
    return false;
  }
}

/** Local file URI, whether or not it exists yet. */
export function poseModelUri(): string {
  return modelFile().uri;
}

/**
 * Make sure the model is on disk, downloading it if not.
 *
 * Safe to call repeatedly: it returns immediately once the file is present.
 * A partial or bogus download is deleted rather than left to fail confusingly
 * on the next run.
 */
export async function ensurePoseModel(): Promise<ModelFileState> {
  try {
    if (isPoseModelReady()) return { status: 'ready', uri: poseModelUri() };

    const dir = new Directory(Paths.document, MODEL_DIR);
    if (!dir.exists) dir.create({ intermediates: true });

    // Clear a previous bad attempt so the download does not append or collide.
    const existing = modelFile();
    if (existing.exists) existing.delete();

    await File.downloadFileAsync(POSE_MODEL_URL, existing);

    if (!isPoseModelReady()) {
      const size = modelFile().exists ? (modelFile().size ?? 0) : 0;
      try {
        if (modelFile().exists) modelFile().delete();
      } catch {
        // Nothing more we can do; the size check will catch it next time too.
      }
      return {
        status: 'error',
        message:
          size === 0
            ? 'I could not download the pose model. Check your connection and try again.'
            : 'That download did not come through cleanly. Try again in a moment.',
      };
    }

    return { status: 'ready', uri: poseModelUri() };
  } catch (e) {
    return {
      status: 'error',
      message: `I could not get the pose model ready. ${(e as Error).message}`,
    };
  }
}

/** Remove the cached model. Exposed for a settings-level "free up space". */
export function deletePoseModel(): void {
  try {
    const file = modelFile();
    if (file.exists) file.delete();
  } catch {
    // Best effort.
  }
}
