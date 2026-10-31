/**
 * MealWaitSheet: the calm wait after a meal goes to Drona.
 *
 * Drawn as a Drona card (components/coach/DronaCardPopup.tsx): the same
 * centred card, corners, kicker, title and body sizes, and the same quiet
 * answer under it. Inside, Drona's moving orb (OrbLoader, the orb #309 put
 * in place of every spinner), one line saying what he is doing, the user's
 * own words, and the foods he has named so far.
 *
 * There is no "process in background" button because there is nothing to
 * choose: the parse always runs on its own. Closing the card (the X, the
 * backdrop, Android back, "Close") only stops watching. When the meal lands
 * the screen opens the result if the card is still up, or tells the user
 * with a toast if it is not (lib/mealReady arrivalAction).
 *
 * Root Portal, never RN <Modal>: Android edge-to-edge insets a Modal's window
 * (components/ui/Portal.tsx).
 */
import { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, BackHandler } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { OrbLoader } from '@/components/ui/OrbLoader';
import { PulsingStatus } from '@/components/coach/OrbStage';
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

/** The orb at the heart of the card. Big enough to be the moment, small
 *  enough that the words under it stay the point. */
const ORB = 96;

export function MealWaitSheet({ open, words, statusLabel, rows, autoLogging, onClose, onCancel }: Props) {
  const { C } = useTheme();

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
  // working the food out is its working shape. Same rule as the inline card.
  const orbState = statusLabel && /^(Checking|Looking)/.test(statusLabel) ? 'searching' : 'working';

  return (
    <Portal>
      <Animated.View
        entering={FadeIn.duration(220)}
        exiting={FadeOut.duration(150)}
        style={[s.backdrop, { backgroundColor: C.overlay }]}
        accessibilityViewIsModal
        importantForAccessibility="yes"
      >
        {/* A sibling of the card, not its parent, so a screen reader reaches
            the card's own controls. Tapping outside only stops watching. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Animated.View
          entering={ZoomIn.duration(240)}
          style={[s.card, { backgroundColor: C.elevated, borderColor: C.borderSubtle }]}
        >
          {/* Who is talking */}
          <View style={s.head}>
            <Text style={[s.kicker, { color: C.textMuted }]}>{autoLogging ? 'DRONA IS LOGGING' : 'DRONA IS READING'}</Text>
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

          <View style={s.orb} pointerEvents="none">
            <OrbLoader size={ORB} color={C.accentText} state={orbState} accessibilityLabel="Drona is working" />
          </View>

          {/* What, and the words it is about */}
          <PulsingStatus label={line} color={C.foreground} style={s.title} />
          {!!words && (
            <Text style={[s.body, { color: C.textSecondary }]} numberOfLines={3}>{words}</Text>
          )}

          {/* The foods named so far, in the card's calm strip */}
          {named && (
            <View style={[s.rows, { backgroundColor: C.muted }]}>
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

          {/* The quiet answers, the card's "Later" */}
          <View style={s.quietRow}>
            {!autoLogging && (
              <Pressable onPress={onCancel} style={s.quiet} hitSlop={8} accessibilityRole="button" accessibilityLabel="Cancel this meal">
                <Text style={[s.quietText, { color: C.mutedFg }]}>Cancel</Text>
              </Pressable>
            )}
            <Pressable onPress={onClose} style={s.quiet} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close. Drona keeps working.">
              <Text style={[s.quietText, { color: C.foreground }]}>Close</Text>
            </Pressable>
          </View>
        </Animated.View>
      </Animated.View>
    </Portal>
  );
}

// Sizes and spacing follow DronaCardPopup, so the two read as one family.
const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xxl,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: Radius.xxl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.xxl,
    paddingTop: Spacing.xxl,
    paddingBottom: Spacing.lg,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm + 2, marginBottom: Spacing.lg },
  kicker: { flex: 1, fontSize: FontSize.xs, fontWeight: FontWeight.bold, letterSpacing: 1.4 },
  close: { padding: 2 },
  orb: { alignItems: 'center', justifyContent: 'center', height: ORB + Spacing.lg, marginBottom: Spacing.md },
  title: { fontSize: FontSize.xl, lineHeight: 24, fontWeight: FontWeight.bold, marginBottom: Spacing.sm },
  body: { fontSize: FontSize.base, lineHeight: 21 },
  rows: { borderRadius: Radius.lg, paddingHorizontal: Spacing.md, marginTop: Spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: 10 },
  rowName: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.medium },
  rowServing: { fontSize: FontSize.sm, fontWeight: FontWeight.regular },
  rowKcal: { fontSize: FontSize.sm, fontVariant: ['tabular-nums'] },
  hint: { fontSize: FontSize.xs, lineHeight: 16, marginTop: Spacing.xl },
  quietRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.sm },
  quiet: { paddingVertical: Spacing.md + 2, paddingHorizontal: Spacing.lg },
  quietText: { fontSize: FontSize.md, fontWeight: FontWeight.medium },
});
