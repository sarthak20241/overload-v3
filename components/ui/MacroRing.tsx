/**
 * MacroRing — the calorie goal-progress hero arc.
 *
 * display='remaining': a graphite ring whose CENTER is two tiers — the big
 * "LEFT" (or "+OVER") number and a tiny LEFT/OVER caption — with the eaten / goal
 * line rendered as a caption BELOW the ring (via belowCaption) so the center
 * breathes and nothing touches the circumference. Over budget, a SAME-HUE second
 * lap rides just inside the base lap (inset radius, thinner, 0.55 opacity, rounded
 * leading cap) — the Apple/Google subtle overshoot, never a new colour; the signed
 * number always carries "over" too. Arcs tween previous→new; reduced-motion snaps.
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedProps, withTiming, withDelay, Easing, useReducedMotion,
} from 'react-native-reanimated';
import { FontWeight, FontSize, LetterSpacing, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface MacroRingProps {
  value: number;
  target: number;
  color: string;
  label?: string;
  unit?: string;
  size?: number;
  thickness?: number;
  valueColor?: string;
  trackColor?: string;
  animate?: boolean;
  display?: 'progress' | 'remaining';
  name?: string;
  centerFontSize?: number;
  showSubline?: boolean;
  /** render a same-hue second-lap overshoot when over (calorie hero). */
  overshoot?: boolean;
  /** colour of the gap/moat that lifts the overshoot lap off the base (the card bg). */
  gapColor?: string;
  /** small caption rendered BELOW the ring (e.g. "1,623 / 2,000 kcal"). */
  belowCaption?: string;
}

const fmtInt = (n: number) => Math.round(n).toLocaleString();

export function MacroRing({
  value, target, color, label, unit = '', size = 72, thickness = 6,
  valueColor, trackColor, animate = true, display = 'progress', name,
  centerFontSize, showSubline = true, overshoot = false, gapColor, belowCaption,
}: MacroRingProps) {
  const { C } = useTheme();
  const reduced = useReducedMotion();
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;

  const baseFrac = target > 0 ? Math.min(Math.max(value, 0) / target, 1) : 0;
  const over = target > 0 && value > target;
  const overFrac = over ? Math.min((value - target) / target, 1) : 0;

  const progress = useSharedValue(animate && !reduced ? 0 : baseFrac);
  useEffect(() => {
    progress.value = animate && !reduced
      ? withTiming(baseFrac, { duration: 650, easing: Easing.out(Easing.cubic) })
      : baseFrac;
  }, [baseFrac, animate, reduced, progress]);
  const baseProps = useAnimatedProps(() => ({ strokeDashoffset: circ * (1 - progress.value) }));

  // Same-hue overshoot lap (Apple/Google style): a full-hue second arc lifted off
  // the base ring by a card-coloured "moat" so a white-space gap shows how much
  // extra was logged. Animates in after the base tops out.
  const overSv = useSharedValue(animate && !reduced ? 0 : overFrac);
  useEffect(() => {
    overSv.value = animate && !reduced
      ? withDelay(180, withTiming(overFrac, { duration: 520, easing: Easing.out(Easing.cubic) }))
      : overFrac;
  }, [overFrac, animate, reduced, overSv]);
  const overProps = useAnimatedProps(() => ({ strokeDashoffset: circ * (1 - overSv.value) }));
  const gap = gapColor ?? C.card;
  // A short card-coloured gap that sits just AHEAD of the overshoot's rounded
  // leading cap, so the second lap reads as floating over the base (Google Fit).
  const gapArcLen = circ * 0.05;
  const gapPad = thickness * 0.85;
  const gapProps = useAnimatedProps(() => ({ strokeDashoffset: -(overSv.value * circ + gapPad) }));

  const remaining = target - value;
  const dur = animate && !reduced ? 650 : 1;
  const heroColor = valueColor ?? C.foreground;

  const a11yUnit = unit || 'calories';
  const a11yText = over
    ? `${fmtInt(value)} of ${fmtInt(target)} ${a11yUnit}, ${fmtInt(value - target)} over`
    : `${fmtInt(value)} of ${fmtInt(target)} ${a11yUnit}, ${fmtInt(remaining)} ${display === 'remaining' ? 'left' : 'remaining'}`;

  return (
    <View
      style={{ alignItems: 'center' }}
      accessible
      accessibilityLabel={name ?? label}
      accessibilityValue={{ text: a11yText }}
    >
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          <Circle cx={cx} cy={cy} r={r} stroke={trackColor ?? colorWithAlpha(color, 0.12)} strokeWidth={thickness} fill="none" />
          <AnimatedCircle
            cx={cx} cy={cy} r={r} stroke={color} strokeWidth={thickness} fill="none"
            strokeLinecap="round" strokeDasharray={circ} animatedProps={baseProps}
            transform={`rotate(-90, ${cx}, ${cy})`}
          />
          {overshoot && over && (
            <>
              {/* the second lap, same hue, with a rounded leading cap (the "arch"). */}
              <AnimatedCircle
                cx={cx} cy={cy} r={r} stroke={color} strokeWidth={thickness} fill="none"
                strokeLinecap="round" strokeDasharray={circ} animatedProps={overProps}
                transform={`rotate(-90, ${cx}, ${cy})`}
              />
              {/* a card-coloured gap just ahead of that cap, lifting it off the base
                  ring so you read how far the lap has gone (Google Fit style). */}
              <AnimatedCircle
                cx={cx} cy={cy} r={r} stroke={gap} strokeWidth={thickness + 2} fill="none"
                strokeLinecap="butt" strokeDasharray={`${gapArcLen} ${circ}`} animatedProps={gapProps}
                transform={`rotate(-90, ${cx}, ${cy})`}
              />
            </>
          )}
        </Svg>

        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          {display === 'remaining' ? (
            <>
              <AnimatedNumber
                value={Math.abs(over ? value - target : remaining)}
                durationMs={dur}
                format={(n) => (over ? '+' : '') + fmtInt(n)}
                style={[styles.value, { color: heroColor, fontSize: centerFontSize ?? FontSize.xxl }]}
              />
              <Text style={[styles.caption, { color: C.textDim }]}>{over ? 'OVER' : 'LEFT'}</Text>
            </>
          ) : (
            <>
              <AnimatedNumber
                value={value}
                durationMs={dur}
                format={fmtInt}
                style={[styles.value, { color: heroColor, fontSize: centerFontSize ?? FontSize.base }]}
              />
              {showSubline && (
                <Text style={[styles.subline, { color: C.textDim }]}>of {fmtInt(target)}{unit ? ` ${unit}` : ''}</Text>
              )}
            </>
          )}
        </View>
      </View>
      {label ? <Text style={[styles.label, { color: C.textDim }]}>{label}</Text> : null}
      {belowCaption ? <Text style={[styles.belowCaption, { color: C.textDim }]}>{belowCaption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  value: {
    fontWeight: FontWeight.black,
    letterSpacing: LetterSpacing.tight,
    fontVariant: ['tabular-nums'],
  },
  caption: {
    fontSize: 9,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    marginTop: 1,
  },
  subline: {
    fontSize: 9,
    fontWeight: FontWeight.semibold,
    letterSpacing: LetterSpacing.label,
    marginTop: 1,
    fontVariant: ['tabular-nums'],
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    textTransform: 'uppercase',
    marginTop: 6,
  },
  belowCaption: {
    fontSize: 11,
    fontWeight: FontWeight.medium,
    marginTop: 7,
    fontVariant: ['tabular-nums'],
  },
});
