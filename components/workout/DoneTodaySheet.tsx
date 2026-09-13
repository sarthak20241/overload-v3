import { useEffect, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, Pressable, ScrollView, StyleSheet, BackHandler, useWindowDimensions,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Portal } from '@/components/ui/Portal';
import { PressableScale } from '@/components/ui/PressableScale';
import { BodyHeatmap } from '@/components/ui/BodyHeatmap';
import { DronaMark } from '@/components/coach/DronaMark';
import { useSheetSlide } from '@/hooks/useSheetSlide';
import { useTheme } from '@/hooks/useTheme';
import { abbreviateNumber } from '@/lib/format';
import { metricTypeOf } from '@/lib/exercises';
import { setLabel } from '@/lib/setDisplay';
import { groupSetsByExercise, muscleSetCounts, type SummarySet } from '@/lib/workoutSummary';
import { Spacing, Radius, FontSize, FontWeight, IconSize } from '@/constants/theme';

// Opened from the TODAY card once the day's session is done: where it landed
// on the body, what was actually done, and what comes next. Read-only except
// "up next", pinned under the scroll, which hands off to the same session
// preview the TODAY card opens.

export interface DoneWorkout {
  name?: string | null;
  duration_seconds?: number | null;
  total_volume_kg?: number | null;
  sets?: SummarySet[] | null;
}

export type UpNext =
  | { kind: 'planned'; routine: { name?: string | null; routine_exercises?: unknown[] | null }; reason?: string | null }
  | { kind: 'new' };

interface Props {
  workout: DoneWorkout | null;
  visible: boolean;
  gender?: string | null;
  upNext: UpNext | null;
  onClose: () => void;
  onUpNextPress: () => void;
}

