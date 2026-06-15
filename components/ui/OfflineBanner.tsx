import { useEffect, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSync } from '@/components/SyncProvider';
import { useTheme } from '@/hooks/useTheme';
import { FontSize, FontWeight, Spacing } from '@/constants/theme';

/**
 * Transient status pill shown when a finished workout is saved locally but not
 * yet synced. Driven by the queue state (lib/syncQueue). It auto-hides after a
 * few seconds so it's a notification, not a permanent overlay, and re-appears
 * whenever the pending count changes (a new workout queued, or one synced).
 * Tap to retry now. Mounted in app/(app)/_layout.tsx.
 */
const VISIBLE_MS = 5000;

export function OfflineBanner() {
  const { pendingCount, flushing, flushNow } = useSync();
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (pendingCount <= 0) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = setTimeout(() => setVisible(false), VISIBLE_MS);
    return () => clearTimeout(t);
  }, [pendingCount]);

  if (!visible || pendingCount <= 0) return null;

  // Keep it short so it never truncates inside the pill — the cloud-off icon
  // already conveys the offline-saved state.
  const message = flushing ? 'Syncing…' : 'Saved on your phone';

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={flushing}
      onPress={() => void flushNow()}
      style={[
        styles.banner,
        {
          top: insets.top + 6,
          backgroundColor: C.elevated,
          borderColor: C.border,
        },
      ]}
    >
      <Feather
        name={flushing ? 'refresh-cw' : 'cloud-off'}
        size={12}
        color={C.mutedFg}
      />
      <Text style={[styles.text, { color: C.foreground }]} numberOfLines={1}>
        {message}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: '92%',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    zIndex: 50,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  text: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
});
