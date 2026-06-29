import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeInDown, useSharedValue, useAnimatedStyle, withTiming, type SharedValue } from 'react-native-reanimated';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Colors, Spacing, Radius, FontSize, FontWeight, Shadow, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { getGuestWorkouts, removeGuestWorkout } from '@/lib/guestStore';
import { abbreviateNumber, formatWeight, formatDuration as formatSetDuration, formatDistanceKm } from '@/lib/format';
import { metricTypeDef, metricTypeOf } from '@/lib/exercises';
import type { MetricType } from '@/lib/exercises';
import { SetTypeBadge, setTypeOf } from '@/components/workout/SetTypeBadge';
import { getXpForWorkout } from '@/lib/xp';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import { useToast } from '@/components/ui/Toast';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { hydrateCache, readCache, writeCache, evictWorkoutFromCaches } from '@/lib/localCache';
import { getPendingWorkouts, removePendingWorkout } from '@/lib/syncQueue';
import { pendingToHistoryRow } from '@/lib/pendingAdapters';
import { applyEditsToHistoryRows, getPendingEdit, removePendingEdit } from '@/lib/editQueue';
import { useSync } from '@/components/SyncProvider';

const ROUTINE_COLORS = Colors.routineColors;

const WEEK_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface ExerciseDetail {
  name: string;
  metric_type?: MetricType;
  sets: { weight_kg: number; reps: number; completed: boolean; duration_seconds?: number | null; distance_m?: number | null; resistance?: number | null; set_type?: string; rpe?: number | null; is_unilateral?: boolean; reps_right?: number | null; rpe_right?: number | null; weight_kg_right?: number | null; superset_group?: number | null }[];
}
type HistorySet = ExerciseDetail['sets'][number];

/** Per-set pill text, axis-aware ("60kg × 8", "+10kg × 6", "0:45", "5km · 22:30", "12"). */
function historySetLabel(metricType: MetricType, s: HistorySet): string {
  const axes = metricTypeDef(metricType).axes;
  const usesWeightAxis = axes.some(a => a === 'weight' || a === 'added_weight' || a === 'assist_weight');
  // Per-side weight (migration 0059): a unilateral set whose two sides used different
  // loads spells both out ("40kg×8 / 35kg×7"); equal weights keep the compact form below.
  if (s.is_unilateral && usesWeightAxis && axes.includes('reps')
      && s.weight_kg_right != null && s.weight_kg_right !== s.weight_kg) {
    const pre = axes.includes('assist_weight') ? '-' : axes.includes('added_weight') ? '+' : '';
    return `${pre}${formatWeight(s.weight_kg)}kg×${s.reps} / ${pre}${formatWeight(s.weight_kg_right)}kg×${s.reps_right ?? 0}`;
  }
  const parts = axes.map((a) =>
    // A unilateral set shows both sides on the reps axis (weight is shared).
    a === 'reps' ? (s.is_unilateral ? `${s.reps}/${s.reps_right ?? 0}` : `${s.reps}`)
    : a === 'duration' ? formatSetDuration(s.duration_seconds)
    : a === 'distance' ? `${formatDistanceKm(s.distance_m)}km`
    : a === 'resistance' ? `Lv ${s.resistance ?? 0}`
    : a === 'assist_weight' ? `-${formatWeight(s.weight_kg)}kg`
    : a === 'added_weight' ? `+${formatWeight(s.weight_kg)}kg`
    : `${formatWeight(s.weight_kg)}kg`,
  );
  const usesWeight = axes.some(a => a === 'weight' || a === 'added_weight' || a === 'assist_weight');
  return usesWeight && axes.includes('reps') ? parts.join(' × ') : parts.join(' · ');
}

/** Headline "best" stat for an exercise's completed sets (heaviest / longest / farthest / most reps). */
function historyBest(metricType: MetricType, sets: HistorySet[]): string {
  const axes = metricTypeDef(metricType).axes;
  if (axes.includes('distance')) {
    return `${formatDistanceKm(Math.max(0, ...sets.map(s => s.distance_m ?? 0)))}km`;
  }
  if (axes.includes('duration') && !axes.some(a => a === 'weight')) {
    return formatSetDuration(Math.max(0, ...sets.map(s => s.duration_seconds ?? 0)));
  }
  if (axes.some(a => a === 'weight' || a === 'added_weight' || a === 'assist_weight')) {
    return `${formatWeight(Math.max(0, ...sets.map(s => s.weight_kg), ...sets.map(s => s.weight_kg_right ?? 0)))}kg`;
  }
  return `${Math.max(0, ...sets.map(s => s.reps), ...sets.map(s => s.reps_right ?? 0))} reps`;
}

interface WorkoutRaw {
  id: string;
  name: string;
  started_at: string;
  finished_at?: string;
  duration_seconds?: number;
  total_volume_kg?: number;
  routine_id?: string;
  workout_sets?: { id: string }[];
  exercises?: ExerciseDetail[];
  notes?: string;
}

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function formatDateShort(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  ) return 'Today';

  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) return 'Yesterday';

  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatVolume(kg?: number) {
  if (!kg) return '—';
  return `${abbreviateNumber(kg)} kg`;
}

