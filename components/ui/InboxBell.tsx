/**
 * The bell in the dashboard's top bar: what Drona left for later.
 *
 * Counts the device's ready items (lib/readyInbox) plus the server cards put
 * off with Later (`cardsWaiting`). Tapping it opens From Drona, where both
 * wait. A card that flies in (bellTarget) makes it bump.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { Colors, FontWeight } from '@/constants/theme';
import { readyInbox } from '@/lib/readyInbox';
import { onBellBump, registerBell } from '@/lib/bellTarget';

const SIZE = 40;

export function InboxBell({ cardsWaiting, onPress }: { cardsWaiting: number; onPress: () => void }) {
  const { C } = useTheme();
  const items = useSyncExternalStore(readyInbox.subscribe, readyInbox.getSnapshot);
  const count = items.length + cardsWaiting;

  const ref = useRef<View>(null);
  const measure = useCallback(() => new Promise<{ x: number; y: number } | null>((resolve) => {
    const node = ref.current;
    if (!node) { resolve(null); return; }
    node.measureInWindow((x, y, w, h) => resolve(w > 0 ? { x: x + w / 2, y: y + h / 2 } : null));
  }), []);
  useEffect(() => registerBell(measure), [measure]);

  const scale = useSharedValue(1);
  useEffect(() => onBellBump(() => {
    scale.value = withSequence(withTiming(1.22, { duration: 120 }), withSpring(1, { damping: 8, stiffness: 220 }));
  }), [scale]);
  const bump = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Pressable
      ref={ref}
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `From Drona, ${count} waiting` : 'From Drona'}
    >
      <Animated.View style={[s.bell, { backgroundColor: C.muted, borderColor: C.borderSubtle }, bump]}>
        <Feather name="bell" size={16} color={C.foreground} />
        {count > 0 && (
          <View style={[s.badge, { borderColor: C.background }]}>
            <Text style={s.badgeText}>{count > 9 ? '9+' : count}</Text>
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  bell: {
    width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  badge: {
    position: 'absolute', top: -3, right: -3,
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.primary,
  },
  badgeText: { fontSize: 10, fontWeight: FontWeight.black, color: Colors.primaryFg },
});
