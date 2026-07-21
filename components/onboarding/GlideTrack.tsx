/**
 * The journey track: Drona's arrowhead gliding along a line on loop, its speed
 * set by the caller. Shared by the frequency step (speed = training days) and
 * the pace step (speed = weekly rate) so schedule and pace read as one
 * instrument.
 */
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';
import { DronaMark } from '@/components/coach/DronaMark';

const MARK_W = 20;

export function GlideTrack({ durationMs, width }: { durationMs: number; width: number }) {
  const { C } = useTheme();
  const progress = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: durationMs, easing: Easing.linear }),
      -1,
    );
  }, [durationMs, progress]);

  const glide = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * Math.max(0, width - MARK_W) }],
    opacity: interpolate(progress.value, [0, 0.07, 0.93, 1], [0, 1, 1, 0]),
  }));

  return (
    <View style={[g.wrap, { width }]}>
      <View style={[g.line, { backgroundColor: C.borderSubtle }]} />
      <Animated.View style={[g.mark, glide]}>
        {/* Arrowhead points up by default; rotate to fly along the track. */}
        <View style={{ transform: [{ rotate: '90deg' }] }}>
          <DronaMark size={MARK_W} state="static" />
        </View>
      </Animated.View>
    </View>
  );
}

const g = StyleSheet.create({
  wrap: {
    height: 36,
    justifyContent: 'center',
    marginBottom: 12,
  },
  line: { height: 1, borderRadius: 0.5 },
  mark: { position: 'absolute', top: 0 },
});
