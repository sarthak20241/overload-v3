/**
 * The upload path: sample a saved video into pose frames.
 *
 * Same engine, same rules, same summary as the live path. The only difference
 * is where frames come from, which is deliberate: two code paths that judged
 * the same lift differently would be impossible to reason about.
 *
 * ffmpeg-kit was retired, so frames come from expo-video-thumbnails, which uses
 * AVAssetImageGenerator on iOS and MediaMetadataRetriever on Android. It
 * extracts one frame per call, so this module is written around keeping that
 * call count small and the temporary files cleaned up.
 */

import { File } from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Skia } from '@shopify/react-native-skia';

import { decodeMoveNet, letterboxFor, type PoseFrame } from './keypoints';

/**
 * Sampling rate. A rep lasts one to three seconds, so 6 fps puts a dozen or
 * more samples inside every rep, which is plenty to find the bottom and time
 * the tempo. Doubling it would double the extraction cost for detail nobody
 * can act on.
 */
export const SAMPLE_FPS = 6;

/** Hard cap on clip length. Beyond this the user is asked to trim. */
export const MAX_CLIP_MS = 30_000;

/** Derived cap on native calls, so a long clip cannot hang the screen. */
export const MAX_FRAMES = Math.ceil((MAX_CLIP_MS / 1000) * SAMPLE_FPS);

export interface SampleOptions {
  uri: string;
  /** Clip duration in ms. Clamped to MAX_CLIP_MS. */
  durationMs: number;
  startMs?: number;
  /** Runs a model on one decoded frame. Returns the flat 51-value pose buffer. */
  infer: (pixels: Uint8Array, width: number, height: number) => ArrayLike<number> | null;
  /** 0..1, for the progress bar. */
  onProgress?: (fraction: number) => void;
  /** Set true to stop early when the user backs out. */
  shouldCancel?: () => boolean;
}

export interface SampleResult {
  frames: PoseFrame[];
  /** Frames the extractor or decoder could not produce. */
  skipped: number;
  cancelled: boolean;
  /**
   * The clip's aspect ratio (width / height), read off the decoded frames.
   *
   * The engine needs it for the same reason the live path does: coordinates
   * are normalised per axis, so every angle depends on the frame's real shape.
   * 1 when nothing decoded.
   */
  aspect: number;
}

/**
 * Walk the clip at SAMPLE_FPS, decode each frame, run the model, and collect
 * poses stamped with their real timestamp in the video. Using the video
 * timestamp rather than wall-clock is what keeps tempo honest: extraction is
 * far slower than real time, and wall-clock would report every rep as taking
 * ten seconds.
 */
export async function samplePoses({
  uri,
  durationMs,
  startMs = 0,
  infer,
  onProgress,
  shouldCancel,
}: SampleOptions): Promise<SampleResult> {
  const clipMs = Math.min(Math.max(0, durationMs), MAX_CLIP_MS);
  const step = 1000 / SAMPLE_FPS;
  const count = Math.min(MAX_FRAMES, Math.max(1, Math.floor(clipMs / step)));

  const frames: PoseFrame[] = [];
  const scratch: string[] = [];
  let skipped = 0;
  let aspect = 1;
  let cancelled = false;

  try {
    for (let i = 0; i < count; i++) {
      if (shouldCancel?.()) {
        cancelled = true;
        break;
      }
      const atMs = startMs + i * step;

      let thumbUri: string | null = null;
      try {
        const { uri: out } = await VideoThumbnails.getThumbnailAsync(uri, {
          time: Math.round(atMs),
          quality: 0.8,
        });
        thumbUri = out;
        scratch.push(out);
      } catch {
        // A single unreadable timestamp is normal near the end of a clip.
        skipped++;
        onProgress?.((i + 1) / count);
        continue;
      }

      const decoded = await decodeImage(thumbUri);
      if (!decoded) {
        skipped++;
        onProgress?.((i + 1) / count);
        continue;
      }

      const raw = infer(decoded.pixels, decoded.width, decoded.height);
      if (!raw || raw.length < 51) {
        skipped++;
      } else {
        aspect = decoded.height > 0 ? decoded.width / decoded.height : 1;
        // Same un-letterboxing the live path does on the frame thread, so both
        // paths hand the engine coordinates describing the real frame rather
        // than the padded square the model saw.
        frames.push(
          decodeMoveNet(raw, atMs, false, letterboxFor(decoded.width, decoded.height))
        );
      }
      onProgress?.((i + 1) / count);
    }
  } finally {
    // Thumbnails land in the cache directory and would otherwise accumulate
    // there for every clip the user ever checked.
    cleanUp(scratch);
  }

  return { frames, skipped, cancelled, aspect };
}

interface DecodedImage {
  pixels: Uint8Array;
  width: number;
  height: number;
}

/**
 * JPEG to RGBA bytes, via Skia. Skia is already a dependency for the overlay,
 * so this needs no extra native module.
 */
async function decodeImage(uri: string): Promise<DecodedImage | null> {
  let data: { dispose?: () => void } | null = null;
  let image: { dispose?: () => void } | null = null;
  try {
    const d = await Skia.Data.fromURI(uri);
    data = d as unknown as { dispose?: () => void };
    const img = Skia.Image.MakeImageFromEncoded(d);
    if (!img) return null;
    image = img as unknown as { dispose?: () => void };
    const width = img.width();
    const height = img.height();
    const pixels = img.readPixels() as Uint8Array | null;
    if (!pixels) return null;
    return { pixels, width, height };
  } catch {
    return null;
  } finally {
    // Both wrap native memory. A 30 second clip decodes up to 180 full
    // resolution images, so waiting for the collector to notice is the
    // difference between a bounded working set and an unbounded one.
    try {
      image?.dispose?.();
      data?.dispose?.();
    } catch {
      // Older Skia builds do not expose dispose; the collector handles it.
    }
  }
}

function cleanUp(uris: string[]): void {
  for (const u of uris) {
    try {
      // The `File` class, not the legacy `deleteAsync`: on SDK 54 that name is
      // a stub that throws unconditionally, so the catch below would have
      // swallowed every single delete and leaked the whole clip's thumbnails.
      const f = new File(u);
      if (f.exists) f.delete();
    } catch {
      // Best effort. A leftover cache file is not worth failing the check.
    }
  }
}

/**
 * Is this clip short enough to check as is?
 * Kept here so the picker and the analyser agree on the limit.
 */
export function needsTrim(durationMs: number): boolean {
  return durationMs > MAX_CLIP_MS;
}
