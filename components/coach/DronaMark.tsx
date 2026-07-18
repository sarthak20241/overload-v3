/**
 * DronaMark: Coach Drona's identity mark (the arrowhead), replacing the
 * thunderbolt. One closed Skia path drives every state, so all coach surfaces
 * share a single component at different sizes.
 *
 * States:
 *  - idle:     solid lime, soft glow breathing slowly
 *  - thinking: dim fill, a stroke traces the edge continuously (draw/erase chase)
 *  - answer:   one-shot release: pop + glow flash + a thin ring expands out
 *  - rest:     muted gray, no glow (rest day / signed-out surfaces)
 *  - static:   lime with a fixed soft glow, NO animation loops. Use this for
 *              small avatars that appear many times in scrolling lists
 *              (chat bubbles, meal cards) so we don't run dozens of
 *              infinite Reanimated loops at once.
 *
 * Purely visual: haptics stay caller-side. Geometry mirrors the approved
 * Figma exploration (Drona Mark Exploration file): arrowhead M40,4 L74,70
 * L40,52 L6,70 with per-corner optical rounding.
 */
import React, { useEffect, useMemo } from 'react';
import {
  BlurMask,
  Canvas,
  Circle,
  Group,
  Path,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import {
  Easing,
  cancelAnimation,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Colors } from '@/constants/theme';

export type DronaMarkState = 'idle' | 'thinking' | 'answer' | 'rest' | 'static';

interface Props {
  /** Rendered width of the mark itself (canvas adds glow padding around it). */
  size?: number;
  state?: DronaMarkState;
  /** Accent override; defaults to the app lime. */
  color?: string;
  /** Color used for the rest state. */
  restColor?: string;
}

// ─── Geometry ────────────────────────────────────────────────────────────────

const VB_W = 80;
const VB_H = 74;

interface Pt {
  x: number;
  y: number;
}

// apex, right tip, notch, left tip - matches the Figma vector.
const POINTS: Pt[] = [
  { x: 40, y: 4 },
  { x: 74, y: 70 },
  { x: 40, y: 52 },
  { x: 6, y: 70 },
];
// Per-corner rounding: softer apex, tighter notch.
const RADII = [7, 5, 4.5, 5];

function buildArrowheadSvg(): string {
  const n = POINTS.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = POINTS[i];
    const prev = POINTS[(i + n - 1) % n];
    const next = POINTS[(i + 1) % n];
    const r = RADII[i];
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    const entry = {
      x: p.x - ((p.x - prev.x) / inLen) * r,
      y: p.y - ((p.y - prev.y) / inLen) * r,
    };
    const exit = {
      x: p.x + ((next.x - p.x) / outLen) * r,
      y: p.y + ((next.y - p.y) / outLen) * r,
    };
    d += i === 0 ? `M ${entry.x} ${entry.y}` : ` L ${entry.x} ${entry.y}`;
    d += ` Q ${p.x} ${p.y} ${exit.x} ${exit.y}`;
  }
  return `${d} Z`;
}

const ARROWHEAD_SVG = buildArrowheadSvg();

// ─── Component ───────────────────────────────────────────────────────────────

export function DronaMark({
  size = 48,
  state = 'idle',
  color = Colors.primary,
  restColor = '#565c66',
}: Props) {
  const path = useMemo(() => Skia.Path.MakeFromSVGString(ARROWHEAD_SVG)!, []);

  // Canvas is padded so the glow and the answer ring never clip.
  const pad = size * 0.38;
  const w = size + pad * 2;
  const h = size * (VB_H / VB_W) + pad * 2;
  const scale = size / VB_W;
  const cx = w / 2;
  const cy = h / 2;

  const glow = useSharedValue(0);
  const fillOpacity = useSharedValue(1);
  const pop = useSharedValue(1);
  // Thinking trace: progress runs 0..2, first half draws (end), second erases (start).
  const traceProg = useSharedValue(0);
  const traceOpacity = useSharedValue(0);
  const ringProg = useSharedValue(0);
  const ringOpacity = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(glow);
    cancelAnimation(traceProg);
    if (state === 'idle') {
      fillOpacity.value = withTiming(1, { duration: 220 });
      traceOpacity.value = withTiming(0, { duration: 150 });
      glow.value = withRepeat(
        withSequence(
          withTiming(0.55, { duration: 1700, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.28, { duration: 1700, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
      );
    } else if (state === 'thinking') {
      fillOpacity.value = withTiming(0.16, { duration: 220 });
      traceOpacity.value = withTiming(1, { duration: 150 });
      glow.value = withTiming(0.14, { duration: 220 });
      traceProg.value = 0;
      traceProg.value = withRepeat(
        withTiming(2, { duration: 2100, easing: Easing.inOut(Easing.cubic) }),
        -1,
      );
    } else if (state === 'answer') {
      traceOpacity.value = withTiming(0, { duration: 100 });
      fillOpacity.value = withTiming(1, { duration: 120 });
      pop.value = withSequence(
        withTiming(0.9, { duration: 80, easing: Easing.out(Easing.quad) }),
        withTiming(1.05, { duration: 170, easing: Easing.out(Easing.cubic) }),
        withTiming(1, { duration: 140, easing: Easing.inOut(Easing.quad) }),
      );
      glow.value = withSequence(
        withTiming(0.85, { duration: 130 }),
        withTiming(0.35, { duration: 650, easing: Easing.out(Easing.quad) }),
      );
      ringProg.value = 0;
      ringProg.value = withTiming(1, { duration: 560, easing: Easing.out(Easing.cubic) });
      ringOpacity.value = withSequence(
        withTiming(0.5, { duration: 70 }),
        withTiming(0, { duration: 520, easing: Easing.out(Easing.quad) }),
      );
    } else if (state === 'static') {
      fillOpacity.value = 1;
      traceOpacity.value = 0;
      glow.value = 0.28;
    } else {
      // rest
      fillOpacity.value = withTiming(1, { duration: 220 });
      traceOpacity.value = withTiming(0, { duration: 150 });
      glow.value = withTiming(0, { duration: 220 });
    }
  }, [state, fillOpacity, glow, pop, ringOpacity, ringProg, traceOpacity, traceProg]);

  const popTransform = useDerivedValue(() => [{ scale: pop.value }]);
  const traceStart = useDerivedValue(() => Math.max(0, traceProg.value - 1));
  const traceEnd = useDerivedValue(() => Math.min(1, traceProg.value));
  const ringRadius = useDerivedValue(
    () => size * 0.46 + ringProg.value * size * 0.26,
  );

  const fillColor = state === 'rest' ? restColor : color;

  return (
    <Canvas style={{ width: w, height: h }}>
      <Group origin={vec(cx, cy)} transform={popTransform}>
        <Group transform={[{ translateX: pad }, { translateY: pad }, { scale }]}>
          <Path path={path} color={color} opacity={glow}>
            <BlurMask blur={size * 0.24} style="normal" />
          </Path>
          <Path path={path} color={fillColor} opacity={fillOpacity} />
          <Path
            path={path}
            color={color}
            opacity={traceOpacity}
            style="stroke"
            strokeWidth={4}
            strokeJoin="round"
            strokeCap="round"
            start={traceStart}
            end={traceEnd}
          />
        </Group>
      </Group>
      <Circle
        cx={cx}
        cy={cy}
        r={ringRadius}
        color={color}
        opacity={ringOpacity}
        style="stroke"
        strokeWidth={1.5}
      />
    </Canvas>
  );
}
