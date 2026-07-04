/**
 * MacroRing — the calorie goal-progress hero arc.
 *
 * display='remaining': a graphite ring whose CENTER is two tiers — the big
 * "LEFT" (or "+OVER") number and a tiny LEFT/OVER caption — with the eaten / goal
 * line rendered as a caption BELOW the ring (via belowCaption) so the center
 * breathes and nothing touches the circumference. Over budget, the ring stays
 * fully lit and a SAME-HUE second lap rides over it; the seam is a coil: the
 * arch tip floats at the outer line (soft shadow beneath), and across a tight
 * gap the lap ahead re-emerges tucked INWARD, easing back out to full radius —
 * sliding under the lap above like Google Fit. Never a new colour; the signed
 * number always carries "over" too. Arcs tween previous→new; reduced-motion snaps.
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

/** Coil-tail path: starts at `startDeg` tucked INWARD (radius r - inset), eases
 *  back out to the full radius by `riseEndDeg`, then continues on r to `endDeg`.
 *  Stroked with round caps this is the Google Fit over-target seam — the lap
 *  ahead dips under the arch riding over it. Angles clockwise from 12 o'clock. */
function tuckPath(
  cx: number, cy: number, r: number, inset: number,
  startDeg: number, riseEndDeg: number, endDeg: number,
): string {
  const pt = (deg: number, rr: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${cx + rr * Math.cos(a)} ${cy + rr * Math.sin(a)}`;
  };
  const steps = 14;
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const deg = startDeg + (riseEndDeg - startDeg) * t;
    const rr = r - inset * ((1 + Math.cos(Math.PI * t)) / 2); // ease in-out
    parts.push(`${i === 0 ? 'M' : 'L'} ${pt(deg, rr)}`);
  }
  parts.push(`A ${r} ${r} 0 0 1 ${pt(endDeg, r)}`);
  return parts.join(' ');
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
  const gapDeg = Math.max(3, capDeg); // visible background ahead of the arch (snug seam)
  const overEndDeg = Math.min(
    Math.max(overLapFrac * 360, capDeg * 1.6),
    360 - (capDeg * 2 + gapDeg),
  );
  // Tip shadow: cast along the travel tangent (into the gap, ahead of the arch)
  // so the overhang reads correctly at ANY over-fraction; a fixed screen offset
  // only works while the tip sits in the lower-right quadrant. In arcPath coords
  // the clockwise tangent at angle-from-12 θ is (cos θ, sin θ).
  const tipA = (overEndDeg * Math.PI) / 180;
  const shadowLen = Math.max(thickness * 0.1, 1);
  const shadowDx = Math.cos(tipA) * shadowLen;
  const shadowDy = Math.sin(tipA) * shadowLen;

  // The over-crossing in time: the second lap SWEEPS in from 12 o'clock after
  // the base lap closes, and the seam accessories (break, coil tail, shadow)
  // fade in only as the arch arrives — the cut never pre-scars a still-filling
  // ring. Retargets while already over move the cap and briefly dip the seam.
  const snap = !animate || reduced;
  const overLapTarget = over ? overEndDeg / 360 : 0;
  const overSweep = useSharedValue(snap ? overLapTarget : 0);
  const seamSv = useSharedValue(snap && over ? 1 : 0);
  const wasOverRef = useRef(false);
  useEffect(() => {
    const wasOver = wasOverRef.current;
    wasOverRef.current = over;
    if (snap) {
      overSweep.value = overLapTarget;
      seamSv.value = over ? 1 : 0;
      return;
    }
    if (!over) {
      overSweep.value = 0;
      seamSv.value = 0;
      return;
    }
    const sweepDur = Math.min(300 + 450 * overLapTarget, 750);
    if (!wasOver) {
      overSweep.value = 0;
      seamSv.value = 0;
      overSweep.value = withDelay(480, withTiming(overLapTarget, { duration: sweepDur, easing: Easing.out(Easing.cubic) }));
      seamSv.value = withDelay(480 + Math.max(sweepDur - 150, 0), withTiming(1, { duration: 180 }));
    } else {
      overSweep.value = withTiming(overLapTarget, { duration: 300, easing: Easing.out(Easing.cubic) });
      seamSv.value = withSequence(
        withTiming(0, { duration: 90 }),
        withDelay(230, withTiming(1, { duration: 180 })),
      );
    }
  }, [over, overLapTarget, snap, overSweep, seamSv]);
  const overProps = useAnimatedProps(() => ({ strokeDashoffset: circ * (1 - overSweep.value) }));
  const seamProps = useAnimatedProps(() => ({ opacity: seamSv.value }));

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
              {/* full-thickness break in the lap below — runs across the whole
                  tuck transition so the straight cut edge of the lap underneath
                  never shows above the dipping coil tail drawn next */}
              <AnimatedPath
                animatedProps={seamProps}
                d={arcPath(cx, cy, overR, overEndDeg, overEndDeg + capDeg * 6 + gapDeg)}
                stroke={gap}
                strokeWidth={overThickness + 2}
                fill="none"
              />
              {/* the coil tail: the lap ahead starts tucked INWARD across the
                  gap (its round tip a half-thickness inside the arch's line,
                  sliding under the lap riding over it) and eases back out to
                  the full radius — the Google Fit seam */}
              <AnimatedPath
                animatedProps={seamProps}
                d={tuckPath(
                  cx, cy, overR, overThickness * 0.5,
                  overEndDeg + capDeg * 2 + gapDeg,
                  overEndDeg + capDeg * 6 + gapDeg,
                  overEndDeg + capDeg * 9 + gapDeg,
                )}
                stroke={color}
                strokeWidth={overThickness}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* two-pass tip shadow (wide faint + tight) cast into the gap —
                  a fake penumbra, no hard printed edge, no SVG filters */}
              <AnimatedPath
                animatedProps={seamProps}
                d={arcPath(cx, cy, overR, Math.max(0.01, overEndDeg - capDeg * 2.5), overEndDeg)}
                stroke={colorWithAlpha('#000000', 0.06)}
                strokeWidth={overThickness + 2.5}
                fill="none"
                strokeLinecap="round"
                transform={`translate(${shadowDx}, ${shadowDy})`}
              />
              <AnimatedPath
                animatedProps={seamProps}
                d={arcPath(cx, cy, overR, Math.max(0.01, overEndDeg - capDeg * 2.5), overEndDeg)}
                stroke={colorWithAlpha('#000000', 0.12)}
                strokeWidth={overThickness}
                fill="none"
                strokeLinecap="round"
                transform={`translate(${shadowDx}, ${shadowDy})`}
              />
              {/* the second lap sweeps in from 12 o'clock; its rounded leading
                  cap is the arch */}
              <AnimatedCircle
                cx={cx} cy={cy} r={overR} stroke={color} strokeWidth={overThickness} fill="none"
                strokeLinecap="round" strokeDasharray={circ} animatedProps={overProps}
                transform={`rotate(-90, ${cx}, ${cy})`}
              />
            </>
          )}
        </Svg>

        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          {display === 'remaining' ? (
            <>
              <AnimatedNumber
                key={over ? 'over' : 'left'}
                value={centerValue}
                durationMs={dur}
                format={(n) => (over ? '+' : '') + fmtInt(n)}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                style={[styles.value, { color: heroColor, fontSize: resolvedCenterFontSize, maxWidth: centerMaxWidth }]}
              />
              <Animated.Text
                key={over ? 'OVER' : 'LEFT'}
                entering={snap ? undefined : FadeIn.duration(160)}
                style={[styles.caption, { color: C.textMuted }]}
              >
                {over ? 'OVER' : 'LEFT'}
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
