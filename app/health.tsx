/**
 * Readiness hub (holistic tracking, Phase 2 redesign).
 *
 * Root-level full-screen route (like workout/[id]), reached from the dashboard
 * ReadinessCard and the deep link overload://health. It is NOT a connect button:
 * once data is flowing it shows the readiness score, WHY it moved (contributors
 * vs the user's own baseline), the trend, and WHAT is feeding it (the hub + which
 * metrics, honestly, since iOS never reports read grants). The connect action is
 * demoted to a "Sync now" footer once connected. Fully theme-aware (no hardcoded
 * light). Plan: .planning/holistic-tracking-plan.md.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Dimensions,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { loadReadiness, loadReadinessHistory, runHealthSyncAndReadiness } from '@/lib/readinessSync';
import { loadConnectedMetrics, loadMetricSeries, requestHealthAuthorization, type ReadableMetric } from '@/lib/healthSync';
import { bandColor, directive, bandPillTextColor, type ReadinessContributor, type ReadinessResult } from '@/lib/readiness';
import { ReadinessRing } from '@/components/ui/ReadinessRing';
import { MiniAreaChart } from '@/components/ui/MiniAreaChart';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { dailyMetricDef, type DailyMetricDef } from '@/lib/dailyMetrics';
import { sourcesForHub, type HealthHub } from '@/lib/healthSources';
import { Colors, Spacing, Radius, FontSize, FontWeight, IconSize, Shadow, colorWithAlpha } from '@/constants/theme';

const HUB: HealthHub = Platform.OS === 'ios' ? 'healthkit' : 'health_connect';
const HUB_LABEL = Platform.OS === 'ios' ? 'Apple Health' : 'Health Connect';
const CHART_W = Math.round(Dimensions.get('window').width - Spacing.xl * 2 - Spacing.lg * 2);
// Display order for signal cards: recovery signals first, then activity/body.
const SIGNAL_ORDER: ReadableMetric[] = ['sleep_minutes', 'resting_hr_bpm', 'hrv_sdnn_ms', 'steps', 'active_energy_kcal', 'bodyweight_kg'];

// Plain-language meaning (so the user gets it without tapping), the "good"
// direction for the baseline caption, and a personalized prompt handed to Drona.
const METRIC_INFO: Record<string, { meaning: string; higherBetter: boolean | null; ask: (val: string, base: string) => string }> = {
  sleep_minutes: {
    meaning: 'Total time asleep. More sleep is more fuel to recover and adapt.',
    higherBetter: true,
    ask: (v, b) => `I slept ${v} last night and my usual is around ${b}. What does that mean for my training and recovery today?`,
  },
  resting_hr_bpm: {
    meaning: 'Your heart rate at rest. Lower usually means you are well recovered.',
    higherBetter: false,
    ask: (v, b) => `My resting heart rate today is ${v} and my usual is around ${b}. What does resting heart rate tell me, and what is mine saying?`,
  },
  hrv_sdnn_ms: {
    meaning: 'Heart rate variability, a read on how recovered your nervous system is. Higher is better.',
    higherBetter: true,
    ask: (v, b) => `My HRV today is ${v} and my usual is around ${b}. Explain what HRV is in simple terms and what mine means for my training today.`,
  },
  steps: {
    meaning: 'How much you moved through the day, outside training.',
    higherBetter: true,
    ask: (v, b) => `I took ${v} steps today and usually do around ${b}. Does daily movement matter alongside my lifting?`,
  },
  active_energy_kcal: {
    meaning: 'Calories burned through movement and training.',
    higherBetter: true,
    ask: (v, b) => `I burned ${v} active calories today vs my usual ${b}. How should I read this number?`,
  },
  bodyweight_kg: {
    meaning: 'Your bodyweight trend over time.',
    higherBetter: null,
    ask: (v, b) => `My bodyweight is ${v}, hovering around ${b} lately. How should I think about my weight trend for my goals?`,
  },
};

const stat = Colors.stat as Record<string, string>;

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; written: number | null }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

// contributor key -> daily-metric type (load/subjective have no metric)
const CONTRIB_METRIC: Record<string, string | undefined> = {
  hrv: 'hrv_sdnn_ms',
  rhr: 'resting_hr_bpm',
  sleep: 'sleep_minutes',
};


function contributorNote(c: ReadinessContributor): string {
  const z = c.z ?? 0;
  const up = z > 0.3;
  const down = z < -0.3;
  switch (c.key) {
    case 'hrv':
      return up ? 'HRV is up on your normal. That is your body saying it is ready.'
        : down ? 'HRV is below your normal, a sign recovery is still catching up.'
        : 'HRV is about your normal.';
    case 'rhr':
      return up ? 'Resting heart rate is sitting low (lower is better), a good recovery sign.'
        : down ? 'Resting heart rate is a touch high today (lower is better), so readiness eased down.'
        : 'Resting heart rate is about your normal (lower is better).';
    case 'sleep':
      return up ? 'You slept more than your usual, which helps recovery.'
        : down ? 'Sleep came in short of your usual, so readiness took a small hit.'
        : 'Sleep is about your usual.';
    case 'load':
      return 'Recent training load is high this week, so readiness leaves room to recover.';
    case 'subjective':
      return 'Built from how you said you feel today.';
    default:
      return c.note;
  }
}

export default function HealthScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const userId = user?.id ?? null;

  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ReadinessResult | null>(null);
  const [connected, setConnected] = useState<Set<ReadableMetric>>(new Set());
  const [history, setHistory] = useState<{ date: string; value: number }[]>([]);
  const [series, setSeries] = useState<Record<string, { date: string; value: number }[]>>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachPrompt, setCoachPrompt] = useState<string | undefined>(undefined);

  const accent = stat.readiness;
  const metricColor = (colorKey: string) => stat[colorKey] ?? C.textSecondary;

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    // Keep the readiness read distinct: a failed read must NOT look like no-data.
    let readinessFailed = false;
    const [r, c, h, s] = await Promise.all([
      loadReadiness(supabase, userId).catch(() => {
        readinessFailed = true;
        return null;
      }),
      loadConnectedMetrics(supabase, userId).catch(() => new Set<ReadableMetric>()),
      loadReadinessHistory(supabase, userId).catch(() => []),
      loadMetricSeries(supabase, userId).catch(() => ({})),
    ]);
    setResult(r);
    setConnected(c);
    setHistory(h);
    setSeries(s);
    setLoadError(readinessFailed);
    setLoading(false);
  }, [userId, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Open Drona with a personalized question about this metric (its value + the user's usual).
  function askAboutMetric(def: DailyMetricDef, pts: { date: string; value: number }[]) {
    const latest = pts[pts.length - 1].value;
    const mean = pts.reduce((a, p) => a + p.value, 0) / pts.length;
    const info = METRIC_INFO[def.type];
    setCoachPrompt(
      info
        ? info.ask(def.format(latest), def.format(mean))
        : `Tell me about my ${def.label.toLowerCase()} and what it means for my training.`,
    );
    setCoachOpen(true);
  }

  // A one-shot status (synced / error) should not stay pinned forever.
  useEffect(() => {
    if (status.kind === 'idle' || status.kind === 'working') return;
    const t = setTimeout(() => setStatus({ kind: 'idle' }), 5000);
    return () => clearTimeout(t);
  }, [status]);

  // reauth=true only for the first-time Connect; "Sync now" must never re-prompt.
  async function runSync(reauth: boolean) {
    if (!userId) {
      setStatus({ kind: 'error', message: 'Sign in first so your data can sync to your account.' });
      return;
    }
    setStatus({ kind: 'working' });
    try {
      if (reauth) {
        const ok = await requestHealthAuthorization();
        if (!ok) {
          setStatus({ kind: 'unavailable' });
          return;
        }
      }
      const { synced } = await runHealthSyncAndReadiness(supabase, userId);
      setStatus({ kind: 'done', written: synced });
      await load();
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Something went wrong.' });
    }
  }

  const hasScore = result?.score != null && result.band != null;
  const calibrating = !hasScore && result?.calibrating === true;
  const hasData = connected.size > 0;
  const notConnected = !hasScore && !calibrating && !hasData;
  const working = status.kind === 'working';

  const contributors = (result?.contributors ?? []).filter((c) => c.key !== 'subjective' || result?.tier === 'B');

  return (
    <View style={[styles.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.iconBtn}>
          <Feather name="chevron-left" size={IconSize.lg} color={C.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: C.foreground }]}>Readiness</Text>
        <View style={styles.iconBtn} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: Spacing.xl, paddingBottom: insets.bottom + Spacing.xxxl, gap: Spacing.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={accent} colors={[accent]} />}
      >
        {loading ? (
          <View style={{ paddingVertical: Spacing.xxxl * 2, alignItems: 'center' }}>
            <ActivityIndicator color={accent} />
          </View>
        ) : (
          <>
            {loadError && (
              <Pressable onPress={load} style={[styles.card, { backgroundColor: Colors.dangerBg, borderColor: C.borderSubtle }]}>
                <Text style={[styles.statusText, { color: C.foreground }]}>
                  Could not load your readiness just now. Tap to retry.
                </Text>
              </Pressable>
            )}
            {/* HERO */}
            <View style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
              <View style={[styles.cardGlow, { backgroundColor: accent }]} />
              <View style={styles.cardHeaderRow}>
                <Svg width={12} height={12} viewBox="0 0 24 24">
                  <Circle cx={12} cy={12} r={5} fill="none" stroke={accent} strokeWidth={2.5} />
                </Svg>
                <Text style={[styles.cardLabel, { color: accent }]}>READINESS</Text>
              </View>

              {hasScore ? (
                <View style={styles.heroBody}>
                  <ReadinessRing score={result!.score!} color={bandColor(result!.band!)} track={C.muted} size={140} stroke={12}>
                    <Text style={[styles.heroScore, { color: C.foreground }]}>{result!.score}</Text>
                    <Text style={[styles.heroOutOf, { color: C.textMuted }]}>/100</Text>
                  </ReadinessRing>
                  <View style={[styles.pill, { backgroundColor: colorWithAlpha(bandColor(result!.band!), 0.12) }]}>
                    <Text style={[styles.pillText, { color: bandPillTextColor(result!.band!, C) }]}>{directive(result!.band!)}</Text>
                  </View>
                  <Text style={[styles.tierChip, { color: C.textMuted }]}>
                    {result!.tier === 'A1' ? 'From HRV, resting heart rate and sleep'
                      : result!.tier === 'A2' ? 'From resting heart rate and sleep'
                      : 'From your check-in'}
                  </Text>
                  <Text style={[styles.rationale, { color: C.textSecondary }]}>{result!.rationale}</Text>
                </View>
              ) : (
                <View style={styles.heroBody}>
                  <ReadinessRing score={0} color={accent} track={C.muted} size={140} stroke={12}>
                    {working ? (
                      <ActivityIndicator color={accent} />
                    ) : (
                      <Feather name={notConnected ? 'plus-circle' : 'moon'} size={26} color={C.textMuted} />
                    )}
                  </ReadinessRing>
                  <Text style={[styles.emptyTitle, { color: C.foreground }]}>
                    {notConnected ? 'Connect health' : calibrating ? 'Building your baseline' : 'Connected'}
                  </Text>
                  <Text style={[styles.emptySub, { color: C.textMuted }]}>
                    {notConnected
                      ? `Sync your sleep and recovery and Drona reads how recovered you are each morning.`
                      : calibrating
                        ? `Still learning your normal. Give it a week or two of data and readiness kicks in.`
                        : `Connected. Waiting on your first night of data.`}
                  </Text>
                </View>
              )}
            </View>

            {/* WHY TODAY */}
            {hasScore && contributors.length > 0 && (
              <View style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
                <View style={styles.sectionHeader}>
                  <View style={[styles.tile, { backgroundColor: colorWithAlpha(accent, 0.12) }]}>
                    <Feather name="sun" size={IconSize.sm} color={accent} />
                  </View>
                  <Text style={[styles.sectionTitle, { color: C.foreground }]}>Why today</Text>
                </View>
                {contributors.map((c) => {
                  const def = CONTRIB_METRIC[c.key] ? dailyMetricDef(CONTRIB_METRIC[c.key]) : undefined;
                  const col = def ? metricColor(def.colorKey) : C.textMuted;
                  const hasZ = c.z != null && (c.key === 'hrv' || c.key === 'rhr' || c.key === 'sleep');
                  return (
                    <View key={c.key} style={styles.contribRow}>
                      <View style={[styles.tile, { backgroundColor: colorWithAlpha(col, 0.12) }]}>
                        <Feather name={(def?.icon ?? 'circle') as keyof typeof Feather.glyphMap} size={IconSize.sm} color={col} />
                      </View>
                      <Text style={[styles.contribNote, { color: C.foreground }]}>{contributorNote(c)}</Text>
                      {hasZ && (
                        <ZBar z={c.z!} pos={C.successText} neg={C.dangerText} neutral={C.textMuted} track={C.muted} mid={C.border} />
                      )}
                    </View>
                  );
                })}
                <Text style={[styles.caption, { color: C.textMuted }]}>Measured against your own baseline, not anyone else.</Text>
              </View>
            )}

            {/* TREND */}
            {history.length >= 2 && (
              <View style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
                <View style={styles.sectionHeaderSplit}>
                  <Text style={[styles.sectionTitle, { color: C.foreground }]}>Last 14 days</Text>
                  <TrendDelta history={history} C={C} />
                </View>
                <View style={{ marginTop: Spacing.md, marginHorizontal: -4 }}>
                  <MiniAreaChart
                    data={history.map((p) => p.value)}
                    labels={history.map((p) => p.date.slice(5))}
                    width={CHART_W}
                    height={72}
                    color={accent}
                    tooltipBgColor={C.elevated}
                    tooltipTextColor={C.foreground}
                  />
                </View>
              </View>
            )}

            {/* YOUR SIGNALS — your data, read like a coach (not a BI grid) */}
            {hasData && (
              <View style={{ gap: Spacing.lg }}>
                <Text style={[styles.signalsTitle, { color: C.textMuted }]}>Your signals</Text>
                {SIGNAL_ORDER.filter((m) => (series[m]?.length ?? 0) > 0).map((m) => {
                  const def = dailyMetricDef(m);
                  if (!def) return null;
                  return (
                    <SignalCard
                      key={m}
                      def={def}
                      pts={series[m]}
                      col={metricColor(def.colorKey)}
                      C={C}
                      onAsk={() => askAboutMetric(def, series[m])}
                    />
                  );
                })}
              </View>
            )}

            {/* Compact, honest connection line (replaces the old source catalog). */}
            {hasData && (
              <View style={styles.connLine}>
                <View style={[styles.statusDot, { backgroundColor: Colors.success }]} />
                <Text style={[styles.connText, { color: C.textMuted }]}>Syncing from {HUB_LABEL}.</Text>
              </View>
            )}

            {/* MANAGE / CONNECT */}
            {notConnected ? (
              <>
                <Pressable
                  onPress={() => runSync(true)}
                  disabled={working}
                  style={({ pressed }) => [styles.cta, { backgroundColor: Colors.primary }, (pressed || working) && { opacity: 0.85 }]}
                >
                  {working ? (
                    <ActivityIndicator color={Colors.primaryFg} />
                  ) : (
                    <>
                      <Feather name="link" size={IconSize.md} color={Colors.primaryFg} />
                      <Text style={[styles.ctaText, { color: Colors.primaryFg }]}>Connect {HUB_LABEL}</Text>
                    </>
                  )}
                </Pressable>
                <Text style={[styles.worksWith, { color: C.textMuted }]}>
                  Works with {sourcesForHub(HUB).map((s) => s.name).join(', ')}.
                </Text>
              </>
            ) : (
              <Pressable
                onPress={() => runSync(false)}
                disabled={working}
                style={({ pressed }) => [styles.ghost, { borderColor: C.border }, (pressed || working) && { opacity: 0.7 }]}
              >
                {working ? (
                  <ActivityIndicator color={C.foreground} />
                ) : (
                  <>
                    <Feather name="refresh-cw" size={IconSize.md} color={C.foreground} />
                    <Text style={[styles.ghostText, { color: C.foreground }]}>Sync now</Text>
                  </>
                )}
              </Pressable>
            )}

            {status.kind !== 'idle' && status.kind !== 'working' && (
              <View
                style={[
                  styles.statusBox,
                  {
                    backgroundColor:
                      status.kind === 'done' ? colorWithAlpha(Colors.success, 0.1)
                        : status.kind === 'error' ? Colors.dangerBg
                        : C.muted,
                  },
                ]}
              >
                <Text style={[styles.statusText, { color: C.foreground }]}>
                  {status.kind === 'done'
                    ? (status.written ?? 0) > 0
                      ? `Synced ${status.written} readings. Drona folded them into your readiness.`
                      : Platform.OS === 'ios' && !hasData
                        ? 'If you just allowed access, give it a moment. If nothing shows, check Apple Health, then Sharing, then Overload.'
                        : 'Connected. No new readings yet, so nothing to pull right now.'
                    : status.kind === 'unavailable'
                      ? `${HUB_LABEL} is not set up on this device yet. Open it, allow Overload, then try again.`
                      : status.message}
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>

      <AICoachModal
        visible={coachOpen}
        onClose={() => setCoachOpen(false)}
        initialScreen="chat"
        initialPrompt={coachPrompt}
        onRoutineCreated={() => {}}
      />
    </View>
  );
}

