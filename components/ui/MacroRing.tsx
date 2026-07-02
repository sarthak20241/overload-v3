/**
 * MacroRing — the calorie goal-progress hero arc.
 *
 * display='remaining': a graphite ring whose CENTER is two tiers — the big
 * "LEFT" (or "+OVER") number and a tiny LEFT/OVER caption — with the eaten / goal
 * line rendered as a caption BELOW the ring (via belowCaption) so the center
 * breathes and nothing touches the circumference. Over budget, the ring stays
 * fully lit and a SAME-HUE second lap rides over it; the tip is a rounded arch
 * floating over the lap below — a clean background gap ahead of it (Google Fit)
 * plus a soft shadow under the tip (Apple) — never a new colour; the signed
 * number always carries "over" too. Arcs tween previous→new; reduced-motion snaps.
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedProps, withTiming, Easing, useReducedMotion,
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
  const over = target > 0 && value > target;
  const overRawFrac = over ? (value - target) / target : 0;

  const progress = useSharedValue(animate && !reduced ? 0 : baseFrac);
  useEffect(() => {
    progress.value = animate && !reduced
      ? withTiming(baseFrac, { duration: 650, easing: Easing.out(Easing.cubic) })
      : baseFrac;
  }, [baseFrac, animate, reduced, progress]);
  const baseProps = useAnimatedProps(() => ({ strokeDashoffset: circ * (1 - progress.value) }));

  const gap = gapColor ?? C.card;
  // Google Fit / Apple-style over target: the ring stays fully lit, a same-hue
  // second lap rides over it from 12 o'clock, and the tip is a rounded arch that
  // floats over the lap below — separated by a clean full-thickness background
  // gap ahead of the cap (Google) plus a soft shadow under the tip (Apple). For
  // very large overages, keep the arch long and readable instead of wrapping to
  // a tiny remainder; the exact surplus still lives in the center number.
  const overLapFrac = overRawFrac > 0
    ? (overRawFrac >= 1 ? Math.min(0.86, 0.74 + Math.min(overRawFrac - 1, 1) * 0.12) : overRawFrac)
    : 0;
  const overR = r;
  const overThickness = thickness;
  const capDeg = ((overThickness * 0.5) / overR) * (180 / Math.PI); // half-cap, in degrees
  const gapDeg = Math.max(3, capDeg * 1.2); // visible background ahead of the arch
  const overEndDeg = Math.min(
    Math.max(overLapFrac * 360, capDeg * 1.6),
    360 - (capDeg * 2 + gapDeg),
  );
  const shadowDxy = Math.max(thickness * 0.08, 0.8);

  const remaining = target - value;
  const dur = animate && !reduced ? 650 : 1;
  const heroColor = valueColor ?? C.foreground;
  const centerValue = Math.abs(over ? value - target : remaining);
  const centerText = (over ? '+' : '') + fmtInt(centerValue);
  const baseCenterFontSize = centerFontSize ?? (display === 'remaining' ? FontSize.xxl : FontSize.base);
  const centerScale = centerText.length >= 7 ? 0.72 : centerText.length >= 6 ? 0.84 : 1;
  const resolvedCenterFontSize = display === 'remaining'
    ? Math.round(baseCenterFontSize * centerScale)
    : baseCenterFontSize;
  const centerMaxWidth = Math.max(size * 0.52, size - thickness * 2.6);

  const a11yUnit = unit || 'calories';
  const a11yText = over
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
          {overshoot && over && (
            <>
              {/* full-thickness break in the lap below, ahead of the arch */}
              <Path
                d={arcPath(cx, cy, overR, overEndDeg, overEndDeg + capDeg + gapDeg)}
                stroke={gap}
                strokeWidth={overThickness + 2}
                fill="none"
              />
              {/* soft shadow under the tip so the arch floats over the lap below */}
              <Path
                d={arcPath(cx, cy, overR, Math.max(0.01, overEndDeg - capDeg * 2.5), overEndDeg)}
                stroke={colorWithAlpha('#000000', 0.18)}
                strokeWidth={overThickness}
                fill="none"
                strokeLinecap="round"
                transform={`translate(${shadowDxy * 0.6}, ${shadowDxy})`}
              />
              {/* the overshoot lap; its rounded leading cap is the arch */}
              <Path
                d={arcPath(cx, cy, overR, 0.01, overEndDeg)}
                stroke={color}
                strokeWidth={overThickness}
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
                value={centerValue}
                durationMs={dur}
                format={(n) => (over ? '+' : '') + fmtInt(n)}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                style={[styles.value, { color: heroColor, fontSize: resolvedCenterFontSize, maxWidth: centerMaxWidth }]}
              />
              <Text style={[styles.caption, { color: C.textDim }]}>{over ? 'OVER' : 'LEFT'}</Text>
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
                <Text style={[styles.subline, { color: C.textDim }]}>of {fmtInt(target)}{unit ? ` ${unit}` : ''}</Text>
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
          style={[styles.belowCaption, { color: C.textDim, maxWidth: Math.max(size + 44, 120) }]}
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
