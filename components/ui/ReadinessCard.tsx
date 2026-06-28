/**
 * Dashboard readiness card (holistic tracking, Phase 2).
 *
 * Takes the half-width stat slot vacated by the muscle donut (moved to Analytics).
 * Leads with the decision: a band-coloured score ring + a short directive derived
 * from readiness, in Drona's voice. Reads (does not write) today's readiness from
 * daily_metrics; the foreground sync owns the write. Falls back to a connect /
 * calibrating prompt when there is no score yet. Tapping opens the health screen.
 */
import { useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { loadReadiness } from '@/lib/readinessSync';
import { bandColor, directive, bandPillTextColor } from '@/lib/readiness';
import type { ReadinessResult } from '@/lib/readiness';
import { Colors, Radius, Spacing, FontSize, FontWeight, colorWithAlpha } from '@/constants/theme';
import { ReadinessRing } from '@/components/ui/ReadinessRing';

export function ReadinessCard() {
  const { C } = useTheme();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const userId = user?.id ?? null;
  const [state, setState] = useState<{ loading: boolean; result: ReadinessResult | null }>({
    loading: true,
    result: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setState({ loading: false, result: null });
      return;
    }
    loadReadiness(supabase, userId)
      .then((r) => {
        if (!cancelled) setState({ loading: false, result: r });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, result: null });
      });
    return () => {
      cancelled = true;
    };
  }, [userId, supabase]);

  const result = state.result;
  const hasScore = result != null && result.score != null && result.band != null;
  const accent = Colors.stat.readiness;

  return (
    <Pressable
      onPress={() => router.push('/health')}
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
            <Svg width={18} height={18} viewBox="0 0 24 24">
              <Circle cx={12} cy={12} r={7} fill="none" stroke={accent} strokeWidth={2} />
            </Svg>
          </View>
          <Text style={[styles.emptyTitle, { color: C.foreground }]}>
            {result?.calibrating ? 'Calibrating' : 'Connect health'}
          </Text>
          <Text style={[styles.emptySub, { color: C.textDim }]}>
            {result?.calibrating ? 'A week of data and readiness kicks in.' : 'Sync sleep + recovery to see readiness.'}
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
  center: { alignItems: 'center', justifyContent: 'center', marginTop: 2, minHeight: 116 },
  ringLabel: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  score: { fontSize: 28, fontWeight: FontWeight.black, letterSpacing: -1 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.full, marginTop: 6 },
  directive: { fontSize: 11, fontWeight: FontWeight.semibold },
  emptyChip: { width: 40, height: 40, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  emptySub: { fontSize: 10, marginTop: 3, textAlign: 'center', lineHeight: 14 },
});
