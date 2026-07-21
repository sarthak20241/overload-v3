/**
 * Projected weight curve for the plan reveal (Phase 5): a gentle S from
 * today's weight to the goal, drawing itself in on mount (Skia path trim).
 * Direction-aware: cuts slope down-right, builds slope up-right. Labels are
 * plain RN text so no Skia font loading is involved.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Canvas, Circle, DashPathEffect, Path, Skia } from '@shopify/react-native-skia';
import { Easing, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { Colors, FontFamily, FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';

const H = 150;
const PAD_X = 14;
const PAD_Y = 26;

export function ProjectedCurve({
  direction,
  startLabel,
  endLabel,
}: {
  direction: 'loss' | 'gain';
  /** e.g. "Now · 72.5 kg" */
  startLabel: string;
  /** e.g. "Jan 4 · 64 kg" */
  endLabel: string;
}) {
  const { C } = useTheme();
  const [w, setW] = useState(0);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (w > 0) {
      progress.value = 0;
      progress.value = withDelay(
        250,
        withTiming(1, { duration: 1300, easing: Easing.out(Easing.cubic) }),
      );
    }
  }, [w, progress]);

  const { curve, baseline, x0, y0, x1, y1 } = useMemo(() => {
    const width = Math.max(1, w);
    const sx = PAD_X;
    const ex = width - PAD_X;
    const sy = direction === 'loss' ? PAD_Y : H - PAD_Y;
    const ey = direction === 'loss' ? H - PAD_Y : PAD_Y;
    const p = Skia.Path.Make();
    p.moveTo(sx, sy);
    const midX = (sx + ex) / 2;
    p.cubicTo(midX, sy, midX, ey, ex, ey);
    const b = Skia.Path.Make();
    b.moveTo(sx, sy);
    b.lineTo(ex, sy);
    return { curve: p, baseline: b, x0: sx, y0: sy, x1: ex, y1: ey };
  }, [w, direction]);

  return (
    <View
      style={[curveStyles.wrap, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
      onLayout={(e) => setW(e.nativeEvent.layout.width - Spacing.lg * 2)}
    >
      {w > 0 && (
        <>
          <Canvas style={{ width: w, height: H }}>
            <Path path={baseline} style="stroke" strokeWidth={1} color={C.border}>
              <DashPathEffect intervals={[5, 6]} />
            </Path>
            <Path
              path={curve}
              style="stroke"
              strokeWidth={3.5}
              strokeCap="round"
              color={Colors.primary}
              start={0}
              end={progress}
            />
            <Circle cx={x0} cy={y0} r={5} color={C.border} />
            <Circle cx={x1} cy={y1} r={6} color={Colors.primary} />
          </Canvas>
          <Text
            style={[
              curveStyles.label,
              { color: C.textMuted },
              direction === 'loss' ? curveStyles.topLeft : curveStyles.bottomLeft,
            ]}
          >
            {startLabel}
          </Text>
          <Text
            style={[
              curveStyles.label,
              { color: C.accentText, fontFamily: FontFamily.displayMedium },
              direction === 'loss' ? curveStyles.bottomRight : curveStyles.topRight,
            ]}
          >
            {endLabel}
          </Text>
        </>
      )}
    </View>
  );
}

const curveStyles = StyleSheet.create({
  wrap: {
    borderRadius: 20,
    borderWidth: 1,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  label: { position: 'absolute', fontSize: FontSize.sm },
  topLeft: { top: Spacing.md, left: Spacing.lg },
  bottomLeft: { bottom: Spacing.md, left: Spacing.lg },
  topRight: { top: Spacing.md, right: Spacing.lg },
  bottomRight: { bottom: Spacing.md, right: Spacing.lg },
});
