/**
 * Pace slider (Phase 2): how fast to move toward the goal weight. Continuous
 * drag snapped to a 0.05 kg/week grid between honest safety bounds, with the
 * shared glide track above (arrowhead speed = chosen rate) and Slow /
 * Recommended / Fast band labels below. The recommended detent is marked on
 * the track: anchoring, not enforcement.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Colors, FontFamily, FontSize, FontWeight, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';
import { GlideTrack } from '@/components/onboarding/GlideTrack';

const THUMB = 30;
const GRID = 0.05;

export function PaceSlider({
  min,
  max,
  recommended,
  value,
  unitLabel,
  onChange,
}: {
  min: number;
  max: number;
  recommended: number;
  value: number;
  /** e.g. "kg" - the rate reads "<value> kg a week". */
  unitLabel: string;
  onChange: (rate: number) => void;
}) {
  const { C } = useTheme();
  const [trackW, setTrackW] = useState(0);
  const usable = Math.max(1, trackW - THUMB);
  const steps = Math.round((max - min) / GRID);

  const pos = useSharedValue(((value - min) / (max - min)) * usable);
  const startX = useSharedValue(0);
  const curIdx = useSharedValue(Math.round((value - min) / GRID));

  useEffect(() => {
    pos.value = ((value - min) / (max - min)) * usable;
    curIdx.value = Math.round((value - min) / GRID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable]);

  const notify = (rate: number) => {
    haptics.tick();
    onChange(Math.round(rate * 100) / 100);
  };

  const pan = Gesture.Pan()
    .onBegin(() => {
      startX.value = pos.value;
    })
    .onUpdate((e) => {
      'worklet';
      const next = Math.min(usable, Math.max(0, startX.value + e.translationX));
      pos.value = next;
      const idx = Math.round((next / usable) * steps);
      if (idx !== curIdx.value) {
        curIdx.value = idx;
        runOnJS(notify)(min + idx * GRID);
      }
    })
    .onEnd(() => {
      'worklet';
      pos.value = withTiming((curIdx.value / steps) * usable, { duration: 120 });
    });

  const tap = Gesture.Tap().onEnd((e) => {
    'worklet';
    const x = Math.min(usable, Math.max(0, e.x - THUMB / 2));
    const idx = Math.round((x / usable) * steps);
    pos.value = withTiming((idx / steps) * usable, { duration: 140 });
    if (idx !== curIdx.value) {
      curIdx.value = idx;
      runOnJS(notify)(min + idx * GRID);
    }
  });

  const gesture = Gesture.Exclusive(pan, tap);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pos.value }],
  }));
  const fillStyle = useAnimatedStyle(() => ({
    width: pos.value + THUMB / 2,
  }));

  // Glide speed scales with the chosen rate: crawl at min, dart at max.
  const fraction = (value - min) / (max - min);
  const glideMs = Math.round(6000 - fraction * 4600);

  // Band for the label highlight: below/around/above the recommended rate.
  const band = value < recommended - GRID ? 'slow' : value > recommended + GRID ? 'fast' : 'rec';
  const recLeft = THUMB / 2 + ((recommended - min) / (max - min)) * usable - 1.5;

  return (
    <View>
      {trackW > 0 && <GlideTrack durationMs={glideMs} width={trackW} />}

      <View style={p.valueRow}>
        <Text style={[p.valueBig, { color: C.foreground }]}>{value.toFixed(2).replace(/0$/, '')}</Text>
        <Text style={[p.valueUnit, { color: C.textMuted }]}>{unitLabel} a week</Text>
      </View>

      <GestureDetector gesture={gesture}>
        <View
          style={p.sliderHit}
          onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
          accessibilityRole="adjustable"
          accessibilityLabel="Weekly pace"
          accessibilityValue={{ min, max, now: value }}
        >
          <View style={[p.sliderTrack, { backgroundColor: C.muted }]} />
          <Animated.View style={[p.sliderFill, { backgroundColor: C.accentText }, fillStyle]} />
          {trackW > 0 && (
            <View style={[p.recMark, { left: recLeft, backgroundColor: C.border }]} />
          )}
          <Animated.View style={[p.thumb, { backgroundColor: Colors.primary }, thumbStyle]} />
        </View>
      </GestureDetector>

      <View style={p.bands}>
        <Text style={[p.bandLabel, { color: band === 'slow' ? C.accentText : C.textDim }]}>
          Slow
        </Text>
        <Text style={[p.bandLabel, { color: band === 'rec' ? C.accentText : C.textDim }]}>
          Recommended
        </Text>
        <Text style={[p.bandLabel, { color: band === 'fast' ? C.accentText : C.textDim }]}>
          Fast
        </Text>
      </View>
    </View>
  );
}

const p = StyleSheet.create({
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    justifyContent: 'center',
    marginBottom: Spacing.xl,
  },
  valueBig: { fontFamily: FontFamily.display, fontSize: 44, letterSpacing: -1 },
  valueUnit: { fontSize: FontSize.md, fontFamily: FontFamily.displayMedium },

  sliderHit: { height: 44, justifyContent: 'center' },
  sliderTrack: { height: 6, borderRadius: 3 },
  sliderFill: {
    position: 'absolute',
    left: 0,
    height: 6,
    borderRadius: 3,
  },
  recMark: {
    position: 'absolute',
    width: 3,
    height: 14,
    borderRadius: 1.5,
    top: 15,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    top: 7,
  },
  bands: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.sm,
    paddingHorizontal: 2,
  },
  bandLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
});
