/** A logged food row you throw off to the left to remove. Past the line the bin
 *  grows and the phone ticks; let go there and the row is gone. Short of it,
 *  the row springs back. The screen holds the delete behind an Undo. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  interpolate, runOnJS, useAnimatedReaction, useAnimatedStyle, withTiming, Extrapolation, type SharedValue,
} from 'react-native-reanimated';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';

/** Share of the row a swipe must pass before letting go removes it. */
const REMOVE_AT = 0.4;
/** How much of the slide off-screen plays before the row unmounts. */
const LEAVE_MS = 140;

interface Props {
  style?: StyleProp<ViewStyle>;
  onRemove: () => void;
  children: ReactNode;
}

export function SwipeToRemove({ style, onRemove, children }: Props) {
  const { width: screenW } = useWindowDimensions();
  const [rowW, setRowW] = useState(screenW);
  const threshold = rowW * REMOVE_AT;
  // Cleared if the row unmounts first (a day switch mid-slide), so no stale remove fires.
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);

  return (
    <View onLayout={(e) => setRowW(e.nativeEvent.layout.width)}>
      <ReanimatedSwipeable
        containerStyle={style}
        friction={1}
        rightThreshold={threshold}
        overshootRight={false}
        // The bin panel is the full row, so "open" means the row left the screen.
        renderRightActions={(_progress, translation) => (
          <RemoveBackdrop width={rowW} threshold={threshold} translation={translation} />
        )}
        // On release past the line. The spring's long settle read as a stall,
        // so the row goes once the fast part of the slide has played.
        onSwipeableWillOpen={() => { leaveTimer.current = setTimeout(onRemove, LEAVE_MS); }}
      >
        {children}
      </ReanimatedSwipeable>
    </View>
  );
}

function RemoveBackdrop({ width, threshold, translation }: {
  width: number; threshold: number; translation: SharedValue<number>;
}) {
  const { C } = useTheme();
  // One tick each time the swipe crosses the line, either way.
  useAnimatedReaction(
    () => translation.value <= -threshold,
    (past, prev) => { if (prev !== null && past !== prev) runOnJS(haptics.tick)(); },
  );
  const fill = useAnimatedStyle(() => ({
    opacity: interpolate(-translation.value, [0, threshold * 0.5, threshold], [0, 0.6, 1], Extrapolation.CLAMP),
  }));
  // The bin waits at the far edge and pops once the swipe is past the line.
  const bin = useAnimatedStyle(() => {
    const pulled = -translation.value;
    return {
      opacity: interpolate(pulled, [0, 48], [0, 1], Extrapolation.CLAMP),
      transform: [{ scale: withTiming(pulled >= threshold ? 1.25 : 1, { duration: 120 }) }],
    };
  });
  return (
    <View style={[s.panel, { width }]}>
      {/* A soft red tint, not a solid alarm: the bin carries the colour. */}
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: `${C.dangerText}2E` }, fill]} />
      <Animated.View style={[s.bin, bin]}>
        <Feather name="trash-2" size={16} color={C.dangerText} />
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  panel: { justifyContent: 'center', alignItems: 'flex-end', overflow: 'hidden' },
  bin: { width: 48, alignItems: 'center' },
});
