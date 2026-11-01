/**
 * "Your first week": the dashboard's guided start (rules in
 * lib/startGuide.ts). One step leads at a time, with a short lesson behind it
 * (StartLessonSheet) that ends on the screen where the step is done; the
 * rest wait below in any order. A step ticks itself off from real data when
 * the user comes back, and finishing them all gets one full-screen moment.
 *
 * The facts are read here, cheaply: one row each from meal_entries and
 * daily_metrics (RLS-scoped, limit 1), the parse-mode key, and three device
 * flags. Re-read on every focus of the dashboard, so a step done elsewhere is
 * ticked when the user comes back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown, ZoomIn } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import { haptics } from '@/lib/haptics';
import { DronaMark } from '@/components/coach/DronaMark';
import { PressableScale } from '@/components/ui/PressableScale';
import { Celebration } from '@/components/ui/Celebration';
import { StartLessonSheet } from '@/components/home/StartLessonSheet';
import { Colors, FontFamily, FontSize, FontWeight, LetterSpacing, Radius, Spacing } from '@/constants/theme';
import {
  parseOpened,
  START_STEPS,
  startGuideCelebratedKey,
  startGuideDismissedKey,
  startGuideOpenedKey,
  startGuideView,
  type StartStepId,
} from '@/lib/startGuide';
import type { SupabaseClient } from '@supabase/supabase-js';

// lib/parseSpeed.ts keeps the chosen food logging mode under this key; it is
// only written when the user picks one.
const PARSE_SPEED_KEY = 'overload.parseSpeed';

interface Props {
  /** Spacing around the card; nothing is drawn (or spaced) when it hides. */
  containerStyle?: StyleProp<ViewStyle>;
  supabase: SupabaseClient;
  userId: string | null;
  /** Clerk's account creation time, ms. */
  createdAtMs: number | null;
  workoutsLogged: number;
  /** Open the step's screen. */
  onOpen: (id: StartStepId) => void;
}

