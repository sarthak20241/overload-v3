/**
 * The app's one "something is loading" mark: a dotted orb, never a spinner.
 *
 * Drop-in for ActivityIndicator. `size` takes the same 'small' | 'large'
 * words or a number. With no `color` the orb is monochrome and follows the
 * app theme, the way the diary's day loader does. Pass `color` when it sits
 * on a filled button, so it reads in the button's own ink.
 */
import type { StyleProp, ViewStyle } from 'react-native';
import { ThinkingOrb, type OrbState } from 'expo-thinking-orbs';

import { useTheme } from '@/hooks/useTheme';
import { orbTheme } from '@/lib/orbTheme';

const SIZES = { small: 20, large: 40 } as const;

type Props = {
  size?: keyof typeof SIZES | number;
  color?: string;
  /** 'searching' for fetches, 'working' for writes and waits. */
  state?: OrbState;
  paused?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

export function OrbLoader({ size = 'small', color, state = 'working', paused, style, accessibilityLabel }: Props) {
  const { mode } = useTheme();
  const px = typeof size === 'number' ? size : SIZES[size];
  return (
    <ThinkingOrb
      state={state}
      size={px}
      theme={orbTheme(color, mode)}
      color={color}
      paused={paused}
      // ActivityIndicator centred itself in whatever it filled; the orb has
      // a fixed box, so it centres itself instead.
      style={[{ alignSelf: 'center' }, style]}
      accessibilityLabel={accessibilityLabel ?? 'Loading'}
    />
  );
}
