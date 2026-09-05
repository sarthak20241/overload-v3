/**
 * ParseSpeedSheet — how should Drona log what you type?
 *
 * Two tiers, set once and sticky (lib/parseSpeed): Quick is the default
 * estimate-first fast parse, Thorough is the full catalog pipeline. Below them,
 * one switch: "Just log it" (lib/autoLog), where send commits and the server
 * writes the diary itself. One sheet answers the whole question of how Drona
 * logs, so the composer grows no extra chrome. Portal sheet like the other
 * diet sheets; no keyboard input, so the plain SlideInDown idiom
 * (DayPickerSheet's) is enough and useSheetSlide is not needed. Copy stays in
 * Drona's voice: what he does, never which model ran.
 */
import { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, BackHandler, Switch, Platform } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import type { ParseSpeed } from '@/lib/parseSpeed';

interface Props {
  open: boolean;
  value: ParseSpeed;
  /** "Just log it" is on: send commits, no review card. */
  autoLog: boolean;
  onClose: () => void;
  onPick: (v: ParseSpeed) => void;
  onAutoLogChange: (on: boolean) => void;
}

const OPTIONS: { key: ParseSpeed; icon: 'zap' | 'target'; title: string; sub: string }[] = [
  { key: 'quick', icon: 'zap', title: 'Quick', sub: 'Logs in seconds. Drona estimates from what you typed.' },
  { key: 'thorough', icon: 'target', title: 'Thorough', sub: 'A few seconds slower. Drona double-checks every item against the food catalog.' },
];

export function ParseSpeedSheet({ open, value, autoLog, onClose, onPick, onAutoLogChange }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return <Portal>{null}</Portal>;

  return (
    <Portal>
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
        <Animated.View
          entering={SlideInDown.duration(320).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(180)}
          style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.lg }]}
        >
          <Pressable>
            <View style={[s.handle, { backgroundColor: C.handle }]} />
            <Text style={[s.title, { color: C.foreground }]}>How should Drona log?</Text>

            {OPTIONS.map((o) => {
              const sel = o.key === value;
              return (
                <Pressable
                  key={o.key}
                  onPress={() => { haptics.tick(); onPick(o.key); onClose(); }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: sel }}
                  accessibilityLabel={`${o.title}. ${o.sub}`}
                  style={({ pressed }) => [
                    s.row,
                    { borderColor: sel ? C.accentText : C.border, backgroundColor: pressed ? C.muted : C.card },
                  ]}
                >
                  <View style={[s.rowIcon, { backgroundColor: C.muted }]}>
                    <Feather name={o.icon} size={12} color={sel ? C.accentText : C.textSecondary} />
                  </View>
                  <View style={s.rowBody}>
                    <Text style={[s.rowTitle, { color: C.foreground }]}>{o.title}</Text>
                    <Text style={[s.rowSub, { color: C.textSecondary }]}>{o.sub}</Text>
                  </View>
                  {/* Reserve the slot either way so selecting never shifts the row text. */}
                  <View style={s.check}>
                    {sel && <Feather name="check" size={14} color={C.accentText} />}
                  </View>
                </Pressable>
              );
            })}

            {/* "Just log it": a switch, not a third tier. It changes WHAT send
                does (commit), not how the parse runs, so it sits apart from the
                tiers and the sheet stays open when it flips: the user may want
                to read the sub-copy twice before trusting it. */}
            <View style={[s.toggleRow, { borderTopColor: C.borderSubtle }]}>
              <View style={[s.rowIcon, { backgroundColor: autoLog ? C.primarySubtle : C.muted }]}>
                <Feather name="check-circle" size={12} color={autoLog ? C.accentText : C.textSecondary} />
              </View>
              <View style={s.rowBody}>
                <Text style={[s.rowTitle, { color: C.foreground }]}>Just log it</Text>
                <Text style={[s.rowSub, { color: C.textSecondary }]}>
                  Drona adds it straight to your diary. Close the app if you like. Undo from the diary any time.
                </Text>
              </View>
              <Switch
                value={autoLog}
                onValueChange={(v) => { haptics.selection(); onAutoLogChange(v); }}
                trackColor={{ true: Colors.primary, false: C.border }}
                thumbColor={Platform.OS === 'android' ? (autoLog ? Colors.primaryFg : '#f4f4f5') : undefined}
                ios_backgroundColor={C.border}
                accessibilityLabel="Just log it. Drona adds what you type straight to your diary."
              />
            </View>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: Spacing.lg },
  title: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.tight, marginBottom: Spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, borderWidth: 1, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm },
  rowIcon: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  rowSub: { fontSize: FontSize.sm, marginTop: 2, lineHeight: 17 },
  check: { width: 18, alignItems: 'center' },
  // Same inner rhythm as the tier rows (icon, body, control) but no card
  // border: it is a setting under the choice, not a third choice.
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    marginTop: Spacing.sm, paddingTop: Spacing.lg, paddingHorizontal: Spacing.md, borderTopWidth: 1,
  },
});
