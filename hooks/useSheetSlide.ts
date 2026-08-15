import { useEffect, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import {
  Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming,
} from 'react-native-reanimated';

/**
 * Slide-up/slide-down animation for a bottom sheet, driven by a transform we
 * own rather than by Reanimated's `entering`/`exiting` layout animations.
 *
 * Why this exists: a view carrying `entering`/`exiting` keeps the native frame
 * Reanimated gave it, so every later layout change on that view is dropped —
 * including a plain layout change on a parent. Our sheets render through
 * <Portal> (the app's own window, which the OS does not resize for the
 * keyboard), so they lift themselves with `marginBottom: kbHeight` and cap
 * themselves with `maxHeight`. Both are layout, so both were silently ignored:
 * the sheet stayed flush to the screen bottom and the keyboard buried its input
 * and its primary button. A transform leaves the sheet under normal layout, so
 * the lift and the cap work again.
 *
 * Usage:
 *   const { mounted, slideStyle } = useSheetSlide(visible);
 *   <Portal>{mounted && (
 *     <View style={{ flex: 1, justifyContent: 'flex-end' }} pointerEvents={visible ? 'auto' : 'none'}>
 *       {visible && <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />}
 *       <Animated.View style={[styles.sheet, slideStyle, { marginBottom: kbHeight }]}>…</Animated.View>
 *     </View>
 *   )}</Portal>
 *
 * `mounted` stays true through the closing animation so the sheet can slide
 * back out before it unmounts — gate the sheet on it, and the backdrop on
 * `visible` so the dim clears the moment the user dismisses.
 *
 * @param visible Whether the sheet should be open.
 * @param inDuration Slide-in duration, to match whatever each sheet used before.
 * @param outDuration Slide-out duration.
 */
export function useSheetSlide(visible: boolean, inDuration = 320, outDuration = 200) {
  const { height } = useWindowDimensions();
  // Starts off-screen so the first frame after mount is already below the fold,
  // never a flash of the sheet in its resting place.
  const translateY = useSharedValue(height);
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.value = withTiming(0, { duration: inDuration, easing: Easing.out(Easing.cubic) });
    } else {
      translateY.value = withTiming(height, { duration: outDuration }, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
  }, [visible, height, inDuration, outDuration, translateY]);

  const slideStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));

  return { mounted, slideStyle };
}
