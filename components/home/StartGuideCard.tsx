/**
 * "Get started": the dashboard's first-week checklist (rules in
 * lib/startGuide.ts). Each row opens the screen where the step is done; a row
 * shows its one-line tip under the title until it is done.
 *
 * The facts are read here, cheaply: one row each from meal_entries and
 * daily_metrics (RLS-scoped, limit 1), the parse-mode key, and two device
 * flags. Re-read on every focus of the dashboard, so a step done elsewhere is
 * ticked when the user comes back.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import { haptics } from '@/lib/haptics';
import { DronaMark } from '@/components/coach/DronaMark';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import {
  parseOpened,
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
  } | null>(null);
  const [tick, setTick] = useState(0);
  useFocusEffect(useCallback(() => { setTick((t) => t + 1); }, []));

  useEffect(() => {
    if (!userId) { setFacts(null); return; }
    let alive = true;
    (async () => {
      try {
        const [ai, wt, mode, opened, dismissed] = await Promise.all([
          supabase.from('meal_entries').select('id').like('logged_via', 'ai%').limit(1),
          supabase.from('daily_metrics').select('metric_date').eq('user_id', userId).eq('metric_type', 'bodyweight_kg').limit(1),
          AsyncStorage.getItem(PARSE_SPEED_KEY).catch(() => null),
          AsyncStorage.getItem(startGuideOpenedKey(userId)).catch(() => null),
          AsyncStorage.getItem(startGuideDismissedKey(userId)).catch(() => null),
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
        workoutsLogged,
        aiMealLogged: facts.aiMealLogged,
        modePicked: facts.modePicked,
        weightLogged: facts.weightLogged,
        opened: facts.opened,
      })
    : null;

  const shownOnce = view != null;
  useEffect(() => {
    if (shownOnce) track('start_guide_shown', { done: view?.doneCount ?? 0 });
    // Once per mount, not per tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownOnce]);

  if (!view || !userId) return null;

  const open = (id: StartStepId) => {
    haptics.selection();
    track('start_guide_step_tapped', { step: id, done_before: view.doneCount });
    const next = new Set(facts!.opened);
    next.add(id);
    setFacts((f) => (f ? { ...f, opened: next } : f));
    AsyncStorage.setItem(startGuideOpenedKey(userId), JSON.stringify([...next])).catch(() => {});
    onOpen(id);
  };

  const hide = () => {
    haptics.tick();
    track('start_guide_dismissed', { done: view.doneCount });
    setFacts((f) => (f ? { ...f, dismissed: true } : f));
    AsyncStorage.setItem(startGuideDismissedKey(userId), '1').catch(() => {});
  };

  return (
    <View style={containerStyle}>
    <View style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
      <View style={s.head}>
        <View style={[s.mark, { backgroundColor: C.muted }]}>
          <DronaMark size={11} state="static" />
        </View>
        <Text style={[s.title, { color: C.foreground }]}>Get started</Text>
        <Text style={[s.count, { color: C.mutedFg }]}>{view.doneCount} of {view.steps.length}</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={hide} hitSlop={10} accessibilityRole="button" accessibilityLabel="Hide the getting started list">
          <Text style={[s.hide, { color: C.textDim }]}>Hide</Text>
        </Pressable>
      </View>
      <View style={[s.bar, { backgroundColor: C.muted }]}>
        <View style={[s.fill, { width: `${Math.max(4, (view.doneCount / view.steps.length) * 100)}%`, backgroundColor: Colors.primary }]} />
      </View>
      {view.steps.map((st) => {
        const isNext = st.id === view.nextId;
        return (
          <Pressable
            key={st.id}
            onPress={() => open(st.id)}
            style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityState={{ checked: st.done }}
            accessibilityLabel={`${st.title}${st.done ? ', done' : ''}. ${st.tip}`}
          >
            <View
              style={[
                s.check,
                st.done
                  ? { backgroundColor: C.primaryMuted, borderColor: 'transparent' }
                  : { borderColor: isNext ? Colors.primary : C.border },
              ]}
            >
              {st.done && <Feather name="check" size={10} color={C.accentText} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  s.stepTitle,
                  { color: st.done ? C.mutedFg : C.foreground },
                  st.done && { textDecorationLine: 'line-through' },
                ]}
                numberOfLines={1}
              >
                {st.title}
              </Text>
              {!st.done && isNext && <Text style={[s.tip, { color: C.mutedFg }]}>{st.tip}</Text>}
            </View>
            {!st.done && <Feather name="chevron-right" size={13} color={C.textDim} />}
          </Pressable>
        );
      })}
    </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: Radius.lg, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 22, height: 22, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
  count: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  hide: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  bar: { height: 4, borderRadius: 2, marginTop: 10, marginBottom: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, minHeight: 40 },
  check: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  stepTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  tip: { fontSize: FontSize.xs, lineHeight: 16, marginTop: 2 },
});
