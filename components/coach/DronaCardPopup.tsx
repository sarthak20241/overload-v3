import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, BackHandler, AccessibilityInfo, findNodeHandle } from 'react-native';
import Animated, {
  Easing, FadeIn, FadeOut, ZoomIn, useAnimatedStyle, useSharedValue, withSequence, withTiming,
} from 'react-native-reanimated';
import { haptics } from '@/lib/haptics';
import { bellPoint, bumpBell } from '@/lib/bellTarget';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { OrbStage } from '@/components/coach/OrbStage';
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
// Later shrinks the card into the dashboard's bell (lib/bellTarget), so the
// user sees where it went. With no bell on screen it just fades, as before.
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
  /** A card the app made, not the server (the phase build): its own words. */
  kicker?: string;
  primaryLabel?: string;
  /** null: no second button. */
  secondary?: { label: string; press: () => void } | null;
}

const FLY_MS = 560;
const MEASURE_TIMEOUT_MS = 250;

export function DronaCardPopup({ card, onAct, onDismiss, onUndo, onLater, kicker, primaryLabel, secondary }: Props) {
  const { C } = useTheme();
  const isNotice = card.kind === 'notice';
  const undoable = isNotice && card.payload.action === 'undo_swap';
  const primary = {
    label: primaryLabel ?? (isNotice ? 'Got it' : primaryLabelFor(card.payload)),
    press: isNotice ? onDismiss : onAct,
  };
  const second = secondary !== undefined
    ? secondary
    : undoable
      ? { label: 'Undo', press: onUndo }
      : card.kind === 'act'
        ? { label: 'Keep the plan', press: onDismiss }
        : isNotice
          ? null
          : { label: 'Skip this week', press: onDismiss };
  const evidence = card.evidence.slice(0, 3);

  // Later: the card shrinks into the bell, the bell bumps, then it is gone.
  const cardRef = useRef<View>(null);
  const leaving = useRef(false);
  // Flying: the card's buttons stop answering, so a tap mid-flight cannot act
  // on a card that is already on its way to Later.
  const [flying, setFlying] = useState(false);
  const landRef = useRef<{ timer: ReturnType<typeof setTimeout>; land: () => void } | null>(null);
  // Unmounted mid-flight (the screen went away): the user still said Later.
  useEffect(() => () => {
    const pending = landRef.current;
    if (pending) { clearTimeout(pending.timer); pending.land(); }
  }, []);
  const dx = useSharedValue(0);
  const dy = useSharedValue(0);
  const shrink = useSharedValue(1);
  const fade = useSharedValue(1);
  const dim = useSharedValue(1);
  const flyStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
    transform: [{ translateX: dx.value }, { translateY: dy.value }, { scale: shrink.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: dim.value }));
  const later = useCallback(async () => {
    if (leaving.current) return;
    leaving.current = true;
    // The buttons stop answering now, not after the measures: a tap in that
    // gap would act on a card that is already on its way to Later.
    setFlying(true);
    // A measure that never calls back (a node detached mid-measure) must not
    // leave Later dead: after a beat it counts as "no bell", a plain Later.
    const orNull = <T,>(p: Promise<T | null>) => Promise.race([
      p,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), MEASURE_TIMEOUT_MS)),
    ]);
    const [to, from] = await Promise.all([
      orNull(bellPoint()),
      orNull(new Promise<{ x: number; y: number } | null>((resolve) => {
        const node = cardRef.current;
        if (!node) { resolve(null); return; }
        node.measureInWindow((x, y, w, h) => resolve(w > 0 ? { x: x + w / 2, y: y + h / 2 } : null));
      })),
    ]);
    if (!to || !from) { setFlying(false); onLater(); return; }
    haptics.tick();
    // Small first, then the trip, so the eye follows a chip into the bell
    // rather than a big card sliding off. Visible until the last stretch.
    const travel = { duration: FLY_MS, easing: Easing.inOut(Easing.cubic) };
    // A bell scrolled out of view: aim for the top of the screen instead.
    dx.value = withTiming(to.x - from.x, travel);
    dy.value = withTiming(Math.max(to.y, 40) - from.y, travel);
    shrink.value = withTiming(0.1, { duration: FLY_MS * 0.6, easing: Easing.out(Easing.cubic) });
    fade.value = withSequence(
      withTiming(1, { duration: FLY_MS * 0.75 }),
      withTiming(0, { duration: FLY_MS * 0.25, easing: Easing.in(Easing.quad) }),
    );
    dim.value = withTiming(0, { duration: FLY_MS * 0.6 });
    const land = () => { landRef.current = null; bumpBell(); onLater(); };
    landRef.current = { timer: setTimeout(land, FLY_MS), land };
  }, [onLater, dx, dy, shrink, fade, dim]);

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
        style={s.backdrop}
        // Keep screen readers inside the popup while it is up: the dashboard
        // is still mounted underneath it in the same window.
        accessibilityViewIsModal
        importantForAccessibility="yes"
      >
        {/* The dim, its own view so the fly can fade it (a layout animation
            owns the outer view's opacity). */}
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }, backdropStyle]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={later}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
        </Animated.View>
        <Animated.View entering={ZoomIn.duration(240)} style={s.cardSlot}>
        <Animated.View
          ref={cardRef}
          pointerEvents={flying ? 'none' : 'auto'}
          style={[s.card, { backgroundColor: C.elevated, borderColor: C.borderSubtle }, flyStyle]}
        >
          {/* Who is talking */}
          <View style={s.head}>
            {/* Drona's orb, resting: the same face as the coach chat. One
                popup at a time, so one live orb. */}
            <View style={s.mark}>
              <OrbStage size={32} state="listening" level={0.15} />
            </View>
            <Text style={[s.kicker, { color: C.textMuted }]}>{kicker ?? kickerFor(card, undoable)}</Text>
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
      </Animated.View>
    </Portal>
  );
}

function primaryLabelFor(payload: SavedDronaCard['payload']): string {
  switch (payload.action) {
    case 'apply_targets':
      return payload.to_kcal ? `Set ${payload.to_kcal} kcal` : 'Set the new target';
    case 'log_weight':
      return 'Log a weigh-in';
    case 'log_food':
      return payload.focus === 'ai' ? 'Try it' : 'Log food';
    case 'start_session':
      return 'See what is due';
    case 'apply_swap':
      return 'Make it the plan';
    case 'talk':
      return 'Talk it through';
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
  cardSlot: { width: '100%', maxWidth: 360 },
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
