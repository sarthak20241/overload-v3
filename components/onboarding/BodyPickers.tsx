/**
 * Physical inputs for the onboarding body/target steps (Phase 1 of the
 * redesign): a themed number wheel and a horizontal ruler slider. Both arrive
 * prefilled with sensible medians (smart defaults) so Continue is always one
 * tap, and both tick haptically per detent.
 *
 * The wheel wraps @quidone/react-native-wheel-picker (pure JS, no native dep).
 * The ruler is a snap-interval FlatList: standard list physics, not hand-rolled
 * gestures (feedback rule), with a Space Grotesk readout above.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import WheelPicker from '@quidone/react-native-wheel-picker';
import { FontFamily, FontSize, Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';

// ─── Number wheel ───────────────────────────────────────────────────────────

export function NumberWheel({
  min,
  max,
  value,
  onChange,
  width = 110,
  accessibilityLabel,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  width?: number;
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
        itemHeight={44}
        visibleItemCount={3}
        enableScrollByTapOnItem
        itemTextStyle={{
          fontFamily: FontFamily.displayMedium,
          fontSize: 22,
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

// ─── Ruler slider ───────────────────────────────────────────────────────────

const TICK_GAP = 11; // px per step

export function RulerSlider({
  min,
  max,
  step,
  value,
  onChange,
  unitLabel,
  accessibilityLabel,
}: {
  min: number;
  max: number;
  /** Value distance between adjacent ticks (e.g. 0.5 kg). */
  step: number;
  value: number;
  onChange: (v: number) => void;
  unitLabel: string;
  accessibilityLabel: string;
}) {
  const { C } = useTheme();
  const count = Math.round((max - min) / step) + 1;
  const lastIdx = useRef(Math.round((value - min) / step));
  const listRef = useRef<FlatList<number>>(null);
  // Measured so the side padding centers tick 0 under the indicator exactly.
  const [viewportW, setViewportW] = useState(0);
  const sidePad = Math.max(0, viewportW / 2 - TICK_GAP / 2);

  const data = useMemo(() => Array.from({ length: count }, (_, i) => i), [count]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.min(count - 1, Math.max(0, Math.round(e.nativeEvent.contentOffset.x / TICK_GAP)));
      if (idx !== lastIdx.current) {
        lastIdx.current = idx;
        haptics.tick();
        onChange(min + idx * step);
      }
    },
    [count, min, step, onChange],
  );

  const display = Number.isInteger(step) ? String(value) : value.toFixed(1).replace(/\.0$/, '');

  return (
    <View accessibilityLabel={accessibilityLabel}>
      <View style={r.readout}>
        <Text style={[r.value, { color: C.foreground }]}>{display}</Text>
        <Text style={[r.unit, { color: C.textMuted }]}>{unitLabel}</Text>
      </View>
      <View style={r.rulerWrap} onLayout={(e) => setViewportW(e.nativeEvent.layout.width)}>
        {viewportW > 0 && (
        <FlatList
          ref={listRef}
          data={data}
          keyExtractor={(i) => String(i)}
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={TICK_GAP}
          decelerationRate="fast"
          getItemLayout={(_, index) => ({ length: TICK_GAP, offset: TICK_GAP * index, index })}
          initialScrollIndex={Math.round((value - min) / step)}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingHorizontal: sidePad }}
          renderItem={({ index }) => {
            const major = index % 5 === 0;
            return (
              <View style={[r.tickSlot]}>
                <View
                  style={[
                    r.tick,
                    {
                      height: major ? 34 : 20,
                      backgroundColor: C.border,
                      opacity: major ? 1 : 0.6,
                    },
                  ]}
                />
              </View>
            );
          }}
        />
        )}
        <View pointerEvents="none" style={[r.centerLine, { backgroundColor: C.accentText }]} />
      </View>
    </View>
  );
}

const RULER_H = 48;

const r = StyleSheet.create({
  readout: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 14,
  },
  value: {
    fontFamily: FontFamily.display,
    fontSize: 48,
    letterSpacing: -1,
  },
  unit: { fontSize: FontSize.lg, fontFamily: FontFamily.displayMedium },
  rulerWrap: { height: RULER_H, justifyContent: 'center' },
  tickSlot: {
    width: TICK_GAP,
    height: RULER_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tick: { width: 2, borderRadius: 1 },
  centerLine: {
    position: 'absolute',
    left: '50%',
    marginLeft: -1.5,
    top: -4,
    width: 3,
    height: RULER_H + 8,
    borderRadius: 1.5,
  },
});
