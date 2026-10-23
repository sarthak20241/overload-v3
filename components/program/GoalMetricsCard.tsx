/**
 * "Goal metrics" on the Analytics tab: the active program's hero metric and
 * any custom metric of its current phase, each with its chart (the same
 * components as the Goal screen) and status word. Renders nothing when the
 * user has no program, the program has no metrics, or the metrics table is
 * not there yet (loadActiveProgram answers an empty list for that).
 */
import { useCallback, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { track } from '@/lib/analytics';
import { loadActiveProgram, peekActiveProgram, daysBetweenISO, todayLocalISO, type ActiveProgram } from '@/lib/programData';
import {
  chartKindOf, formatMetricValue, heroOf, metricLabel, STATUS_LABEL, statusTone, type PhaseMetricRow,
} from '@/lib/phaseMetrics';
import { loadMetricSeries, programWeeks, type MetricSeries } from '@/lib/phaseMetricSeries';
import { MetricBarsChart, MetricLineChart } from '@/components/program/PhaseMetricChart';

interface Props {
  chartWidth: number;
}

interface Item {
  metric: PhaseMetricRow;
  series: MetricSeries;
}

export function GoalMetricsCard({ chartWidth }: Props) {
  const { C } = useTheme();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const clerkId = user?.id ?? null;
  const [program, setProgram] = useState<ActiveProgram | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const viewedSent = useRef(false);
  // Only the newest load may paint: a focus right after mount, or a user
  // change, can resolve out of order.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const fresh = () => seq === loadSeq.current;
    if (!supabase || !clerkId) { setProgram(null); setItems([]); return; }
    // What the series were last read for, so a program that comes back the
    // same (the cached one, then its revalidation) reads them once.
    let shownFor: string | null = null;
    const show = async (p: ActiveProgram | null) => {
      const phase = p && p.currentPhaseSeq != null ? p.phases.find((ph) => ph.seq === p.currentPhaseSeq) ?? null : null;
      if (!p || !phase || phase.metrics.length === 0) {
        shownFor = null;
        if (fresh()) { setProgram(null); setItems([]); }
        return;
      }
      const hero = heroOf(phase.metrics);
      const picks = phase.metrics.filter((m) => m.id === hero?.id || m.kind === 'custom');
      const inputs = JSON.stringify([p.start_date, programWeeks(p), phase.diet_protein_g, picks]);
      if (inputs === shownFor) return;
      shownFor = inputs;
      const loaded = await Promise.all(picks.map(async (metric) => ({
        metric,
        series: await loadMetricSeries(supabase, clerkId, p, metric, phase.diet_protein_g),
      })));
      if (!fresh()) return;
      setProgram(p);
      setItems(loaded);
      if (!viewedSent.current) { viewedSent.current = true; track('goal_metrics_viewed', { metrics: loaded.length }); }
    };
    try {
      // The series start from the cached program at once; the program is
      // revalidated beside them, and its series read only if it changed. In
      // that order, so the fresh program's paint is always the last.
      const cached = peekActiveProgram(clerkId);
      const programP = loadActiveProgram(supabase, clerkId);
      // Awaited below; a no-op handler keeps a failure that lands while the
      // cached series load from being reported as unhandled.
      programP.catch(() => {});
      if (cached !== undefined) await show(cached);
      await show(await programP);
    } catch (e) {
      // Keep what we had; the card is a nicety on a busy screen.
      console.warn('[programs] goal metrics load failed', e);
    }
  }, [supabase, clerkId]);

  // Focus fires on mount too, so one effect is enough.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (!program || items.length === 0) return null;
  const phase = program.phases.find((ph) => ph.seq === program.currentPhaseSeq);
  if (!phase) return null;
  const weeks = programWeeks(program);
  const daysIn = daysBetweenISO(program.start_date, todayLocalISO());
  const curWeek = Math.max(1, Math.min(weeks, Math.floor(daysIn / 7) + 1));
  const phaseEnd = phase.start_offset_weeks + phase.duration_weeks;

  return (
    <View style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
      <Pressable style={s.head} onPress={() => router.push('/goal-plan' as any)} accessibilityRole="button" accessibilityLabel="Open Goal and Plan">
        <View style={[s.icon, { backgroundColor: C.primarySubtle }]}>
          <Feather name="target" size={14} color={C.accentText} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: C.foreground }]}>Goal metrics</Text>
          <Text style={[s.sub, { color: C.mutedFg }]} numberOfLines={1}>{program.title} · {phase.name}</Text>
        </View>
        <Feather name="chevron-right" size={14} color={C.textMuted} />
      </Pressable>

      {items.map(({ metric, series }, i) => {
        const tone = statusTone(metric.status);
        const color = tone === 'ok' ? C.accentText : tone === 'warn' ? C.warningText : C.textDim;
        const cur = metric.current_value;
        return (
          <View key={metric.id} style={[s.item, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.borderSubtle }]}>
            <View style={s.itemHead}>
              <Text style={[s.itemName, { color: C.foreground }]} numberOfLines={1}>
                {metricLabel(metric)}{metric.is_hero ? '' : '  ·  you log it'}
              </Text>
              <Text style={[s.itemStatus, { color }]}>{STATUS_LABEL[metric.status]}</Text>
            </View>
            <Text style={[s.itemValue, { color: C.foreground }]}>
              {cur == null ? '–' : formatMetricValue(metric.kind, cur, metric.unit)}
              <Text style={[s.itemUnit, { color: C.mutedFg }]}> {metric.unit}  ·  target {formatMetricValue(metric.kind, metric.target_value, metric.unit)}</Text>
            </Text>
            {chartKindOf(metric.kind) === 'line' ? (
              (series.points.length > 0 || cur != null) && (
                <MetricLineChart
                  width={chartWidth}
                  points={series.points.length > 0 ? series.points : [{ x: Math.max(0, daysIn / 7), y: cur! }]}
                  weeks={weeks}
                  endTarget={metric.kind === 'bodyweight' && program.target_weight_kg != null ? program.target_weight_kg : metric.target_value}
                />
              )
            ) : (
              <MetricBarsChart
                width={chartWidth}
                values={series.weekly}
                weeks={weeks}
                curWeek={curWeek}
                target={metric.target_value}
                targetLabel={metric.kind === 'steps' ? `${formatMetricValue('steps', metric.target_value)} a day` : `${formatMetricValue(metric.kind, metric.target_value, metric.unit)} a week`}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: Radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: Spacing.lg, marginBottom: Spacing.lg },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  icon: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  sub: { fontSize: FontSize.xs, marginTop: 1 },
  item: { paddingTop: 12, paddingBottom: 4 },
  itemHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  itemName: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, flexShrink: 1 },
  itemStatus: { fontSize: 11.5, fontWeight: FontWeight.semibold },
  itemValue: { fontSize: 22, fontWeight: FontWeight.bold, marginTop: 2, fontVariant: ['tabular-nums'], letterSpacing: -0.4 },
  itemUnit: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, letterSpacing: 0 },
});
