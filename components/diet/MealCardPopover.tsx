/**
 * MealCardPopover - the parsed-meal card lifted out of the food bar into a
 * bigger view over a blurred nutrition screen.
 *
 * It is a morph, not a new screen: the frame starts on the exact rect the
 * inline card occupied and springs to its larger home, so the card reads as
 * having popped out of its place. Closing runs it back into the same spot.
 * The children are the SAME ParsedMealCard with the same callbacks, laid out
 * to fill the frame, so the footer stays pinned while the list grows into the
 * new room. Nothing is snapshotted, so nothing can go stale mid-flight.
 *
 * When the card has no home to return to (Add finished, Discard, the words
 * went back to the box) it fades out where it stands instead, holding the last
 * content it showed so the frame never empties while it leaves.
 *
 * The food box stays out of it. The blur and the card stop above the box, so
 * the user can type a correction or the next food without putting the card
 * away, and the card rides up with the keyboard. The card is anchored to the
 * box and grows upward, like a thread over its composer, and follows its own
 * content as a reply is read, lands, or gains a notice.
 *
 * Rendered through the root Portal, never RN <Modal> (Android edge-to-edge;
 * see components/ui/Portal.tsx). The screen mounts this BEFORE the line editor
 * and save sheets, so those still open on top of it.
 */
import React, { useEffect, useRef } from 'react';
import { View, Pressable, StyleSheet, BackHandler, useWindowDimensions } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, Easing,
  interpolate, Extrapolation, runOnJS, useReducedMotion,
} from 'react-native-reanimated';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Portal } from '@/components/ui/Portal';
import { useTheme } from '@/hooks/useTheme';
import { Spacing } from '@/constants/theme';

export interface CardRect { x: number; y: number; width: number; height: number }

/**
 * expo-blur is a native view. A dev client or store binary built before it
 * landed has no ExpoBlurView, and requiring the JS side there warns and draws
 * nothing, so look for the native half first and fall back to a plain scrim.
 * This keeps the feature safe to ship over the air: the blur simply arrives
 * with the next native build.
 */
const BlurView: React.ComponentType<{
  intensity?: number; tint?: 'light' | 'dark'; style?: object;
}> | null = (() => {
  try {
    if (!requireOptionalNativeModule('ExpoBlurView')) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-blur').BlurView;
  } catch {
    return null;
  }
})();

interface Props {
  /** Where the inline card sits on screen. null = closing with nowhere to
   *  return to, so the card fades out in place. */
  origin: CardRect | null;
  /** The card's height with nothing capping it: the popover grows to this,
   *  never to a fixed full-screen block that leaves a short meal floating in
   *  empty space. Updates while open; the frame follows. */
  naturalHeight: number;
  /** Screen y of the food box's top edge. Everything here stays above it so
   *  the box remains visible and usable. Moves with the keyboard. */
  bottomEdge: number;
  /** Mounted at all. */
  visible: boolean;
  /** false starts the return trip; onClosed fires when it lands. */
  open: boolean;
  onRequestClose: () => void;
  onClosed: () => void;
  children: React.ReactNode;
}

const OPEN_SPRING = { damping: 22, stiffness: 240, mass: 0.9 };
const CLOSE_TIMING = { duration: 220, easing: Easing.out(Easing.cubic) };
// Close to the iOS keyboard curve, so the card rides up with the box.
const FOLLOW_TIMING = { duration: 250, easing: Easing.out(Easing.cubic) };

export function MealCardPopover(props: Props) {
  // The Portal entry is registered on the screen's first render whether or not
  // a card is up, which is what keeps it BELOW the sheets declared after it.
  return <Portal>{props.visible ? <PopoverBody {...props} /> : null}</Portal>;
}

