/**
 * The dashboard's floating log-food button (rules in lib/homeLogHint.ts):
 * bottom right, above the tab bar and clear of its centre play button. A tap
 * opens Drona's food box on Nutrition with the keyboard up.
 *
 * Beside it, the first few times, a small pill says what it is for. The facts
 * are read here, cheaply: a per-user tap count on the device and, until the
 * user is known to have logged food or the pill is done, one row from
 * meal_entries (RLS-scoped, limit 1). Today's food comes from the caller,
 * which already holds it for the calorie ring. Re-read on every focus, so a
 * meal logged on Nutrition hides the pill when the user comes back.
 *
 * Text only today. Voice and camera join HomeLogMode, and the button grows a
 * small menu once there is more than one mode.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import { PressableScale } from '@/components/ui/PressableScale';
import { Colors, FontSize, FontWeight, Radius, Spacing, Shadow } from '@/constants/theme';
import { HOME_LOG_HINT_MAX_TAPS, homeLogHint, homeLogTapsKey, parseTaps, type HomeLogMode } from '@/lib/homeLogHint';
import type { SupabaseClient } from '@supabase/supabase-js';

// components/ui/BottomNav.tsx draws the bar at 64 + the bottom inset.
const TAB_BAR_HEIGHT = 64;
const SIZE = 52;

interface Props {
  supabase: SupabaseClient;
  userId: string;
  /** Today's food has been read (true once the day's totals are in). */
  todayReady: boolean;
  /** Any food on today's diary. */
  loggedToday: boolean;
  /** Something else owns the screen (a popup, the coach, a live workout). */
  hidden: boolean;
  onLog: (mode: HomeLogMode) => void;
}

export function HomeLogButton({ supabase, userId, todayReady, loggedToday, hidden, onLog }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const [facts, setFacts] = useState<{ everLogged: boolean; taps: number } | null>(null);
  const [tick, setTick] = useState(0);
  useFocusEffect(useCallback(() => { setTick((t) => t + 1); }, []));
  // The user this phone has seen log food. Once true it stays true, so the
  // meal_entries read is not repeated on every focus.
  const everLoggedFor = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const taps = parseTaps(await AsyncStorage.getItem(homeLogTapsKey(userId)).catch(() => null));
      if (!alive) return;
      const known = everLoggedFor.current === userId;
      // Nothing left to learn: the words are settled, or the pill is done.
      if (known || taps >= HOME_LOG_HINT_MAX_TAPS) {
        setFacts({ everLogged: known, taps });
        return;
      }
      const any = await supabase.from('meal_entries').select('id').limit(1);
      // A failed read leaves the pill off rather than guessing its words.
      if (!alive || any.error) return;
      const everLogged = (any.data?.length ?? 0) > 0;
      if (everLogged) everLoggedFor.current = userId;
      setFacts({ everLogged, taps });
    })().catch(() => {});
    return () => { alive = false; };
  }, [supabase, userId, tick]);

  const hint = homeLogHint({
    ready: facts != null && todayReady,
    everLogged: (facts?.everLogged ?? false) || loggedToday,
    loggedToday,
    taps: facts?.taps ?? 0,
  });

  if (hidden) return null;

  const press = () => {
    const taps = (facts?.taps ?? 0) + 1;
    track('home_log_food_tapped', { mode: 'text', hint, taps });
    setFacts((f) => (f ? { ...f, taps } : f));
    // Count from the stored value, not only what is on screen: a tap before
    // the focus read settles must not write 1 over a stored 2.
    const key = homeLogTapsKey(userId);
    AsyncStorage.getItem(key)
      .then((raw) => AsyncStorage.setItem(key, String(Math.max(parseTaps(raw) + 1, taps))))
      .catch(() => {});
    onLog('text');
  };

  return (
    <View
      pointerEvents="box-none"
      style={[s.wrap, { bottom: TAB_BAR_HEIGHT + insets.bottom + Spacing.lg }]}
    >
      {hint ? (
        <Animated.View entering={FadeIn.duration(400).delay(300)} exiting={FadeOut.duration(200)}>
          <Pressable
            onPress={press}
            style={[s.pill, { backgroundColor: C.elevated, borderColor: C.primaryBorder }]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text style={[s.pillText, { color: C.foreground }]}>{hint}</Text>
            <Feather name="chevron-right" size={12} color={C.accentText} />
          </Pressable>
        </Animated.View>
      ) : null}
      <PressableScale
        onPress={press}
        scaleTo={0.92}
        style={[s.btn, Shadow.playBtn]}
        accessibilityRole="button"
        accessibilityLabel="Log food with Drona"
        accessibilityHint="Opens the food box. Type what you ate."
      >
        <Feather name="plus" size={22} color={Colors.primaryFg} />
      </PressableScale>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: Spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 34,
    paddingLeft: 14,
    paddingRight: 10,
    borderRadius: Radius.full,
    borderWidth: 1,
    // A soft, fixed lime glow: the pill is noticed without moving.
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 4,
  },
  pillText: { fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  btn: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
