/**
 * "Your program is ready. Now let's build week one."
 *
 * Onboarding hands out the PROGRAM (the phase-by-phase road) and stops there.
 * The concrete week of workouts is built afterwards by Drona, from the Goal
 * screen, so it is written against a real user id instead of a guest blob.
 * This is the one nudge that closes that gap.
 *
 * A centred popup, not a bottom sheet: a sheet reads as "a drawer you opened",
 * and nobody opened this. Rendered through the root <Portal> rather than RN's
 * <Modal> for the Android edge-to-edge reason documented there.
 *
 * The decision of WHETHER to show is in lib/splitPrompt (pure, tested); this
 * file owns the storage and the words.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, BackHandler, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather } from '@expo/vector-icons';
import { Portal } from '@/components/ui/Portal';
import { DronaMark } from '@/components/coach/DronaMark';
import { useTheme } from '@/hooks/useTheme';
import { splitPromptFor, splitPromptSnoozeKey, type SplitPromptAction } from '@/lib/splitPrompt';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

interface Props {
  /** False while auth or the program query is still settling. */
  ready: boolean;
  onboardingDone: boolean;
  isGuest: boolean;
  hasProgram: boolean;
  /** Routines linked to the current phase; null until loaded. */
  phaseRoutineCount: number | null;
  /** The phase being asked about. Its id scopes "Not now"; null for a guest. */
  phaseId: string | null;
  /** Signed in: open the Goal screen on phase 1's build flow. */
  onBuild: () => void;
  /** Guest: send them to sign-in so the program has somewhere to land. */
  onSignIn: () => void;
}

export function BuildSplitPrompt(props: Props) {
  const { C } = useTheme();
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Session-only. Tapping Build or Sign in hides the ask for as long as this
  // screen lives; nothing is written down, because the real "done" is the
  // phase actually having routines, and the dashboard re-reads that on focus.
  // An abandoned builder gets asked again next launch, which is the point.
  const [answered, setAnswered] = useState(false);
  const snoozeKey = splitPromptSnoozeKey(props.phaseId);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    // A different phase is a different question; a Build tap on the old one
    // says nothing about it.
    setAnswered(false);
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(snoozeKey);
        if (!alive) return;
        const n = raw ? parseInt(raw, 10) : NaN;
        setDismissedAt(Number.isFinite(n) ? n : null);
      } catch {
        /* no stored answer reads the same as never asked */
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [snoozeKey]);

  const action: SplitPromptAction = answered
    ? null
    : splitPromptFor({
        ready: props.ready && loaded,
        onboardingDone: props.onboardingDone,
        isGuest: props.isGuest,
        hasProgram: props.hasProgram,
        phaseRoutineCount: props.phaseRoutineCount,
        dismissedAt,
        nowMs: Date.now(),
      });
  const visible = action != null;

  const later = useCallback(() => {
    const now = Date.now();
    setDismissedAt(now);
    AsyncStorage.setItem(snoozeKey, String(now)).catch(() => {});
  }, [snoozeKey]);

  // <Portal> has no onRequestClose, so route the Android hardware back button.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      later();
      return true;
    });
    return () => sub.remove();
  }, [visible, later]);

  const go = useCallback(() => {
    setAnswered(true);
    if (action === 'signin') props.onSignIn();
    else props.onBuild();
  }, [action, props]);

  return (
    <Portal>
      {visible && (
        <Animated.View
          entering={FadeIn.duration(220)}
          exiting={FadeOut.duration(150)}
          style={[styles.backdrop, { backgroundColor: C.overlay }]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={later} />
          <Animated.View
            entering={ZoomIn.duration(240)}
            style={[styles.card, { backgroundColor: C.elevated, borderColor: C.borderSubtle }]}
          >
            <View style={styles.head}>
              <View style={[styles.mark, { backgroundColor: C.muted }]}>
                <DronaMark size={12} state="static" />
              </View>
              <Text style={[styles.title, { color: C.foreground }]}>
                {action === 'signin' ? 'Save your program' : 'Your program is ready'}
              </Text>
            </View>
            <Text style={[styles.body, { color: C.mutedFg }]}>
              {action === 'signin'
                ? 'I mapped out every phase for you, but without an account it will not be here tomorrow. Sign in and I will keep it, then build your first week.'
                : 'I have your phases mapped out. Now let me build the actual workouts for phase one, so you know exactly what to do on day one.'}
            </Text>

            <Pressable
              onPress={go}
              style={({ pressed }) => [
                styles.primary,
                { backgroundColor: Colors.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[styles.primaryText, { color: Colors.primaryFg }]}>
                {action === 'signin' ? 'Sign in to save it' : 'Build phase 1'}
              </Text>
              <Feather name="arrow-right" size={13} color={Colors.primaryFg} />
            </Pressable>
            <Pressable onPress={later} style={styles.later} hitSlop={8}>
              <Text style={[styles.laterText, { color: C.mutedFg }]}>Not now</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>
      )}
    </Portal>
  );
}

// Deliberately small. This interrupts a screen the user just arrived at, so it
// asks for a glance, not a page: the mark sits on the title line rather than
// above it, and the card is narrower than the phone.
const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
  card: {
    width: '100%',
    maxWidth: 310,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  mark: { width: 22, height: 22, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
  body: { fontSize: FontSize.xs, lineHeight: 17, marginBottom: 14 },
  primary: {
    height: 40,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  primaryText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  later: { alignSelf: 'center', paddingVertical: 9, paddingHorizontal: 16 },
  laterText: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
});
