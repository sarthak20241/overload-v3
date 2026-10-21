/**
 * OrbStage: Drona's orb with a line under it saying what Drona is doing.
 * The waiting moment anywhere in the app (plan building, food logging,
 * onboarding), so every wait looks and reads the same as the coach chat.
 *
 * One live orb per screen: the orb is a small WebView with its own animation
 * loop, so never render this inside a list.
 */
import React, { useEffect } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';
import { FontWeight } from '@/constants/theme';
import { SignalOrb, SIGNAL_ORB_SPHERE, signalOrbColor, type SignalOrbState } from './SignalOrb';
import { DronaMark } from './DronaMark';

/** WebView box that shows a sphere of `orb` size (the sphere is ~72% of an orb box). */
export const orbWebBox = (orb: number) => Math.round((orb * 0.72) / SIGNAL_ORB_SPHERE);

/** What Drona is doing, breathing slowly while it lasts. */
export function PulsingStatus({
  label,
  color,
  style,
}: {
  label: string;
  color: string;
  style?: StyleProp<TextStyle>;
}) {
  const o = useSharedValue(1);
  useEffect(() => {
    o.value = withRepeat(withSequence(withTiming(0.45, { duration: 900 }), withTiming(1, { duration: 900 })), -1);
  }, [o]);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.Text
      key={label}
      entering={FadeIn.duration(250)}
      style={[style, { color }, st]}
      accessibilityLiveRegion="polite"
    >
      {label}
    </Animated.Text>
  );
}

interface Props {
  state: SignalOrbState;
  /** The status line. Omit for an orb with no words. */
  label?: string;
  /** A quieter second line (what this wait is for). */
  detail?: string;
  /** The orb's visual box. 168 is the chat hero size. */
  size?: number;
  level?: number;
  paused?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function OrbStage({ state, label, detail, size = 168, level = 0.3, paused = false, style }: Props) {
  const { C, mode } = useTheme();
  const web = orbWebBox(size);
  // Fewer, bolder dots as the orb gets small, so it stays readable.
  const particles = size >= 120 ? 2200 : size >= 70 ? 1400 : 650;
  return (
    <View style={[s.wrap, style]}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
        <View style={{ position: 'absolute', left: (size - web) / 2, top: (size - web) / 2 }}>
          <SignalOrb
            size={web}
            state={state}
            level={level}
            particles={particles}
            brightness={size < 70 ? 1.8 : 1}
            color={signalOrbColor(mode)}
            paused={paused}
            placeholder={<DronaMark size={Math.max(10, Math.round(size * 0.22))} color={C.accentText} state="static" />}
          />
        </View>
      </View>
      {!!label && <PulsingStatus label={label} color={C.foreground} style={s.label} />}
      {!!detail && <Text style={[s.detail, { color: C.textMuted }]}>{detail}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { alignItems: 'center' },
  label: { fontSize: 16, fontWeight: FontWeight.medium, marginTop: 10, textAlign: 'center' },
  detail: { fontSize: 13, lineHeight: 19, marginTop: 6, textAlign: 'center', maxWidth: 300 },
});
