import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  BackHandler,
  Pressable,
} from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Portal } from '@/components/ui/Portal';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useExerciseNotes } from '@/hooks/useExerciseNotes';
import { usesReps } from '@/lib/exercises';
import { readRoutineTargets, slotTargetLabel } from '@/lib/routineTargets';
import { track } from '@/lib/analytics';
import { slotKey, type SessionSwaps } from '@/lib/sessionSwaps';
import { useSwapCatalog } from '@/hooks/useSwapCatalog';
import { ExerciseSwapList } from '@/components/routines/ExerciseSwapList';

// Shared routine-detail / session-preview sheet. Used by the Routines screen
// (tap a routine) and by the dashboard's "today" card (tap the suggestion).
// It only shows the actions the caller wires: pass onEdit to show Edit, pass
// onAskCoach to show "Ask Drona". Start Workout is always present. Pass
// allowSwap to let the person swap an exercise for this session only: the
// swaps go to onStartWorkout, and the routine itself is not changed.
//
// Rendered via the root <Portal> (NOT RN <Modal>) so it behaves on Android
// edge-to-edge — a <Modal> is a separate Dialog window inset by the system nav
// bar, leaving a gap under the sheet (see components/ui/Portal.tsx).

export interface RoutineExerciseRaw {
  exercise_id: string;
  sets: number;
  reps_min: number;
  reps_max: number;
  rest_seconds: number;
  order: number;
  note?: string | null;
  // Superset grouping ordinal (migration 0060). Members share a value and are
  // contiguous by `order`; null = solo. Drives the bracket/accent below.
  superset_group?: number | null;
  // Time / distance target (lib/routineTargets.ts); absent before its migration.
  target_duration_seconds?: number | null;
  target_distance_m?: number | null;
  exercises: {
    id: string;
    name: string;
    muscle_group: string;
    category: string;
    // Selected by every routines query (exercises(*)). Optional for rows
    // cached before the column existed and for guest rows.
    metric_type?: string | null;
  };
}

export interface RoutineRaw {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  color?: string;
  created_at: string;
  routine_exercises: RoutineExerciseRaw[];
}

interface Props {
  routine: RoutineRaw | null;
  onClose: () => void;
  /** Called with this session's swaps (empty when none, or when swapping is off). */
  onStartWorkout: (swaps: SessionSwaps) => void;
  onEdit?: () => void;
  onAskCoach?: () => void;
  /** Show a swap button on each exercise (signed-in only; guests have no catalog to rank). */
  allowSwap?: boolean;
}

/** "0:45 · " for a timed slot with a target, "8-12 reps · " for a rep slot, and
 *  nothing for a timed slot without one (its stored 8-12 reps is only the
 *  table default, not a prescription). */
function routineSlotLabel(re: RoutineExerciseRaw): string {
  const target = slotTargetLabel(re.exercises?.metric_type, readRoutineTargets(re));
  if (target) return `${target} · `;
  if (!usesReps(re.exercises?.metric_type)) return '';
  return `${re.reps_min === re.reps_max ? re.reps_min : `${re.reps_min}-${re.reps_max}`} reps · `;
}

