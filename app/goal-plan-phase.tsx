/**
 * The phase screen (.planning/phase-metrics/SPEC.md section 8): one phase of
 * the active program in full. Reached from the Goal & Plan screen's phase
 * card and its Train / Eat / Recover rows:
 *   /goal-plan-phase            the current phase
 *   /goal-plan-phase?seq=2      that phase
 *   /goal-plan-phase?pillar=eat scrolled to that card
 * The stepper switches phases here. Building a split, previewing a routine
 * and the fuel-day sheet all live here too, as they did on the main screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { track, markWorkoutSource } from '@/lib/analytics';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { loadActiveProgram, daysBetweenISO, todayLocalISO, type ActiveProgram, type ActiveProgramPhaseRow } from '@/lib/programData';
import { PhaseDetail, type Pillar } from '@/components/program/PhaseDetail';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { RoutineDetailSheet, type RoutineRaw } from '@/components/routines/RoutineDetailSheet';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

export default function GoalPlanPhaseScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const clerkId = user?.id ?? null;
  const { seq: seqParam, pillar: pillarParam } = useLocalSearchParams<{ seq?: string; pillar?: string }>();

  const [program, setProgram] = useState<ActiveProgram | null>(null);
  const [loading, setLoading] = useState(true);
  const [seq, setSeq] = useState<number | null>(() => {
    const n = parseInt(seqParam ?? '', 10);
    return Number.isFinite(n) ? n : null;
  });
  const [coachOpen, setCoachOpen] = useState(false);
  const [buildSeed, setBuildSeed] = useState<{ goal?: string; days?: string; note?: string } | null>(null);
  const [buildPhaseId, setBuildPhaseId] = useState<string | null>(null);
  const [detailRoutine, setDetailRoutine] = useState<RoutineRaw | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const pillarY = useRef<Partial<Record<Pillar, number>>>({});
  const scrolledTo = useRef(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const n = ++loadSeq.current;
    if (!supabase || !clerkId) { setProgram(null); setLoading(false); return; }
    try {
      const p = await loadActiveProgram(supabase, clerkId);
      if (n !== loadSeq.current) return;
      setProgram(p);
    } catch {
      /* keep what we had */
    } finally {
      // Only the newest load clears the spinner.
      if (n === loadSeq.current) setLoading(false);
    }
  }, [supabase, clerkId]);
  // Focus fires on mount too, so one effect is enough.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    track('program_phase_opened', { seq: seq ?? null, pillar: pillarParam ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the asked-for pillar has a position, scroll to it, one time.
  const onPillarLayout = useCallback((pillar: Pillar, y: number) => {
    pillarY.current[pillar] = y;
    if (!scrolledTo.current && pillarParam === pillar) {
      scrolledTo.current = true;
      // The detail sits after the top padding; y is inside it.
      setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, y + Spacing.xl - 8), animated: true }), 50);
    }
  }, [pillarParam]);

  const buildSplitFor = useCallback((ph: ActiveProgramPhaseRow) => {
    const b = ph.training_block;
    const desc = [b?.split_type, b?.emphasis].filter(Boolean).join(', ');
    setBuildSeed({
      goal: b?.emphasis || b?.split_type || undefined,
      note: `Build the training split for the "${ph.name}" phase of my current program${desc ? `: ${desc}` : ''}.${ph.training_directive ? ` ${ph.training_directive}` : ''} Follow that exact split and cadence.`,
    });
    setBuildPhaseId(ph.id);
    track('program_split_build_started', { phase_seq: ph.seq, has_training_block: !!b });
    setCoachOpen(true);
  }, []);

  const openRoutinePreview = useCallback(async (routineId: string) => {
    if (!supabase) return;
    const { data } = await supabase
      .from('routines')
      .select('*, routine_exercises(*, exercises(*))')
      .eq('id', routineId)
      .maybeSingle();
    if (data) setDetailRoutine(data as RoutineRaw);
    else router.push(`/workout/${routineId}` as any);
  }, [supabase, router]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/goal-plan' as any));
  // "Phase 2 of 4": the phase shown (the stepper moves it), not the current one.
  const shownIndex = program
    ? Math.max(0, program.phases.findIndex((ph) => ph.seq === (seq ?? program.currentPhaseSeq ?? program.phases[0]?.seq)))
    : 0;
  const headerTitle = program && program.phases.length > 0 ? `Phase ${shownIndex + 1} of ${program.phases.length}` : 'Phase';
  const totalWeeks = program ? (program.total_weeks ?? program.phases.reduce((a, p) => a + p.duration_weeks, 0)) : 0;
  const ended = program != null && totalWeeks > 0 && daysBetweenISO(program.start_date, todayLocalISO()) >= totalWeeks * 7;

  return (
    <View style={[styles.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={back} style={[styles.iconBtn, { backgroundColor: C.muted }]} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={16} color={C.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: C.foreground }]}>{headerTitle}</Text>
        <View style={{ width: 32 }} />
      </View>

      {loading ? (
        <View style={styles.centerWrap}><ActivityIndicator size="small" color={C.accentText} /></View>
      ) : !program ? (
        <View style={styles.centerWrap}>
          <Text style={[styles.emptyText, { color: C.mutedFg }]}>No program yet. Build one from Goal & Plan.</Text>
        </View>
      ) : (
        <ScrollView ref={scrollRef} contentContainerStyle={{ padding: Spacing.xl, paddingBottom: insets.bottom + 48 }}>
          <PhaseDetail
            program={program}
            seq={seq}
            ended={ended}
            onSelectSeq={setSeq}
            onBuild={buildSplitFor}
            onOpenRoutine={openRoutinePreview}
            onPillarLayout={onPillarLayout}
          />
        </ScrollView>
      )}

      <RoutineDetailSheet
        routine={detailRoutine}
        onClose={() => setDetailRoutine(null)}
        onStartWorkout={() => {
          const id = detailRoutine?.id;
          setDetailRoutine(null);
          if (id) { markWorkoutSource('program'); router.push(`/workout/${id}` as any); }
        }}
      />

      <AICoachModal
        visible={coachOpen}
        source="goal_plan"
        onClose={() => { setCoachOpen(false); setBuildSeed(null); setBuildPhaseId(null); load(); }}
        initialScreen={buildSeed ? 'plan' : 'program'}
        planSeed={buildSeed ?? undefined}
        linkRoutinesToPhaseId={buildPhaseId ?? undefined}
        onRoutineCreated={() => load()}
        onProgramApplied={() => load()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md },
  iconBtn: { width: 32, height: 32, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xxl },
  emptyText: { fontSize: FontSize.sm, textAlign: 'center' },
});
