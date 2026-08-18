/**
 * Owns one form-check session: the pose model, the frame processor, the rule
 * engine, and the live state the screen renders.
 *
 * THREADING, which is the whole design here:
 * inference runs on VisionCamera's frame thread (a worklet). From there the
 * keypoints go two ways. They are written straight into a Reanimated
 * SharedValue, which the Skia overlay reads on the UI thread with no bridge
 * hop, so the skeleton tracks the lifter in real time. Separately they are
 * handed to the JS thread, where the rule engine counts reps and evaluates
 * cues. Rep logic does not need to be frame-perfect; the drawing does.
 *
 * The engine lives in a ref rather than state because it is mutated ~30 times a
 * second and re-rendering on every frame would be absurd. Only the small
 * LiveState snapshot is pushed into React, and only when something a human
 * could notice actually changed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useSharedValue, runOnJS } from 'react-native-reanimated';
import {
  loadTensorflowModel,
  type TensorflowModelDelegate,
  type TfliteModel,
} from 'react-native-fast-tflite';
import { useFrameOutput } from 'react-native-vision-camera';
import { useResizer } from 'react-native-vision-camera-resizer';

import { FormEngine, type LiveState, type SetAnalysis } from '@/lib/form/engine';
import { decodeMoveNet } from '@/lib/form/keypoints';
import { checkOutputShape, deriveInputSpec, viewOutput } from '@/lib/form/model';
import { ensurePoseModel } from '@/lib/form/modelFile';
import type { FormRuleSpec } from '@/lib/form/spec';

/**
 * Cap the rate the rule engine is fed. The camera runs at 30 fps but rep
 * detection is comfortable at 20, and the headroom keeps the frame pipeline
 * from dropping buffers on mid-range Android.
 */
const ENGINE_MIN_INTERVAL_MS = 45;

/** Sensible defaults while the model is still loading. */
const FALLBACK_INPUT = { width: 256, height: 256, dataType: 'uint8' as const };

/**
 * Hardware acceleration. MoveNet Thunder on CPU lands around 10 fps on a
 * mid-range phone, which is too slow to time a rep, so the accelerated path is
 * the one that matters: CoreML on iOS, the GPU delegate on Android. NNAPI is
 * deliberately not used, having been deprecated in Android 15.
 */
const DELEGATES: TensorflowModelDelegate[] = Platform.select({
  ios: ['core-ml'],
  android: ['android-gpu'],
  default: [],
});

export type SessionStatus = 'loading' | 'ready' | 'error';

export interface FormSession {
  status: SessionStatus;
  /** Human-readable reason, in coach voice, when status is 'error'. */
  error: string | null;
  /** Flat 17 * (y, x, score) buffer for the overlay. */
  pose: ReturnType<typeof useSharedValue<number[]>>;
  live: LiveState;
  /** Pass to <Camera outputs={[...]}>. Null until the model is ready. */
  frameOutput: ReturnType<typeof useFrameOutput> | null;
  /** Close the set and hand back everything the engine measured. */
  finish: () => SetAnalysis | null;
  reset: () => void;
}

const IDLE_LIVE: LiveState = {
  reps: 0,
  phase: 'waiting',
  side: 'unknown',
  depth: 0,
  cues: [],
  wrongView: false,
  lowConfidence: false,
};

export interface UseFormSessionArgs {
  spec: FormRuleSpec | null;
  /** Source frame aspect ratio. Undoes the squeeze into the square model input. */
  aspect: number;
  /** True for the front camera, where the preview is mirrored. */
  mirrored?: boolean;
  /** Stop feeding the engine without tearing the camera down. */
  paused?: boolean;
}