function formatDuration(sec: number) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function DoneTodaySheet({ workout, visible, gender, upNext, onClose, onUpNextPress }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { mounted, slideStyle } = useSheetSlide(visible, 320, 200);

  // <Portal> has no onRequestClose, so the Android back button closes it here.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  const groups = useMemo(() => groupSetsByExercise(workout?.sets), [workout]);
  const counts = useMemo(() => muscleSetCounts(workout?.sets), [workout]);
  const hasMuscles = Object.keys(counts).length > 0;
  const doneSets = (workout?.sets ?? []).filter((set) => set.completed !== false).length;

  if (!mounted || !workout) return null;

  const stats = [
    workout.duration_seconds ? formatDuration(workout.duration_seconds) : null,
    workout.total_volume_kg ? `${abbreviateNumber(workout.total_volume_kg)} kg` : null,
    doneSets > 0 ? `${doneSets} ${doneSets === 1 ? 'set' : 'sets'}` : null,
  ].filter(Boolean).join('  ·  ');

  const upNextCount = upNext?.kind === 'planned' ? upNext.routine.routine_exercises?.length ?? 0 : 0;

  return (
    <Portal>
      <View style={s.backdrop} pointerEvents={visible ? 'auto' : 'none'}>
        {visible && (
          <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]} onPress={onClose} />
        )}
        <Animated.View
          style={[
            s.sheet,
            slideStyle,
            { backgroundColor: C.elevated, maxHeight: windowHeight * 0.88, paddingBottom: insets.bottom + Spacing.md },
          ]}
        >
          <View style={[s.handle, { backgroundColor: C.handle }]} />

          <View style={s.header}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={s.eyebrowRow}>
                <Feather name="check-circle" size={IconSize.xs} color={C.accentText} />
                <Text style={[s.eyebrow, { color: C.accentText }]}>DONE FOR TODAY</Text>
              </View>
              <Text style={[s.title, { color: C.foreground }]} numberOfLines={1}>
                {workout.name?.trim() || 'Workout complete'}
              </Text>
              {stats ? <Text style={[s.stats, { color: C.textMuted }]}>{stats}</Text> : null}
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={[s.closeBtn, { backgroundColor: C.closeBtn }]}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Feather name="x" size={15} color={C.foreground} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={{ flexShrink: 1 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: Spacing.sm }}
          >
            {hasMuscles ? (
              <View style={s.section}>
                <Text style={[s.sectionLabel, { color: C.textMuted }]}>MUSCLES WORKED</Text>
                <View style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
                  <BodyHeatmap
                    counts={counts}
                    gender={gender}
                    width={windowWidth - Spacing.xl * 2 - Spacing.md * 2}
                    legendLimit={5}
                  />
                </View>
              </View>
            ) : null}

            <View style={s.section}>
              <Text style={[s.sectionLabel, { color: C.textMuted }]}>THE SESSION</Text>
              <View style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
                {groups.length === 0 ? (
                  <Text style={[s.empty, { color: C.textMuted }]}>No sets were logged in this one.</Text>
                ) : (
                  groups.map((g, gi) => (
                    <View
                      key={`${g.name}-${gi}`}
                      style={[
                        s.exercise,
                        gi > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.borderSubtle },
                      ]}
                    >
                      <View style={s.exerciseHeader}>
                        <Text style={[s.exerciseName, { color: C.foreground }]} numberOfLines={1}>{g.name}</Text>
                        <Text style={[s.exerciseCount, { color: C.textDim }]}>
                          {g.sets.length} {g.sets.length === 1 ? 'set' : 'sets'}
                        </Text>
                      </View>
                      <View style={s.setPills}>
                        {g.sets.map((set, si) => (
                          <View
                            key={si}
                            style={[
                              s.setPill,
                              { backgroundColor: C.muted, borderColor: C.borderSubtle },
                              set.completed === false && { opacity: 0.5 },
                            ]}
                          >
                            <Text style={[s.setPillText, { color: C.textSecondary }]}>
                              {setLabel(metricTypeOf({ metric_type: g.metricType as any }), set)}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ))
                )}
              </View>
            </View>
          </ScrollView>

          {/* Pinned under the scroll, so the one action never needs a scroll to reach. */}
          {upNext ? (
            <View style={[s.footer, { borderTopColor: C.borderSubtle }]}>
              <Text style={[s.sectionLabel, { color: C.textMuted }]}>UP NEXT</Text>
              <PressableScale
                onPress={onUpNextPress}
                style={[s.upNext, { backgroundColor: C.primaryMuted, borderColor: C.primaryBorder }]}
              >
                <View style={[s.upNextIcon, { backgroundColor: C.muted }]}>
                  {upNext.kind === 'new' ? (
                    <DronaMark size={IconSize.sm} color={C.accentText} state="static" />
                  ) : (
                    <Feather name="play" size={IconSize.sm} color={C.accentText} />
                  )}
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={s.upNextTitleRow}>
                    <Text style={[s.upNextTitle, { color: C.foreground, flexShrink: 1 }]} numberOfLines={1}>
                      {upNext.kind === 'new' ? 'Build your next session' : upNext.routine.name || 'Next session'}
                    </Text>
                    {upNextCount > 0 ? (
                      <Text style={[s.upNextMeta, { color: C.textMuted }]}>  ·  {upNextCount} ex</Text>
                    ) : null}
                  </View>
                  {upNext.kind === 'planned' && upNext.reason ? (
                    <Text style={[s.upNextReason, { color: C.textMuted }]} numberOfLines={2}>{upNext.reason}</Text>
                  ) : null}
                </View>
                <Feather name="chevron-right" size={IconSize.md} color={C.textMuted} />
              </PressableScale>
            </View>
          ) : null}
        </Animated.View>
      </View>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: Spacing.xl },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: Spacing.sm, marginBottom: Spacing.md },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md, marginBottom: Spacing.lg },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  eyebrow: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1 },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.semibold, marginTop: 4 },
  stats: { fontSize: FontSize.sm, marginTop: 3 },
  closeBtn: { width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  section: { marginBottom: Spacing.lg },
  sectionLabel: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1, marginBottom: Spacing.sm },
  card: { borderRadius: Radius.lg, borderWidth: 1, padding: Spacing.md },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Spacing.md },
  upNext: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    padding: Spacing.md, borderRadius: Radius.lg, borderWidth: 1,
  },
  upNextIcon: { width: 28, height: 28, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center' },
  upNextTitleRow: { flexDirection: 'row', alignItems: 'baseline' },
  upNextTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  upNextMeta: { fontSize: FontSize.sm },
  upNextReason: { fontSize: FontSize.xs, lineHeight: 16, marginTop: 3 },
  empty: { fontSize: FontSize.sm },
  exercise: { paddingVertical: Spacing.sm, gap: 6 },
  exerciseHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  exerciseName: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, flexShrink: 1 },
  exerciseCount: { fontSize: 10, marginLeft: 'auto' },
  setPills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  setPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  setPillText: { fontSize: 11, fontWeight: FontWeight.medium },
});
