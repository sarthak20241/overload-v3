/**
 * What the diary shows while a different day is being fetched.
 *
 * The day switch used to keep the PREVIOUS day's ring, macros and food on
 * screen for a second or two, so yesterday's calories read as today's. The
 * numbers are the whole point of this screen, and stale ones are worse than
 * none: this replaces them until the real day lands.
 *
 * Not zeros, either. An empty ring says "you logged nothing", which is a claim,
 * and it was wrong about half the time. A shimmer says "not known yet".
 */
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { ThinkingOrb } from 'expo-thinking-orbs';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';

/** One shimmering block standing in for a number or a row. */
export function Skeleton({ width, height, radius }: { width: number | `${number}%`; height: number; radius?: number }) {
  const { C } = useTheme();
  const pulse = useSharedValue(0.35);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) { pulse.value = 0.5; return; }
    pulse.value = withRepeat(withTiming(0.75, { duration: 820, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [reduced, pulse]);

  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius ?? Radius.sm, backgroundColor: C.borderSubtle },
        style,
      ]}
    />
  );
}

/** The summary block: the orb where the calorie ring goes, shimmer where the
 *  caption and the three macro bars go. Same height as the real thing, so the
 *  page does not jump when the day lands. */
export function DaySummaryLoading({ orbSize = 116 }: { orbSize?: number }) {
  const { mode } = useTheme();
  const s = makeStyles();
  return (
    <View style={s.row} accessibilityLabel="Loading this day">
      <View style={[s.ringSlot, { width: orbSize, height: orbSize }]}>
        {/* 'searching' is the one that reads as "fetching", which is what this
            is: the day is being looked up, not computed. */}
        <ThinkingOrb state="searching" size={orbSize} theme={mode} />
      </View>
      <View style={s.rail}>
        <Skeleton width={110} height={12} />
        <Skeleton width="100%" height={10} />
        <Skeleton width="100%" height={10} />
        <Skeleton width="100%" height={10} />
      </View>
    </View>
  );
}

/** Two shimmer rows under a meal heading. Two, not the real count: the count
 *  is not known yet either, and guessing it makes the list jump twice. */
export function MealRowsLoading() {
  const s = makeStyles();
  return (
    <View style={s.rows}>
      <Skeleton width="100%" height={44} radius={Radius.md} />
      <Skeleton width="72%" height={44} radius={Radius.md} />
    </View>
  );
}

function makeStyles() {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg },
    ringSlot: { alignItems: 'center', justifyContent: 'center' },
    rail: { flex: 1, gap: Spacing.sm },
    rows: { gap: Spacing.xs },
  });
}
