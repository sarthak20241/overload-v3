/**
 * The skeleton drawn over the camera preview.
 *
 * Reads keypoints straight off a Reanimated SharedValue that the frame
 * processor writes to, so the drawing never crosses to the JS thread. At 30 fps
 * that difference is the whole reason the overlay tracks the lifter instead of
 * lagging half a second behind them.
 *
 * Restrained on purpose: a thin line, dim joints, one lime accent. This sits on
 * top of a live human being, and a glowing neon rig would be noise.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { Canvas, Circle, Path, Skia, Group } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import { Colors } from '@/constants/theme';
import { KEYPOINT_INDEX, MIN_KEYPOINT_SCORE, SKELETON_EDGES } from '@/lib/form/keypoints';

/**
 * Flat keypoint buffer, 17 * (y, x, score) in normalised 0..1 image space.
 * The same layout the model emits, kept flat because a SharedValue holding
 * plain numbers is far cheaper than one holding objects.
 */
export type PoseBuffer = SharedValue<number[]>;

interface Props {
  pose: PoseBuffer;
  /** Preview size in points, so normalised coordinates can be scaled up. */
  width: number;
  height: number;
  /** The camera frame's width / height, from the session. */
  frameAspect: SharedValue<number>;
  /** Dim the whole rig when the view is wrong or tracking is poor. */
  muted?: boolean;
}

/** Edge indices resolved once, so the render path does no name lookups. */
const EDGE_PAIRS = SKELETON_EDGES.map(
  ([a, b]) => [KEYPOINT_INDEX[a], KEYPOINT_INDEX[b]] as const
);

const JOINT_INDICES = Object.values(KEYPOINT_INDEX);

/**
 * Where the preview actually draws the frame, in points.
 *
 * The keypoints describe the camera frame, but `<Camera>` fills the screen by
 * scaling that frame up until it covers, then centring and letting the overflow
 * crop. Mapping straight onto the window instead would stretch the skeleton on
 * whichever axis the crop removed, and the mismatch grows with the difference
 * between the sensor's shape and the screen's -- exactly the case on a phone,
 * where a 16:9 sensor feeds a much taller display.
 */
function coverRect(width: number, height: number, aspect: number) {
  'worklet';
  const a = aspect > 0 ? aspect : 1;
  // The frame scaled to cover: one axis matches the screen, the other overflows.
  const drawnW = Math.max(width, height * a);
  const drawnH = Math.max(height, width / a);
  return { drawnW, drawnH, offX: (width - drawnW) / 2, offY: (height - drawnH) / 2 };
}

export function PoseOverlay({ pose, width, height, frameAspect, muted = false }: Props) {
  const skeleton = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const buf = pose.value;
    if (!buf || buf.length < 51) return path;

    const { drawnW, drawnH, offX, offY } = coverRect(width, height, frameAspect.value);

    for (const [ai, bi] of EDGE_PAIRS) {
      // Layout is (y, x, score) per keypoint, y first, matching MoveNet.
      const ay = buf[ai * 3];
      const ax = buf[ai * 3 + 1];
      const as = buf[ai * 3 + 2];
      const by = buf[bi * 3];
      const bx = buf[bi * 3 + 1];
      const bs = buf[bi * 3 + 2];
      // Never draw a bone to a joint the model is unsure about: a confident
      // looking line to a hallucinated ankle is worse than no line.
      if (as < MIN_KEYPOINT_SCORE || bs < MIN_KEYPOINT_SCORE) continue;
      path.moveTo(offX + ax * drawnW, offY + ay * drawnH);
      path.lineTo(offX + bx * drawnW, offY + by * drawnH);
    }
    return path;
  }, [pose, width, height, frameAspect]);

  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      <Group opacity={muted ? 0.35 : 1}>
        <Path
          path={skeleton}
          style="stroke"
          strokeWidth={3}
          strokeCap="round"
          strokeJoin="round"
          color={Colors.primary}
        />
        {JOINT_INDICES.map((i) => (
          <Joint
            key={i}
            pose={pose}
            index={i}
            width={width}
            height={height}
            frameAspect={frameAspect}
          />
        ))}
      </Group>
    </Canvas>
  );
}

/**
 * One joint dot. Split into its own component so each circle's position is its
 * own derived value and a single low-confidence joint does not invalidate the
 * whole rig.
 */
function Joint({
  pose,
  index,
  width,
  height,
  frameAspect,
}: {
  pose: PoseBuffer;
  index: number;
  width: number;
  height: number;
  frameAspect: SharedValue<number>;
}) {
  const cx = useDerivedValue(() => {
    const { drawnW, offX } = coverRect(width, height, frameAspect.value);
    return offX + (pose.value?.[index * 3 + 1] ?? 0) * drawnW;
  }, [pose, width, height, frameAspect]);
  const cy = useDerivedValue(() => {
    const { drawnH, offY } = coverRect(width, height, frameAspect.value);
    return offY + (pose.value?.[index * 3] ?? 0) * drawnH;
  }, [pose, width, height, frameAspect]);
  // Radius carries the confidence: uncertain joints shrink to nothing rather
  // than sitting there looking authoritative.
  const r = useDerivedValue(() => {
    const score = pose.value?.[index * 3 + 2] ?? 0;
    return score < MIN_KEYPOINT_SCORE ? 0 : 4;
  }, [pose]);

  return <Circle cx={cx} cy={cy} r={r} color="#ffffff" />;
}
