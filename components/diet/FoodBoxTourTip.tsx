/**
 * One step of the food box tour (lib/foodBoxTour): Drona's short line, pointing
 * down at the thing to tap. Sits in the food bar's own column, so it rides up
 * with the keyboard the same way the box does.
 *
 * Fades with RN's Animated rather than a Reanimated entering animation: a
 * layout animation inside the bar pins its frame and the bar stops lifting
 * with the keyboard (see hooks/useSheetSlide).
 */
import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import { DronaMark } from '@/components/coach/DronaMark';

interface Props {
  title: string;
  body: string;
  /** 'Skip' while there is more to come, 'Got it' on the last line. */
  actionLabel: string;
  onAction: () => void;
  /** Point down at what sits below (the box). Off when the tip sits above a
   *  card it is talking about rather than the box. */
  caret?: boolean;
}

export function FoodBoxTourTip({ title, body, actionLabel, onAction, caret = true }: Props) {
  const { C } = useTheme();
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [title, fade]);
  // accessibilityLiveRegion (below) is Android only. On iOS, VoiceOver hears a
  // new step only when it is announced.
  useEffect(() => {
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(`${title}. ${body}`);
  }, [title, body]);

  return (
    <Animated.View
      style={[styles.wrap, { opacity: fade }]}
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.primaryBorder }]}>
        <View style={styles.head}>
          <DronaMark size={12} state="static" />
          <Text style={[styles.title, { color: C.foreground }]} accessibilityRole="header">{title}</Text>
          <Pressable
            onPress={onAction}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={actionLabel === 'Skip' ? 'Skip the food box tour' : actionLabel}
          >
            <Text style={[styles.action, { color: C.textMuted }]}>{actionLabel}</Text>
          </Pressable>
        </View>
        <Text style={[styles.body, { color: C.textSecondary }]}>{body}</Text>
      </View>
      {caret && (
        <View
          style={[styles.caret, { backgroundColor: C.card, borderColor: C.primaryBorder }]}
          importantForAccessibility="no"
        />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: Spacing.sm },
  card: {
    borderWidth: 1, borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, gap: 4,
    ...Shadow.card,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  action: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  body: { fontSize: FontSize.md, lineHeight: 18 },
  // A rotated square tucked under the card, its top half hidden behind it.
  caret: {
    position: 'absolute', bottom: -5, left: Spacing.xxl,
    width: 10, height: 10, borderRightWidth: 1, borderBottomWidth: 1,
    transform: [{ rotate: '45deg' }],
  },
});
