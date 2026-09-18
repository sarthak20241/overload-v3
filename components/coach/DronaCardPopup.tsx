import { useCallback, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, BackHandler } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { DronaMark } from '@/components/coach/DronaMark';
import type { SavedDronaCard } from '@/lib/dronaCard';

// The week's card from Drona, as a centred popup over the dashboard.
//
// Every kind is a popup (owner's call, 2026-09-18): the point of a card is to
// bring one thing to the user's notice, and a card in the scroll does not. So
// it interrupts once, asks for one answer, and goes. Three answers, always:
//   the card's own action   (Log a weigh-in / Make it the plan / Got it)
//   the quiet no            (Not now / Keep the plan / Undo on an adjustment)
//   Later                   the card leaves and waits on From Drona
// Tapping outside, or the Android back button, is Later: nobody answered.
//
// Same shape as BuildSplitPrompt on purpose. The two never show together; the
// dashboard holds this one back while that one is up.

interface Props {
  card: SavedDronaCard;
  onAct: () => void;
  onDismiss: () => void;
  onUndo: () => void;
  onLater: () => void;
}

export function DronaCardPopup({ card, onAct, onDismiss, onUndo, onLater }: Props) {
  const { C } = useTheme();
  const isNotice = card.kind === 'notice';
  const undoable = isNotice && card.payload.action === 'undo_swap';
  const primaryLabel = isNotice ? 'Got it' : labelFor(card.payload.action);
  const onPrimary = isNotice ? onDismiss : onAct;
  const second = undoable
    ? { label: 'Undo', press: onUndo }
    : card.kind === 'act'
      ? { label: 'Keep the plan', press: onDismiss }
      : isNotice
        ? null
        : { label: 'Not now', press: onDismiss };

  const later = useCallback(() => onLater(), [onLater]);

  // <Portal> has no onRequestClose, so route the Android hardware back button.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      later();
      return true;
    });
    return () => sub.remove();
  }, [later]);

  return (
    <Portal>
      <Animated.View
        entering={FadeIn.duration(220)}
        exiting={FadeOut.duration(150)}
        style={[s.backdrop, { backgroundColor: C.overlay }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={later} accessibilityLabel="Later" />
        <Animated.View
          entering={ZoomIn.duration(240)}
          style={[s.card, { backgroundColor: C.elevated, borderColor: C.borderSubtle }]}
        >
          <View style={s.head}>
            <View style={[s.mark, { backgroundColor: C.muted }]}>
              <DronaMark size={12} state="static" />
            </View>
            <Text style={[s.kicker, { color: C.textMuted }]}>{kickerFor(card, undoable)}</Text>
          </View>

          <Text style={[s.title, { color: C.foreground }]}>{card.title}</Text>
          <Text style={[s.body, { color: C.mutedFg }]}>{card.body}</Text>

          {card.evidence.length > 0 && (
            <View style={s.chips}>
              {card.evidence.slice(0, 3).map((e) => (
                <View key={e.label} style={[s.chip, { backgroundColor: C.muted, borderColor: C.borderSubtle }]}>
                  <Text style={[s.chipValue, { color: C.foreground }]}>{e.value}</Text>
                  <Text style={[s.chipLabel, { color: C.textDim }]}>{e.label}</Text>
                </View>
              ))}
            </View>
          )}

          <Pressable
            onPress={onPrimary}
            style={({ pressed }) => [s.primary, { backgroundColor: Colors.primary, opacity: pressed ? 0.85 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={primaryLabel}
          >
            <Text style={[s.primaryText, { color: Colors.primaryFg }]}>{primaryLabel}</Text>
            {!isNotice && <Feather name="arrow-right" size={13} color={Colors.primaryFg} />}
          </Pressable>

          <View style={s.row}>
            {second && (
              <Pressable
                onPress={second.press}
                style={[s.secondary, { borderColor: C.borderSubtle }]}
                accessibilityRole="button"
                accessibilityLabel={second.label}
              >
                <Text style={[s.secondaryText, { color: C.foreground }]}>{second.label}</Text>
              </Pressable>
            )}
            <Pressable onPress={later} style={s.later} hitSlop={8} accessibilityRole="button" accessibilityLabel="Later">
              <Text style={[s.laterText, { color: C.mutedFg }]}>Later</Text>
            </Pressable>
          </View>
        </Animated.View>
      </Animated.View>
    </Portal>
  );
}

function labelFor(action?: string): string {
  switch (action) {
    case 'log_weight':
      return 'Log a weigh-in';
    case 'log_food':
      return 'Log food';
    case 'start_session':
      return 'See what is due';
    case 'apply_swap':
      return 'Make it the plan';
    default:
      return 'Open';
  }
}

/** What Drona is doing, in two words, above the title. */
function kickerFor(card: SavedDronaCard, undoable: boolean): string {
  if (undoable) return 'DRONA ADJUSTED';
  if (card.kind === 'act') return 'DRONA SUGGESTS';
  if (card.kind === 'notice') return 'DRONA NOTICED';
  return 'DRONA ASKS';
}

// Narrower than the phone and light on padding: this interrupts a screen the
// user just arrived at, so it asks for a glance, not a page.
const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
  card: {
    width: '100%',
    maxWidth: 320,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  mark: { width: 22, height: 22, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  kicker: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, letterSpacing: 1 },
  title: { fontSize: FontSize.md, fontWeight: FontWeight.bold, marginBottom: 4 },
  body: { fontSize: FontSize.xs, lineHeight: 17, marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs, marginBottom: 12 },
  chip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 5,
    borderRadius: Radius.sm,
    borderWidth: 1,
  },
  chipValue: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  chipLabel: { fontSize: FontSize.xs },
  primary: {
    height: 40,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  primaryText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, marginTop: Spacing.sm },
  secondary: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  secondaryText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  later: { paddingVertical: 9, paddingHorizontal: 14 },
  laterText: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
});
