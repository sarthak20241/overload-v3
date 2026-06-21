import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSequence,
  Easing, SlideInUp, SlideOutDown, FadeIn, FadeOut,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Radius, FontSize, FontWeight, Spacing, Shadow, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useWorkout } from '@/hooks/useWorkout';
import { haptics } from '@/lib/haptics';
import { useEffect } from 'react';

// Paused-state colour now lives in Colors.paused (constants/theme.ts).

function fmt(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  // Roll into hours so long sessions don't overflow as "588:34".
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function NavButton({
  icon, label, active, onPress,
}: { icon: React.ComponentProps<typeof Feather>['name']; label: string; active: boolean; onPress: () => void }) {
  const { C } = useTheme();
  return (
    <TouchableOpacity
      style={styles.navItem}
      onPress={() => { if (!active) haptics.selection(); onPress(); }}
      activeOpacity={0.7}
      accessibilityRole="tab"
      accessibilityLabel={`${label} tab`}
      accessibilityState={{ selected: active }}
    >
      <Feather
        name={icon}
        size={22}
        color={active ? C.accentText : C.textMuted}
      />
      <Text style={[styles.navLabel, { color: active ? C.accentText : C.textMuted }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function PulsingDot({ color }: { color?: string }) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.8, { duration: 800, easing: Easing.out(Easing.ease) }),
        withTiming(1, { duration: 400, easing: Easing.in(Easing.ease) }),
      ),
      -1,
    );
    opacity.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 800, easing: Easing.out(Easing.ease) }),
        withTiming(0.4, { duration: 400, easing: Easing.in(Easing.ease) }),
      ),
      -1,
    );
  }, []);

  const pingStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const dotColor = color || Colors.primary;

  return (
    <View style={styles.pulseDotWrap}>
      <View style={[styles.pulseDot, { backgroundColor: dotColor }]} />
      <Animated.View style={[styles.pulseDotPing, { backgroundColor: dotColor }, pingStyle]} />
    </View>
  );
}

interface BottomNavProps {
  onOpenModal?: () => void;
}