function isSameDay(d1: Date, d2: Date) {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

function isSameMonth(d1: Date, d2: Date) {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth();
}

// ─── Month Calendar ───────────────────────────────────────────────────────────
function MonthCalendar({
  year,
  month,
  workouts,
  selectedDate,
  onSelectDate,
  onPrev,
  onNext,
  onToday,
}: {
  year: number;
  month: number;
  workouts: WorkoutRaw[];
  selectedDate: Date | null;
  onSelectDate: (date: Date | null) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  const { C } = useTheme();
  const today = new Date();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const showTodayBtn = !isSameMonth(new Date(year, month, 1), today);

  // Count workouts per day
  const workoutCounts = useMemo(() => {
    const map: Record<string, number> = {};
    workouts.forEach((w) => {
      const d = new Date(w.started_at);
      if (d.getFullYear() === year && d.getMonth() === month) {
        const key = `${year}-${month}-${d.getDate()}`;
        map[key] = (map[key] || 0) + 1;
      }
    });
    return map;
  }, [workouts, year, month]);

  const monthWorkoutCount = workouts.filter((w) => {
    const d = new Date(w.started_at);
    return d.getFullYear() === year && d.getMonth() === month;
  }).length;

  // Build calendar cells
  const cells: (number | null)[] = [];
  // Add days from previous month
  const prevMonthDays = new Date(year, month, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) cells.push(-(prevMonthDays - i));
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  // Add days from next month
  const remaining = 42 - cells.length;
  for (let i = 1; i <= remaining; i++) cells.push(null);

  const isToday = (d: number) =>
    today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;

  return (
    <View style={[styles.calendarCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
      {/* Month navigation */}
      <View style={styles.calHeader}>
        <TouchableOpacity
          onPress={onPrev}
          style={[styles.calNavBtn, { backgroundColor: C.glowBg }]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Feather name="chevron-left" size={16} color={C.mutedFg} />
        </TouchableOpacity>

        <View style={styles.calTitleWrap}>
          <Text style={[styles.calMonthTitle, { color: C.foreground }]}>
            {MONTH_NAMES[month]} {year}
          </Text>
          <Text style={[styles.calMonthSub, { color: C.textMuted }]}>
            {monthWorkoutCount} workout{monthWorkoutCount !== 1 ? 's' : ''}
          </Text>
        </View>

        <View style={styles.calRightNav}>
          {showTodayBtn && (
            <TouchableOpacity
              onPress={onToday}
              style={[styles.todayBtn, { backgroundColor: C.primaryMuted }]}
            >
              <Text style={[styles.todayBtnText, { color: C.accentText }]}>Today</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={onNext}
            style={[styles.calNavBtn, { backgroundColor: C.glowBg }]}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Feather name="chevron-right" size={16} color={C.mutedFg} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Day headers */}
      <View style={styles.calWeekRow}>
        {WEEK_LABELS.map((l, i) => (
          <View key={i} style={styles.calWeekCell}>
            <Text style={[styles.calWeekLabel, { color: C.textDim }]}>{l}</Text>
          </View>
        ))}
      </View>

      {/* Day grid */}
      {Array.from({ length: Math.ceil(cells.length / 7) }, (_, row) => (
        <View key={row} style={styles.calDayRow}>
          {cells.slice(row * 7, row * 7 + 7).map((day, col) => {
            // Out of month cells (prev/next month or null)
            if (!day || day < 1) {
              const outDay = day ? Math.abs(day) + (prevMonthDays - firstDay + 1) : '';
              return (
                <View key={col} style={styles.calDayCell}>
                  <View style={[styles.calDaySquare, { backgroundColor: 'transparent', opacity: 0.3 }]}>
                    {outDay ? (
                      <Text style={[styles.calDayNum, { color: C.textDim }]}>{typeof day === 'number' && day < 0 ? prevMonthDays + day + 1 : ''}</Text>
                    ) : null}
                  </View>
                </View>
              );
            }

            const key = `${year}-${month}-${day}`;
            const count = workoutCounts[key] || 0;
            const hasWorkout = count > 0;
            const todayDay = isToday(day);
            const isSelected = selectedDate && isSameDay(selectedDate, new Date(year, month, day));

            // Intensity: brighter green for more workouts
            const intensity = count >= 3 ? 1 : count >= 2 ? 0.8 : count >= 1 ? 0.6 : 0;

            const bgColor = hasWorkout
              ? colorWithAlpha(Colors.calendar.base, intensity)
              : C.glowBg;

            const textColor = hasWorkout
              ? intensity >= 0.8 ? '#0a0a0a' : '#365314'
              : C.textSecondary;

            return (
              <View key={col} style={styles.calDayCell}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => {
                    if (isSelected) {
                      onSelectDate(null);
                    } else {
                      onSelectDate(new Date(year, month, day));
                    }
                  }}
                  style={[
                    styles.calDaySquare,
                    { backgroundColor: bgColor },
                    hasWorkout && {
                      shadowColor: Colors.calendar.base,
                      shadowOffset: { width: 0, height: 0 },
                      shadowOpacity: intensity * 0.3,
                      shadowRadius: 8,
                    },
                    isSelected && {
                      borderWidth: 2,
                      borderColor: C.accentText,
                    },
                    todayDay && !hasWorkout && !isSelected && {
                      borderWidth: 1.5,
                      borderColor: C.primaryBorder,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.calDayNum,
                      {
                        color: textColor,
                        fontWeight: hasWorkout || todayDay ? FontWeight.semibold : FontWeight.regular,
                      },
                    ]}
                  >
                    {day}
                  </Text>
                  {/* Multi-workout indicator */}
                  {count >= 2 && (
                    <View
                      style={[
                        styles.multiDot,
                        { backgroundColor: count >= 3 ? Colors.calendar.max : Colors.calendar.multi },
                      ]}
                    />
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      ))}

      {/* Legend */}
      <View style={[styles.calLegend, { borderTopColor: C.borderSubtle }]}>
        <View style={styles.legendItem}>
          <View style={[styles.legendSquare, { backgroundColor: C.glowBg }]} />
          <Text style={[styles.legendText, { color: C.textDim }]}>Rest</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendSquare, { backgroundColor: colorWithAlpha(Colors.calendar.base, 0.6) }]} />
          <Text style={[styles.legendText, { color: C.textDim }]}>Trained</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendSquare, { backgroundColor: Colors.calendar.max, borderRadius: 999 }]} />
          <Text style={[styles.legendText, { color: C.textDim }]}>Multiple sessions</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Session Card ─────────────────────────────────────────────────────────────
function SessionCard({
  workout,
  colorIndex,
  onDelete,
  onEdit,
  openRowRef,
}: {
  workout: WorkoutRaw;
  colorIndex: number;
  onDelete: () => void;
  onEdit: () => void;
  openRowRef: { current: SwipeableMethods | null };
}) {
  const { C } = useTheme();
  const [expanded, setExpanded] = useState(false);
  // Rotate the chevron 180deg as the card expands.
  const chevronRot = useSharedValue(0);
  useEffect(() => {
    chevronRot.value = withTiming(expanded ? 1 : 0, { duration: 200 });
  }, [expanded]);
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${chevronRot.value * 180}deg` }] }));
  const swipeRef = useRef<SwipeableMethods>(null);
  // Tracks the tray's open state so a tap on an open card closes it instead of
  // toggling the expanded details underneath. (ReanimatedSwipeable also closes
  // on tap-when-open via box-only pointer events; this JS guard is a
  // deterministic fallback that doesn't depend on that internal behaviour.)
  const isOpenRef = useRef(false);
  const dotColor = ROUTINE_COLORS[colorIndex % ROUTINE_COLORS.length];
  const exerciseCount = workout.exercises?.length ?? 0;
  // If this card unmounts while it owns the shared open-row pointer (deleted or
  // filtered out by search), drop the dangling reference.
  useEffect(() => () => {
    if (openRowRef.current === swipeRef.current) openRowRef.current = null;
  }, []);

  // Swipe-left reveals Edit + Delete. Edit sits nearer the content; Delete (red)
  // is at the trailing edge so reaching it takes a fuller, more deliberate pull.
  // Neither auto-fires — you tap the action, and Delete still routes through the
  // confirm alert. We close the tray first so it doesn't linger open behind the
  // edit screen / confirm dialog.
  const renderRightActions = (
    _progress: SharedValue<number>,
    _translation: SharedValue<number>,
    swipeable: SwipeableMethods,
  ) => (
    <View style={styles.swipeActions}>
      <TouchableOpacity
        onPress={() => { swipeable.close(); onEdit(); }}
        style={[styles.swipeBtn, { backgroundColor: C.muted, borderColor: C.borderSubtle }]}
        accessibilityRole="button"
        accessibilityLabel="Edit workout"
      >
        <Feather name="edit-2" size={14} color={C.mutedFg} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => { swipeable.close(); onDelete(); }}
        style={[styles.swipeBtn, { backgroundColor: Colors.dangerBg, borderColor: 'transparent' }]}
        accessibilityRole="button"
        accessibilityLabel="Delete workout"
      >
        <Feather name="trash-2" size={14} color={C.dangerText} />
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[styles.workoutCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
      <ReanimatedSwipeable
        ref={swipeRef}
        friction={2}
        rightThreshold={36}
        overshootRight={false}
        renderRightActions={renderRightActions}
        // Only one row open at a time: opening this one closes whichever was open.
        onSwipeableWillOpen={() => {
          if (openRowRef.current && openRowRef.current !== swipeRef.current) {
            openRowRef.current.close();
          }
          openRowRef.current = swipeRef.current;
        }}
        onSwipeableOpen={() => { isOpenRef.current = true; }}
        onSwipeableClose={() => {
          isOpenRef.current = false;
          // Keep the shared open-row pointer honest after this row closes.
          if (openRowRef.current === swipeRef.current) openRowRef.current = null;
        }}
      >
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => {
            if (isOpenRef.current) { swipeRef.current?.close(); return; }
            setExpanded((v) => !v);
          }}
          style={[styles.workoutCardTop, { backgroundColor: C.card }]}
          accessibilityRole="button"
          accessibilityLabel={`${workout.name}, ${formatDateShort(workout.started_at)}${exerciseCount > 0 ? `, ${exerciseCount} exercise${exerciseCount !== 1 ? 's' : ''}` : ''}`}
          accessibilityHint="Double tap to expand. Use the actions menu to edit or delete."
          accessibilityState={{ expanded }}
          // Screen-reader parity for the swipe actions — VoiceOver / TalkBack
          // expose these via the rotor, so editing / deleting never needs a swipe.
          accessibilityActions={[
            { name: 'edit', label: 'Edit workout' },
            { name: 'delete', label: 'Delete workout' },
          ]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'edit') onEdit();
            else if (e.nativeEvent.actionName === 'delete') onDelete();
          }}
        >
          {/* Color dot */}
          <View style={[styles.wDotWrap, { backgroundColor: `${dotColor}15` }]}>
            <View style={[styles.wDot, { backgroundColor: dotColor }]} />
          </View>

          {/* Info */}
          <View style={styles.wInfo}>
            <Text style={[styles.wName, { color: C.foreground }]} numberOfLines={1}>
              {workout.name}
            </Text>
            <Text style={[styles.wDate, { color: C.textMuted }]}>
              {formatDateShort(workout.started_at)}
            </Text>
            <View style={styles.wMeta}>
              {workout.duration_seconds ? (
                <View style={styles.wMetaItem}>
                  <Feather name="clock" size={10} color={C.textSecondary} />
                  <Text style={[styles.wMetaText, { color: C.textSecondary }]}>
                    {formatDuration(workout.duration_seconds)}
                  </Text>
                </View>
              ) : null}
              {workout.total_volume_kg ? (
                <View style={styles.wMetaItem}>
                  <Feather name="trending-up" size={10} color={C.textSecondary} />
                  <Text style={[styles.wMetaText, { color: C.textSecondary }]}>
                    {formatVolume(workout.total_volume_kg)}
                  </Text>
                </View>
              ) : null}
              {exerciseCount > 0 && (
                <View style={styles.wMetaItem}>
                  <Feather name="activity" size={10} color={C.textSecondary} />
                  <Text style={[styles.wMetaText, { color: C.textSecondary }]}>
                    {exerciseCount} exercise{exerciseCount !== 1 ? 's' : ''}
                  </Text>
                </View>
              )}
            </View>
          </View>

          {/* A discoverable tap-entry to the same Edit / Delete tray the
              left-swipe reveals (for anyone who doesn't think to swipe), above
              the expand chevron. */}
          <View style={styles.wActions}>
            <TouchableOpacity
              onPress={() => swipeRef.current?.openRight()}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Edit or delete workout"
              style={styles.moreBtn}
            >
              <Feather name="more-vertical" size={15} color={C.textMuted} />
            </TouchableOpacity>
            <Animated.View style={chevronStyle}>
              <Feather name="chevron-down" size={14} color={C.textMuted} />
            </Animated.View>
          </View>
        </TouchableOpacity>
      </ReanimatedSwipeable>

      {/* Expanded exercise details */}
      {expanded && (
        <Animated.View entering={FadeInDown.duration(160)} style={[styles.wExpandedSection, { borderTopColor: C.borderSubtle }]}>
          {workout.exercises && workout.exercises.length > 0 ? (
            workout.exercises.map((ex, i) => {
              const completedSets = ex.sets?.filter(s => s.completed) || [];
              if (completedSets.length === 0) return null;
              const mt = metricTypeOf(ex);
              return (
                <View key={i} style={styles.exerciseRow}>
                  <View style={styles.exerciseInfo}>
                    <Text style={[styles.exerciseName, { color: C.foreground }]}>{ex.name}</Text>
                    <View style={styles.setPills}>
                      {completedSets.map((set, si) => (
                        <View
                          key={si}
                          style={[styles.setPill, { backgroundColor: C.muted, flexDirection: 'row', alignItems: 'center', gap: 4 }]}
                        >
                          {set.set_type && set.set_type !== 'normal' && (
                            <SetTypeBadge type={setTypeOf(set.set_type)} size={15} />
                          )}
                          <Text style={[styles.setPillText, { color: C.mutedFg }]}>
                            {historySetLabel(mt, set)}
                          </Text>
                          {(set.rpe != null || (set.is_unilateral && set.rpe_right != null)) && (
                            <Text style={[styles.setPillText, { color: C.textMuted }]}>
                              @{set.rpe ?? '–'}{set.is_unilateral && set.rpe_right != null ? `/${set.rpe_right}` : ''}
                            </Text>
                          )}
                        </View>
                      ))}
                    </View>
                  </View>
                  <View style={styles.exerciseBest}>
                    <Text style={[styles.bestWeight, { color: C.accentText }]}>{historyBest(mt, completedSets)}</Text>
                    <Text style={[styles.bestLabel, { color: C.textMuted }]}>best</Text>
                  </View>
                </View>
              );
            })
          ) : (
            <Text style={[styles.noExercises, { color: C.mutedFg }]}>
              {workout.notes || 'No exercise details available.'}
            </Text>
          )}
          {workout.notes && workout.exercises && workout.exercises.length > 0 && (
            <View style={[styles.notesSection, { borderTopColor: C.borderSubtle }]}>
              <Text style={[styles.notesLabel, { color: C.textMuted }]}>Notes</Text>
              <Text style={[styles.notesText, { color: C.mutedFg }]}>{workout.notes}</Text>
            </View>
          )}
        </Animated.View>
      )}
    </View>
  );
}

// ─── Month Group Header ───────────────────────────────────────────────────────
function MonthGroupHeader({ label, count }: { label: string; count: number }) {
  const { C } = useTheme();
  return (
    <View style={styles.groupHeader}>
      <Text style={[styles.groupLabel, { color: C.textMuted }]}>{label}</Text>
      <View style={[styles.groupBadge, { backgroundColor: C.card }]}>
        <Text style={[styles.groupBadgeText, { color: C.textDim }]}>{count}</Text>
      </View>
      <View style={[styles.groupDivider, { backgroundColor: C.borderSubtle }]} />
    </View>
  );
}

// ─── Skeleton Loader ──────────────────────────────────────────────────────────
function SkeletonCards() {
  const { C } = useTheme();
  return (
    <View style={styles.skeletonWrap}>
      {[1, 2, 3, 4].map((i) => (
        <View
          key={i}
          style={[styles.skeletonCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
        />
      ))}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function HistoryScreen() {
  const { C } = useTheme();
  const router = useRouter();
  const { user, isLoaded: clerkLoaded } = useClerkUser();
  const isGuestSession = useIsGuestSession();
  const supabase = useSupabaseClient();
  const toast = useToast();
  const { pendingCount } = useSync();
  const [workouts, setWorkouts] = useState<WorkoutRaw[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  const today = new Date();
  const [calYear, setCalYear] = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth());

  const scrollRef = useRef<ScrollView>(null);
  // The single currently-open swipe row, so opening one closes any other.
  const openRowRef = useRef<SwipeableMethods | null>(null);
  const searchBarY = useRef(0);

  const fetchWorkouts = useCallback(async () => {
    if (isGuestSession) {
      setWorkouts(getGuestWorkouts() as unknown as WorkoutRaw[]);
      return;
    }
    const clerkId = user?.id;

    // Prepend not-yet-synced workouts (saved locally, still in the flush queue),
    // deduped against rows already on the server by client_id, so a just-finished
    // offline workout shows immediately.
    const withPending = (base: WorkoutRaw[]): WorkoutRaw[] => {
      const serverClientIds = new Set(
        base.map((w: any) => w?.client_id).filter(Boolean),
      );
      const pending = clerkId
        ? getPendingWorkouts(clerkId).filter((e) => !serverClientIds.has(e.clientId))
        : [];
      // Overlay any not-yet-synced edits on top so a revalidate of the server
      // rows doesn't paint over an edit that hasn't reached Supabase yet.
      return applyEditsToHistoryRows(clerkId, [
        ...pending.map(pendingToHistoryRow),
        ...base,
      ]) as WorkoutRaw[];
    };

    await hydrateCache(clerkId);
    const cached = readCache<WorkoutRaw[]>('historyWorkouts', clerkId);
    // Always merge pending on top, even with no cache yet (e.g. a fresh login
    // that never loaded History online), so a just-finished offline workout
    // shows immediately instead of waiting for connectivity.
    setWorkouts(withPending(cached ?? []));
    // Clear the spinner now that we've painted from cache — the network
    // revalidation below runs in the background and must not hold the spinner
    // (offline it can hang, which left the screen spinning forever).
    setLoading(false);

    const sinceIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    let q = supabase
      .from('workouts')
      .select('*, workout_sets(id, exercise_id, weight_kg, reps, completed, duration_seconds, distance_m, resistance, set_type, rpe, is_unilateral, reps_right, rpe_right, weight_kg_right, superset_group, exercises(name, metric_type))')
      .gte('started_at', sinceIso)
      .order('started_at', { ascending: false });
    if (clerkId) q = q.eq('user_id', clerkId);
    try {
      const { data, error } = await q;
      if (error) throw error;
      // Transform supabase data to include exercises grouping
      const transformed = (data || []).map((w: any) => {
        const exerciseMap: Record<string, ExerciseDetail> = {};
        (w.workout_sets || []).forEach((s: any) => {
          const exId = s.exercise_id;
          if (!exerciseMap[exId]) {
            exerciseMap[exId] = { name: s.exercises?.name || 'Exercise', metric_type: s.exercises?.metric_type, sets: [] };
          }
          exerciseMap[exId].sets.push({ weight_kg: s.weight_kg, reps: s.reps, completed: s.completed, duration_seconds: s.duration_seconds, distance_m: s.distance_m, resistance: s.resistance, set_type: s.set_type, rpe: s.rpe, is_unilateral: s.is_unilateral, reps_right: s.reps_right, rpe_right: s.rpe_right, weight_kg_right: s.weight_kg_right, superset_group: s.superset_group });
        });
        return {
          ...w,
          exercises: Object.values(exerciseMap),
          workout_sets: (w.workout_sets || []).map((s: any) => ({ id: s.id })),
        };
      });
      writeCache('historyWorkouts', clerkId, transformed);
      setWorkouts(withPending(transformed));
    } catch {
      // Offline / fetch failed — keep the cache-first + pending view; never blank.
    }
  }, [user?.id, isGuestSession]);

  useEffect(() => {
    // Mid-hydration Clerk has no user yet, so isGuestSession reads true and a
    // signed-in user would flash an empty guest history on cold launch.
    // Hold the spinner until Clerk settles; the effect re-runs when it does.
    if (!clerkLoaded) return;
    fetchWorkouts().finally(() => setLoading(false));
  }, [fetchWorkouts, clerkLoaded, pendingCount]);

  // Re-pull on focus so an edit made on the edit screen (guest / pending /
  // synced) is reflected the moment the user returns to History. fetchWorkouts
  // is cache-first, so this paints instantly and revalidates in the background.
  useFocusEffect(
    useCallback(() => {
      if (clerkLoaded) fetchWorkouts();
    }, [clerkLoaded, fetchWorkouts]),
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchWorkouts();
    setRefreshing(false);
  }, [fetchWorkouts]);

  const handleDelete = (id: string) => {
    setDeleteId(id);
  };

  // Parameterized worker so Retry doesn't need to round-trip through deleteId state.
  const performDelete = async (id: string) => {
    const previous = workouts;
    setWorkouts((prev) => prev.filter((w) => w.id !== id));

    if (isGuestSession) {
      // Persist the delete in the guest store so it stays gone after the next
      // fetchWorkouts() (which reads from getGuestWorkouts). A false return
      // means the id wasn't in the store — roll the optimistic delete back
      // instead of letting the row silently reappear on the next refresh.
      if (!removeGuestWorkout(id)) {
        setWorkouts(previous);
        toast.error("Couldn't delete workout");
        return;
      }
      toast.success('Workout deleted');
      return;
    }

    // A not-yet-synced workout lives only in the local queue (its id is the
    // clientId, not a server row), so drop it there instead of hitting Supabase.
    const clerkId = user?.id;
    if (clerkId && getPendingWorkouts(clerkId).some((e) => e.clientId === id)) {
      removePendingWorkout(clerkId, id);
      toast.success('Workout deleted');
      return;
    }

    try {
      let q = supabase.from('workouts').delete().eq('id', id);
      if (user?.id) q = q.eq('user_id', user.id);
      const { error } = await q;
      if (error) throw error;
      // Refund the XP this workout awarded — xp is a running counter, so a
      // delete must decrement it (otherwise deleting a synced workout leaves its
      // XP credited forever). If an edit was still queued, its XP delta never
      // reached the server, so refund the ORIGINAL baseline (not the edited
      // values). Best-effort; the workout row is already gone.
      const target = previous.find((w) => w.id === id);
      const pendingEdit = user?.id ? getPendingEdit(user.id, id) : null;
      const refundSets = pendingEdit ? pendingEdit.baseSetCount : (target?.workout_sets?.length ?? 0);
      const refundVol = pendingEdit ? pendingEdit.baseVolumeKg : (target?.total_volume_kg ?? 0);
      const earned = getXpForWorkout(refundSets, refundVol);
      if (earned > 0) supabase.rpc('award_xp', { p_earned: -earned }).then(() => {}, () => {});
      // Drop any queued edit for this workout so it doesn't flush against a
      // now-deleted row — the INSERT would FK-fail (23503), get misread as a
      // parkable data error, and keep retrying on every reconnect (backoff caps
      // at ~60s, so it never stops on its own).
      if (user?.id) removePendingEdit(user.id, id);
      // Prune it from the persisted workout caches so an offline reopen of
      // history/dashboard/analytics doesn't resurrect the deleted workout.
      evictWorkoutFromCaches(user?.id, id);
      toast.success('Workout deleted');
    } catch {
      setWorkouts(previous);
      toast.error("Couldn't delete workout", {
        action: { label: 'Retry', onPress: () => performDelete(id) },
      });
    }
  };

  const confirmDelete = () => {
    const id = deleteId;
    if (!id) return;
    setDeleteId(null);
    performDelete(id);
  };

  const handlePrevMonth = () => {
    if (calMonth === 0) {
      setCalMonth(11);
      setCalYear((y) => y - 1);
    } else {
      setCalMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (calMonth === 11) {
      setCalMonth(0);
      setCalYear((y) => y + 1);
    } else {
      setCalMonth((m) => m + 1);
    }
  };

  const handleToday = () => {
    const now = new Date();
    setCalYear(now.getFullYear());
    setCalMonth(now.getMonth());
  };

  // Filter by search and selected date, then group by month.
  // Memoized so per-keystroke filtering doesn't reprocess the full list +
  // O(n) lookups inside the group reducer on every render.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return workouts.filter((w) => {
      const matchSearch = !q ||
        w.name.toLowerCase().includes(q) ||
        w.exercises?.some(e => e.name.toLowerCase().includes(q));

      const matchDate = !selectedDate ||
        isSameDay(new Date(w.started_at), selectedDate);

      return matchSearch && matchDate;
    });
  }, [workouts, search, selectedDate]);

  const grouped = useMemo(() => {
    const out: { key: string; label: string; items: WorkoutRaw[] }[] = [];
    const byKey = new Map<string, { key: string; label: string; items: WorkoutRaw[] }>();
    for (const w of filtered) {
      const d = new Date(w.started_at);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      let g = byKey.get(key);
      if (!g) {
        g = { key, label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`, items: [] };
        byKey.set(key, g);
        out.push(g);
      }
      g.items.push(w);
    }
    return out;
  }, [filtered]);

  // Summary stats
  const totalVolume = useMemo(
    () => workouts.reduce((s, w) => s + (w.total_volume_kg || 0), 0),
    [workouts],
  );
  const totalWorkouts = workouts.length;

  return (
    <>
    <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.screenTitle, { color: C.foreground }]}>History</Text>
        <View style={styles.headerStats}>
          <Text style={[styles.headerStat, { color: C.textMuted }]}>
            {totalWorkouts} workouts
          </Text>
          <Text style={[styles.headerStat, { color: C.textMuted }]}>
            {`${abbreviateNumber(totalVolume)} kg`}{' '}
            total volume
          </Text>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
          />
        }
      >
        {/* Calendar */}
        {!loading && (
          <View style={styles.calWrap}>
            <MonthCalendar
              year={calYear}
              month={calMonth}
              workouts={workouts}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
              onPrev={handlePrevMonth}
              onNext={handleNextMonth}
              onToday={handleToday}
            />
          </View>
        )}

        {/* Active date filter indicator */}
        {selectedDate && (
          <View style={styles.dateFilterWrap}>
            <View style={[styles.dateFilterBar, { backgroundColor: C.primaryMuted }]}>
              <Text style={[styles.dateFilterText, { color: C.accentText }]}>
                Showing: {DAY_NAMES[selectedDate.getDay()]}, {MONTH_FULL[selectedDate.getMonth()]} {selectedDate.getDate()}, {selectedDate.getFullYear()}
              </Text>
              <TouchableOpacity
                onPress={() => setSelectedDate(null)}
                style={[styles.dateFilterClose, { backgroundColor: C.accentText }]}
                hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
                accessibilityRole="button"
                accessibilityLabel="Clear date filter"
              >
                <Feather name="x" size={10} color={Colors.primaryFg} />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Search */}
        {workouts.length > 0 && (
          <View
            style={styles.searchWrap}
            onLayout={(e) => { searchBarY.current = e.nativeEvent.layout.y; }}
          >
            <View style={[styles.searchBar, { backgroundColor: C.card, borderColor: C.borderLight }, Shadow.card]}>
              <Feather name="search" size={14} color={C.textMuted} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search workouts..."
                placeholderTextColor={C.textMuted}
                style={[styles.searchInput, { color: C.foreground }]}
                returnKeyType="search"
                onFocus={() => {
                  scrollRef.current?.scrollTo({ y: Math.max(0, searchBarY.current - 8), animated: true });
                }}
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={13} color={C.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Content */}
        {loading ? (
          <SkeletonCards />
        ) : workouts.length === 0 ? (
          <View style={styles.emptyWrap}>
            <View style={[styles.emptyIcon, { backgroundColor: C.card }]}>
              <Feather name="clock" size={24} color={C.textDim} />
            </View>
            <Text style={[styles.emptyTitle, { color: C.textMuted }]}>
              No workouts logged yet
            </Text>
            <Text style={[styles.emptySub, { color: C.textDim }]}>
              Get your first session in and it'll show up here.
            </Text>
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={[styles.emptyTitle, { color: C.textMuted }]}>
              {selectedDate
                ? `No workouts on ${MONTH_FULL[selectedDate.getMonth()]} ${selectedDate.getDate()}, ${selectedDate.getFullYear()}`
                : `No results for "${search}"`}
            </Text>
            {selectedDate && (
              <TouchableOpacity onPress={() => setSelectedDate(null)}>
                <Text style={[styles.clearFilterText, { color: C.accentText }]}>Clear filter</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          grouped.map((group, gIdx) => (
            <Animated.View
              key={group.key}
              entering={FadeInDown.delay(gIdx * 80).duration(350)}
              style={styles.monthGroup}
            >
              <MonthGroupHeader label={group.label} count={group.items.length} />
              <View style={styles.groupItems}>
                {group.items.map((workout, wIdx) => (
                  <SessionCard
                    key={workout.id}
                    workout={workout}
                    colorIndex={wIdx}
                    openRowRef={openRowRef}
                    onDelete={() => handleDelete(workout.id)}
                    onEdit={() => router.push(`/workout/edit/${workout.id}`)}
                  />
                ))}
              </View>
            </Animated.View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>

    <ThemedAlert
      visible={!!deleteId}
      icon="trash-2"
      iconColor="#ef4444"
      title="Delete Workout"
      message="Are you sure? This cannot be undone."
      buttons={[
        { text: 'Cancel', onPress: () => setDeleteId(null) },
        { text: 'Delete', style: 'destructive', onPress: confirmDelete },
      ]}
      onClose={() => setDeleteId(null)}
    />
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  // Header
  header: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  screenTitle: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.black,
    letterSpacing: -0.5,
  },
  headerStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.lg,
    marginTop: 4,
  },
  headerStat: {
    fontSize: FontSize.xs,
  },

  // Calendar
  calWrap: { paddingHorizontal: Spacing.xl, marginBottom: Spacing.md },
  calendarCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
    overflow: 'hidden',
  },
  calHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.lg,
  },
  calNavBtn: {
    width: 32,
    height: 32,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calRightNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  todayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.sm,
  },
  todayBtnText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
  },
  calTitleWrap: { alignItems: 'center' },
  calMonthTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  calMonthSub: { fontSize: FontSize.xs, marginTop: 2 },
  calWeekRow: { flexDirection: 'row', gap: 4, marginBottom: 4 },
  calWeekCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 4,
  },
  calWeekLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
  },
  calDayRow: { flexDirection: 'row', gap: 4, marginBottom: 4 },
  calDayCell: {
    flex: 1,
    aspectRatio: 1,
  },
  calDaySquare: {
    flex: 1,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calDayNum: { fontSize: FontSize.xs },
  multiDot: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 6,
    height: 6,
    borderRadius: 3,
  },

  // Legend
  calLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSquare: { width: 12, height: 12, borderRadius: 4 },
  legendText: { fontSize: 9 },

  // Date filter
  dateFilterWrap: { paddingHorizontal: Spacing.xl, marginBottom: Spacing.md },
  dateFilterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  dateFilterText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
  },
  dateFilterClose: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Search
  searchWrap: { paddingHorizontal: Spacing.xl, marginBottom: Spacing.lg },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.sm,
    padding: 0,
  },

  // Skeleton
  skeletonWrap: {
    paddingHorizontal: Spacing.xl,
    gap: Spacing.md,
  },
  skeletonCard: {
    height: 96,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },

  // Empty
  emptyWrap: {
    alignItems: 'center',
    paddingHorizontal: Spacing.xxl,
    paddingTop: 80,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: Radius.xxl,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: FontSize.sm,
    marginBottom: 4,
  },
  emptySub: {
    fontSize: FontSize.xs,
    textAlign: 'center',
  },
  clearFilterText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    marginTop: 8,
  },

  // Month group
  monthGroup: {
    marginBottom: Spacing.xxl,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
    marginBottom: Spacing.md,
  },
  groupLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  groupBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.full,
  },
  groupBadgeText: { fontSize: FontSize.xs },
  groupDivider: {
    flex: 1,
    height: 1,
  },
  groupItems: {
    paddingHorizontal: Spacing.xl,
    gap: Spacing.md,
  },

  // Workout Card
  workoutCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },
  workoutCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: Spacing.lg,
  },
  wDotWrap: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 2,
  },
  wDot: { width: 10, height: 10, borderRadius: 5 },
  wInfo: { flex: 1, minWidth: 0 },
  wName: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
  },
  wDate: { fontSize: FontSize.xs, marginTop: 2 },
  wMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md, marginTop: 8 },
  wMetaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  wMetaText: { fontSize: FontSize.xs },
  wActions: { alignItems: 'center', gap: 8, marginTop: 2 },
  moreBtn: { width: 28, height: 24, alignItems: 'center', justifyContent: 'center' },
  // Swipe-to-reveal action tray (Edit / Delete). Buttons float inset on the
  // card background as the header slides left.
  swipeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 6,
  },
  // Compact round icon buttons that echo the app's round-icon language and keep
  // the reveal tight (~86px). Icon-only — the swipe and the kebab both make the
  // intent obvious, and a11y labels carry it for screen readers.
  swipeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Expanded exercise details
  wExpandedSection: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    borderTopWidth: 1,
    gap: Spacing.md,
  },
  exerciseRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  exerciseInfo: {
    flex: 1,
  },
  exerciseName: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    marginBottom: 4,
  },
  setPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  setPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.full,
  },
  setPillText: {
    fontSize: FontSize.xs,
  },
  exerciseBest: {
    alignItems: 'flex-end',
    marginLeft: Spacing.md,
    flexShrink: 0,
  },
  bestWeight: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
  },
  bestLabel: {
    fontSize: FontSize.xs,
  },
  noExercises: {
    fontSize: FontSize.sm,
    lineHeight: 18,
  },
  notesSection: {
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
  },
  notesLabel: {
    fontSize: FontSize.xs,
    marginBottom: 2,
  },
  notesText: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
  },
});
