/**
 * MacroRing - the calorie goal-progress ring (Google Fit style, simple).
 *
 * One circle, always. A dim full-circle track sits under a rounded-cap arc that
 * fills clockwise from 12 o'clock toward the target. Over target the ring stays
 * a complete lit circle and the surplus continues as a second lap drawn ON TOP
 * in the same hue; the seam is the Google Fit one: a card-colored disc slightly
 * larger than the cap is punched into the ring at the tip, then the lap draws
 * over it, so the rounded cap floats in a small gap whose far edge is a concave
 * socket concentric with the cap (a perfectly complementary shape, uniform
 * moat). Never a new colour; the signed center number carries "over".
 *
 * display='remaining': center is the big "LEFT" (or "+OVER") number with a tiny
 * caption, and the eaten / goal line renders BELOW the ring via belowCaption.
 * The fill tweens previous -> new; reduced-motion snaps.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedProps, withTiming, withDelay, withSequence,
  Easing, useReducedMotion, FadeIn,
} from 'react-native-reanimated';
import { FontWeight, FontSize, LetterSpacing, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

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
  /** render the same-hue second-lap cap when over target (calorie hero). */
  overshoot?: boolean;
  /** colour of the seam gap punched around the cap; must match the surface
   *  behind the ring (defaults to the card). */
  gapColor?: string;
  /** small caption rendered BELOW the ring (e.g. "1,623 / 2,000 kcal"). */
  belowCaption?: string;
}

const fmtInt = (n: number) => Math.round(n).toLocaleString();