export function StartGuideCard({ containerStyle, supabase, userId, createdAtMs, workoutsLogged, onOpen }: Props) {
  const { C } = useTheme();
  const [facts, setFacts] = useState<{
    aiMealLogged: boolean;
    weightLogged: boolean;
    modePicked: boolean;
    opened: Set<StartStepId>;
    dismissed: boolean;
    celebrated: boolean;
  } | null>(null);
  const [tick, setTick] = useState(0);
  const [lessonId, setLessonId] = useState<StartStepId | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  // The all-done card stays up until "Thanks", even though the moment is
  // stored as seen the instant it shows (so it can never replay).
  const [holdFinished, setHoldFinished] = useState(false);
  useFocusEffect(useCallback(() => { setTick((t) => t + 1); }, []));

  useEffect(() => {
    if (!userId) { setFacts(null); return; }
    let alive = true;
    (async () => {
      try {
        const [ai, wt, mode, opened, dismissed, celebrated] = await Promise.all([
          supabase.from('meal_entries').select('id').like('logged_via', 'ai%').limit(1),
          supabase.from('daily_metrics').select('metric_date').eq('user_id', userId).eq('metric_type', 'bodyweight_kg').limit(1),
          AsyncStorage.getItem(PARSE_SPEED_KEY).catch(() => null),
          AsyncStorage.getItem(startGuideOpenedKey(userId)).catch(() => null),
          AsyncStorage.getItem(startGuideDismissedKey(userId)).catch(() => null),
          AsyncStorage.getItem(startGuideCelebratedKey(userId)).catch(() => null),
        ]);
        if (!alive) return;
        // A failed read counts as "not yet": the worst case is a step that
        // stays unticked one focus longer.
        setFacts({
          aiMealLogged: !ai.error && (ai.data?.length ?? 0) > 0,
          weightLogged: !wt.error && (wt.data?.length ?? 0) > 0,
          modePicked: mode != null,
          opened: parseOpened(opened),
          dismissed: dismissed === '1',
          celebrated: celebrated === '1',
        });
      } catch {
        if (alive) setFacts((f) => f ?? null);
      }
    })();
    return () => { alive = false; };
  }, [supabase, userId, tick]);

  const view = facts && userId
    ? startGuideView({
        ready: true,
        accountAgeMs: createdAtMs != null ? Date.now() - createdAtMs : null,
        dismissed: facts.dismissed,
        celebrated: facts.celebrated && !holdFinished,
        workoutsLogged,
        aiMealLogged: facts.aiMealLogged,
        modePicked: facts.modePicked,
        weightLogged: facts.weightLogged,
        opened: facts.opened,
      })
    : null;

  // Steps that ticked since the last read: their check pops in with a buzz.
  // The first read only remembers, so a returning user sees no fireworks.
  const seenDone = useRef<Set<StartStepId> | null>(null);
  const [justDone, setJustDone] = useState<Set<StartStepId>>(new Set());
  const doneKey = view ? view.steps.filter((x) => x.done).map((x) => x.id).join(',') : null;
  useEffect(() => {
    if (doneKey == null) return;
    const now = new Set((doneKey ? doneKey.split(',') : []) as StartStepId[]);
    if (seenDone.current) {
      const fresh = [...now].filter((id) => !seenDone.current!.has(id));
      if (fresh.length) { haptics.success(); setJustDone(new Set(fresh)); }
    }
    seenDone.current = now;
  }, [doneKey]);

  // The all-done moment fires once, the first time it is seen, and is
  // remembered at once so it never replays.
  const finished = view?.finished ?? false;
  useEffect(() => {
    if (!finished || !userId || holdFinished) return;
    setHoldFinished(true);
    setCelebrating(true);
    haptics.success();
    track('start_guide_finished', {});
    AsyncStorage.setItem(startGuideCelebratedKey(userId), '1').catch(() => {});
    // holdFinished only guards a re-fire; it is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, userId]);

  const shownOnce = view != null;
  useEffect(() => {
    if (shownOnce) track('start_guide_shown', { done: view?.doneCount ?? 0 });
    // Once per mount, not per tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownOnce]);

  if (!view || !userId) return celebrating ? <Celebration onDone={() => setCelebrating(false)} /> : null;

  const open = (id: StartStepId) => {
    track('start_guide_step_tapped', { step: id, done_before: view.doneCount });
    const next = new Set(facts!.opened);
    next.add(id);
    setFacts((f) => (f ? { ...f, opened: next } : f));
    AsyncStorage.setItem(startGuideOpenedKey(userId), JSON.stringify([...next])).catch(() => {});
    onOpen(id);
  };

  const learn = (id: StartStepId) => {
    haptics.selection();
    setLessonId(id);
  };

  const hide = () => {
    haptics.tick();
    track('start_guide_dismissed', { done: view.doneCount });
    setFacts((f) => (f ? { ...f, dismissed: true } : f));
    AsyncStorage.setItem(startGuideDismissedKey(userId), '1').catch(() => {});
  };

  const closeFinished = () => {
    haptics.tick();
    setHoldFinished(false);
    setFacts((f) => (f ? { ...f, celebrated: true } : f));
  };

  const total = view.steps.length;
  const next = view.steps.find((x) => x.id === view.nextId) ?? null;
  const nextNumber = next ? START_STEPS.findIndex((x) => x.id === next.id) + 1 : 0;
  const others = view.steps.filter((x) => x.id !== view.nextId);

  return (
    <View style={containerStyle}>
      <View style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
        <View style={s.head}>
          <View style={[s.mark, { backgroundColor: C.muted }]}>
            <DronaMark size={11} state={view.finished ? 'answer' : 'static'} />
          </View>
          <Text style={[s.title, { color: C.foreground }]}>Your first week</Text>
          <Text style={[s.count, { color: C.mutedFg }]}>{view.doneCount} of {total}</Text>
          <View style={{ flex: 1 }} />
          {!view.finished && (
            <Pressable onPress={hide} hitSlop={12} accessibilityRole="button" accessibilityLabel="Hide your first week">
              <Text style={[s.hide, { color: C.textDim }]}>Hide</Text>
            </Pressable>
          )}
        </View>

        <View style={s.segments} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {view.steps.map((x) => (
            <View key={x.id} style={[s.segment, { backgroundColor: C.muted }]}>
              {x.done && (
                <Animated.View
                  entering={justDone.has(x.id) ? FadeIn.duration(420) : undefined}
                  style={[StyleSheet.absoluteFill, { backgroundColor: C.accentText }]}
                />
              )}
            </View>
          ))}
        </View>

        {view.finished ? (
          <Animated.View entering={FadeInDown.duration(380)} style={s.finished}>
            <Animated.View entering={ZoomIn.springify().damping(12).delay(150)} style={[s.bigCheck, { backgroundColor: C.accentText }]}>
              <Feather name="check" size={18} color={C.background} />
            </Animated.View>
            <Text style={[s.nextTitle, { color: C.foreground }]}>Week one, done.</Text>
            <Text style={[s.nextTip, { color: C.mutedFg }]}>
              You know your way around now. Keep logging and I will keep adjusting.
            </Text>
            <PressableScale
              onPress={closeFinished}
              style={[s.cta, s.ctaWide, { backgroundColor: C.muted }]}
              accessibilityRole="button"
              accessibilityLabel="Close your first week"
            >
              <Text style={[s.ctaText, { color: C.foreground }]}>Thanks, Drona</Text>
            </PressableScale>
          </Animated.View>
        ) : (
          <>
            {view.fresh && (
              <Text style={[s.hello, { color: C.mutedFg }]}>
                I'm Drona, your coach. Five quick things this week and you will know your way around.
              </Text>
            )}

            {next && (
              <Animated.View key={next.id} entering={FadeInDown.duration(360)} style={[s.next, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
                <Text style={[s.eyebrow, { color: C.textDim }]}>UP NEXT  ·  STEP {nextNumber}</Text>
                <Text style={[s.nextTitle, { color: C.foreground }]}>{next.title}</Text>
                <Text style={[s.nextTip, { color: C.mutedFg }]}>{next.tip}</Text>
                <PressableScale
                  onPress={() => learn(next.id)}
                  haptic={false}
                  style={[s.cta, { backgroundColor: Colors.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Show me: ${next.title}`}
                >
                  <Text style={[s.ctaText, { color: Colors.primaryFg }]}>Show me</Text>
                  <Feather name="arrow-right" size={14} color={Colors.primaryFg} />
                </PressableScale>
              </Animated.View>
            )}

            <View style={s.rows}>
              {others.map((st) => (
                <Pressable
                  key={st.id}
                  onPress={() => (st.done ? open(st.id) : learn(st.id))}
                  style={({ pressed }) => [s.row, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  accessibilityState={{ checked: st.done }}
                  accessibilityLabel={`${st.title}${st.done ? ', done' : ''}`}
                >
                  <View
                    style={[
                      s.check,
                      st.done ? { backgroundColor: C.primaryMuted, borderColor: 'transparent' } : { borderColor: C.border },
                    ]}
                  >
                    {st.done && (
                      <Animated.View entering={justDone.has(st.id) ? ZoomIn.springify().damping(12) : undefined}>
                        <Feather name="check" size={10} color={C.accentText} />
                      </Animated.View>
                    )}
                  </View>
                  <Text
                    style={[s.stepTitle, { color: st.done ? C.mutedFg : C.foreground }, st.done && s.struck]}
                    numberOfLines={1}
                  >
                    {st.title}
                  </Text>
                  {!st.done && <Feather name="chevron-right" size={13} color={C.textDim} />}
                </Pressable>
              ))}
            </View>
          </>
        )}
      </View>

      <StartLessonSheet
        stepId={lessonId}
        stepNumber={lessonId ? START_STEPS.findIndex((x) => x.id === lessonId) + 1 : 0}
        stepTotal={total}
        onClose={() => setLessonId(null)}
        onGo={open}
      />
      {celebrating && <Celebration onDone={() => setCelebrating(false)} />}
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: Radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: Spacing.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 22, height: 22, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
  count: { fontSize: FontSize.xs, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
  hide: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  segments: { flexDirection: 'row', gap: 4, marginTop: 12 },
  segment: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  hello: { fontSize: FontSize.sm, lineHeight: 18, marginTop: 12 },
  next: { borderRadius: Radius.md, borderWidth: StyleSheet.hairlineWidth, padding: Spacing.md, marginTop: 12 },
  eyebrow: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.label },
  nextTitle: { fontFamily: FontFamily.display, fontSize: FontSize.xl, letterSpacing: LetterSpacing.snug, marginTop: 6 },
  nextTip: { fontSize: FontSize.sm, lineHeight: 18, marginTop: 4 },
  cta: {
    marginTop: 12,
    height: 44,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  ctaText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  ctaWide: { alignSelf: 'stretch' },
  rows: { marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  check: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  stepTitle: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  struck: { textDecorationLine: 'line-through' },
  finished: { alignItems: 'flex-start', marginTop: 14 },
  bigCheck: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