export function BottomNav({ onOpenModal }: BottomNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const workout = useWorkout();
  const { C } = useTheme();

  const isOnWorkout = pathname.includes('/workout/');
  const showMiniBar = workout.isActive && !isOnWorkout;

  const isActive = (route: string) => {
    if (route === '/(app)') return pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index';
    return pathname.includes(route.replace('/(app)/', ''));
  };

  const handleCenterPress = () => {
    if (!workout.isActive) {
      onOpenModal?.();
    } else if (isOnWorkout) {
      workout.togglePause();
    } else {
      router.push(`/workout/${workout.routineId}` as any);
    }
  };

  // Determine play button appearance
  const getCenterButtonStyle = () => {
    if (workout.isActive && workout.isPaused) {
      return {
        backgroundColor: Colors.paused,
        shadowColor: Colors.paused,
      };
    }
    return {
      backgroundColor: Colors.primary,
      shadowColor: Colors.primary,
    };
  };

  const getCenterIcon = (): React.ComponentProps<typeof Feather>['name'] => {
    if (!workout.isActive) return 'play';
    if (isOnWorkout) {
      return workout.isPaused ? 'play' : 'pause';
    }
    return 'play';
  };

  const getCenterIconColor = () => {
    if (workout.isActive && workout.isPaused) {
      return '#1a1a1a';
    }
    return Colors.primaryFg;
  };

  return (
    <>
      {/* Mini workout bar */}
      {showMiniBar && (
        <Animated.View
          entering={SlideInUp.duration(300).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[
            styles.miniBar,
            {
              bottom: 68 + insets.bottom,
              backgroundColor: C.elevated,
              borderColor: workout.isPaused ? Colors.paused : Colors.primary,
              shadowColor: workout.isPaused ? Colors.paused : Colors.primary,
              shadowOffset: { width: 0, height: -2 },
              shadowOpacity: 0.25,
              shadowRadius: 10,
              elevation: 8,
            },
          ]}
        >
          <View style={styles.miniBarInner}>
            {/* Pause/Resume button */}
            <TouchableOpacity
              onPress={() => { haptics.selection(); workout.togglePause(); }}
              style={[
                styles.miniPauseBtn,
                {
                  backgroundColor: workout.isPaused
                    ? colorWithAlpha(Colors.paused, 0.15)
                    : Colors.primary,
                },
              ]}
            >
              <Feather
                name={workout.isPaused ? 'play' : 'pause'}
                size={12}
                color={workout.isPaused ? Colors.paused : Colors.primaryFg}
              />
            </TouchableOpacity>

            {/* Info — tap to navigate */}
            <TouchableOpacity
              onPress={() => router.push(`/workout/${workout.routineId}` as any)}
              style={{ flex: 1, minWidth: 0 }}
              activeOpacity={0.8}
            >
              <Text style={[styles.miniBarName, { color: C.foreground }]} numberOfLines={1}>
                {workout.routineName}
              </Text>
              <View style={styles.miniBarMeta}>
                <Feather
                  name="clock"
                  size={9}
                  color={workout.isPaused ? Colors.paused : C.textMuted}
                />
                <Text style={[
                  styles.miniBarTime,
                  { color: workout.isPaused ? Colors.paused : C.textMuted },
                ]}>
                  {fmt(workout.elapsed)}
                </Text>
                {workout.isPaused && (
                  <Text style={[styles.pausedBadge, { color: Colors.paused }]}>PAUSED</Text>
                )}
                <Text style={[styles.miniBarDot, { color: C.textDim }]}>·</Text>
                <Text style={[styles.miniBarTime, { color: C.textMuted }]}>
                  {workout.exercises.flatMap(e => e.sets.filter(s => s.completed)).length} sets
                </Text>
              </View>
            </TouchableOpacity>

            {/* Return button */}
            <TouchableOpacity
              onPress={() => router.push(`/workout/${workout.routineId}` as any)}
              style={[styles.returnBtn, { backgroundColor: Colors.primary }]}
            >
              <Text style={[styles.returnText, { color: Colors.primaryFg }]}>Return</Text>
              <Feather name="chevron-right" size={12} color={Colors.primaryFg} />
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}

      {/* Bottom navigation */}
      <View
        style={[
          styles.navBar,
          {
            backgroundColor: C.navBg,
            // Make the safe-area inset additive to the bar height instead of
            // eating into the 64px icon row. Without this, iOS devices with a
            // home indicator (insets.bottom ≈ 34) crush the icon area to
            // ~20px, making the nav look noticeably shorter than Android
            // (where insets.bottom ≈ 0 with gesture nav, so the icons get
            // the full 64px).
            height: 64 + insets.bottom,
            paddingBottom: insets.bottom,
            borderTopColor: C.border,
          },
        ]}
      >
        <NavButton icon="home" label="Dashboard" active={isActive('/(app)')} onPress={() => router.navigate('/(app)' as any)} />
        <NavButton icon="grid" label="Routines" active={isActive('/(app)/routines')} onPress={() => router.navigate('/(app)/routines' as any)} />

        {/* Center play button */}
        <View style={styles.centerBtnWrap}>
          <TouchableOpacity
            onPress={handleCenterPress}
            style={[
              styles.playBtn,
              {
                backgroundColor: getCenterButtonStyle().backgroundColor,
                shadowColor: getCenterButtonStyle().shadowColor,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.3,
                shadowRadius: 8,
                elevation: 6,
              },
            ]}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={
              !workout.isActive ? 'Start workout'
              : workout.isPaused ? 'Resume workout'
              : isOnWorkout ? 'Pause workout' : 'Open active workout'
            }
          >
            <Feather name={getCenterIcon()} size={22} color={getCenterIconColor()} />
            {/* A neutral "session in progress" dot (the FAB colour + icon already
                convey running vs paused). White reads as a status indicator on
                both the lime and amber FAB; red looked like an error, and an
                amber dot was invisible on the paused (amber) FAB. */}
            {workout.isActive && !isOnWorkout && (
              <View style={[
                styles.activeDot,
                {
                  borderColor: C.navBg,
                  backgroundColor: '#fff',
                },
              ]} />
            )}
          </TouchableOpacity>
        </View>

        <NavButton icon="clock" label="History" active={isActive('/(app)/history')} onPress={() => router.navigate('/(app)/history' as any)} />
        <NavButton icon="bar-chart-2" label="Analytics" active={isActive('/(app)/analytics')} onPress={() => router.navigate('/(app)/analytics' as any)} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    // height is set inline as `64 + insets.bottom` so the iOS home-indicator
    // safe area is additive to the icon row, not subtractive from it.
    paddingTop: 10,
    borderTopWidth: 1,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 50,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  navLabel: {
    fontSize: 10,
    fontWeight: FontWeight.medium,
    letterSpacing: 0.3,
  },
  centerBtnWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -24,
  },
  playBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
  },
  miniBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    borderRadius: Radius.xxl,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 55,
  },
  miniBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
  },
  miniPauseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  pulseDotWrap: {
    width: 10,
    height: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  pulseDot: { width: 10, height: 10, borderRadius: 5, position: 'absolute' },
  pulseDotPing: { width: 10, height: 10, borderRadius: 5, position: 'absolute' },
  miniBarName: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  miniBarMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  miniBarTime: { fontSize: 10, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  miniBarDot: { fontSize: 10 },
  pausedBadge: { fontSize: 9, fontWeight: FontWeight.semibold, letterSpacing: 1 },
  returnBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.lg,
    flexShrink: 0,
  },
  returnText: { fontSize: 10, fontWeight: FontWeight.bold },
});