function TrendDelta({ history, C }: { history: { value: number }[]; C: ReturnType<typeof useTheme>['C'] }) {
  const latest = history[history.length - 1].value;
  const first = history[0].value;
  const delta = latest - first;
  const col = delta > 0 ? C.successText : delta < 0 ? C.dangerText : C.textMuted;
  const sign = delta > 0 ? '+' : '';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
      <Text style={{ fontSize: FontSize.base, fontWeight: FontWeight.black, color: C.foreground }}>{latest}</Text>
      <Text style={{ fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: col }}>{sign}{delta}</Text>
    </View>
  );
}

function ZBar({ z, pos, neg, neutral, track, mid }: { z: number; pos: string; neg: string; neutral: string; track: string; mid: string }) {
  const W = 64;
  const H = 6;
  const half = W / 2;
  const mag = Math.min(Math.abs(z), 3) / 3;
  const isNeutral = Math.abs(z) < 0.3;
  const fillW = Math.max(2, mag * half);
  const color = isNeutral ? neutral : z > 0 ? pos : neg;
  return (
    <View style={{ width: W, height: H, borderRadius: H / 2, backgroundColor: track, justifyContent: 'center' }}>
      <View style={{ position: 'absolute', left: half - 0.5, width: 1, height: H, backgroundColor: mid }} />
      {isNeutral ? (
        <View style={{ position: 'absolute', left: half - 3, width: 6, height: H, borderRadius: H / 2, backgroundColor: color }} />
      ) : (
        <View style={{ position: 'absolute', height: H, borderRadius: H / 2, backgroundColor: color, width: fillW, left: z > 0 ? half : half - fillW }} />
      )}
    </View>
  );
}