export function useFormSession({
  spec,
  aspect,
  mirrored = false,
  paused = false,
}: UseFormSessionArgs): FormSession {
  const pose = useSharedValue<number[]>([]);
  const [live, setLive] = useState<LiveState>(IDLE_LIVE);
  const [modelError, setModelError] = useState<string | null>(null);

  const engineRef = useRef<FormEngine | null>(null);
  const lastFedAtRef = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // A fresh engine whenever the rules change, so switching exercise mid-screen
  // never grades one lift with another's thresholds.
  useEffect(() => {
    engineRef.current = spec ? new FormEngine(spec, { aspect }) : null;
    setLive(IDLE_LIVE);
  }, [spec, aspect]);

  // The model is fetched to disk on first use rather than bundled; see
  // lib/form/modelFile.ts for why. Loading is imperative rather than via
  // useTensorflowModel because that hook demands a source up front, and there
  // is nothing to give it until the download lands.
  const [model, setModel] = useState<TfliteModel | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const file = await ensurePoseModel();
      if (cancelled) return;
      if (file.status === 'error') {
        setModelError(file.message);
        return;
      }
      try {
        // Try hardware-accelerated first, fall back to CPU if the delegate
        // is unavailable (e.g. CoreML on the iOS Simulator).
        let loaded: TfliteModel;
        try {
          loaded = await loadTensorflowModel({ url: file.uri }, DELEGATES);
        } catch {
          loaded = await loadTensorflowModel({ url: file.uri }, []);
        }
        if (cancelled) return;

        // Validate once, loudly. A multi-person or oddly shaped model would
        // otherwise produce confident nonsense for every angle downstream.
        const derived = deriveInputSpec(loaded.inputs[0]);
        if (!derived.ok) {
          setModelError(`This pose model will not work here: ${derived.reason}`);
          return;
        }
        const out = checkOutputShape(loaded.outputs[0]);
        if (!out.ok) {
          setModelError(`This pose model will not work here: ${out.reason}`);
          return;
        }

        setModel(loaded);
        setModelError(null);
      } catch (e) {
        if (!cancelled) {
          setModelError(`I could not load the pose model. ${(e as Error).message}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Read the input geometry off the model instead of hardcoding it, so any
  // MoveNet variant (Thunder 256, Lightning 192, quantised or float) works.
  const inputSpec = useMemo(() => {
    if (!model) return FALLBACK_INPUT;
    const derived = deriveInputSpec(model.inputs[0]);
    return derived.ok ? derived.spec : FALLBACK_INPUT;
  }, [model]);

  const outputDataType = model?.outputs[0]?.dataType ?? 'float32';

  const { resizer } = useResizer({
    width: inputSpec.width,
    height: inputSpec.height,
    channelOrder: 'rgb',
    dataType: inputSpec.dataType,
    // MoveNet is NHWC, so complete pixels sit next to each other.
    pixelLayout: 'interleaved',
    // 'cover' would crop the lifter's feet out of a portrait frame, which is
    // exactly the joint the squat rules need most.
    scaleMode: 'contain',
  });

  /**
   * Called from the frame thread with one decoded pose. Feeds the rule engine
   * and pushes a snapshot into React only when the rendered numbers change.
   */
  const ingest = useCallback(
    (buffer: number[], t: number) => {
      if (pausedRef.current) return;
      const engine = engineRef.current;
      if (!engine) return;

      const now = t;
      if (now - lastFedAtRef.current < ENGINE_MIN_INTERVAL_MS) return;
      lastFedAtRef.current = now;

      const frame = decodeMoveNet(buffer, now, mirrored);
      const next = engine.push(frame);

      setLive((prev) =>
        prev.reps === next.reps &&
        prev.phase === next.phase &&
        prev.wrongView === next.wrongView &&
        prev.lowConfidence === next.lowConfidence &&
        prev.side === next.side &&
        // Depth drives a progress bar, so a small change is not worth a render.
        Math.abs(prev.depth - next.depth) < 0.02 &&
        prev.cues === next.cues
          ? prev
          : next
      );
    },
    [mirrored]
  );

  const ready = !!model && !!resizer && !modelError && !!spec;

  const frameOutput = useFrameOutput({
    // YUV is the camera's native format; the GPU resizer converts to RGB as
    // part of the resize, which is far cheaper than asking the pipeline for RGB.
    pixelFormat: 'yuv',
    onFrame: (frame) => {
      'worklet';
      try {
        if (!ready || !resizer || !model) return;

        const resized = resizer.resize(frame);
        try {
          const outputs = model.runSync([resized.getPixelBuffer()]);
          const view = viewOutput(outputs[0], outputDataType);
          if (!view || view.length < 51) return;

          // Copy into a plain array: the underlying buffer is reused by the
          // next inference, so holding a view would show tearing.
          const flat: number[] = new Array(51);
          for (let i = 0; i < 51; i++) flat[i] = view[i];

          // UI thread reads this directly, no bridge hop.
          pose.value = flat;
          // JS thread runs the rules.
          runOnJS(ingest)(flat, Date.now());
        } finally {
          resized.dispose();
        }
      } finally {
        // Always dispose, on every path. A leaked frame stalls the whole
        // camera pipeline within a second or two.
        frame.dispose();
      }
    },
  });

  const finish = useCallback(() => engineRef.current?.finish() ?? null, []);

  const reset = useCallback(() => {
    engineRef.current = spec ? new FormEngine(spec, { aspect }) : null;
    lastFedAtRef.current = 0;
    pose.value = [];
    setLive(IDLE_LIVE);
  }, [spec, aspect, pose]);

  const status: SessionStatus = modelError ? 'error' : ready ? 'ready' : 'loading';

  return {
    status,
    error: modelError,
    pose,
    live,
    frameOutput: ready ? frameOutput : null,
    finish,
    reset,
  };
}
