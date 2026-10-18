/**
 * CopyMealSheet: copy one meal from the day before into the day on screen.
 *
 * Opened from the clipboard icon in a meal section's header. Lists the day
 * before's lines for that meal, every one ticked; untick what you did not have
 * again, then Copy. Lines already in today's meal start unticked, so copying
 * twice never doubles the food. Each line keeps its own portion and numbers:
 * this is the same food, not a fresh estimate. Portal sheet, no typing.
 */
import { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, TouchableOpacity, ScrollView, StyleSheet, BackHandler, Keyboard } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { formatServing } from '@/lib/foods';
import { copyableFromDay, type HistoryEntry } from '@/lib/foodPatterns';

interface Props {
  open: boolean;
  /** "Yesterday's breakfast" / "Tuesday's breakfast". */
  title: string;
  /** Where it lands: "Copies into today's breakfast". */
  subtitle: string;
  lines: HistoryEntry[];
  /** What the target meal already holds, to start those lines unticked. */
  current: { food_name: string }[];
  busy: boolean;
  onClose: () => void;
  onCopy: (lines: HistoryEntry[]) => void;
}

export function CopyMealSheet({ open, title, subtitle, lines, current, busy, onClose, onCopy }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const fresh = useMemo(() => new Set(copyableFromDay(lines, current)), [lines, current]);
  const [picked, setPicked] = useState<Set<number>>(fresh);

  // Reset the ticks when the sheet opens (or switches meal), and only then.
  // `fresh` also changes on any reload of the day behind the sheet, and
  // resetting on that would silently undo what the user just unticked.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) setPicked(new Set(fresh)); }, [open, title]);
  useEffect(() => { if (open) Keyboard.dismiss(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return <Portal>{null}</Portal>;

  const chosen = lines.filter((_, i) => picked.has(i));
  const kcal = Math.round(chosen.reduce((t, l) => t + l.kcal, 0));
  const protein = Math.round(chosen.reduce((t, l) => t + l.protein_g, 0));
  const toggle = (i: number) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(i)) n.delete(i); else n.add(i);
    return n;
  });

  return (
    <Portal>
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
        <Animated.View
          entering={SlideInDown.duration(320).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(180)}
          style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.md }]}
        >
          <Pressable style={{ flexShrink: 1 }}>
            <View style={[s.handle, { backgroundColor: C.handle }]} />
            <View style={s.header}>
              <View style={{ flex: 1 }}>
                <Text style={[s.title, { color: C.foreground }]}>{title}</Text>
                <Text style={[s.subtitle, { color: C.mutedFg }]}>{subtitle}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityLabel="Close">
                <Feather name="x" size={15} color={C.foreground} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} showsVerticalScrollIndicator={false}>
              {lines.map((l, i) => {
                const on = picked.has(i);
                const already = !fresh.has(i);
                return (
                  <Pressable
                    key={`${i}:${l.food_name}`}
                    onPress={() => toggle(i)}
                    style={[s.row, { borderColor: C.borderSubtle }]}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`${l.food_name}, ${formatServing(l.quantity, l.serving_unit)}, ${Math.round(l.kcal)} calories${already ? ', already in this meal' : ''}`}
                  >
                    <View style={[s.check, on
                      ? { backgroundColor: Colors.primary, borderColor: Colors.primary }
                      : { borderColor: C.border }]}
                    >
                      {on && <Feather name="check" size={11} color={Colors.primaryFg} />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.name, { color: on ? C.foreground : C.textMuted }]} numberOfLines={1}>
                        {l.food_name} <Text style={[s.serving, { color: C.textMuted }]}>· {formatServing(l.quantity, l.serving_unit)}</Text>
                      </Text>
                      <Text style={[s.meta, { color: C.textMuted }]}>
                        {`${Math.round(l.kcal)} cal · ${Math.round(l.protein_g)}g P`}
                        {already ? '  ·  already in' : ''}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>

            <Pressable
              onPress={() => onCopy(chosen)}
              disabled={busy || chosen.length === 0}
              style={[s.copyBtn, { backgroundColor: Colors.primary, opacity: busy || chosen.length === 0 ? 0.45 : 1 }]}
              accessibilityRole="button"
            >
              <Feather name="copy" size={15} color={Colors.primaryFg} />
              <Text style={s.copyTxt}>
                {chosen.length === 0
                  ? 'Pick what you had'
                  : busy ? 'Copying...' : `Copy ${chosen.length} · ${kcal} kcal · ${protein}g P`}
              </Text>
            </Pressable>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, maxHeight: '82%' },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  check: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: FontSize.base, fontWeight: FontWeight.medium },
  serving: { fontSize: FontSize.sm, fontWeight: FontWeight.regular },
  meta: { fontSize: FontSize.xs, marginTop: 2, fontVariant: ['tabular-nums'] },
  copyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: Radius.lg, paddingVertical: 14, marginTop: Spacing.md },
  copyTxt: { fontSize: FontSize.base, color: Colors.primaryFg, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
});
