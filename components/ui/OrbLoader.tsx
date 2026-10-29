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

/** The orb fades far dots toward its theme's background. A tint picks the
 *  side it contrasts with: light ink fades to black, dark ink to white.
 *  Mid greys keep the app theme. */
function orbTheme(color: string | undefined, mode: 'dark' | 'light'): 'dark' | 'light' {
  const l = color ? luminance(color) : null;
  if (l == null) return mode;
  if (l > 0.6) return 'dark';
  if (l < 0.15) return 'light';
  return mode;
}

function luminance(color: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
