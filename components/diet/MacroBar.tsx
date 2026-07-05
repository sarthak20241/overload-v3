/**
 * MacroBar — one macro's progress toward its gram goal, as a baseline-aligned bar.
 *
 * The decided macro encoding (round 3): three of these stacked on a shared left
 * baseline are directly length-comparable AND carry the numbers a ring center
 * can't — eaten, target, and (when over) the signed surplus, on one tabular line.
 * Over target stays the SAME hue (never amber/oxblood): the fill reaches 100%, then
 * a LIGHTER same-hue over-segment (the hue opaquely pre-blended toward the card,
 * mixHex — same-hue alpha over the same solid fill is a no-op) rides over it from
 * the left, and the value prints the surplus. Two verbosities: compact (dashboard,
 * "131/56 +75") and verbose (diary, "131 / 56 g · +75 over"). Fills tween
 * prev→new; reduced-motion snaps.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withDelay, Easing, useReducedMotion,
} from 'react-native-reanimated';
import { FontSize, FontWeight, colorWithAlpha, mixHex } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';

interface Props {
  label: string;        // 'P' (compact) or 'Protein' (verbose)
  name: string;         // 'Protein' (for VoiceOver)
  value: number;        // grams eaten
  target: number;       // gram goal
  color: string;        // macro hue (pass from C.macro)
  verbose?: boolean;    // diary = true (roomy), dashboard = false (compact)
  animate?: boolean;
  delayMs?: number;     // entrance stagger
}

const r = (n: number) => Math.round(n);

export function MacroBar({ label, name, value, target, color, verbose = false, animate = true, delayMs = 0 }: Props) {
  const { C } = useTheme();
  const reduced = useReducedMotion();
  const [trackW, setTrackW] = useState(0);

  const pct = target > 0 ? Math.min(value / target, 1) : 0;
  const over = target > 0 && value > target;
  const overFrac = over ? Math.min((value - target) / target, 1) : 0;
  const overColor = mixHex(color, C.card, 0.45);

  const frac = useSharedValue(animate && !reduced ? 0 : pct);
  const oFrac = useSharedValue(animate && !reduced ? 0 : overFrac);
  const firstRef = useRef(true);
  const prevValRef = useRef(value);
  useEffect(() => {
    if (!animate || reduced) {
      frac.value = pct; oFrac.value = overFrac;
      firstRef.current = false; prevValRef.current = value;
      return;
    }
    if (firstRef.current) {
      firstRef.current = false;
      prevValRef.current = value;
      frac.value = withDelay(delayMs, withTiming(pct, { duration: 650, easing: Easing.out(Easing.cubic) }));
      oFrac.value = withDelay(delayMs + 180, withTiming(overFrac, { duration: 520, easing: Easing.out(Easing.cubic) }));
      return;
    }
    const dGrams = Math.abs(value - prevValRef.current);
    prevValRef.current = value;
    const d = Math.min(Math.max(220 + dGrams * 1.5, 220), 520);
    frac.value = withTiming(pct, { duration: d, easing: Easing.out(Easing.cubic) });
    oFrac.value = withTiming(overFrac, { duration: d, easing: Easing.out(Easing.cubic) });
  }, [pct, overFrac, value, animate, reduced, delayMs, frac, oFrac]);

  const baseStyle = useAnimatedStyle(() => ({ width: frac.value * trackW }));
  const overStyle = useAnimatedStyle(() => ({ width: oFrac.value * trackW }));

  const a11yText = over
    ? `${r(value)} of ${r(target)} grams, ${r(value - target)} over`
    : `${r(value)} of ${r(target)} grams, ${r(target - value)} left`;

  const trackH = verbose ? 6 : 5;

  return (
    <View
      style={s.row}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={name}
      accessibilityValue={{ text: a11yText }}
    >
      <Text style={[verbose ? s.labelWord : s.labelLetter, { color }]} numberOfLines={1}>{label}</Text>
      <View
        style={[s.track, { backgroundColor: colorWithAlpha(color, 0.14), height: trackH, borderRadius: trackH / 2 }]}
        onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
      >
        <Animated.View style={[s.fill, baseStyle, { backgroundColor: color, height: trackH, borderRadius: trackH / 2 }]} />
        {over && <Animated.View style={[s.fill, overStyle, { backgroundColor: overColor, height: trackH, borderRadius: trackH / 2 }]} />}
      </View>
      <Text style={[verbose ? s.valueVerbose : s.valueCompact]} numberOfLines={1}>
        <Text style={{ color, fontWeight: FontWeight.bold }}>{r(value)}</Text>
        <Text style={{ color: C.textMuted }}>{verbose ? ` / ${r(target)} g` : `/${r(target)}`}</Text>
        {over && <Text style={{ color, fontWeight: FontWeight.semibold }}>{verbose ? ` · +${r(value - target)} over` : ` +${r(value - target)}`}</Text>}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  labelLetter: { width: 10, fontSize: 11, fontWeight: FontWeight.bold, textAlign: 'center' },
  labelWord: { width: 52, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  track: { flex: 1, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0 },
  valueCompact: { minWidth: 76, textAlign: 'right', fontSize: 11, fontVariant: ['tabular-nums'] },
  valueVerbose: { minWidth: 132, textAlign: 'right', fontSize: FontSize.sm, fontVariant: ['tabular-nums'] },
});
