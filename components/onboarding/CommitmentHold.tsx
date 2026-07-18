/**
 * The commitment ritual (Phase 4): a pledge card and a tap-and-hold ring.
 * Holding fills a lime arc around Drona's mark over ~1.4 s; letting go early
 * rewinds it. Completing fires the success haptic, a restrained lime confetti
 * burst, and hands off to the build moment. Endowment beats a checkbox: the
 * user physically holds the promise.
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Canvas, Group, Path, Skia, vec } from '@shopify/react-native-skia';
import {
  Easing,
  runOnJS,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Confetti } from 'react-native-fast-confetti';
import { Colors, FontFamily, FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';
import { DronaMark } from '@/components/coach/DronaMark';

const SIZE = 132;
const STROKE = 7;
const HOLD_MS = 1400;

const CONFETTI_COLORS = ['#c8ff00', '#9fcc00', '#5a6069', '#e7f5c2', '#ffffff'];

export function CommitmentHold({
  pledgeTitle,
  pledgeBody,
  onCommitted,
}: {
  pledgeTitle: string;
  pledgeBody: string;
  onCommitted: () => void;
}) {
  const { C } = useTheme();
  const [committed, setCommitted] = useState(false);
  const progress = useSharedValue(0);

  const path = useMemo(() => {
    const p = Skia.Path.Make();
    p.addCircle(SIZE / 2, SIZE / 2, (SIZE - STROKE) / 2);
    return p;
  }, []);

  const done = useSharedValue(false);

  const complete = () => {
    setCommitted(true);
    haptics.success();
    setTimeout(onCommitted, 2100);
  };
  const tickStart = () => haptics.tick();

  // RNGH pan (not Pressable): onBegin fires at touch-down and onFinalize at
  // release, which holds up under synthetic input too. No movement needed.
  const hold = Gesture.Pan()
    .maxPointers(1)
    .onBegin(() => {
      'worklet';
      if (done.value) return;
      runOnJS(tickStart)();
      progress.value = withTiming(1, { duration: HOLD_MS, easing: Easing.linear }, (finished) => {
        'worklet';
        if (finished && !done.value) {
          done.value = true;
          runOnJS(complete)();
        }
      });
    })
    .onFinalize(() => {
      'worklet';
      if (!done.value) progress.value = withTiming(0, { duration: 250 });
    });

  return (
    <View style={c.wrap}>
      <View style={[c.pledge, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
        <Text style={[c.pledgeTitle, { color: C.foreground }]}>{pledgeTitle}</Text>
        <Text style={[c.pledgeBody, { color: C.textSecondary }]}>{pledgeBody}</Text>
      </View>

      <GestureDetector gesture={hold}>
      <View
        accessibilityRole="button"
        accessibilityLabel="Tap and hold to commit"
        style={c.holdArea}
      >
        <Canvas style={{ width: SIZE, height: SIZE }}>
          <Path
            path={path}
            style="stroke"
            strokeWidth={STROKE}
            color={C.muted}
          />
          {/* Progress arc starts at 12 o'clock. */}
          <Group origin={vec(SIZE / 2, SIZE / 2)} transform={[{ rotate: -Math.PI / 2 }]}>
            <Path
              path={path}
              style="stroke"
              strokeWidth={STROKE}
              strokeCap="round"
              color={Colors.primary}
              start={0}
              end={progress}
            />
          </Group>
        </Canvas>
        <View style={c.markOverlay} pointerEvents="none">
          <DronaMark size={36} state={committed ? 'answer' : 'static'} />
        </View>
      </View>
      </GestureDetector>

      <Text style={[c.caption, { color: committed ? C.accentText : C.textDim }]}>
        {committed ? 'Committed.' : 'Tap and hold to make it yours'}
      </Text>

      {committed && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Confetti count={140} colors={CONFETTI_COLORS} fadeOutOnEnd />
        </View>
      )}
    </View>
  );
}

const c = StyleSheet.create({
  wrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.xxl },
  pledge: {
    borderRadius: 20,
    borderWidth: 1,
    padding: Spacing.xl,
    gap: Spacing.md,
    alignSelf: 'stretch',
  },
  pledgeTitle: {
    fontFamily: FontFamily.display,
    fontSize: 22,
  },
  pledgeBody: { fontSize: FontSize.md, lineHeight: 22 },
  holdArea: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
});
