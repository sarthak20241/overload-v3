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
 *
 * The URL names a COMMIT SHA rather than `main`. That matters: this binary is
 * handed straight to the TFLite runtime, and a branch ref would let whatever
 * the mirror points at today become code we execute. A commit path is
 * content-addressed by git, so its bytes cannot change under us.
 */
const MODEL_COMMIT = '9d70b988fe9bb936e9fc3155aae0e9de2cd4dde1';
export const POSE_MODEL_URL =
  `https://raw.githubusercontent.com/Kazuhito00/MoveNet-Python-Example/${MODEL_COMMIT}/tflite/lite-model_movenet_singlepose_thunder_tflite_float16_4.tflite`;

/**
 * MD5 of the file at that commit, verified after every download.
 *
 * MD5 is not collision-resistant, but it is not being asked to be: the commit
 * pin above is what makes the bytes immutable. This is the belt to that
 * braces, catching a corrupted, truncated, or substituted download that the
 * size window would wave through. It is also free -- the OS computes it, so
 * nothing has to read 12 MB into JS.
 */
const MODEL_MD5 = '79f70a81ff84589ae74250a7ea914a09';

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

/**
 * Is the model on disk and the right size?
 *
 * Deliberately does NOT hash: `File.md5` is a synchronous getter that reads all
 * 12 MB on the calling thread, and this runs every time the screen mounts.
 * The hash is checked once, by `verifyPoseModel` below, at the only moment the
 * bytes can have changed -- immediately after a download.
 */
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

/** Does the file on disk hash to the model we pinned? */
function verifyPoseModel(): boolean {
  try {
    return modelFile().md5 === MODEL_MD5;
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

    // Hash exactly here: the file is new, and this is the one moment its bytes
    // could differ from the pinned model.
    if (!isPoseModelReady() || !verifyPoseModel()) {
      const size = modelFile().exists ? (modelFile().size ?? 0) : 0;
      try {
        if (modelFile().exists) modelFile().delete();
      } catch {
        // Nothing more we can do; the checks will catch it next time too.
      }
      // A file of the right size that still fails the hash is the wrong file,
      // not a flaky connection, so it is never loaded.
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
