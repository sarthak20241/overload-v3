import { useCallback, useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, BackHandler, AccessibilityInfo, findNodeHandle } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
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
//   the card's own action   Log a weigh-in / Make it the plan / Got it
//   the quiet no            Skip this week / Keep the plan / Undo
//   Later                   the card leaves and waits on From Drona
// Tapping outside, or the Android back button, is Later: nobody answered.
//
// Laid out to be read top to bottom in one breath, then answered. Every
// spacing step is deliberate (owner's ask, 2026-09-19):
//   who is talking   a small mark and a kicker, then room
//   what             the title, then a short body that explains the why
//   the proof        the numbers in one calm strip, equal columns, no pills
//   the answers      two stacked full-width buttons, same size, clear rank,
//                    and Later as quiet text underneath
// The two never show together with BuildSplitPrompt; the dashboard holds
// this one back while that one is up.

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
  const primary = { label: isNotice ? 'Got it' : primaryLabelFor(card.payload.action), press: isNotice ? onDismiss : onAct };
  const second = undoable
    ? { label: 'Undo', press: onUndo }
    : card.kind === 'act'
      ? { label: 'Keep the plan', press: onDismiss }
      : isNotice
        ? null
        : { label: 'Skip this week', press: onDismiss };
  const evidence = card.evidence.slice(0, 3);

  const later = useCallback(() => onLater(), [onLater]);

  // A screen reader stays on whatever the dashboard control was until told
  // otherwise; accessibilityViewIsModal fences traversal but does not move
  // focus. Put it on the title as the popup lands.
  const titleRef = useRef<Text>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const node = titleRef.current ? findNodeHandle(titleRef.current) : null;
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, 260); // after the zoom-in, so the focus ring lands on a settled view
    return () => clearTimeout(t);
  }, []);

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
        // Keep screen readers inside the popup while it is up: the dashboard
        // is still mounted underneath it in the same window.
        accessibilityViewIsModal
        importantForAccessibility="yes"
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={later}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Animated.View
          entering={ZoomIn.duration(240)}
          style={[s.card, { backgroundColor: C.elevated, borderColor: C.borderSubtle }]}
        >
          {/* Who is talking */}
          <View style={s.head}>
            <View style={[s.mark, { backgroundColor: C.muted }]}>
              <DronaMark size={16} state="static" />
            </View>
            <Text style={[s.kicker, { color: C.textMuted }]}>{kickerFor(card, undoable)}</Text>
          </View>

          {/* What, and why */}
          <Text ref={titleRef} accessibilityRole="header" style={[s.title, { color: C.foreground }]}>{card.title}</Text>
          <Text style={[s.body, { color: C.textSecondary }]}>{card.body}</Text>

          {/* The proof: equal columns, hairline between them */}
          {evidence.length > 0 && (
            <View style={[s.facts, { backgroundColor: C.muted }]}>
              {evidence.map((e, i) => (
                <View key={e.label} style={s.factWrap}>
                  {i > 0 && <View style={[s.factDivider, { backgroundColor: C.borderSubtle }]} />}
                  <View style={s.fact}>
                    <Text style={[s.factValue, { color: C.foreground }]}>{e.value}</Text>
                    <Text style={[s.factLabel, { color: C.textMuted }]} numberOfLines={2}>{e.label}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* The answers */}
          <Pressable
            onPress={primary.press}
            style={({ pressed }) => [s.primary, { backgroundColor: Colors.primary, opacity: pressed ? 0.85 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={primary.label}
          >
            <Text style={[s.primaryText, { color: Colors.primaryFg }]}>{primary.label}</Text>
          </Pressable>

          {second && (
            <Pressable
              onPress={second.press}
              style={({ pressed }) => [s.secondary, { borderColor: C.border, opacity: pressed ? 0.7 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel={second.label}
            >
              <Text style={[s.secondaryText, { color: C.foreground }]}>{second.label}</Text>
            </Pressable>
          )}

          <Pressable onPress={later} style={s.later} hitSlop={8} accessibilityRole="button" accessibilityLabel="Later">
            <Text style={[s.laterText, { color: C.mutedFg }]}>Later</Text>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Portal>
  );
}

function primaryLabelFor(action?: string): string {
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

const BUTTON_HEIGHT = 50;

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xxl,
  },
  // Wider than a prompt, narrower than the screen: a sheet of paper held up,
  // not a wall. Generous padding so nothing touches an edge.
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: Radius.xxl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.xxl,
    paddingTop: Spacing.xxl,
    paddingBottom: Spacing.lg,
  },

  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm + 2, marginBottom: Spacing.xl },
  mark: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  kicker: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, letterSpacing: 1.4 },

  title: { fontSize: FontSize.xl, lineHeight: 24, fontWeight: FontWeight.bold, marginBottom: Spacing.sm },
  body: { fontSize: FontSize.base, lineHeight: 21, marginBottom: Spacing.xl },

  facts: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md + 2,
    marginBottom: Spacing.xxl,
  },
  factWrap: { flex: 1, flexDirection: 'row', alignItems: 'stretch' },
  factDivider: { width: StyleSheet.hairlineWidth, marginVertical: 2 },
  fact: { flex: 1, alignItems: 'center', paddingHorizontal: Spacing.sm },
  factValue: { fontSize: FontSize.xxl, lineHeight: 26, fontWeight: FontWeight.bold },
  factLabel: { fontSize: FontSize.xs, lineHeight: 13, textAlign: 'center', marginTop: 3 },

  // Same height, same width, same corners: rank comes from fill against
  // outline, not from one being smaller.
  primary: {
    height: BUTTON_HEIGHT,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  secondary: {
    height: BUTTON_HEIGHT,
    borderRadius: Radius.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.sm + 2,
  },
  secondaryText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  // Quiet on purpose: the answer for when the user is not ready to answer.
  later: { alignSelf: 'center', paddingVertical: Spacing.md + 2, paddingHorizontal: Spacing.xl, marginTop: Spacing.xs },
  laterText: { fontSize: FontSize.md, fontWeight: FontWeight.medium },
});
