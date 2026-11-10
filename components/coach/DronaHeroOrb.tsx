/**
 * DronaHeroOrb: Drona's orb as the hero of a still screen (the paywall's trust
 * step, onboarding's "I set the route"), so both read as the same Drona.
 *
 * Drawn with SignalOrb directly so it can run brighter than OrbStage's
 * default, which reads dim on these dark screens. No placeholder: nothing
 * waits here, so a mark that swaps to the orb a second later reads as a
 * glitch; the orb fades in from empty space instead.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { orbWebBox } from './OrbStage';
import { SignalOrb, signalOrbColor } from './SignalOrb';

export function DronaHeroOrb({ size = 140, style }: { size?: number; style?: StyleProp<ViewStyle> }) {
  const { mode } = useTheme();
  return (
    <View
      style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}
      pointerEvents="none"
    >
      <SignalOrb
        size={orbWebBox(size)}
        state="listening"
        level={0.4}
        particles={2200}
        brightness={1.6}
        color={signalOrbColor(mode)}
      />
    </View>
  );
}
