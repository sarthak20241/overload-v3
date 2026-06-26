/**
 * MacroRing — a single goal-progress ring (eaten / target) for the diet UI.
 *
 * Distinct from MiniDonutChart (which is a multi-segment %-of-total donut): this
 * is one arc that fills toward a target, with a tabular center number and an
 * under-ring label. The arc animates to its value via Reanimated (the "fill up
 * when you log" beat), so the number visibly moves rather than hard-cutting.
 *
 * Presentational: pass a color from Colors.macro. Calories reads graphite (the
 * neutral primary), protein clay, etc. — co-equal, never protein-dominant. Lime
 * is reserved for actions, so it is NOT a default ring color here.
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { FontWeight, FontSize, LetterSpacing, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface MacroRingProps {
  value: number;
  target: number;
  color: string;
  /** under-ring caption, e.g. "Protein" (rendered uppercase + tracked) */
  label?: string;
  /** unit shown on the "of {target}" subline, e.g. "g"; calories pass "" */
  unit?: string;
  size?: number;
  thickness?: number;
  /** center number color; defaults to the theme foreground (ink), not the ring color */
  valueColor?: string;
  trackColor?: string;
  animate?: boolean;
}

export function MacroRing({
  value,
  target,
  color,
  label,
  unit = '',
  size = 72,
  thickness = 6,
  valueColor,
  trackColor,
  animate = true,
}: MacroRingProps) {
  const { C } = useTheme();
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const pct = target > 0 && value > 0 ? Math.min(value / target, 1) : 0;

  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = animate
      ? withTiming(pct, { duration: 600, easing: Easing.out(Easing.cubic) })
      : pct;
  }, [pct, animate, progress]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }));

  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          <Circle
            cx={cx}
            cy={cy}
            r={r}
            stroke={trackColor ?? colorWithAlpha(color, 0.15)}
            strokeWidth={thickness}
            fill="none"
          />
          <AnimatedCircle
            cx={cx}
            cy={cy}
            r={r}
            stroke={color}
            strokeWidth={thickness}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            animatedProps={animatedProps}
            transform={`rotate(-90, ${cx}, ${cy})`}
          />
        </Svg>
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <Text style={[styles.value, { color: valueColor ?? C.foreground }]}>
            {Math.round(value).toLocaleString()}
          </Text>
          <Text style={[styles.subline, { color: C.textDim }]}>
            of {Math.round(target).toLocaleString()}{unit ? ` ${unit}` : ''}
          </Text>
        </View>
      </View>
      {label ? (
        <Text style={[styles.label, { color: C.textDim }]}>{label}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  value: {
    fontSize: FontSize.xxl, // 22; bump per call-site for a hero ring
    fontWeight: FontWeight.black,
    letterSpacing: LetterSpacing.tight,
    fontVariant: ['tabular-nums'],
    lineHeight: 24,
  },
  subline: {
    fontSize: 9,
    fontWeight: FontWeight.medium,
    marginTop: 1,
    fontVariant: ['tabular-nums'],
  },
  label: {
    fontSize: FontSize.xs, // 10
    fontWeight: FontWeight.semibold,
    letterSpacing: LetterSpacing.eyebrow,
    textTransform: 'uppercase',
    marginTop: 6,
  },
});
