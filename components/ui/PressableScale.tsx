import { Pressable, PressableProps, StyleProp, ViewStyle, GestureResponderEvent } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { haptics, type HapticKind } from '@/lib/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface Props extends Omit<PressableProps, 'style'> {
  // The whole control dips slightly on press (the crafted, tactile feel).
  scaleTo?: number;
  // Which haptic to fire on press; pass false to stay silent.
  haptic?: HapticKind | false;
  style?: StyleProp<ViewStyle>;
}

// A drop-in for TouchableOpacity that scales down on press (Reanimated) and
// fires a haptic. Use for primary CTAs and tappable cards.
export function PressableScale({
  scaleTo = 0.97,
  haptic = 'tap',
  onPressIn,
  onPressOut,
  onPress,
  style,
  children,
  ...rest
}: Props) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <AnimatedPressable
      onPressIn={(e: GestureResponderEvent) => {
        scale.value = withTiming(scaleTo, { duration: 80, easing: Easing.out(Easing.quad) });
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        scale.value = withTiming(1, { duration: 140, easing: Easing.out(Easing.quad) });
        onPressOut?.(e);
      }}
      onPress={(e: GestureResponderEvent) => {
        if (haptic) haptics[haptic]();
        onPress?.(e);
      }}
      style={[animStyle, style]}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}
