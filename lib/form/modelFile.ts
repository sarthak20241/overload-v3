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
/**
 * The filename carries the model's identity, so changing MODEL_COMMIT or
 * MODEL_MD5 changes where the app looks.
 *
 * Without this, bumping the pinned model would strand every existing install:
 * the fast path only checks the file's SIZE (hashing 12 MB on every mount is
 * not affordable), so a cached older build of similar size would satisfy it
 * forever -- no re-download, no error, and the thresholds in patterns.ts
 * silently applied to a model they were never tuned against. A new identity is
 * simply a cache miss, which resolves itself.
 */
const MODEL_NAME = `movenet_thunder_${MODEL_MD5.slice(0, 8)}.tflite`;

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

/** Remove pose models from earlier pins, which nothing will ask for again. */
function dropSupersededModels(dir: Directory): void {
  try {
    for (const entry of dir.list()) {
      // Files only, and only ones shaped like a model we wrote. A bare prefix
      // match would also sweep up a directory that happened to start with the
      // same characters, which is not this function's business to delete.
      if (!(entry instanceof File)) continue;
      const name = entry.name;
      if (name === MODEL_NAME) continue;
      if (!name.startsWith('movenet_thunder_') || !name.endsWith('.tflite')) continue;
      entry.delete();
    }
  } catch {
    // Best effort: a leftover file wastes space but breaks nothing.
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
  // Two callers arriving together (a remount, or the screen reopened while the
  // first download is still running) would otherwise both delete the partial
  // file and download over each other. Share the first attempt instead.
  inFlight ??= runEnsurePoseModel().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let inFlight: Promise<ModelFileState> | null = null;

async function runEnsurePoseModel(): Promise<ModelFileState> {
  try {
    if (isPoseModelReady()) return { status: 'ready', uri: poseModelUri() };

    const dir = new Directory(Paths.document, MODEL_DIR);
    if (!dir.exists) dir.create({ intermediates: true });
    // A version bump makes the old file dead weight: 12 MB of a model nothing
    // will ever ask for again.
    dropSupersededModels(dir);

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
