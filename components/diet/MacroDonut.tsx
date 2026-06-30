/**
 * MacroDonut — a food's calorie composition as a single segmented ring.
 *
 * Distinct from MacroRing (one arc filling toward a daily target): this splits one
 * food/meal's calories into carb / fat / protein arcs sized by their CALORIE
 * contribution (carb & protein 4 kcal/g, fat 9 kcal/g), with the total calories in
 * the center. It's the "what is this made of" summary on the food-detail screen,
 * mirroring the donut every mature tracker shows. Colors come from Colors.macro
 * (clay / slate / ochre); lime stays reserved for the action.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';

interface Props {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  size?: number;
  thickness?: number;
}

export function MacroDonut({ kcal, protein_g, carb_g, fat_g, size = 116, thickness = 12 }: Props) {
  const { C } = useTheme();
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;

  const segs = [
    { val: Math.max(carb_g, 0) * 4, color: C.macro.carbs },
    { val: Math.max(fat_g, 0) * 9, color: C.macro.fat },
    { val: Math.max(protein_g, 0) * 4, color: C.macro.protein },
  ];
  const total = segs.reduce((a, s) => a + s.val, 0);
  const gap = total > 0 ? circ * 0.015 : 0; // hairline gap between segments

  let cursor = 0;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle cx={cx} cy={cy} r={r} stroke={C.muted} strokeWidth={thickness} fill="none" />
        {total > 0 &&
          segs.map((s, i) => {
            const frac = s.val / total;
            const len = Math.max(frac * circ - gap, 0.001);
            const node = (
              <Circle
                key={i}
                cx={cx}
                cy={cy}
                r={r}
                stroke={s.color}
                strokeWidth={thickness}
                fill="none"
                strokeLinecap="butt"
                strokeDasharray={`${len} ${circ - len}`}
                strokeDashoffset={-cursor}
                transform={`rotate(-90, ${cx}, ${cy})`}
              />
            );
            cursor += frac * circ;
            return node;
          })}
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
        <Text style={[styles.num, { color: C.foreground }]}>{Math.round(kcal).toLocaleString()}</Text>
        <Text style={[styles.lbl, { color: C.textDim }]}>Cal</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  num: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.black,
    letterSpacing: LetterSpacing.tight,
    fontVariant: ['tabular-nums'],
    lineHeight: 26,
  },
  lbl: {
    fontSize: 9,
    fontWeight: FontWeight.semibold,
    letterSpacing: LetterSpacing.eyebrow,
    textTransform: 'uppercase',
    marginTop: 1,
  },
});