/** SVG arc path, angles in degrees clockwise from 12 o'clock. */
function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const pt = (deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const [x0, y0] = pt(startDeg);
  const [x1, y1] = pt(endDeg);
  const large = Math.abs(endDeg - startDeg) % 360 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

export function MacroRing({
  value, target, color, label, unit = '', size = 72, thickness = 6,
  valueColor, trackColor, animate = true, display = 'progress', name,
  centerFontSize, showSubline = true, overshoot = false, gapColor, belowCaption,
}: MacroRingProps) {
  const { C } = useTheme();
  const reduced = useReducedMotion();
  const bleed = Math.max(2, thickness * 0.35);
  const svgSize = size + bleed * 2;
  const r = (size - thickness) / 2;
  const cx = size / 2 + bleed;
  const cy = size / 2 + bleed;
  const circ = 2 * Math.PI * r;

  const baseFrac = target > 0 ? Math.min(Math.max(value, 0) / target, 1) : 0;
  const over = overshoot && target > 0 && value > target;

  const progress = useSharedValue(animate && !reduced ? 0 : baseFrac);
  useEffect(() => {
    progress.value = animate && !reduced
      ? withTiming(baseFrac, { duration: 650, easing: Easing.out(Easing.cubic) })
      : baseFrac;
  }, [baseFrac, animate, reduced, progress]);
  const baseProps = useAnimatedProps(() => ({
    strokeDashoffset: circ * (1 - progress.value),
    // a zero-length dash with a round cap still prints a dot at 12 o'clock
    opacity: progress.value > 0.001 ? 1 : 0,
  }));

  // Over target the surplus wraps as extra laps on the same circle, so only the
  // fractional part places the cap. The seam is a card-colored disc punched
  // into the ring at the tip: the lap drawn on top fills its trailing half, so
  // what remains is a moat around the cap plus a concave socket ahead of it,
  // concentric with the cap (the complementary Google Fit end).
  const holeR = thickness * 0.9; // cap half (0.5t) + moat (0.4t)
  const holeDeg = (holeR / r) * (180 / Math.PI); // angular reach of the punch
  const overRawFrac = over ? (value - target) / target : 0;
  // floor: the lap must reach past the punch so the bite never crosses 12
  const overEndDeg = over ? Math.max((overRawFrac % 1) * 360, holeDeg * 1.25) : 0;
  const tipA = ((overEndDeg - 90) * Math.PI) / 180;
  const tipX = cx + r * Math.cos(tipA);
  const tipY = cy + r * Math.sin(tipA);

  // The lap rides same-hue on the lit ring, so the sweep itself is invisible;
  // the visible event is the gap + cap settling in. Fade them in after the
  // base ring closes; retargets while already over dip the seam briefly (the
  // punch jumps to its new angle at render, the dip masks it).
  const snap = !animate || reduced;
  const tipSv = useSharedValue(snap && over ? 1 : 0);
  const wasOverRef = useRef(false);
  useEffect(() => {
    const wasOver = wasOverRef.current;
    wasOverRef.current = over;
    if (snap) {
      tipSv.value = over ? 1 : 0;
      return;
    }
    if (!over) {
      tipSv.value = withTiming(0, { duration: 120 });
      return;
    }
    tipSv.value = wasOver
      ? withSequence(
          withTiming(0, { duration: 90 }),
          withDelay(140, withTiming(1, { duration: 180 })),
        )
      : withDelay(600, withTiming(1, { duration: 220 }));
  }, [over, overEndDeg, snap, tipSv]);
  const tipProps = useAnimatedProps(() => ({ opacity: tipSv.value }));

  const remaining = target - value;
  const dur = animate && !reduced ? 650 : 1;
  const heroColor = valueColor ?? C.foreground;
  const isOverBudget = target > 0 && value > target;
  const centerValue = Math.abs(isOverBudget ? value - target : remaining);
  const centerText = (isOverBudget ? '+' : '') + fmtInt(centerValue);
  const baseCenterFontSize = centerFontSize ?? (display === 'remaining' ? FontSize.xxl : FontSize.base);
  const centerScale = centerText.length >= 7 ? 0.72 : centerText.length >= 6 ? 0.84 : 1;
  const resolvedCenterFontSize = display === 'remaining'
    ? Math.round(baseCenterFontSize * centerScale)
    : baseCenterFontSize;
  const centerMaxWidth = Math.max(size * 0.52, size - thickness * 2.6);

  const a11yUnit = unit || 'calories';
  const a11yText = isOverBudget
    ? `${fmtInt(value)} of ${fmtInt(target)} ${a11yUnit}, ${fmtInt(value - target)} over`
    : `${fmtInt(value)} of ${fmtInt(target)} ${a11yUnit}, ${fmtInt(remaining)} ${display === 'remaining' ? 'left' : 'remaining'}`;

  return (
    <View
      style={{ alignItems: 'center' }}
      accessible
      accessibilityLabel={name ?? label}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: Math.max(target, value, 0), now: Math.max(value, 0), text: a11yText }}
    >
      <View style={{ width: size, height: size, overflow: 'visible' }}>
        <Svg width={svgSize} height={svgSize} style={{ position: 'absolute', left: -bleed, top: -bleed }}>
          <Circle cx={cx} cy={cy} r={r} stroke={trackColor ?? colorWithAlpha(color, 0.12)} strokeWidth={thickness} fill="none" />
          <AnimatedCircle
            cx={cx} cy={cy} r={r} stroke={color} strokeWidth={thickness} fill="none"
            strokeLinecap="round" strokeDasharray={circ} animatedProps={baseProps}
            transform={`rotate(-90, ${cx}, ${cy})`}
          />
          {over && (
            <>
              {/* the seam: a card-colored disc punched into the ring at the tip;
                  the lap drawn on top fills its trailing half, leaving a moat
                  around the cap and a concave socket ahead of it (Google Fit) */}
              <AnimatedCircle
                animatedProps={tipProps}
                cx={tipX} cy={tipY} r={holeR}
                fill={gapColor ?? C.card}
              />
              {/* the surplus lap: same hue, same circle, rounded cap on top */}
              <AnimatedPath
                animatedProps={tipProps}
                d={arcPath(cx, cy, r, 0, overEndDeg)}
                stroke={color}
                strokeWidth={thickness}
                fill="none"
                strokeLinecap="round"
              />
            </>
          )}
        </Svg>

        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          {display === 'remaining' ? (
            <>
              <AnimatedNumber
                key={isOverBudget ? 'over' : 'left'}
                value={centerValue}
                durationMs={dur}
                format={(n) => (isOverBudget ? '+' : '') + fmtInt(n)}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                style={[styles.value, { color: heroColor, fontSize: resolvedCenterFontSize, maxWidth: centerMaxWidth }]}
              />
              <Animated.Text
                key={isOverBudget ? 'OVER' : 'LEFT'}
                entering={snap ? undefined : FadeIn.duration(160)}
                style={[styles.caption, { color: C.textMuted }]}
              >
                {isOverBudget ? 'OVER' : 'LEFT'}
              </Animated.Text>
            </>
          ) : (
            <>
              <AnimatedNumber
                value={value}
                durationMs={dur}
                format={fmtInt}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                style={[styles.value, { color: heroColor, fontSize: baseCenterFontSize, maxWidth: centerMaxWidth }]}
              />
              {showSubline && (
                <Text style={[styles.subline, { color: C.textMuted }]}>of {fmtInt(target)}{unit ? ` ${unit}` : ''}</Text>
              )}
            </>
          )}
        </View>
      </View>
      {label ? <Text style={[styles.label, { color: C.textDim }]}>{label}</Text> : null}
      {belowCaption ? (
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.82}
          style={[styles.belowCaption, { color: C.textMuted, maxWidth: Math.max(size + 44, 120) }]}
        >
          {belowCaption}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  value: {
    fontWeight: FontWeight.black,
    letterSpacing: LetterSpacing.normal,
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
    textAlign: 'center',
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
