/**
 * Goal & Plan (Drona Programs, Phase 3 redesign).
 *
 * Root-level full-screen route (like app/health.tsx), reached from the dashboard
 * "Goal" pill, the coach menu, and the deep link overload://goal-plan. The page
 * tells one story top-down instead of a wall of equal cards:
 *   1. HERO: the goal, the destination, and a segmented progress bar where each
 *      segment is a phase (width = its weeks) and the current segment fills to
 *      today. One glance answers "where am I in this".
 *   2. NOW: the current phase only, with its daily targets as chips, the three
 *      directives as icon rows, and the phase's split (built routines or the
 *      build button).
 *   3. THE FULL PLAN: every phase as a compact rail row (done / now / ahead),
 *      expanding on tap to the same detail block.
 * "Adjust with Drona" opens the coach program flow; per-phase "Build workout
 * split" opens the plan generator seeded to that phase (cadence comes from the
 * phase's training directive). Fully theme-aware, coach-voice copy.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import {
  loadActiveProgram,
  daysBetweenISO,
  todayLocalISO,
  type ActiveProgram,
  type ActiveProgramPhaseRow,
} from '@/lib/programData';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { RoutineDetailSheet, type RoutineRaw } from '@/components/routines/RoutineDetailSheet';
import { Colors, Spacing, Radius, FontSize, FontWeight, colorWithAlpha } from '@/constants/theme';

const GOAL_LABEL: Record<string, string> = {
  hypertrophy: 'MUSCLE',
  strength: 'STRENGTH',
  fat_loss: 'FAT LOSS',
  endurance: 'ENDURANCE',
  general: 'FITNESS',
};

function fmtShortISO(iso: string): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function addDaysISO(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d + delta);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export default function GoalPlanScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const clerkId = user?.id ?? null;

  const [program, setProgram] = useState<ActiveProgram | null>(null);
  const [loading, setLoading] = useState(true);
  const [coachOpen, setCoachOpen] = useState(false);
  // Which rail row is expanded in "The full plan" (phase seq), if any.
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  // When set, the coach opens in plan-generation mode seeded to build a specific
  // phase's split; null opens the program builder ("Adjust with Drona").
  const [buildSeed, setBuildSeed] = useState<{ goal?: string; days?: string; note?: string } | null>(null);
  // The phase id whose split is being built, so saved routines link back to it.
  const [buildPhaseId, setBuildPhaseId] = useState<string | null>(null);
  // Routine preview: tapping a split routine opens the shared detail sheet
  // (same one as the Routines tab and the dashboard today card) so the user
  // sees the session and chooses to start, instead of starting on tap.
  const [detailRoutine, setDetailRoutine] = useState<RoutineRaw | null>(null);

  const openRoutinePreview = useCallback(async (routineId: string) => {
    if (!supabase) return;
    const { data } = await supabase
      .from('routines')
      .select('*, routine_exercises(*, exercises(*))')
      .eq('id', routineId)
      .maybeSingle();
    if (data) {
      setDetailRoutine(data as RoutineRaw);
    } else {
      // Preview fetch failed (offline, etc). Fall back to the workout screen
      // rather than a dead tap.
      router.push(`/workout/${routineId}` as any);
    }
  }, [supabase, router]);

  const load = useCallback(async () => {
    if (!supabase || !clerkId) { setProgram(null); setLoading(false); return; }
    try {
      setProgram(await loadActiveProgram(supabase, clerkId));
    } catch {
      /* keep whatever we had */
    } finally {
      setLoading(false);
    }
  }, [supabase, clerkId]);

  useEffect(() => { load(); }, [load]);
  // Reload when returning to the screen (e.g. after applying a program or
  // building a split in the coach modal).
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Open the plan generator pre-seeded to a phase's training block, so the
  // generated split matches that phase. The training_directive carries the
  // phase's real cadence (which may be a rotation like "8-day, 6 sessions"),
  // so it drives the split, NOT the weekly days_per_week number.
  const buildSplitFor = useCallback((ph: ActiveProgramPhaseRow) => {
    const b = ph.training_block;
    const desc = [b?.split_type, b?.emphasis].filter(Boolean).join(', ');
    setBuildSeed({
      goal: b?.emphasis || b?.split_type || undefined,
      note: `Build the training split for the "${ph.name}" phase of my current program${desc ? `: ${desc}` : ''}.${ph.training_directive ? ` ${ph.training_directive}` : ''} Follow that exact split and cadence.`,
    });
    setBuildPhaseId(ph.id);
    setCoachOpen(true);
  }, []);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // ── Derived progress (only when a program exists) ──────────────────────────
  const totalWeeks = program
    ? (program.total_weeks ?? program.phases.reduce((a, p) => a + p.duration_weeks, 0))
    : 0;
  const daysIn = program ? daysBetweenISO(program.start_date, todayLocalISO()) : 0;
  const totalDays = totalWeeks * 7;
  const notStarted = program != null && daysIn < 0;
  const ended = program != null && totalDays > 0 && daysIn >= totalDays;
  const weekOverall = program
    ? Math.max(1, Math.min(totalWeeks, Math.floor(daysIn / 7) + 1))
    : 0;
  const endDateISO = program ? addDaysISO(program.start_date, totalDays) : null;

  const currentPhase = program != null && program.currentPhaseSeq != null
    ? program.phases[program.currentPhaseSeq]
    : null;

  // ── Shared detail block: targets + directives + split ──────────────────────
  const renderPhaseDetail = (ph: ActiveProgramPhaseRow, opts?: { compact?: boolean }) => {
    const directives: Array<{ icon: 'zap' | 'activity' | 'moon'; label: string; text: string | null }> = [
      { icon: 'zap', label: 'DIET', text: ph.diet_directive },
      {
        icon: 'activity',
        label: 'TRAINING',
        text: [
          [ph.training_block?.split_type, ph.training_block?.emphasis].filter(Boolean).join(' · ') || null,
          ph.training_directive,
        ].filter(Boolean).join('. ') || null,
      },
      { icon: 'moon', label: 'RECOVERY', text: ph.readiness_directive },
    ];
    return (
      <View>
        {/* Daily targets as chips. Calories lead, macros follow. */}
        <View style={styles.chipRow}>
          {ph.diet_calorie_target != null && (
            <View style={[styles.chip, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}>
              <Text style={[styles.chipValue, { color: C.accentText }]}>{ph.diet_calorie_target}</Text>
              <Text style={[styles.chipLabel, { color: C.accentText }]}>KCAL / DAY</Text>
            </View>
          )}
          {ph.diet_protein_g != null && (
            <View style={[styles.chip, { backgroundColor: C.muted, borderColor: 'transparent' }]}>
              <Text style={[styles.chipValue, { color: C.foreground }]}>{ph.diet_protein_g}g</Text>
              <Text style={[styles.chipLabel, { color: C.mutedFg }]}>PROTEIN</Text>
            </View>
          )}
          {ph.diet_carb_g != null && (
            <View style={[styles.chip, { backgroundColor: C.muted, borderColor: 'transparent' }]}>
              <Text style={[styles.chipValue, { color: C.foreground }]}>{ph.diet_carb_g}g</Text>
              <Text style={[styles.chipLabel, { color: C.mutedFg }]}>CARBS</Text>
            </View>
          )}
          {ph.diet_fat_g != null && (
            <View style={[styles.chip, { backgroundColor: C.muted, borderColor: 'transparent' }]}>
              <Text style={[styles.chipValue, { color: C.foreground }]}>{ph.diet_fat_g}g</Text>
              <Text style={[styles.chipLabel, { color: C.mutedFg }]}>FAT</Text>
            </View>
          )}
        </View>

        {/* Directives as labeled icon rows, one story line each. */}
        {directives.filter((d) => d.text).map((d) => (
          <View key={d.label} style={styles.directiveRow}>
            <View style={[styles.directiveIcon, { backgroundColor: C.primarySubtle }]}>
              <Feather name={d.icon} size={12} color={C.accentText} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.directiveLabel, { color: C.mutedFg }]}>{d.label}</Text>
              <Text
                style={[styles.directiveText, { color: C.foreground }]}
                numberOfLines={opts?.compact ? 3 : undefined}
              >
                {d.text}
              </Text>
            </View>
          </View>
        ))}

        {/* The phase's split: built routines, or the build affordance. */}
        {ph.routines.length > 0 ? (
          <View style={styles.builtWrap}>
            <View style={styles.builtHeader}>
              <Feather name="check-circle" size={13} color={C.accentText} />
              <Text style={[styles.builtHeaderText, { color: C.accentText }]}>
                Split built · {ph.routines.length} routine{ph.routines.length === 1 ? '' : 's'}
              </Text>
            </View>
            {ph.routines.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => openRoutinePreview(r.id)}
                style={[styles.routineRow, { backgroundColor: C.muted }]}
                accessibilityRole="button"
                accessibilityLabel={`Preview ${r.name}`}
              >
                <Feather name="eye" size={11} color={C.accentText} />
                <Text style={[styles.routineName, { color: C.foreground }]} numberOfLines={1}>{r.name}</Text>
                <Feather name="chevron-right" size={13} color={C.textMuted} />
              </Pressable>
            ))}
            <Pressable onPress={() => buildSplitFor(ph)} style={styles.rebuildBtn}>
              <Feather name="refresh-cw" size={11} color={C.mutedFg} />
              <Text style={[styles.rebuildText, { color: C.mutedFg }]}>Rebuild split</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => buildSplitFor(ph)}
            style={[styles.buildSplitBtn, { backgroundColor: C.primarySubtle }]}
          >
            <Feather name="plus" size={13} color={C.accentText} />
            <Text style={[styles.buildSplitText, { color: C.accentText }]}>Build workout split</Text>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderColor: C.borderSubtle }]}>
        <Pressable
          onPress={back}
          style={[styles.iconBtn, { backgroundColor: C.muted }]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="arrow-left" size={16} color={C.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: C.foreground }]}>Goal & Plan</Text>
        <View style={{ width: 32 }} />
      </View>

      {loading ? (
        <View style={styles.centerWrap}>
          <ActivityIndicator size="small" color={C.accentText} />
        </View>
      ) : !program ? (
        // Empty state
        <View style={styles.centerWrap}>
          <View style={[styles.emptyIconWrap, { backgroundColor: C.primarySubtle }]}>
            <Feather name="target" size={24} color={C.accentText} />
          </View>
          <Text style={[styles.emptyTitle, { color: C.foreground }]}>No program yet</Text>
          <Text style={[styles.emptySub, { color: C.mutedFg }]}>
            Tell Drona your goal and it will lay out a phased plan, week by week, and keep your
            targets in step with it.
          </Text>
          <Pressable onPress={() => setCoachOpen(true)} style={[styles.primaryBtn, { backgroundColor: Colors.primary }]}>
            <Feather name="target" size={16} color={Colors.primaryFg} />
            <Text style={[styles.primaryBtnText, { color: Colors.primaryFg }]}>Build a program</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: Spacing.xl, paddingBottom: insets.bottom + 96 }}>
          {/* ── HERO: the goal + where you are ─────────────────────────────── */}
          <Animated.View
            entering={FadeInDown.duration(300)}
            style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
          >
            <View style={styles.heroTopRow}>
              {program.goal && (
                <View style={[styles.goalPill, { backgroundColor: C.primarySubtle }]}>
                  <Text style={[styles.goalPillText, { color: C.accentText }]}>
                    {GOAL_LABEL[program.goal] ?? program.goal.toUpperCase()}
                  </Text>
                </View>
              )}
              <Text style={[styles.heroWeeks, { color: C.mutedFg }]}>{totalWeeks} weeks</Text>
            </View>
            <Text style={[styles.heroTitle, { color: C.foreground }]}>{program.title}</Text>
            {program.objective && (
              <Text style={[styles.objective, { color: C.mutedFg }]}>{program.objective}</Text>
            )}

            {/* Destination stats */}
            <View style={styles.statsRow}>
              <View style={styles.statBlock}>
                <Text style={[styles.statValue, { color: C.foreground }]}>
                  {notStarted ? `Starts ${fmtShortISO(program.start_date)}` : ended ? 'Done' : `Week ${weekOverall} of ${totalWeeks}`}
                </Text>
                <Text style={[styles.statLabel, { color: C.mutedFg }]}>WHERE YOU ARE</Text>
              </View>
              {program.target_weight_kg != null && (
                <View style={styles.statBlock}>
                  <Text style={[styles.statValue, { color: C.foreground }]}>{program.target_weight_kg} kg</Text>
                  <Text style={[styles.statLabel, { color: C.mutedFg }]}>TARGET</Text>
                </View>
              )}
              <View style={styles.statBlock}>
                <Text style={[styles.statValue, { color: C.foreground }]}>
                  {fmtShortISO(program.target_date ?? endDateISO!)}
                </Text>
                <Text style={[styles.statLabel, { color: C.mutedFg }]}>FINISH</Text>
              </View>
            </View>

            {/* Segmented phase progress: one segment per phase, sized by weeks.
                Past phases filled dim, current fills to today, future stay muted. */}
            <View style={styles.barTrack}>
              {program.phases.map((ph) => {
                const isPast = program.currentPhaseSeq != null
                  ? ph.seq < program.currentPhaseSeq
                  : ended;
                const isCur = ph.seq === program.currentPhaseSeq;
                const frac = isCur
                  ? clamp01((daysIn - ph.start_offset_weeks * 7) / (ph.duration_weeks * 7))
                  : 0;
                return (
                  <View
                    key={ph.id}
                    style={[
                      styles.barSegment,
                      { flex: ph.duration_weeks, backgroundColor: isPast ? colorWithAlpha(Colors.primary, 0.35) : C.muted },
                    ]}
                  >
                    {isCur && (
                      <View style={[styles.barFill, { width: `${Math.max(6, frac * 100)}%`, backgroundColor: Colors.primary }]} />
                    )}
                  </View>
                );
              })}
            </View>
            <View style={styles.barCaptionRow}>
              <Text style={[styles.barCaption, { color: C.accentText }]} numberOfLines={1}>
                {notStarted
                  ? 'Locked in. We start soon.'
                  : ended
                    ? 'Program complete. Talk to Drona about what is next.'
                    : currentPhase
                      ? `Now: ${currentPhase.name}`
                      : 'Between phases'}
              </Text>
              {!ended && currentPhase && program.weekInPhase != null && (
                <Text style={[styles.barCaptionRight, { color: C.mutedFg }]}>
                  wk {program.weekInPhase}/{currentPhase.duration_weeks}
                </Text>
              )}
            </View>
          </Animated.View>

          {/* ── NOW: the phase driving today's targets ─────────────────────── */}
          {currentPhase && (
            <Animated.View
              entering={FadeInDown.duration(300).delay(70)}
              style={[styles.card, styles.nowCard, { backgroundColor: C.card, borderColor: Colors.primary }]}
            >
              <View style={styles.nowHeadRow}>
                <View style={[styles.nowPill, { backgroundColor: Colors.primary }]}>
                  <Text style={[styles.nowPillText, { color: Colors.primaryFg }]}>NOW</Text>
                </View>
                <Text style={[styles.nowWeeksText, { color: C.mutedFg }]}>
                  Weeks {currentPhase.start_offset_weeks + 1}-{currentPhase.start_offset_weeks + currentPhase.duration_weeks}
                </Text>
              </View>
              <Text style={[styles.phaseTitle, { color: C.foreground }]}>{currentPhase.name}</Text>
              {renderPhaseDetail(currentPhase)}
            </Animated.View>
          )}

          {/* ── THE FULL PLAN: rail timeline of every phase ────────────────── */}
          <Animated.View entering={FadeInDown.duration(300).delay(140)}>
            <Text style={[styles.sectionEyebrow, { color: C.mutedFg }]}>THE FULL PLAN</Text>
            <View style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              {program.phases.map((ph, idx) => {
                const isCur = ph.seq === program.currentPhaseSeq;
                const isPast = program.currentPhaseSeq != null ? ph.seq < program.currentPhaseSeq : ended;
                const isLast = idx === program.phases.length - 1;
                const expanded = expandedSeq === ph.seq;
                const wkStart = ph.start_offset_weeks + 1;
                const wkEnd = ph.start_offset_weeks + ph.duration_weeks;
                return (
                  <View key={ph.id} style={styles.railRow}>
                    {/* Rail */}
                    <View style={styles.railCol}>
                      <View
                        style={[
                          styles.railDot,
                          isCur
                            ? { backgroundColor: Colors.primary, borderColor: Colors.primary }
                            : isPast
                              ? { backgroundColor: colorWithAlpha(Colors.primary, 0.4), borderColor: 'transparent' }
                              : { backgroundColor: 'transparent', borderColor: C.textMuted },
                        ]}
                      />
                      {!isLast && <View style={[styles.railLine, { backgroundColor: C.borderSubtle }]} />}
                    </View>
                    {/* Row content */}
                    <View style={[styles.railContent, !isLast && styles.railContentSpacing]}>
                      <Pressable
                        onPress={() => setExpandedSeq(expanded ? null : ph.seq)}
                        style={styles.railHead}
                        accessibilityRole="button"
                        accessibilityLabel={`${ph.name}, ${expanded ? 'collapse' : 'expand'}`}
                      >
                        <View style={{ flex: 1 }}>
                          <View style={styles.railNameRow}>
                            <Text style={[styles.railName, { color: isPast ? C.mutedFg : C.foreground }]} numberOfLines={1}>
                              {ph.name}
                            </Text>
                            {isCur && (
                              <View style={[styles.nowPillSmall, { backgroundColor: C.primarySubtle }]}>
                                <Text style={[styles.nowPillSmallText, { color: C.accentText }]}>NOW</Text>
                              </View>
                            )}
                            {isPast && <Feather name="check" size={12} color={C.mutedFg} />}
                          </View>
                          <Text style={[styles.railSub, { color: C.mutedFg }]}>
                            {wkStart === wkEnd ? `Week ${wkStart}` : `Weeks ${wkStart}-${wkEnd}`}
                            {ph.diet_calorie_target != null ? ` · ${ph.diet_calorie_target} kcal` : ''}
                            {ph.routines.length > 0 ? ` · split ready` : ''}
                          </Text>
                        </View>
                        <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={15} color={C.textMuted} />
                      </Pressable>
                      {expanded && (
                        <Animated.View entering={FadeInDown.duration(200)} style={{ marginTop: 4 }}>
                          {renderPhaseDetail(ph, { compact: true })}
                        </Animated.View>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </Animated.View>

          {/* Adjust with Drona */}
          <Pressable
            onPress={() => { setBuildSeed(null); setBuildPhaseId(null); setCoachOpen(true); }}
            style={[styles.secondaryBtn, { backgroundColor: C.muted }]}
          >
            <Feather name="message-circle" size={14} color={C.mutedFg} />
            <Text style={[styles.secondaryBtnText, { color: C.mutedFg }]}>Adjust with Drona</Text>
          </Pressable>
        </ScrollView>
      )}

      {/* Session preview: view the routine, then choose to start. */}
      <RoutineDetailSheet
        routine={detailRoutine}
        onClose={() => setDetailRoutine(null)}
        onStartWorkout={() => {
          const id = detailRoutine?.id;
          setDetailRoutine(null);
          if (id) router.push(`/workout/${id}` as any);
        }}
      />

      <AICoachModal
        visible={coachOpen}
        onClose={() => { setCoachOpen(false); setBuildSeed(null); setBuildPhaseId(null); load(); }}
        initialScreen={buildSeed ? 'plan' : 'program'}
        planSeed={buildSeed ?? undefined}
        linkRoutinesToPhaseId={buildPhaseId ?? undefined}
        onRoutineCreated={() => load()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { width: 32, height: 32, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xxl, gap: 12 },
  emptyIconWrap: { width: 56, height: 56, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, marginTop: 4 },
  emptySub: { fontSize: FontSize.sm, textAlign: 'center', lineHeight: 20 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: Radius.lg, paddingHorizontal: 18, paddingVertical: 12, marginTop: 8 },
  primaryBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },

  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },

  // Hero
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  goalPill: { borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  goalPillText: { fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1 },
  heroWeeks: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  heroTitle: { fontSize: 24, fontWeight: FontWeight.bold, marginTop: 10, letterSpacing: -0.3 },
  objective: { fontSize: FontSize.sm, lineHeight: 20, marginTop: 6 },
  statsRow: { flexDirection: 'row', gap: Spacing.xl, marginTop: 16 },
  statBlock: { gap: 2 },
  statValue: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  statLabel: { fontSize: 9, fontWeight: FontWeight.semibold, letterSpacing: 0.8 },
  barTrack: { flexDirection: 'row', gap: 3, height: 8, marginTop: 16 },
  barSegment: { borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4 },
  barCaptionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8 },
  barCaption: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, flexShrink: 1 },
  barCaptionRight: { fontSize: FontSize.xs },

  // Now card
  nowCard: { borderWidth: 1.5 },
  nowHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nowPill: { borderRadius: Radius.full, paddingHorizontal: 9, paddingVertical: 3 },
  nowPillText: { fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1 },
  nowWeeksText: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  phaseTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, marginTop: 8, marginBottom: 2 },

  // Phase detail (chips + directives + split)
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { borderRadius: Radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 7, alignItems: 'flex-start', gap: 1 },
  chipValue: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  chipLabel: { fontSize: 8.5, fontWeight: FontWeight.semibold, letterSpacing: 0.8 },
  directiveRow: { flexDirection: 'row', gap: 10, marginTop: 12, alignItems: 'flex-start' },
  directiveIcon: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  directiveLabel: { fontSize: 9, fontWeight: FontWeight.semibold, letterSpacing: 0.8, marginBottom: 2 },
  directiveText: { fontSize: FontSize.sm, lineHeight: 19 },

  builtWrap: { marginTop: 14, gap: 6 },
  builtHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  builtHeaderText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  routineRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12, borderRadius: Radius.md },
  routineName: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  rebuildBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: 6 },
  rebuildText: { fontSize: FontSize.xs },
  buildSplitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 14, borderRadius: Radius.md, paddingVertical: 10,
  },
  buildSplitText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  // Full plan rail
  sectionEyebrow: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1, marginBottom: 8, marginLeft: 2 },
  railRow: { flexDirection: 'row' },
  railCol: { width: 20, alignItems: 'center' },
  railDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, marginTop: 5 },
  railLine: { width: 2, flex: 1, marginTop: 4, marginBottom: -2, borderRadius: 1 },
  railContent: { flex: 1, marginLeft: 8 },
  railContentSpacing: { paddingBottom: Spacing.lg },
  railHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  railNameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  railName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, flexShrink: 1 },
  nowPillSmall: { borderRadius: Radius.full, paddingHorizontal: 7, paddingVertical: 2 },
  nowPillSmallText: { fontSize: 9, fontWeight: FontWeight.bold, letterSpacing: 0.8 },
  railSub: { fontSize: FontSize.xs, marginTop: 2 },

  secondaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: Radius.lg, paddingVertical: 12 },
  secondaryBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
});
