/**
 * The frequency step's story (Phase 1b): choosing training days should FEEL
 * like choosing momentum, not picking a number. A detented slider (1-7 days)
 * drives a journey track above it where Drona's arrowhead glides on loop, its
 * speed scaling with the chosen days, plus an honest coach-voice caption per
 * count. The captions never claim more days is linearly faster; the top end
 * names the recovery cost.
 *
 * Same slider + arrowhead-speed language returns on the pace step (Phase 2),
 * so schedule and pace read as one instrument.
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

const MIN_DAYS = 1;
const MAX_DAYS = 7;
const STEPS = MAX_DAYS - MIN_DAYS; // 6 intervals
const THUMB = 30;

const STORY: Record<number, string> = {
  1: 'One day a week is a real start. We will make it count.',
  2: 'Twice a week still moves the needle. Slow and steady.',
  3: 'Full Body, three days. The consistency sweet spot.',
  4: 'Upper Lower, four days. Faster progress, still easy to recover from.',
  5: 'Push Pull Legs, five days. Serious pace.',
  6: 'PPL twice over. The fastest route, and recovery becomes part of the job.',
  7: 'Every single day. Only works if sleep and food keep up.',
};

// Loop duration per day count: more days, faster glide.
const GLIDE_MS: Record<number, number> = {
  1: 6500,
  2: 5200,
  3: 4000,
  4: 3000,
  5: 2100,
  6: 1400,
  7: 1000,
};

export function FrequencyStory({
  value,
  onChange,
}: {
  value: number;
  onChange: (days: number) => void;
}) {
  const { C } = useTheme();
  const [trackW, setTrackW] = useState(0);
  const usable = Math.max(1, trackW - THUMB);

  const pos = useSharedValue(((value - MIN_DAYS) / STEPS) * usable);
  const startX = useSharedValue(0);
  const curIdx = useSharedValue(value - MIN_DAYS);

  // Re-derive position when layout lands (usable goes 1 -> real width).
  useEffect(() => {
    pos.value = ((value - MIN_DAYS) / STEPS) * usable;
    curIdx.value = value - MIN_DAYS;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable]);

  const notify = (days: number) => {
    haptics.selection();
    onChange(days);
  };

  const pan = Gesture.Pan()
    .onBegin(() => {
      startX.value = pos.value;
    })
    .onUpdate((e) => {
      'worklet';
      const next = Math.min(usable, Math.max(0, startX.value + e.translationX));
      pos.value = next;
      const idx = Math.round((next / usable) * STEPS);
      if (idx !== curIdx.value) {
        curIdx.value = idx;
        runOnJS(notify)(MIN_DAYS + idx);
      }
    })
    .onEnd(() => {
      'worklet';
      pos.value = withTiming((curIdx.value / STEPS) * usable, { duration: 140 });
    });

  const tap = Gesture.Tap().onEnd((e) => {
    'worklet';
    const x = Math.min(usable, Math.max(0, e.x - THUMB / 2));
    const idx = Math.round((x / usable) * STEPS);
    pos.value = withTiming((idx / STEPS) * usable, { duration: 160 });
    if (idx !== curIdx.value) {
      curIdx.value = idx;
      runOnJS(notify)(MIN_DAYS + idx);
    }
  });

  const gesture = Gesture.Exclusive(pan, tap);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pos.value }],
  }));
  const fillStyle = useAnimatedStyle(() => ({
    width: pos.value + THUMB / 2,
  }));

  return (
    <View>
      {trackW > 0 && <GlideTrack durationMs={GLIDE_MS[value] ?? 3000} width={trackW} />}

      <View style={t.valueRow}>
        <Text style={[t.valueBig, { color: C.foreground }]}>{value}</Text>
        <Text style={[t.valueUnit, { color: C.textMuted }]}>
          day{value === 1 ? '' : 's'} a week
        </Text>
      </View>

      <GestureDetector gesture={gesture}>
        <View
          style={t.sliderHit}
          onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
          accessibilityRole="adjustable"
          accessibilityLabel="Training days per week"
          accessibilityValue={{ min: MIN_DAYS, max: MAX_DAYS, now: value }}
        >
          <View style={[t.sliderTrack, { backgroundColor: C.muted }]} />
          <Animated.View style={[t.sliderFill, { backgroundColor: C.accentText }, fillStyle]} />
          {Array.from({ length: STEPS + 1 }, (_, i) => (
            <View
              key={i}
              style={[
                t.detent,
                {
                  left: THUMB / 2 + (i / STEPS) * usable - 2,
                  backgroundColor: i <= value - MIN_DAYS ? C.accentText : C.border,
                },
              ]}
            />
          ))}
          <Animated.View style={[t.thumb, { backgroundColor: Colors.primary }, thumbStyle]} />
        </View>
      </GestureDetector>

      <Text style={[t.story, { color: C.textSecondary }]}>{STORY[value]}</Text>

      <View style={t.weekDots}>
        {Array.from({ length: 7 }, (_, i) => (
          <View
            key={i}
            style={[t.weekDot, { backgroundColor: i < value ? C.accentText : C.muted }]}
          />
        ))}
      </View>
    </View>
  );
}

const t = StyleSheet.create({
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    justifyContent: 'center',
    marginBottom: Spacing.xl,
  },
  valueBig: { fontFamily: FontFamily.display, fontSize: 48, letterSpacing: -1 },
  valueUnit: { fontSize: FontSize.lg, fontFamily: FontFamily.displayMedium },

  sliderHit: { height: 44, justifyContent: 'center' },
  sliderTrack: { height: 6, borderRadius: 3 },
  sliderFill: {
    position: 'absolute',
    left: 0,
    height: 6,
    borderRadius: 3,
  },
  detent: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
    top: 20,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    top: 7,
  },
  story: {
    fontSize: FontSize.md,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: Spacing.xl,
    minHeight: 42,
  },
  weekDots: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    marginTop: Spacing.lg,
  },
  weekDot: { width: 8, height: 8, borderRadius: 4 },
});
