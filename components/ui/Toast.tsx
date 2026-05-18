/**
 * Top-of-screen, non-blocking notification banner with auto-dismiss.
 * Three variants: info (spinner, persists), success (auto-dismiss 2s), error (5s + optional Retry).
 *
 * Usage:
 *   const toast = useToast();
 *   toast.info('Saving Push Day…');
 *   toast.success('Saved');
 *   toast.error("Couldn't save", { action: { label: 'Retry', onPress: retry } });
 */

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { SlideInDown, SlideOutUp, Easing } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

export type ToastType = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface ToastConfig {
  type?: ToastType;
  text: string;
  action?: ToastAction;
  /** 0 = persist until replaced or hidden manually. Defaults: info=0, success=2000, error=5000. */
  durationMs?: number;
}

interface ToastContextValue {
  show: (config: ToastConfig) => void;
  hide: () => void;
  info: (text: string, opts?: Omit<ToastConfig, 'type' | 'text'>) => void;
  success: (text: string, opts?: Omit<ToastConfig, 'type' | 'text'>) => void;
  error: (text: string, opts?: Omit<ToastConfig, 'type' | 'text'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<ToastConfig | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const hide = useCallback(() => {
    clearTimer();
    setConfig(null);
  }, []);

  const show = useCallback((c: ToastConfig) => {
    clearTimer();
    setConfig(c);
    const defaultDuration = c.type === 'error' ? 5000 : c.type === 'success' ? 2000 : 0;
    const duration = c.durationMs ?? defaultDuration;
    if (duration > 0) {
      timerRef.current = setTimeout(() => {
        setConfig(null);
        timerRef.current = null;
      }, duration);
    }
  }, []);

  const info = useCallback((text: string, opts?: Omit<ToastConfig, 'type' | 'text'>) => show({ ...opts, type: 'info', text }), [show]);
  const success = useCallback((text: string, opts?: Omit<ToastConfig, 'type' | 'text'>) => show({ ...opts, type: 'success', text }), [show]);
  const error = useCallback((text: string, opts?: Omit<ToastConfig, 'type' | 'text'>) => show({ ...opts, type: 'error', text }), [show]);

  useEffect(() => () => clearTimer(), []);

  return (
    <ToastContext.Provider value={{ show, hide, info, success, error }}>
      {children}
      {config && <ToastView config={config} onDismiss={hide} />}
    </ToastContext.Provider>
  );
}

function ToastView({ config, onDismiss }: { config: ToastConfig; onDismiss: () => void }) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const type = config.type ?? 'info';

  const accent =
    type === 'success' ? Colors.primary :
    type === 'error' ? '#ef4444' :
    C.foreground;
  const iconName: React.ComponentProps<typeof Feather>['name'] | null =
    type === 'success' ? 'check-circle' :
    type === 'error' ? 'alert-circle' :
    null;

  return (
    <Animated.View
      entering={SlideInDown.duration(220).easing(Easing.out(Easing.cubic))}
      exiting={SlideOutUp.duration(180)}
      style={[
        styles.container,
        {
          top: insets.top + 8,
          backgroundColor: C.elevated,
          borderColor: C.borderSubtle,
        },
      ]}
    >
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onDismiss}
        style={styles.row}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      >
        <View style={styles.iconWrap}>
          {type === 'info' ? (
            <ActivityIndicator size="small" color={accent} />
          ) : iconName ? (
            <Feather name={iconName} size={18} color={accent} />
          ) : null}
        </View>
        <Text style={[styles.text, { color: C.foreground }]} numberOfLines={2}>{config.text}</Text>
        {config.action && (
          <TouchableOpacity
            onPress={() => { config.action!.onPress(); onDismiss(); }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={[styles.actionBtn, { backgroundColor: accent }]}
          >
            <Text style={[styles.actionText, { color: type === 'error' ? '#fff' : Colors.primaryFg }]}>
              {config.action.label}
            </Text>
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
    zIndex: 9999,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconWrap: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.md,
  },
  actionText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
});
