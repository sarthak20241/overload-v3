/**
 * RPE / RIR picker (Phase B). Tapping the intensity cell in the logger opens
 * this — a compact grid of values instead of an inline stepper, so the dense
 * multi-axis set row never gets crowded.
 *
 * Values are always stored as raw RPE (1-10, 0.5 grid). When the user's scale is
 * RIR the chips are labeled 10-rpe, but ordered easiest→hardest (left→right) the
 * same way regardless of scale.
 */
import { useEffect } from 'react';
import { View, Text, Pressable, TouchableOpacity, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';

// Practical hypertrophy/strength range, RPE 6 -> 10 in 0.5 steps (easiest first).
const RPE_VALUES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

interface Props {
  visible: boolean;
  scale: 'rpe' | 'rir';
  value: number | null;
  onSelect: (rpe: number | null) => void;
  onClose: () => void;
}

export function RpePickerSheet({ visible, scale, value, onSelect, onClose }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [visible, onClose]);

  const label = scale === 'rir' ? 'RIR' : 'RPE';

  return (
    <Portal>
      {visible && (
        <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
          <Animated.View
            entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.md }]}
          >
            <Pressable style={{ flexShrink: 1 }}>
              <View style={[s.handle, { backgroundColor: C.handle }]} />
              <View style={s.header}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.title, { color: C.foreground }]}>{label}</Text>
                  <Text style={[s.subtitle, { color: C.mutedFg }]}>
                    {scale === 'rir' ? 'Reps you had left in the tank' : 'How hard was that set, out of 10'}
                  </Text>
                </View>
                <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityRole="button" accessibilityLabel="Close">
                  <Feather name="x" size={15} color={C.foreground} />
                </TouchableOpacity>
              </View>

              <View style={s.grid}>
                {RPE_VALUES.map((rpe) => {
                  const active = value === rpe;
                  const shown = scale === 'rir' ? 10 - rpe : rpe;
                  return (
                    <TouchableOpacity
                      key={rpe}
                      onPress={() => { haptics.selection(); onSelect(rpe); onClose(); }}
                      activeOpacity={0.8}
                      style={[s.chip, { borderColor: active ? Colors.primary : C.border, backgroundColor: active ? Colors.primary : C.muted }]}
                    >
                      <Text style={[s.chipText, { color: active ? Colors.primaryFg : C.foreground }]}>{shown}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {value != null && (
                <TouchableOpacity onPress={() => { haptics.selection(); onSelect(null); onClose(); }} style={s.clearRow} activeOpacity={0.7}>
                  <Feather name="x-circle" size={15} color={C.textMuted} />
                  <Text style={[s.clearText, { color: C.textMuted }]}>Clear</Text>
                </TouchableOpacity>
              )}
            </Pressable>
          </Animated.View>
        </Pressable>
      )}
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, maxHeight: '90%' },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  chip: { width: 56, height: 48, borderRadius: Radius.lg, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chipText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  clearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: Spacing.md, marginTop: Spacing.sm },
  clearText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
});
