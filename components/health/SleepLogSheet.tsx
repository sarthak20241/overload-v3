/**
 * Manual sleep log (holistic tracking). A ten-second bottom sheet: how long you
 * slept (duration steppers + quick chips) and an optional 1-5 quality tap. It is
 * the phone-only path to a readiness score, so friction is the enemy: quality is
 * skippable and the whole thing is two taps if the prefill is close.
 *
 * Portal-based (never RN <Modal>, per the project's Android edge-to-edge rule),
 * mirroring components/workout/RpePickerSheet.tsx. The parent owns the async save
 * (logSleepForToday) and passes `saving`; this component is pure UI over local
 * duration/quality state, reset each time it opens.
 */
import { useEffect, useState } from 'react';
import { View, Text, Pressable, TouchableOpacity, ActivityIndicator, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import { formatSleepMinutes } from '@/lib/format';

interface Props {
  visible: boolean;
  /** Prefill duration in minutes (from today's / yesterday's log, or a default). */
  initialMinutes: number;
  /** Prefill quality 1-5, or null when none. */
  initialQuality: number | null;
  /** True when today already has a manual log (label reads "Update" not "Save"). */
  editing: boolean;
  /** Parent is mid-save: disable inputs, spin the button. */
  saving: boolean;
  onSave: (minutes: number, quality: number | null) => void;
  onClose: () => void;
}

const MIN_MINUTES = 0;
const MAX_MINUTES = 16 * 60;
const STEP = 15;
const QUICK_HOURS = [6, 7, 8, 9];
const QUALITY_LABELS = ['Rough', 'Poor', 'OK', 'Good', 'Great']; // index 0 -> rating 1

const clampMinutes = (m: number) => Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, m));

export function SleepLogSheet({ visible, initialMinutes, initialQuality, editing, saving, onSave, onClose }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const [minutes, setMinutes] = useState(initialMinutes);
  const [quality, setQuality] = useState<number | null>(initialQuality);

  // Reset local state from the prefill each time the sheet opens (not on every
  // prop change, so a re-render mid-edit doesn't clobber what the user picked).
  useEffect(() => {
    if (visible) {
      setMinutes(clampMinutes(initialMinutes));
      setQuality(initialQuality);
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [visible, onClose]);

  const step = (delta: number) => {
    haptics.tick();
    setMinutes((m) => clampMinutes(m + delta));
  };
  const setHours = (h: number) => {
    haptics.selection();
    setMinutes(h * 60);
  };
  const pickQuality = (rating: number) => {
    haptics.selection();
    setQuality((q) => (q === rating ? null : rating)); // tap the active one to clear
  };

  const accent = Colors.stat.sleep;

  return (
    <Portal>
      {visible && (
        <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={saving ? undefined : onClose}>
          <Animated.View
            entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.md }]}
          >
            <Pressable>
              <View style={[s.handle, { backgroundColor: C.handle }]} />
              <View style={s.header}>
                <Text style={[s.title, { color: C.foreground }]}>{editing ? 'Update sleep' : 'Log sleep'}</Text>
                <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityRole="button" accessibilityLabel="Close">
                  <Feather name="x" size={15} color={C.foreground} />
                </TouchableOpacity>
              </View>

              {/* Duration readout with steppers on either side */}
              <View style={s.durationRow}>
                <TouchableOpacity onPress={() => step(-STEP)} disabled={saving} style={[s.stepBtn, { borderColor: C.border }]} activeOpacity={0.7} accessibilityLabel="15 minutes less">
                  <Feather name="minus" size={20} color={C.foreground} />
                </TouchableOpacity>
                <View style={s.readout}>
                  <Text style={[s.value, { color: C.foreground }]}>{formatSleepMinutes(minutes)}</Text>
                  <Text style={[s.readoutSub, { color: C.textMuted }]}>asleep</Text>
                </View>
                <TouchableOpacity onPress={() => step(STEP)} disabled={saving} style={[s.stepBtn, { borderColor: C.border }]} activeOpacity={0.7} accessibilityLabel="15 minutes more">
                  <Feather name="plus" size={20} color={C.foreground} />
                </TouchableOpacity>
              </View>

              {/* Quick jumps */}
              <View style={s.chipRow}>
                {QUICK_HOURS.map((h) => {
                  const active = minutes === h * 60;
                  return (
                    <TouchableOpacity
                      key={h}
                      onPress={() => setHours(h)}
                      disabled={saving}
                      style={[s.chip, { borderColor: active ? accent : C.border, backgroundColor: active ? colorWithAlpha(accent, 0.14) : 'transparent' }]}
                      activeOpacity={0.7}
                    >
                      <Text style={[s.chipText, { color: active ? accent : C.textSecondary }]}>{h}h</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Optional quality */}
              <Text style={[s.qLabel, { color: C.textMuted }]}>How did it feel? (optional)</Text>
              <View style={s.qRow}>
                {QUALITY_LABELS.map((label, i) => {
                  const rating = i + 1;
                  const active = quality === rating;
                  return (
                    <TouchableOpacity
                      key={rating}
                      onPress={() => pickQuality(rating)}
                      disabled={saving}
                      style={[s.qCell, { borderColor: active ? accent : C.border, backgroundColor: active ? colorWithAlpha(accent, 0.14) : 'transparent' }]}
                      activeOpacity={0.7}
                    >
                      <Text style={[s.qCellText, { color: active ? accent : C.textSecondary, fontWeight: active ? FontWeight.bold : FontWeight.medium }]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <TouchableOpacity
                onPress={() => { haptics.selection(); onSave(minutes, quality); }}
                disabled={saving}
                style={[s.saveBtn, { backgroundColor: Colors.primary }, saving && { opacity: 0.85 }]}
                activeOpacity={0.85}
              >
                {saving ? (
                  <ActivityIndicator color={Colors.primaryFg} />
                ) : (
                  <Text style={s.saveText}>{editing ? 'Update' : 'Save'}</Text>
                )}
              </TouchableOpacity>
            </Pressable>
          </Animated.View>
        </Pressable>
      )}
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  durationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.lg },
  stepBtn: { width: 52, height: 52, borderRadius: 26, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  readout: { alignItems: 'center' },
  value: { fontSize: 40, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'], lineHeight: 44 },
  readoutSub: { fontSize: FontSize.sm, marginTop: 2, textTransform: 'uppercase', letterSpacing: 1 },
  chipRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: Spacing.lg },
  chip: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: Radius.full, borderWidth: 1 },
  chipText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  qLabel: { fontSize: FontSize.sm, marginBottom: Spacing.sm },
  qRow: { flexDirection: 'row', gap: 6, marginBottom: Spacing.xl },
  qCell: { flex: 1, paddingVertical: 12, borderRadius: Radius.md, borderWidth: 1, alignItems: 'center' },
  qCellText: { fontSize: FontSize.xs },
  saveBtn: { height: 52, borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primaryFg },
});