export function RoutineDetailSheet({ routine, onClose, onStartWorkout, onEdit, onAskCoach, allowSwap }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  // A null routine means the sheet is closed; don't fetch until it opens.
  const { noteFor } = useExerciseNotes(!!routine);
  const swapCatalog = useSwapCatalog(!!routine && !!allowSwap);
  const canSwap = !!allowSwap && swapCatalog.available;
  // This session's swaps (slot key -> exercise), and the slot whose swap list is open.
  const [swaps, setSwaps] = useState<SessionSwaps>({});
  const [swapping, setSwapping] = useState<string | null>(null);
  // A new routine in the sheet starts from its own plan.
  useEffect(() => {
    setSwaps({});
    setSwapping(null);
  }, [routine?.id]);
  const catalogById = useMemo(() => new Map(swapCatalog.exercises.map((e) => [e.id, e])), [swapCatalog.exercises]);

  // <Portal> has no onRequestClose (unlike RN <Modal>), so wire the Android
  // hardware back button to dismiss the sheet while it's open. On the swap
  // list it goes back to the session first.
  useEffect(() => {
    if (!routine) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (swapping) setSwapping(null);
      else onClose();
      return true;
    });
    return () => sub.remove();
  }, [routine, onClose, swapping]);

  if (!routine) return null;

  const sortedExercises = [...routine.routine_exercises].sort((a, b) => a.order - b.order);
  // Superset members are contiguous once sorted; flag the first of each run so we
  // can label it once and run a left accent down the whole group (a bracket).
  // What each slot holds now: its swap for this session, or the plan's exercise.
  const shownOf = (re: RoutineExerciseRaw) => swaps[slotKey(re)] ?? re.exercises;
  const swapCount = sortedExercises.filter((re) => swaps[slotKey(re)]).length;
  const swapSlot = swapping ? sortedExercises.find((re) => slotKey(re) === swapping) ?? null : null;
  const openSwap = (re: RoutineExerciseRaw) => {
    track('today_swap_opened', { routine_id: routine.id, swapped_already: !!swaps[slotKey(re)] });
    setSwapping(slotKey(re));
  };
  const supersetRows = sortedExercises.map((re, i) => {
    const g = re.superset_group ?? null;
    const prevG = i > 0 ? (sortedExercises[i - 1].superset_group ?? null) : null;
    return { grouped: g != null, isFirstInGroup: g != null && g !== prevG };
  });

  return (
    <Portal>
      <View style={s.backdrop}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]}
          onPress={onClose}
        />
        <Animated.View
          entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[s.detailSheet, {
            backgroundColor: C.card,
            borderColor: C.border,
            paddingBottom: insets.bottom + Spacing.md,
          }]}
        >
          <View style={[s.handle, { backgroundColor: C.handle }]} />

          {swapSlot ? (
            <ExerciseSwapList
              from={catalogById.get(shownOf(swapSlot).id) ?? shownOf(swapSlot)}
              original={swaps[slotKey(swapSlot)] ? (catalogById.get(swapSlot.exercise_id) ?? swapSlot.exercises) : null}
              exercises={swapCatalog.exercises}
              doneIds={swapCatalog.doneIds}
              excludeIds={new Set(sortedExercises.flatMap((re) => [shownOf(re).id, re.exercise_id]))}
              onPick={(row, tier) => {
                const key = slotKey(swapSlot);
                track('today_exercise_swapped', {
                  routine_id: routine.id,
                  tier,
                  done_before: swapCatalog.doneIds.has(row.id),
                  tagged: !!row.swap_pattern,
                });
                setSwaps((prev) => ({
                  ...prev,
                  [key]: { id: row.id, name: row.name, muscle_group: row.muscle_group, category: row.category, metric_type: row.metric_type ?? null },
                }));
                setSwapping(null);
              }}
              onRestore={() => {
                track('today_swap_undone', { routine_id: routine.id });
                setSwaps((prev) => {
                  const next = { ...prev };
                  delete next[slotKey(swapSlot)];
                  return next;
                });
                setSwapping(null);
              }}
              onBack={() => setSwapping(null)}
            />
          ) : (<>
          {/* Header */}
          <View style={s.detailHeader}>
            <View style={{ flex: 1 }}>
              <Text style={[s.detailTitle, { color: C.foreground }]} numberOfLines={1}>
                {routine.name}
              </Text>
              {routine.description ? (
                <Text style={[s.detailDesc, { color: C.mutedFg }]} numberOfLines={2}>
                  {routine.description}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={onClose} style={[s.sheetCloseBtn, { backgroundColor: C.closeBtn }]}>
              <Feather name="x" size={15} color={C.foreground} />
            </TouchableOpacity>
          </View>

          {/* Exercises list */}
          <View style={s.detailExercisesLabel}>
            <Text style={[s.exercisesLabel, { color: C.textMuted }]}>
              EXERCISES ({sortedExercises.length})
            </Text>
            {swapCount > 0 ? (
              <Text style={[s.swapCount, { color: C.accentText }]}>
                {swapCount} swapped for today
              </Text>
            ) : null}
          </View>

          <ScrollView
            style={{ flexShrink: 1, flexGrow: 1 }}
            contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md }}
            showsVerticalScrollIndicator
          >
            {sortedExercises.map((re, i) => {
              const { grouped, isFirstInGroup } = supersetRows[i];
              const shown = shownOf(re);
              const swapped = shown !== re.exercises;
              return (
                <View key={`${re.exercise_id}-${i}`}>
                  {isFirstInGroup ? (
                    <View style={s.supersetLabelRow}>
                      <Feather name="link" size={10} color={C.accentText} />
                      <Text style={[s.supersetLabel, { color: C.accentText }]}>SUPERSET</Text>
                    </View>
                  ) : null}
                  <View
                    style={[
                      s.detailExRow,
                      { borderBottomColor: C.borderSubtle },
                      grouped ? { borderLeftWidth: 3, borderLeftColor: Colors.primary, paddingLeft: 10 } : null,
                    ]}
                  >
                    <View style={[s.detailExDot, { backgroundColor: C.primaryMuted }]}>
                      <Text style={[s.detailExIdx, { color: C.accentText }]}>{i + 1}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.detailExName, { color: C.foreground }]}>
                        {shown?.name || 'Unknown'}
                      </Text>
                      {swapped ? (
                        <Text style={[s.detailExSwapped, { color: C.accentText }]} numberOfLines={1}>
                          Swapped from {re.exercises?.name || 'the plan'}
                        </Text>
                      ) : null}
                      <Text style={[s.detailExMeta, { color: C.textMuted }]}>
                        {re.sets} sets · {routineSlotLabel(re)}{re.rest_seconds}s rest
                      </Text>
                      {re.note && !swapped ? (
                        <Text style={[s.detailExNote, { color: C.accentText }]} numberOfLines={3}>
                          {re.note}
                        </Text>
                      ) : null}
                      {/* The user's own sticky note for this exercise. Follows
                          the exercise into every routine that uses it, so it
                          shows here without the routine storing anything.
                          Deliberately quieter than the coach cue above and
                          marked with the same bookmark icon the session screen
                          uses, so the two never read as one voice. */}
                      {(() => {
                        const own = noteFor(shown?.name);
                        return own ? (
                          <View style={s.detailExOwnNoteRow}>
                            <Feather name="bookmark" size={10} color={C.textMuted} style={s.detailExOwnNoteIcon} />
                            <Text style={[s.detailExOwnNote, { color: C.mutedFg }]} numberOfLines={3}>
                              {own}
                            </Text>
                          </View>
                        ) : null;
                      })()}
                    </View>
                    {shown?.muscle_group && shown.muscle_group !== 'Other' ? (
                      <View style={[s.detailExBadge, { backgroundColor: C.muted }]}>
                        <Text style={[s.detailExBadgeText, { color: C.textSecondary }]}>
                          {shown.muscle_group}
                        </Text>
                      </View>
                    ) : null}
                    {canSwap ? (
                      <TouchableOpacity
                        onPress={() => openSwap(re)}
                        style={[s.swapBtn, { backgroundColor: swapped ? C.primaryMuted : C.closeBtn }]}
                        hitSlop={8}
                        accessibilityLabel={`Swap ${shown?.name ?? 'this exercise'}`}
                      >
                        <Feather name="shuffle" size={12} color={swapped ? C.accentText : C.foreground} />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </ScrollView>

          {/* Footer Actions */}
          <View style={s.detailFooter}>
            {onEdit ? (
              <TouchableOpacity
                onPress={onEdit}
                style={[s.secondaryBtn, { backgroundColor: C.muted, borderColor: C.border }]}
                activeOpacity={0.8}
              >
                <Feather name="edit-2" size={14} color={C.foreground} />
                <Text style={[s.secondaryBtnText, { color: C.foreground }]}>Edit</Text>
              </TouchableOpacity>
            ) : null}
            {onAskCoach ? (
              <TouchableOpacity
                onPress={onAskCoach}
                style={[s.secondaryBtn, { backgroundColor: C.muted, borderColor: C.border }]}
                activeOpacity={0.8}
              >
                <Feather name="message-circle" size={14} color={C.accentText} />
                <Text style={[s.secondaryBtnText, { color: C.foreground }]}>Ask Drona</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              onPress={() => onStartWorkout(canSwap ? swaps : {})}
              style={s.startWorkoutBtn}
              activeOpacity={0.8}
            >
              <Feather name="play" size={16} color={Colors.primaryFg} />
              <Text style={s.startWorkoutBtnText}>Start Workout</Text>
            </TouchableOpacity>
          </View>
          </>)}
        </Animated.View>
      </View>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 4,
    flexShrink: 0,
  },
  detailSheet: {
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    borderTopWidth: 1,
    paddingBottom: Spacing.xxl,
    height: '80%',
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
    gap: 12,
    flexShrink: 0,
  },
  detailTitle: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    letterSpacing: -0.3,
  },
  detailDesc: {
    fontSize: FontSize.sm,
    marginTop: 4,
    lineHeight: 18,
  },
  sheetCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailExercisesLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    marginBottom: Spacing.sm,
    flexShrink: 0,
  },
  swapCount: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
  },
  detailExSwapped: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  swapBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  exercisesLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  detailExRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  // "SUPERSET" caption above the first member of a group; the rows below it carry
  // a lime left accent so the group reads as one bracketed block.
  supersetLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
    marginBottom: 2,
    paddingLeft: 2,
  },
  supersetLabel: {
    fontSize: 9,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.2,
  },
  detailExDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailExIdx: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
  },
  detailExName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  detailExMeta: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  detailExNote: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
    marginTop: 4,
    lineHeight: 14,
  },
  detailExOwnNoteRow: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 4,
  },
  // Top-aligned so the icon stays on the first line of a wrapped note.
  detailExOwnNoteIcon: {
    marginTop: 1,
  },
  detailExOwnNote: {
    flex: 1,
    fontSize: FontSize.xs,
    lineHeight: 14,
  },
  detailExBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  detailExBadgeText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
  },
  detailFooter: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    flexShrink: 0,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    borderWidth: 1,
    flexShrink: 0,
  },
  secondaryBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  startWorkoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    backgroundColor: Colors.primary,
    flex: 1,
  },
  startWorkoutBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.black,
    color: Colors.primaryFg,
  },
});
