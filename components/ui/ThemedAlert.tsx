/**
 * Themed confirmation / alert dialog that matches the Figma design.
 * Replaces native Alert.alert with a dark/light–aware bottom sheet.
 *
 * Usage:
 *   <ThemedAlert
 *     visible={showCancel}
 *     icon="alert-triangle"
 *     iconColor="#f97316"
 *     title="Cancel Workout?"
 *     message="Your progress won't be saved if you cancel now."
 *     buttons={[
 *       { text: 'Keep Going', onPress: () => setShowCancel(false) },
 *       { text: 'Cancel Workout', style: 'destructive', onPress: handleCancel },
 *     ]}
 *     onClose={() => setShowCancel(false)}
 *   />
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Pressable,
  StyleSheet,
} from 'react-native';
import Animated, {
  SlideInDown,
  SlideOutDown,
  FadeIn,
  FadeOut,
  Easing,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

export interface AlertButton {
  text: string;
  /** 'default' = muted bg, 'destructive' = red bg, 'primary' = accent bg */
  style?: 'default' | 'destructive' | 'primary';
  onPress?: () => void;
}

export interface AlertStat {
  label: string;
  value: string;
}

interface ThemedAlertProps {
  visible: boolean;
  icon?: React.ComponentProps<typeof Feather>['name'];
  iconColor?: string;
  title: string;
  message?: string;
  /** Optional stat cards (e.g. workout summary) */
  stats?: AlertStat[];
  buttons?: AlertButton[];
  onClose: () => void;
}

export function ThemedAlert({
  visible,
  icon,
  iconColor,
  title,
  message,
  stats,
  buttons = [{ text: 'OK', style: 'primary' }],
  onClose,
}: ThemedAlertProps) {
  const { C } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      {/* Backdrop */}
      <Animated.View
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(150)}
        style={[styles.backdrop, { backgroundColor: C.overlay }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        {/* Sheet */}
        <Animated.View
          entering={SlideInDown.duration(300).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[
            styles.sheet,
            {
              backgroundColor: C.elevated,
              borderTopColor: C.borderSubtle,
            },
          ]}
        >
          {/* Header row */}
          <View style={styles.headerRow}>
            {icon && (
              <View
                style={[
                  styles.iconWrap,
                  { backgroundColor: `${iconColor || C.mutedFg}15` },
                ]}
              >
                <Feather
                  name={icon}
                  size={18}
                  color={iconColor || C.mutedFg}
                />
              </View>
            )}
            <Text style={[styles.title, { color: C.foreground }]}>{title}</Text>
          </View>

          {/* Message */}
          {message ? (
            <Text style={[styles.message, { color: C.mutedFg }]}>{message}</Text>
          ) : null}

          {/* Optional stat cards */}
          {stats && stats.length > 0 && (
            <View style={styles.statsRow}>
              {stats.map((s, i) => (
                <View
                  key={i}
                  style={[styles.statCard, { backgroundColor: C.muted }]}
                >
                  <Text style={[styles.statValue, { color: C.foreground }]}>
                    {s.value}
                  </Text>
                  <Text style={[styles.statLabel, { color: C.textMuted }]}>
                    {s.label}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {/* Action buttons */}
          <View style={styles.buttonsRow}>
            {buttons.map((btn, i) => {
              const isDestructive = btn.style === 'destructive';
              const isPrimary = btn.style === 'primary';
              const bgColor = isDestructive
                ? '#ef4444'
                : isPrimary
                  ? Colors.primary
                  : C.muted;
              const textColor = isDestructive
                ? '#fff'
                : isPrimary
                  ? Colors.primaryFg
                  : C.foreground;

              return (
                <TouchableOpacity
                  key={i}
                  onPress={() => {
                    btn.onPress?.();
                    if (!btn.onPress) onClose();
                  }}
                  style={[styles.button, { backgroundColor: bgColor }]}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.buttonText, { color: textColor }]}>
                    {btn.text}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    paddingHorizontal: Spacing.xl,
    paddingTop: 24,
    paddingBottom: 40,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    flex: 1,
  },
  message: {
    fontSize: FontSize.base,
    lineHeight: 22,
    marginBottom: 20,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  statCard: {
    flex: 1,
    padding: 12,
    borderRadius: Radius.xl,
    alignItems: 'center',
  },
  statValue: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.black,
  },
  statLabel: {
    fontSize: 10,
    marginTop: 2,
  },
  buttonsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    alignItems: 'center',
  },
  buttonText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
});
