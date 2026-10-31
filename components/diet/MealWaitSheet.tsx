/**
 * MealWaitSheet: the calm wait after a meal goes to Drona.
 *
 * Drona's orb, one line saying what he is doing, the user's own words under
 * it, and the foods he has named so far. There is no "process in background"
 * button because there is nothing to choose: the parse always runs on its own.
 * Closing the sheet (the backdrop, the X, Android back) only stops watching.
 * When the meal lands the screen opens the result if the sheet is still up,
 * or tells the user with a toast if it is not (lib/mealReady arrivalAction).
 *
 * Root Portal, never RN <Modal>: Android edge-to-edge insets a Modal's window
 * (components/ui/Portal.tsx). No text input, so the plain SlideInDown idiom of
 * the other diet sheets is enough. One live orb: the screen hides the inline
 * card's own orb while this is up.
 */
import { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing, FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { OrbStage } from '@/components/coach/OrbStage';
import { formatServing } from '@/lib/foods';
import type { StreamedItem } from '@/lib/dietData';

interface Props {
  open: boolean;
  /** What the user sent. */
  words: string;
  /** What Drona is doing on a multi-step message ("Checking yesterday's
   *  breakfast"). Replaces the default line while it lasts. */
  statusLabel?: string | null;
  /** Foods named so far (Quick tier streams them before the numbers). */
  rows?: StreamedItem[] | null;
  /** "Just log it" is on: send already committed, so the line says adding. */
  autoLogging?: boolean;
  onClose: () => void;
  /** Stop the parse and throw it away. */
  onCancel: () => void;
}

export function MealWaitSheet({ open, words, statusLabel, rows, autoLogging, onClose, onCancel }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return <Portal>{null}</Portal>;

  const named = rows?.length ? rows : null;
  const line = statusLabel
    ? `${statusLabel}.`
    : autoLogging ? 'Adding it to your diary.'
    : named ? 'Putting numbers on it.' : 'Working out the macros.';
  // Looking things up (the log, saved meals) is the orb's searching shape;
  // working the food out is its thinking shape. Same rule as the inline card.
  const orbState = statusLabel && /^(Checking|Looking)/.test(statusLabel) ? 'searching' : 'thinking';

  return (
    <Portal>
      <View style={s.backdrop}>
        {/* The backdrop is a sibling of the sheet, not its parent, so a
            screen reader reaches the sheet's own controls. */}
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close. Drona keeps working."
        />
        <Animated.View
          entering={SlideInDown.duration(340).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.lg }]}
        >
          <View>
            <View style={s.top}>
              <View style={[s.handle, { backgroundColor: C.handle }]} />
              <Pressable
                onPress={onClose}
                hitSlop={12}
                style={s.close}
                accessibilityRole="button"
                accessibilityLabel="Close"
                accessibilityHint="Drona keeps working and tells you when it is ready"
              >
                <Feather name="x" size={16} color={C.textMuted} />
              </Pressable>
            </View>

            <OrbStage state={orbState} label={line} size={132} level={0.35} style={s.orb} />

            {!!words && (
              <Text style={[s.words, { color: C.textSecondary }]} numberOfLines={3}>
                {words}
              </Text>
            )}

            {named && (
              <View style={[s.rows, { borderColor: C.borderSubtle }]}>
                {named.map((r, i) => (
                  <Animated.View
                    key={`${r.name}-${i}`}
                    entering={FadeIn.duration(220)}
                    style={[s.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.borderSubtle }]}
                  >
                    <Text style={[s.rowName, { color: C.foreground }]} numberOfLines={1}>
                      {r.name}
                      <Text style={[s.rowServing, { color: C.textMuted }]}>{'  '}{formatServing(r.quantity, r.unit)}</Text>
                    </Text>
                    <Text style={[s.rowKcal, { color: C.textMuted }]}>
                      {r.est_kcal != null ? `~${Math.round(r.est_kcal)} kcal` : '··· kcal'}
                    </Text>
                  </Animated.View>
                ))}
              </View>
            )}

            <Text style={[s.hint, { color: C.textMuted }]}>
              {autoLogging ? 'Close this any time. It still goes in.' : 'Close this any time. I will tell you when it is ready.'}
            </Text>
            {!autoLogging && (
              <Pressable
                onPress={onCancel}
                hitSlop={10}
                style={s.cancel}
                accessibilityRole="button"
                accessibilityLabel="Cancel this meal"
              >
                <Text style={[s.cancelTxt, { color: C.textSecondary }]}>Cancel</Text>
              </Pressable>
            )}
          </View>
        </Animated.View>
      </View>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm,
  },
  top: { alignItems: 'center', height: 24, justifyContent: 'flex-start' },
  handle: { width: 36, height: 4, borderRadius: 2, marginTop: 2 },
  close: { position: 'absolute', right: 0, top: 4 },
  orb: { marginTop: Spacing.md },
  words: {
    fontSize: FontSize.sm, lineHeight: 19, textAlign: 'center',
    marginTop: Spacing.sm, paddingHorizontal: Spacing.lg,
  },
  rows: { marginTop: Spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: 10 },
  rowName: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.medium },
  rowServing: { fontSize: FontSize.sm, fontWeight: FontWeight.regular },
  rowKcal: { fontSize: FontSize.sm, fontVariant: ['tabular-nums'] },
  hint: {
    fontSize: FontSize.xs, textAlign: 'center', marginTop: Spacing.xl,
  },
  cancel: { alignSelf: 'center', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg, marginTop: Spacing.xs },
  cancelTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
});