function PopoverBody({ origin, naturalHeight, bottomEdge, open, onRequestClose, onClosed, children }: Props) {
  const { C, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const reduced = useReducedMotion();

  // Last real content, so a fade-out after the meal is gone still shows it.
  const lastChildren = useRef<React.ReactNode>(children);
  if (children) lastChildren.current = children;

  // The first origin is where the card came from. A later one (re-measured on
  // close, after the keyboard dropped) is where it goes back to.
  const from = useRef<CardRect | null>(origin);
  if (origin) from.current = origin;
  const src = from.current ?? { x: Spacing.lg, y: winH / 2, width: winW - Spacing.lg * 2, height: 0 };
  const fadeOnly = !origin;

  const top = insets.top + Spacing.lg;
  const bottom = Math.min(winH - insets.bottom - Spacing.lg, bottomEdge - Spacing.sm);
  const room = Math.max(0, bottom - top);
  const dstH = Math.min(room, naturalHeight > 0 ? naturalHeight : src.height);
  const dstX = Spacing.lg;
  const dstW = winW - Spacing.lg * 2;

  const p = useSharedValue(0);
  // Where the card sits once open. Shared values so a keyboard or a content
  // change glides the frame there instead of snapping, without restarting
  // the open morph that reads them.
  const h = useSharedValue(dstH);
  const b = useSharedValue(bottom);
  const edge = useSharedValue(bottomEdge);
  useEffect(() => {
    h.value = withTiming(dstH, FOLLOW_TIMING);
    b.value = withTiming(bottom, FOLLOW_TIMING);
    edge.value = withTiming(bottomEdge, FOLLOW_TIMING);
  }, [dstH, bottom, bottomEdge, h, b, edge]);

  useEffect(() => {
    if (open) {
      p.value = reduced ? withTiming(1, { duration: 120 }) : withSpring(1, OPEN_SPRING);
      return;
    }
    p.value = withTiming(0, reduced ? { duration: 120 } : CLOSE_TIMING, (done) => {
      if (done) runOnJS(onClosed)();
    });
    // onClosed is the screen's setter wrapper; re-running on its identity
    // would restart a close that is already in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduced, p]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onRequestClose(); return true; });
    return () => sub.remove();
  }, [open, onRequestClose]);

  const frame = useAnimatedStyle(() => {
    // A fade-out holds the big frame and just leaves; a return trip morphs
    // the rect back onto the inline card. The spring may overshoot 1 a touch,
    // which is the "pop"; clamp below 0 so a close never inverts the rect.
    const t = fadeOnly ? 1 : Math.max(0, p.value);
    const lerp = (from: number, to: number) => from + (to - from) * t;
    return {
      left: lerp(src.x, dstX),
      top: lerp(src.y, b.value - h.value),
      width: lerp(src.width, dstW),
      height: lerp(src.height, h.value),
      opacity: fadeOnly ? interpolate(p.value, [0, 1], [0, 1], Extrapolation.CLAMP) : 1,
      transform: fadeOnly ? [{ scale: interpolate(p.value, [0, 1], [0.97, 1], Extrapolation.CLAMP) }] : [],
    };
  });

  // Stops at the food box: above it the screen is blurred and closes the card
  // on a tap, the box itself stays sharp and live.
  const backdrop = useAnimatedStyle(() => ({
    height: edge.value,
    opacity: interpolate(p.value, [0, 1], [0, 1], Extrapolation.CLAMP),
  }));

  return (
    // box-none: the root lets touches through to the food box below the
    // backdrop; only the backdrop and the card take them.
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, backdrop]}>
        {BlurView && (
          <BlurView intensity={28} tint={mode === 'dark' ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        )}
        {/* Without the native blur the scrim alone carries the separation, so
            it runs darker there. */}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay, opacity: BlurView ? 0.45 : 0.85 }]} />
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={open ? onRequestClose : undefined}
          accessibilityRole="button"
          accessibilityLabel="Close the bigger view"
        />
      </Animated.View>
      <Animated.View
        style={[styles.frame, frame]}
        // Not modal for VoiceOver: the food box below is meant to stay reachable.
        pointerEvents={open ? 'auto' : 'none'}
      >
        {lastChildren.current}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
  frame: {
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.18,
    shadowRadius: 28,
    elevation: 12,
  },
});
