/**
 * Set Type bottom sheet (Phase B). Tapping the SET-number cell in the active
 * workout opens this. Picking a type swaps the number for a colored letter
 * badge; "Normal" restores the number. "Remove set" lives here too.
 *
 * Portal pattern (matches WorkoutSettingsSheet / ExercisePickerSheet) so it
 * renders flush to the bottom on Android edge-to-edge.
 */
import { useEffect } from 'react';
import { View, Text, Pressable, ScrollView, TouchableOpacity, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import type { SetType } from '@/lib/types';
import { SET_TYPE_META, SET_TYPE_ORDER, SetTypeBadge } from '@/components/workout/SetTypeBadge';

interface Props {
  visible: boolean;
  currentType: SetType;
  onSelect: (t: SetType) => void;
  onRemove: () => void;
  onClose: () => void;
  /** Hide the destructive Remove row (e.g. for the not-yet-logged active set). */
  canRemove?: boolean;
}

const COMMON = SET_TYPE_ORDER.filter((t) => SET_TYPE_META[t].tier === 'common');
const MORE = SET_TYPE_ORDER.filter((t) => SET_TYPE_META[t].tier === 'more');

export function SetTypeSheet({ visible, currentType, onSelect, onRemove, onClose, canRemove = true }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [visible, onClose]);

  const Row = ({ t }: { t: SetType }) => {
    const meta = SET_TYPE_META[t];
    const active = t === currentType;
    return (
      <TouchableOpacity
        style={[s.row, { borderColor: C.borderSubtle }]}
        activeOpacity={0.7}
        onPress={() => { haptics.selection(); onSelect(t); onClose(); }}
      >
        <View style={[s.badgeWrap, { backgroundColor: C.muted }]}>
          {meta.letter
            ? <SetTypeBadge type={t} size={26} />
            : <Feather name="hash" size={14} color={C.mutedFg} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.rowTitle, { color: C.foreground }]}>{meta.label}</Text>
          <Text style={[s.rowSub, { color: C.textMuted }]}>{meta.explainer}</Text>
        </View>
        {active && <Feather name="check" size={16} color={C.accentText} />}
      </TouchableOpacity>
    );
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
                  <Text style={[s.title, { color: C.foreground }]}>Set type</Text>
                  <Text style={[s.subtitle, { color: C.mutedFg }]}>Tag what this set was</Text>
                </View>
                <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityRole="button" accessibilityLabel="Close">
                  <Feather name="x" size={15} color={C.foreground} />
                </TouchableOpacity>
              </View>

              <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" delaysContentTouches={false}>
                <Text style={[s.sectionLabel, { color: C.textMuted }]}>Common</Text>
                {COMMON.map((t) => <Row key={t} t={t} />)}
                <Text style={[s.sectionLabel, { color: C.textMuted, marginTop: Spacing.md }]}>More</Text>
                {MORE.map((t) => <Row key={t} t={t} />)}

                {canRemove && (
                  <TouchableOpacity
                    style={[s.row, s.removeRow, { borderColor: C.borderSubtle }]}
                    activeOpacity={0.7}
                    onPress={() => { haptics.warning(); onRemove(); onClose(); }}
                  >
                    <View style={[s.badgeWrap, { backgroundColor: Colors.dangerBg }]}>
                      <Feather name="trash-2" size={14} color={Colors.danger} />
                    </View>
                    <Text style={[s.rowTitle, { color: Colors.danger, flex: 1 }]}>Remove set</Text>
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
  removeRow: { marginTop: Spacing.sm },
  badgeWrap: { width: 36, height: 36, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  rowSub: { fontSize: FontSize.sm, marginTop: 1 },
});
