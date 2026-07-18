/**
 * Dashboard readiness card (holistic tracking, Phase 2).
 *
 * Takes the half-width stat slot vacated by the muscle donut (moved to Analytics).
 * Mirrors the FUEL card's anatomy on purpose (ring up top, compact signal rows
 * below) so the two half-width tiles read as siblings: a band-coloured score ring
 * + directive pill, then one row per recovery signal feeding today's score (sleep
 * always, with last night's duration; RHR/HRV/load/fuel as they exist). Reads
 * (does not write) today's readiness from daily_metrics; the foreground sync owns
 * the write. Two honest states:
 *   score    -> ring + directive + signal rows
 *   no score -> "Log last night". Tap deep-links into the sleep sheet, since a
 *               manual sleep log is all readiness needs to start. Connecting a
 *               health hub is pitched inside the hub, not here: the dashboard
 *               never leads with "Connect health".
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
import { loadRecentSleep } from '@/lib/sleepLog';
import { bandColor, directive, bandPillTextColor } from '@/lib/readiness';
import type { ReadinessContributor, ReadinessResult } from '@/lib/readiness';
import { formatSleepMinutes } from '@/lib/format';
import { Colors, Radius, Spacing, FontSize, FontWeight, colorWithAlpha } from '@/constants/theme';
import { ReadinessRing } from '@/components/ui/ReadinessRing';

interface CardState {
  loading: boolean;
  result: ReadinessResult | null;
  /** Today's sleep duration in minutes (any source), for the sleep row's value. */
  sleepMinutes: number | null;
}

/** Row order mirrors how much each signal moves the score; the card shows 3 max. */
const ROW_ORDER: ReadinessContributor['key'][] = ['sleep', 'rhr', 'hrv', 'load', 'diet'];
const MAX_ROWS = 3;
const ROW_LABEL: Record<ReadinessContributor['key'], string> = {
  sleep: 'Sleep',
  rhr: 'RHR',
  hrv: 'HRV',
  load: 'Load',
  diet: 'Fuel',
};

/** Neutral band: within this |z| the signal reads "usual" and the bar shows a dot. */
const NEUTRAL_Z = 0.3;

/**
 * One-word status per signal, in plain coach words. RHR's z is already inverted
 * (positive = lower-than-usual = good), so "low" is the good direction word.
 */
function rowStatus(c: ReadinessContributor): string {
  const v = c.z ?? c.dir ?? 0;
  const up = v > NEUTRAL_Z || (c.z == null && v > 0);
  const down = v < -NEUTRAL_Z || (c.z == null && v < 0);
  switch (c.key) {
    case 'sleep': return up ? 'long' : down ? 'short' : 'usual';
    case 'rhr': return up ? 'low' : down ? 'high' : 'usual';
    case 'hrv': return up ? 'up' : down ? 'down' : 'usual';
    case 'load': return 'high';
    case 'diet': return up ? 'good' : down ? 'low' : 'on track';
  }
}

