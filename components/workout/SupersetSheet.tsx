/**
 * Ad-hoc superset sheet. The "Superset" chip under the exercise header in the
 * active workout opens this: pick any other exercise(s) to pair with the open
 * one (they move next to it; rest fires after the round), or break the group
 * it's already in. One entry point for create / extend / break.
 *
 * Portal pattern (matches SetTypeSheet / ExercisePickerSheet) so it renders
 * flush to the bottom on Android edge-to-edge.
 */
import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, TouchableOpacity, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';

export interface SupersetOption {
  /** Index into the live exercises array. */
  idx: number;
  name: string;
  muscleGroup?: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** The open exercise the picks pair with. */
  exerciseName: string;
  /** Names of the current group's members (2+ when grouped, [] when solo). */
  members: string[];
  /** Exercises that can join (not finished, not already in the group). */
  options: SupersetOption[];
  /** Called with the picked indices (1+). The sheet closes itself. */
  onConfirm: (picked: number[]) => void;
  /** Present when grouped: dissolve the whole superset. */
  onBreak?: () => void;
}

export function SupersetSheet({ visible, onClose, exerciseName, members, options, onConfirm, onBreak }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const [picked, setPicked] = useState<number[]>([]);
  const grouped = members.length >= 2;

  // Fresh picks every open — a stale selection must not survive a reopen.
  useEffect(() => { if (visible) setPicked([]); }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [visible, onClose]);

  const toggle = (idx: number) => {
    haptics.selection();
    setPicked((prev) => (prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]));
  };

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
                  <Text style={[s.title, { color: C.foreground }]}>Superset</Text>
                  <Text style={[s.subtitle, { color: C.mutedFg }]} numberOfLines={1}>
                    {grouped ? members.join(' + ') : `Pair ${exerciseName} with another lift`}
                  </Text>
                </View>
                <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityRole="button" accessibilityLabel="Close">
                  <Feather name="x" size={15} color={C.foreground} />
                </TouchableOpacity>
              </View>

              <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" canCancelContentTouches={false}>
                {options.length > 0 ? (
                  <>
                    <Text style={[s.sectionLabel, { color: C.textMuted }]}>
                      {grouped ? 'Add to the superset' : `Superset ${exerciseName} with`}
                    </Text>
                    {options.map((o) => {
                      const on = picked.includes(o.idx);
                      return (
                        <TouchableOpacity
                          key={o.idx}
                          style={[s.row, { borderColor: C.borderSubtle }]}
                          activeOpacity={0.7}
                          onPress={() => toggle(o.idx)}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: on }}
                        >
                          <View style={[s.checkWrap, on
                            ? { backgroundColor: Colors.primary, borderColor: Colors.primary }
                            : { borderColor: C.border }]}
                          >
                            {on && <Feather name="check" size={13} color={Colors.primaryFg} />}
                          </View>
                          <Text style={[s.rowTitle, { color: C.foreground, flex: 1 }]} numberOfLines={1}>{o.name}</Text>
                          {o.muscleGroup ? (
                            <Text style={[s.rowMuscle, { color: C.textMuted }]}>{o.muscleGroup}</Text>
                          ) : null}
                        </TouchableOpacity>
                      );
                    })}
                    <Text style={[s.hint, { color: C.textMuted }]}>
                      They move next to {exerciseName}. You alternate sets and rest after each round.
                    </Text>
                    <TouchableOpacity
                      disabled={picked.length === 0}
                      onPress={() => { haptics.success(); onConfirm(picked); onClose(); }}
                      style={[s.cta, { backgroundColor: picked.length > 0 ? Colors.primary : colorWithAlpha(Colors.primary, 0.35) }]}
                      accessibilityRole="button"
                      accessibilityLabel={grouped ? 'Add to superset' : 'Create superset'}
                    >
                      <Text style={s.ctaText}>{grouped ? 'Add to superset' : 'Create superset'}</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <Text style={[s.hint, { color: C.textMuted }]}>
                    Every other exercise is finished or already in this superset.
                  </Text>
                )}

                {grouped && onBreak && (
                  <TouchableOpacity
                    style={[s.row, s.breakRow, { borderColor: C.borderSubtle }]}
                    activeOpacity={0.7}
                    onPress={() => { haptics.warning(); onBreak(); onClose(); }}
                    accessibilityRole="button"
                    accessibilityLabel="Break superset"
                  >
                    <View style={[s.checkWrap, { backgroundColor: Colors.dangerBg, borderColor: 'transparent' }]}>
                      <Feather name="x" size={13} color={Colors.danger} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.rowTitle, { color: Colors.danger }]}>Break superset</Text>
                      <Text style={[s.rowSub, { color: C.textMuted }]}>Every member goes back to training solo.</Text>
                    </View>
                  </TouchableOpacity>
                )}
              </ScrollView>
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
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, textTransform: 'uppercase', letterSpacing: 1, marginBottom: Spacing.xs, marginTop: Spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  checkWrap: { width: 24, height: 24, borderRadius: Radius.sm, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  rowSub: { fontSize: FontSize.sm, marginTop: 1 },
  rowMuscle: { fontSize: FontSize.xs },
  hint: { fontSize: FontSize.sm, marginTop: Spacing.sm, marginBottom: Spacing.md, lineHeight: 18 },
  cta: { borderRadius: Radius.xl, paddingVertical: 14, alignItems: 'center' },
  ctaText: { fontSize: FontSize.base, fontWeight: FontWeight.black, color: Colors.primaryFg },
  breakRow: { marginTop: Spacing.md },
});
