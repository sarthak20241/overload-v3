/**
 * Physical inputs for the onboarding body/target steps: themed wheels for
 * numbers and a second wheel beside them for the unit (kg / lbs, cm / ft-in).
 * They arrive prefilled with sensible medians (smart defaults) so Continue is
 * always one tap, and they tick haptically per detent.
 *
 * The wheels wrap @quidone/react-native-wheel-picker (pure JS, no native dep).
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import WheelPicker from '@quidone/react-native-wheel-picker';
import { FontFamily, Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';
import { joinWeight, splitWeight, tenthsMax } from '@/lib/weightWheel';

// ─── Number wheel ───────────────────────────────────────────────────────────

export function NumberWheel({
  min,
  max,
  value,
  onChange,
  width = 150,
  itemHeight = 56,
  visibleItemCount = 5,
  fontSize = 28,
  accessibilityLabel,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  width?: number;
  itemHeight?: number;
  visibleItemCount?: number;
  fontSize?: number;
  accessibilityLabel: string;
}) {
  const { C } = useTheme();
  const data = useMemo(
    () => Array.from({ length: max - min + 1 }, (_, i) => ({ value: min + i, label: String(min + i) })),
    [min, max],
  );
  return (
    <View style={{ width }} accessibilityLabel={accessibilityLabel}>
      <WheelPicker
        data={data}
        value={value}
        onValueChanged={({ item }) => onChange(item.value)}
        onValueChanging={() => haptics.tick()}
        itemHeight={itemHeight}
        visibleItemCount={visibleItemCount}
        enableScrollByTapOnItem
        itemTextStyle={{
          fontFamily: FontFamily.displayMedium,
          fontSize,
          color: C.foreground,
        }}
        overlayItemStyle={{
          backgroundColor: C.muted,
          borderRadius: Radius.lg,
          opacity: 0.55,
        }}
      />
    </View>
  );
}

// ─── Unit wheel ─────────────────────────────────────────────────────────────

/**
 * A short second wheel beside the number: scroll it to switch units (kg / lbs,
 * cm / ft-in). The unit sits where the eye already is, not in a small text
 * toggle above the picker.
 */
export function UnitWheel<T extends string>({
  options,
  value,
  onChange,
  width = 84,
  accessibilityLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  width?: number;
  accessibilityLabel: string;
}) {
  const { C } = useTheme();
  const data = useMemo(() => options.map((o) => ({ value: o.value, label: o.label })), [options]);
  return (
    <View style={{ width }} accessibilityLabel={accessibilityLabel}>
      <WheelPicker
        data={data}
        value={value}
        onValueChanged={({ item }) => {
          if (item.value !== value) onChange(item.value as T);
        }}
        onValueChanging={() => haptics.tick()}
        itemHeight={56}
        visibleItemCount={5}
        enableScrollByTapOnItem
        itemTextStyle={{
          fontFamily: FontFamily.displayMedium,
          fontSize: 20,
          color: C.foreground,
        }}
        overlayItemStyle={{
          backgroundColor: C.muted,
          borderRadius: Radius.lg,
          opacity: 0.55,
        }}
      />
    </View>
  );
}

// ─── Weight wheel ───────────────────────────────────────────────────────────

/** Whole number, a dot, one decimal digit: "72 . 5". Values carry one decimal. */
export function WeightWheel({
  min,
  max,
  value,
  onChange,
  accessibilityLabel,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  accessibilityLabel: string;
}) {
  const { C } = useTheme();
  const { whole, tenth } = splitWeight(value);
  const set = (w: number, t: number) => onChange(joinWeight(w, t, min, max));
  return (
    <View style={w.row} accessibilityLabel={accessibilityLabel}>
      <NumberWheel
        min={min}
        max={max}
        width={104}
        value={whole}
        onChange={(v) => set(v, tenth)}
        accessibilityLabel={`${accessibilityLabel}, whole number`}
      />
      <Text style={[w.dot, { color: C.textMuted }]}>.</Text>
      <NumberWheel
        min={0}
        // At the top of the scale there is no room for a decimal: 200.0 kg is
        // the last stop, so the wheel never offers a tenth it would clamp away.
        max={tenthsMax(whole, max)}
        width={60}
        value={tenth}
        onChange={(v) => set(whole, v)}
        accessibilityLabel={`${accessibilityLabel}, decimal`}
      />
    </View>
  );
}

const w = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  dot: { fontFamily: FontFamily.displayMedium, fontSize: 28, width: 16, textAlign: 'center' },
});
