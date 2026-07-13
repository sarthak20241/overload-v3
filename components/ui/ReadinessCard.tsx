/**
 * Dashboard readiness card (holistic tracking, Phase 2).
 *
 * Takes the half-width stat slot vacated by the muscle donut (moved to Analytics).
 * Leads with the decision: a band-coloured score ring + a short directive derived
 * from readiness, in Drona's voice. Reads (does not write) today's readiness from
 * daily_metrics; the foreground sync owns the write. Three honest states:
 *   score        -> ring + directive
 *   needs sleep  -> we have a connection or recent data but no score today, so the
 *                   one missing input is sleep. Tap deep-links into the log sheet.
 *   not connected-> nothing at all yet. Tap opens the health hub.
 * This kills the old bug where a connected steps-only user saw "Connect health".
 */
import { useCallback, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Feather } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { loadReadiness } from '@/lib/readinessSync';
import { getHealthConnectionStatus, loadConnectedMetrics } from '@/lib/healthSync';
import { bandColor, directive, bandPillTextColor } from '@/lib/readiness';
import type { ReadinessResult } from '@/lib/readiness';
import { Colors, Radius, Spacing, FontSize, FontWeight, colorWithAlpha } from '@/constants/theme';
import { ReadinessRing } from '@/components/ui/ReadinessRing';

// Widen the has-data window well past the sync freshness window: a manual logger
// who lapses a few days must stay "log last night", not regress to "connect".
const HAS_DATA_DAYS = 14;

interface CardState {
  loading: boolean;
  result: ReadinessResult | null;
  /** A hub is connected, OR any readable metric has data in the last HAS_DATA_DAYS. */
  hasData: boolean;
}

export function ReadinessCard() {
  const { C } = useTheme();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const userId = user?.id ?? null;
  const [state, setState] = useState<CardState>({ loading: true, result: null, hasData: false });

  // Reload every time the dashboard REGAINS FOCUS, not just on mount: after the
  // user logs sleep on the /health hub and comes back, the tab screen stays
  // mounted, so a plain useEffect would never re-read and the card would keep
  // showing the stale pre-log state (no score, which also makes it deep-link
  // log=1 and reopen the sheet forever). useFocusEffect refires on return.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!userId) {
        setState({ loading: false, result: null, hasData: false });
        return;
      }
      // Only show the spinner on the FIRST load (no result yet). On a refocus
      // reload keep the current card visible so returning doesn't flash a spinner.
      setState((prev) => ({ ...prev, loading: prev.result == null }));
      Promise.all([
        loadReadiness(supabase, userId).catch(() => null),
        getHealthConnectionStatus(userId).catch(() => 'unknown' as const),
        loadConnectedMetrics(supabase, userId, HAS_DATA_DAYS).catch(() => ({ metrics: new Set(), deviceMetrics: new Set() })),
      ])
        .then(([result, status, connected]) => {
          if (cancelled) return;
          const hasData = status === 'granted' || connected.deviceMetrics.size > 0 || connected.metrics.size > 0;
          setState({ loading: false, result, hasData });
        })
        .catch(() => {
          if (!cancelled) setState((prev) => ({ ...prev, loading: false }));
        });
      return () => {
        cancelled = true;
      };
    }, [userId, supabase]),
  );

  const result = state.result;
  const hasScore = result != null && result.score != null && result.band != null;
  const needsSleep = !hasScore && state.hasData;
  const accent = Colors.stat.readiness;

  return (
    <Pressable
      onPress={() => router.push(needsSleep ? { pathname: '/health', params: { log: '1' } } : '/health')}
      style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
    >
      <View style={[styles.glow, { backgroundColor: accent, opacity: 0.04 }]} />
      <View style={styles.header}>
        <Svg width={12} height={12} viewBox="0 0 24 24">
          <Circle cx={12} cy={12} r={5} fill="none" stroke={accent} strokeWidth={2.5} />
        </Svg>
        <Text style={[styles.label, { color: accent }]}>READINESS</Text>
      </View>

      {state.loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={accent} />
        </View>
      ) : hasScore ? (
        <View style={styles.center}>
          <ReadinessRing score={result!.score!} color={bandColor(result!.band!)} track={C.muted} size={96} stroke={9}>
            <Text style={[styles.score, { color: C.foreground }]}>{result!.score}</Text>
          </ReadinessRing>
          <View style={[styles.pill, { backgroundColor: colorWithAlpha(bandColor(result!.band!), 0.12) }]}>
            <Text style={[styles.directive, { color: bandPillTextColor(result!.band!, C) }]}>
              {directive(result!.band!)}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.center}>
          <View style={[styles.emptyChip, { backgroundColor: colorWithAlpha(accent, 0.12) }]}>
            <Feather name={needsSleep ? 'moon' : 'plus-circle'} size={18} color={accent} />
          </View>
          <Text style={[styles.emptyTitle, { color: C.foreground }]}>
            {needsSleep ? 'Log last night' : 'Connect health'}
          </Text>
          <Text style={[styles.emptySub, { color: C.textDim }]}>
            {needsSleep ? 'Readiness starts with sleep. Ten seconds.' : 'Sync a wearable or log sleep by hand.'}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { width: '47%', borderRadius: Radius.lg, borderWidth: 1, padding: Spacing.md, gap: 4, overflow: 'hidden' },
  glow: { position: 'absolute', top: -20, left: -20, width: 80, height: 80, borderRadius: 40 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  label: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: 0.6, textTransform: 'uppercase' },
  // flex:1 so the content fills the card height the taller FUEL sibling sets
  // (the row stretches both), centering the state vertically instead of leaving
  // dead space below it. minHeight keeps a floor if the card ever isn't stretched.
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 2, minHeight: 116 },
  ringLabel: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  score: { fontSize: 28, fontWeight: FontWeight.black, letterSpacing: -1 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.full, marginTop: 6 },
  directive: { fontSize: 11, fontWeight: FontWeight.semibold },
  emptyChip: { width: 40, height: 40, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  emptySub: { fontSize: 10, marginTop: 3, textAlign: 'center', lineHeight: 14 },
});
