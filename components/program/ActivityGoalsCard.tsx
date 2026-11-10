/**
 * Dashboard row: today's steps and this week's cardio against the current
 * program phase's activity goals. Renders nothing until there is a goal to show
 * (no program, no goals, an older database, a failed read), so users without
 * goals never see it. The steps half taps through to Goal & Plan, where the
 * goals live; the cardio half opens the cardio sheet, to start a session or log
 * one already done.
 */
import { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { cardioLine, shortSteps, stepsLine, type GoalProgress } from '@/lib/activityGoals';
import { loadActivityProgress, type ActivityProgress } from '@/lib/activityProgress';
import { PressableScale } from '@/components/ui/PressableScale';
import { useSync } from '@/components/SyncProvider';
import { CardioSheet } from '@/components/program/CardioSheet';
import { track } from '@/lib/analytics';
import { Colors, Radius, Spacing, FontSize, FontWeight } from '@/constants/theme';

function GoalHalf({
  icon, label, value, line, progress, color,
}: {
  icon: 'activity' | 'heart';
  label: string;
  value: string;
  line: string;
  progress: GoalProgress;
  color: string;
}) {
  const { C } = useTheme();
  return (
    <View style={{ flex: 1, gap: 6 }}>
      <View style={styles.head}>
        <Feather name={icon} size={12} color={color} />
        <Text style={[styles.label, { color }]}>{label}</Text>
        <View style={{ flex: 1 }} />
        <Text style={[styles.value, { color: C.foreground }]}>{value}</Text>
      </View>
      <View style={[styles.track, { backgroundColor: C.muted }]}>
        <View style={[styles.fill, { backgroundColor: color, width: `${Math.round(progress.fraction * 100)}%` }]} />
      </View>
      <Text style={[styles.line, { color: progress.met ? color : C.textMuted }]} numberOfLines={1}>
        {line}
      </Text>
    </View>
  );
}

export function ActivityGoalsCard() {
  const { C } = useTheme();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const [data, setData] = useState<ActivityProgress | null>(null);
  const [cardioOpen, setCardioOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // A queued workout counts until it syncs; re-read when the queue changes so
  // the count holds steady across the upload.
  const { pendingCount } = useSync();

  useFocusEffect(useCallback(() => {
    if (!user?.id) { setData(null); return; }
    let live = true;
    loadActivityProgress(supabase, user.id).then((p) => { if (live) setData(p); });
    return () => { live = false; };
  }, [supabase, user?.id, pendingCount, reloadKey]));

  if (!data) return null;
  const stepsColor = Colors.stat.steps;
  const cardioColor = Colors.stat.streak;
  return (
    <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
        {data.steps && (
          <PressableScale
            haptic="tap"
            onPress={() => router.push('/goal-plan')}
            style={{ flex: 1 }}
            accessibilityRole="button"
            accessibilityLabel="Step goal for this phase"
          >
            <GoalHalf
              icon="activity"
              label="Steps"
              value={`${shortSteps(data.steps.done)} / ${shortSteps(data.steps.target)}`}
              line={stepsLine(data.steps)}
              progress={data.steps}
              color={stepsColor}
            />
          </PressableScale>
        )}
        {data.steps && data.cardio && <View style={[styles.divider, { backgroundColor: C.borderSubtle }]} />}
        {data.cardio && (
          <PressableScale
            haptic="tap"
            onPress={() => {
              track('cardio_sheet_opened', { done: data.cardio?.done ?? 0, target: data.cardio?.target ?? 0 });
              setCardioOpen(true);
            }}
            style={{ flex: 1 }}
            accessibilityRole="button"
            accessibilityLabel="Log cardio"
          >
            <GoalHalf
              icon="heart"
              label="Cardio"
              value={`${data.cardio.done} / ${data.cardio.target}`}
              line={cardioLine(data.cardio)}
              progress={data.cardio}
              color={cardioColor}
            />
          </PressableScale>
        )}
      </View>
      <CardioSheet
        visible={cardioOpen}
        onClose={() => setCardioOpen(false)}
        onLogged={() => setReloadKey((k) => k + 1)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: 0.6, textTransform: 'uppercase' },
  value: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  line: { fontSize: FontSize.xs },
  divider: { width: 1, alignSelf: 'stretch' },
});