export function ReadinessCard() {
  const { C } = useTheme();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const userId = user?.id ?? null;
  const [state, setState] = useState<CardState>({ loading: true, result: null, sleepMinutes: null });

  // Reload every time the dashboard REGAINS FOCUS, not just on mount: after the
  // user logs sleep on the /health hub and comes back, the tab screen stays
  // mounted, so a plain useEffect would never re-read and the card would keep
  // showing the stale pre-log state (no score, which also makes it deep-link
  // log=1 and reopen the sheet forever). useFocusEffect refires on return.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!userId) {
        setState({ loading: false, result: null, sleepMinutes: null });
        return;
      }
      // Only show the spinner on the FIRST load (no result yet). On a refocus
      // reload keep the current card visible so returning doesn't flash a spinner.
      setState((prev) => ({ ...prev, loading: prev.result == null }));
      Promise.all([
        loadReadiness(supabase, userId),
        // Best-effort: the sleep row falls back to a status word without it.
        loadRecentSleep(supabase, userId).catch(() => ({ today: null, yesterday: null })),
      ])
        .then(([result, sleep]) => {
          if (!cancelled) setState({ loading: false, result, sleepMinutes: sleep.today?.minutes ?? null });
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
  const accent = Colors.stat.readiness;

  return (
    <Pressable
      onPress={() => router.push(hasScore ? '/health' : { pathname: '/health', params: { log: '1' } })}
      style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
    >
      <View style={[styles.glow, { backgroundColor: accent, opacity: 0.04 }]} />
      <View style={styles.header}>
        <Svg width={12} height={12} viewBox="0 0 24 24">
          <Circle cx={12} cy={12} r={5} fill="none" stroke={accent} strokeWidth={2.5} />
        </Svg>
        <Text style={[styles.label, { color: accent }]}>READINESS</Text>
        <View style={{ flex: 1 }} />
        <Feather name="chevron-right" size={13} color={C.textDim} />
      </View>

      {state.loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={accent} />
        </View>
      ) : hasScore ? (
        <View style={styles.center}>
          <ReadinessRing score={result!.score!} color={bandColor(result!.band!)} track={C.muted} size={88} stroke={9}>
            <Text style={[styles.score, { color: C.foreground }]}>{result!.score}</Text>
          </ReadinessRing>
          <View style={[styles.pill, { backgroundColor: colorWithAlpha(bandColor(result!.band!), 0.12) }]}>
            <Text style={[styles.directive, { color: bandPillTextColor(result!.band!, C) }]}>
              {directive(result!.band!)}
            </Text>
          </View>
          <SignalRows result={result!} sleepMinutes={state.sleepMinutes} C={C} />
        </View>
      ) : (
        <View style={styles.center}>
          <View style={[styles.emptyChip, { backgroundColor: colorWithAlpha(accent, 0.12) }]}>
            <Feather name="moon" size={18} color={accent} />
          </View>
          <Text style={[styles.emptyTitle, { color: C.foreground }]}>Log last night</Text>
          <Text style={[styles.emptySub, { color: C.textDim }]}>
            Readiness starts with sleep. Ten seconds.
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * Compact per-signal rows mirroring the FUEL card's MacroBar rhythm: short label,
 * a centred diverging bar (right of the tick lifted the score, left dragged it,
 * a dot means about usual), and a right-aligned value or status word. Sleep shows
 * last night's real duration when we have it; the rest carry one plain word.
 */
function SignalRows({ result, sleepMinutes, C }: {
  result: ReadinessResult;
  sleepMinutes: number | null;
  C: ReturnType<typeof useTheme>['C'];
}) {
  const rows = ROW_ORDER
    .map((key) => result.contributors.find((c) => c.key === key))
    .filter((c): c is ReadinessContributor => c != null)
    .slice(0, MAX_ROWS);
  if (rows.length === 0) return null;

  return (
    <View style={styles.rows}>
      {rows.map((c) => {
        const v = c.z ?? c.dir ?? 0;
        const neutral = c.z != null ? Math.abs(c.z) < NEUTRAL_Z : (c.dir ?? 0) === 0;
        const good = v > 0;
        const barColor = neutral ? C.textMuted
          : c.key === 'load' ? C.warningText
          : good ? C.successText
          : C.dangerText;
        // Typical day-to-day |z| lives well under 1.5; scale against that so a
        // normal wobble still reads, and clamp at the half-track.
        const frac = c.z != null ? Math.min(Math.abs(c.z) / 1.5, 1) : 0.35;
        const value = c.key === 'sleep' && sleepMinutes != null ? formatSleepMinutes(sleepMinutes) : rowStatus(c);
        return (
          <View
            key={c.key}
            style={styles.row}
            accessible
            accessibilityLabel={`${ROW_LABEL[c.key]}: ${value}`}
          >
            <Text style={[styles.rowLabel, { color: C.textSecondary }]} numberOfLines={1}>{ROW_LABEL[c.key]}</Text>
            <View style={[styles.rowTrack, { backgroundColor: C.muted }]}>
              <View style={[styles.rowTick, { backgroundColor: C.border }]} />
              {neutral ? (
                <View style={[styles.rowDot, { backgroundColor: C.textMuted }]} />
              ) : (
                <View
                  style={[
                    styles.rowFill,
                    { backgroundColor: barColor, width: `${frac * 50}%` },
                    good ? { left: '50%' } : { left: `${50 - frac * 50}%` },
                  ]}
                />
              )}
            </View>
            <Text style={[styles.rowValue, { color: neutral ? C.textMuted : barColor }]} numberOfLines={1}>
              {value}
            </Text>
          </View>
        );
      })}
    </View>
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
  score: { fontSize: 24, fontWeight: FontWeight.black, letterSpacing: -1 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.full, marginTop: 6 },
  directive: { fontSize: 11, fontWeight: FontWeight.semibold },
  // Signal rows: same rhythm as the FUEL card's MacroBar rows (label, track, value).
  rows: { alignSelf: 'stretch', gap: 8, marginTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowLabel: { width: 34, fontSize: 10, fontWeight: FontWeight.semibold },
  rowTrack: { flex: 1, height: 5, borderRadius: 2.5, position: 'relative', justifyContent: 'center', overflow: 'hidden' },
  rowTick: { position: 'absolute', left: '50%', width: 1, height: 5 },
  rowFill: { position: 'absolute', height: 5, borderRadius: 2.5 },
  rowDot: { position: 'absolute', left: '50%', marginLeft: -2.5, width: 5, height: 5, borderRadius: 2.5 },
  rowValue: { minWidth: 44, textAlign: 'right', fontSize: 10, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  emptyChip: { width: 40, height: 40, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  emptySub: { fontSize: 10, marginTop: 3, textAlign: 'center', lineHeight: 14 },
});