function SignalCard({
  def,
  pts,
  col,
  C,
  onAsk,
}: {
  def: DailyMetricDef;
  pts: { date: string; value: number }[];
  col: string;
  C: ReturnType<typeof useTheme>['C'];
  onAsk: () => void;
}) {
  const vals = pts.map((p) => p.value);
  const latest = vals[vals.length - 1];
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const enough = n >= 4 && sd > 0;
  const info = METRIC_INFO[def.type];

  // Coached caption: where today sits vs the user's own normal, in plain words.
  let caption = '';
  let capColor = C.textMuted;
  if (enough) {
    const dev = (latest - mean) / sd;
    if (Math.abs(dev) < 0.5) {
      caption = 'Right around your normal';
    } else if (info?.higherBetter == null) {
      caption = latest > mean ? 'Up from your usual' : 'Down from your usual';
    } else {
      const good = (latest > mean) === info.higherBetter;
      caption = latest > mean ? 'Above your normal' : 'Below your normal';
      capColor = good ? C.successText : C.dangerText;
    }
  }
  const baseline = enough ? { lo: mean - sd, hi: mean + sd } : undefined;

  return (
    <View style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
      <View style={styles.sigHeadRow}>
        <View style={styles.sigHeadLeft}>
          <View style={[styles.tile, { backgroundColor: colorWithAlpha(col, 0.12) }]}>
            <Feather name={def.icon as keyof typeof Feather.glyphMap} size={IconSize.sm} color={col} />
          </View>
          <Text style={[styles.signalLabel, { color: C.textMuted }]}>{def.label}</Text>
        </View>
        <Pressable onPress={onAsk} hitSlop={8} style={[styles.askChip, { backgroundColor: C.muted }]}>
          <Feather name="message-circle" size={11} color={C.accentText} />
          <Text style={[styles.askText, { color: C.accentText }]}>Ask Drona</Text>
        </Pressable>
      </View>

      <View style={styles.sigValueRow}>
        <Text style={[styles.sigValue, { color: C.foreground }]}>{def.format(latest)}</Text>
        {!!caption && <Text style={[styles.sigCaption, { color: capColor }]}>{caption}</Text>}
      </View>

      {!!info && <Text style={[styles.sigMeaning, { color: C.textMuted }]}>{info.meaning}</Text>}

      {pts.length >= 2 ? (
        <View style={{ marginTop: Spacing.sm, marginHorizontal: -4 }}>
          <MiniAreaChart
            data={vals}
            labels={pts.map((p) => p.date.slice(5))}
            width={CHART_W}
            height={60}
            color={col}
            autoScale
            baseline={baseline}
            tooltipBgColor={C.elevated}
            tooltipTextColor={C.foreground}
          />
        </View>
      ) : (
        <Text style={[styles.sigMeaning, { color: C.textDim, marginTop: 4 }]}>Building history. Check back in a few days.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  card: { borderRadius: Radius.xl, borderWidth: 1, padding: Spacing.lg, overflow: 'hidden', position: 'relative' },
  cardGlow: { position: 'absolute', top: -40, left: -40, width: 120, height: 120, borderRadius: 60, opacity: 0.04 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.sm },
  cardLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: 0.6, textTransform: 'uppercase' },
  heroBody: { alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.sm },
  heroScore: { fontSize: FontSize.display, fontWeight: FontWeight.black, letterSpacing: -1 },
  heroOutOf: { fontSize: FontSize.sm, marginTop: -6 },
  pill: { paddingHorizontal: Spacing.md, paddingVertical: 6, borderRadius: Radius.full },
  pillText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  tierChip: { fontSize: FontSize.xs },
  rationale: { fontSize: FontSize.base, lineHeight: 21, textAlign: 'center', paddingHorizontal: Spacing.md },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, marginTop: Spacing.xs },
  emptySub: { fontSize: FontSize.sm, lineHeight: 19, textAlign: 'center', paddingHorizontal: Spacing.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.md },
  sectionHeaderSplit: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tile: { width: 28, height: 28, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  contribRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md, paddingVertical: Spacing.sm },
  contribNote: { flex: 1, fontSize: FontSize.sm, lineHeight: 18 },
  caption: { fontSize: FontSize.xs, marginTop: Spacing.sm },
  signalsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: Spacing.lg },
  signalCard: { width: '47%', borderRadius: Radius.lg, borderWidth: 1, padding: Spacing.md, overflow: 'hidden' },
  signalHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  signalLabel: { flex: 1, fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: 0.4, textTransform: 'uppercase' },
  signalValue: { fontSize: FontSize.xl, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  signalSub: { fontSize: 10, marginTop: 6 },
  connLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.xs },
  connText: { fontSize: FontSize.sm },
  worksWith: { fontSize: FontSize.sm, lineHeight: 18, textAlign: 'center', marginTop: Spacing.md, paddingHorizontal: Spacing.lg },
  signalsTitle: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: 0.6, textTransform: 'uppercase' },
  sigHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sigHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 },
  askChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.full },
  askText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  sigValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.sm, marginTop: Spacing.sm, flexWrap: 'wrap' },
  sigValue: { fontSize: FontSize.xxl, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  sigCaption: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  sigMeaning: { fontSize: FontSize.sm, lineHeight: 18, marginTop: 2 },
  sourceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md, paddingVertical: Spacing.sm },
  sourceNameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  sourceName: { fontSize: FontSize.base, fontWeight: FontWeight.medium },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  chip: { borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 2 },
  chipText: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  missingRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: 6 },
  missingText: { flex: 1, fontSize: FontSize.sm },
  divider: { height: 1, marginVertical: Spacing.md },
  compatRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: 6 },
  compatName: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  caveatRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingLeft: 40, paddingBottom: 6 },
  caveatText: { flex: 1, fontSize: FontSize.sm, lineHeight: 18 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg, borderRadius: Radius.lg, minHeight: 52 },
  ctaText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  ghost: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingVertical: Spacing.md, borderRadius: Radius.lg, borderWidth: 1, minHeight: 48 },
  ghostText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  statusBox: { padding: Spacing.lg, borderRadius: Radius.md },
  statusText: { fontSize: FontSize.base, lineHeight: 20 },
});
