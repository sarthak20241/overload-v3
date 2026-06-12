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

import React, { useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  BackHandler,
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Portal } from './Portal';
import { useTheme } from '@/hooks/useTheme';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

export interface AlertButton {
  text: string;
  /** 'default' = muted bg, 'destructive' = red bg, 'primary' = accent bg */
  style?: 'default' | 'destructive' | 'primary';
  onPress?: () => void;
  /** Render dimmed and ignore presses — e.g. while a precondition loads. */
  disabled?: boolean;
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
  const insets = useSafeAreaInsets();
  // Three or more buttons don't fit side-by-side (labels wrap/truncate), so
  // stack them full-width. Two-button alerts keep the original row layout.
  const stacked = buttons.length >= 3;

  // Without RN's <Modal> we lose onRequestClose, so wire the Android hardware
  // back button to dismiss the alert while it's open.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  return (
    // Rendered via a root <Portal> (the app's own window) rather than RN's
    // <Modal>. On Android edge-to-edge a <Modal> is a separate Dialog window
    // inset by the nav bar, so a bottom sheet floats above it with a gap; the
    // portal keeps it flush to the bottom on both platforms (and in Expo Go).
    <Portal>
      {visible && (
        /* Backdrop — full-screen dim; tap to dismiss */
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
              // Sheet is now flush with the absolute bottom of the screen, so
              // pad past the home indicator / gesture bar.
              paddingBottom: insets.bottom + 24,
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
          <View style={[styles.buttonsRow, stacked && styles.buttonsColumn]}>
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
                  disabled={btn.disabled}
                  onPress={() => {
                    btn.onPress?.();
                    if (!btn.onPress) onClose();
                  }}
                  style={[
                    styles.button,
                    stacked && styles.buttonStacked,
                    { backgroundColor: bgColor, opacity: btn.disabled ? 0.4 : 1 },
                  ]}
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
      )}
    </Portal>
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
  // 3+ buttons stack vertically (see `stacked` in the component).
  buttonsColumn: {
    flexDirection: 'column',
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    alignItems: 'center',
  },
  // In the stacked layout each button is full-width and content-height
  // (flex:1 in an auto-height column would collapse to zero height).
  buttonStacked: {
    flex: 0,
    alignSelf: 'stretch',
  },
  buttonText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
});
