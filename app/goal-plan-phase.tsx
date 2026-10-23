/**
 * The phase screen (.planning/phase-metrics/SPEC.md sections 8 and 9): one
 * phase of the active program. Reached from the Goal & Plan screen's phase
 * card:
 *   /goal-plan-phase            the current phase
 *   /goal-plan-phase?seq=2      that phase
 * The numbers-only stepper switches phases; under the phase card the same
 * three plan rows as the main screen open the pillar screens for the phase
 * being viewed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { loadActiveProgram, peekActiveProgram, phaseFor, daysBetweenISO, todayLocalISO, type ActiveProgram } from '@/lib/programData';
import { loadLiveReadings, peekLiveReadings, peekTodayVitals, prefetchPillars, sharedTodayVitals } from '@/lib/pillarData';
import type { LiveReadings } from '@/lib/phaseMetricHeadline';
import { PhaseDetail } from '@/components/program/PhaseDetail';
import { PlanRows } from '@/components/program/PlanRows';
import { LoadFailed, ScreenSkeleton, Stagger, S, T } from '@/components/program/finish';
import { FontWeight } from '@/constants/theme';

export default function GoalPlanPhaseScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const clerkId = user?.id ?? null;
  const { seq: seqParam } = useLocalSearchParams<{ seq?: string }>();

  // Paint at once from the screen cache (the Goal screen filled it); the
  // focus load refreshes it behind. A skeleton only on a cold start.
  const [program, setProgram] = useState<ActiveProgram | null>(() => peekActiveProgram(clerkId) ?? null);
  const [loading, setLoading] = useState(() => peekActiveProgram(clerkId) === undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [readinessToday, setReadinessToday] = useState<number | null>(() => peekTodayVitals(clerkId)?.readiness ?? null);
  const [live, setLive] = useState<LiveReadings | null>(() => peekLiveReadings(clerkId));
  const [seq, setSeq] = useState<number | null>(() => {
    const n = parseInt(seqParam ?? '', 10);
    return Number.isFinite(n) ? n : null;
  });
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const n = ++loadSeq.current;
    if (!supabase || !clerkId) { setProgram(null); setLoading(false); setRefreshing(false); return; }
    try {
      // All side by side: the program, today's vitals (readiness for the
      // Recover row) and the live readings, each shared with the other
      // Goal & Plan screens through the cache.
      const [p, vitals, lv] = await Promise.all([
        loadActiveProgram(supabase, clerkId),
        sharedTodayVitals(supabase, clerkId),
        loadLiveReadings(supabase, clerkId),
      ]);
      if (n !== loadSeq.current) return;
      setProgram(p);
      setReadinessToday(vitals.readiness);
      setLive(lv);
      setLoadFailed(false);
    } catch (e) {
      // Keep what we had; with nothing yet, say the load failed rather than "no program".
      console.warn('[programs] phase load failed', e);
      if (n === loadSeq.current) setLoadFailed(true);
    } finally {
      if (n === loadSeq.current) { setLoading(false); setRefreshing(false); }
    }
  }, [supabase, clerkId]);
  useFocusEffect(useCallback(() => { load(); }, [load]));


  // Warm the pillar screens for the phase being viewed (only what the cache lacks).
  const shownRoutineIds = phaseFor(program, seq)?.routines.map((r) => r.id).join(',') ?? '';
  useEffect(() => {
    if (supabase && clerkId && program) prefetchPillars(supabase, clerkId, shownRoutineIds ? shownRoutineIds.split(',') : []);
  }, [supabase, clerkId, program, shownRoutineIds]);

  useEffect(() => {
    track('program_phase_opened', { seq: seq ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/goal-plan' as any));
  const totalWeeks = program ? (program.total_weeks ?? program.phases.reduce((a, p) => a + p.duration_weeks, 0)) : 0;
  const ended = program != null && totalWeeks > 0 && daysBetweenISO(program.start_date, todayLocalISO()) >= totalWeeks * 7;
  const shown = phaseFor(program, seq);
  const shownIndex = program && shown ? Math.max(0, program.phases.findIndex((ph) => ph.id === shown.id)) : 0;
  const headerTitle = program && program.phases.length > 0 ? `Phase ${shownIndex + 1} of ${program.phases.length}` : 'Phase';

  return (
    <View style={[styles.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={back} hitSlop={12} style={styles.navBtn} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={24} color={C.foreground} />
        </Pressable>
        <Text style={[T.rowTitle, { color: C.foreground, fontWeight: FontWeight.semibold }]}>{headerTitle}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: S.xl, paddingTop: S.xs, paddingBottom: insets.bottom + S.xxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.mutedFg} />}
      >
        {loading ? (
          <ScreenSkeleton variant="phase" />
        ) : !program || !shown ? (
          loadFailed && !program ? (
            <LoadFailed onRetry={() => { setLoading(true); load(); }} />
          ) : (
            <Text style={[T.body, { color: C.mutedFg, paddingTop: S.xl }]}>No program yet. Build one from Goal & Plan and this screen fills in.</Text>
          )
        ) : (
          <>
            <Stagger index={0}>
              <PhaseDetail program={program} seq={seq} ended={ended} onSelectSeq={setSeq} />
            </Stagger>
            <View style={{ marginTop: S.xxl }}>
              <PlanRows phase={shown} readinessToday={readinessToday} live={shown.seq === program.currentPhaseSeq ? live : null} from="phase" staggerFrom={1} heading={false} />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.lg, height: 44 },
  navBtn: { width: 44, height: 44, justifyContent: 'center' },
});
