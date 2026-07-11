/**
 * Readiness hub (holistic tracking, Phase 2 redesign).
 *
 * Root-level full-screen route (like workout/[id]), reached from the dashboard
 * ReadinessCard and the deep link overload://health. It is NOT a connect button:
 * once data is flowing it shows the readiness score, WHY it moved (contributors
 * vs the user's own baseline), the trend, and WHAT is feeding it. Sleep is the
 * anchor of the score, so a phone-only user can log last night by hand (the sleep
 * sheet) and get a read without any wearable. The "Sharpen the read" section then
 * shows, honestly, which extra signals would tighten it. Fully theme-aware.
 * Plan: .planning/holistic-tracking-plan.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { loadReadiness, loadReadinessHistory, runHealthSyncAndReadiness } from '@/lib/readinessSync';
import {
  loadConnectedMetrics,
  loadMetricSeries,
  requestHealthAuthorization,
  markHealthConnected,
  getHealthConnectionStatus,
  type ReadableMetric,
  type HealthConnectionStatus,
} from '@/lib/healthSync';
import { logSleepForToday, loadRecentSleep, type SleepEntry } from '@/lib/sleepLog';
import { bandColor, directive, bandPillTextColor, contributorImpact, bandForScore, type ReadinessBand, type ReadinessContributor, type ReadinessResult, type ReadinessTier } from '@/lib/readiness';
import { ReadinessRing } from '@/components/ui/ReadinessRing';
import { MiniAreaChart } from '@/components/ui/MiniAreaChart';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { SleepLogSheet } from '@/components/health/SleepLogSheet';
import { haptics } from '@/lib/haptics';
import { dailyMetricDef, type DailyMetricDef } from '@/lib/dailyMetrics';
import { sourcesForHub, type HealthHub } from '@/lib/healthSources';
import { Colors, Spacing, Radius, FontSize, FontWeight, IconSize, Shadow, colorWithAlpha } from '@/constants/theme';

const HUB: HealthHub = Platform.OS === 'ios' ? 'healthkit' : 'health_connect';
const HUB_LABEL = Platform.OS === 'ios' ? 'Apple Health' : 'Health Connect';
const CHART_W = Math.round(Dimensions.get('window').width - Spacing.xl * 2 - Spacing.lg * 2);
// Recovery signals (HRV/RHR/sleep) live in the hero's contributor bars, told once.
// "Your signals" carries only activity/body, the stuff not already in the score.
const SIGNAL_ORDER: ReadableMetric[] = ['steps', 'active_energy_kcal', 'bodyweight_kg'];
const DEFAULT_SLEEP_MINUTES = 480; // 8h, the prefill when we have no prior night.

// Band-specific next move; the line is tappable into Drona.
function actionLine(band: ReadinessBand): { text: string; prompt: string } {
  if (band === 'high') return { text: 'Good day to push. Tap to plan it with Drona.', prompt: 'My readiness is high today. How should I push my session, and is it worth chasing a top set?' };
  if (band === 'moderate') return { text: 'Train as planned. Tap for a gut check.', prompt: 'My readiness is moderate today. Should I train as planned or adjust anything?' };
  return { text: 'Ease off today. Tap for a lighter version.', prompt: 'My readiness is low today. How should I lighten my session to protect recovery?' };
}

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
  | { kind: 'logged' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

// contributor key -> daily-metric type (load has no metric)
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
  const params = useLocalSearchParams<{ log?: string }>();

  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ReadinessResult | null>(null);
  const [metrics, setMetrics] = useState<Set<ReadableMetric>>(new Set());
  const [deviceMetrics, setDeviceMetrics] = useState<Set<ReadableMetric>>(new Set());
  const [connStatus, setConnStatus] = useState<HealthConnectionStatus>('unknown');
  const [recentSleep, setRecentSleep] = useState<{ today: SleepEntry | null; yesterday: SleepEntry | null }>({ today: null, yesterday: null });
  const [recentSleepReady, setRecentSleepReady] = useState(false);
  const [history, setHistory] = useState<{ date: string; value: number }[]>([]);
  const [series, setSeries] = useState<Record<string, { date: string; value: number }[]>>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachPrompt, setCoachPrompt] = useState<string | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const accent = stat.readiness;
  const metricColor = (colorKey: string) => stat[colorKey] ?? C.textSecondary;

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    // Progressive load: unblock the screen the moment readiness (the hero) is
    // known, and let the trend / signals / sharpen data stream in behind it. Each
    // of those sections already renders nothing until its query lands, so the
    // score no longer waits on the slowest of six round-trips (the old Promise.all
    // meant one slow query held the whole screen on a spinner).
    getHealthConnectionStatus(userId).then(setConnStatus).catch(() => {});
    // A failed connected-metrics read must NOT flip a connected user back to the
    // first-run "Connect health" state, so only apply a successful result.
    loadConnectedMetrics(supabase, userId)
      .then((c) => { setMetrics(c.metrics); setDeviceMetrics(c.deviceMetrics); })
      .catch(() => {});
    // recentSleepReady (set on settle, success or failure) gates the ?log=1
    // auto-open below, since progressive load no longer holds `loading` for this.
    loadRecentSleep(supabase, userId)
      .then(setRecentSleep)
      .catch(() => {})
      .finally(() => setRecentSleepReady(true));
    loadReadinessHistory(supabase, userId).then(setHistory).catch(() => {});
    loadMetricSeries(supabase, userId).then(setSeries).catch(() => {});

    // The hero gates the spinner. On a transient failure keep the last-known
    // result (nulling it would misreport "no readiness") and surface a retry banner.
    try {
      const r = await loadReadiness(supabase, userId);
      setResult(r);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [userId, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  // Deep link overload://health?log=1 (and the dashboard "Log last night" card)
  // opens the sleep sheet once. One-shot: the param persists on the route, so a
  // re-render or pull-to-refresh must not reopen a sheet the user dismissed.
  // Gate on recentSleepReady (not just !loading) so the sheet opens AFTER the
  // prefill has settled; progressive load resolves `loading` on the readiness
  // hero alone, while the sheet only reads its prefill when `visible` flips true,
  // so opening early would show 8h/no-quality defaults over an existing entry.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (params.log === '1' && !autoOpenedRef.current && recentSleepReady && userId) {
      autoOpenedRef.current = true;
      setSheetOpen(true);
    }
  }, [params.log, userId, recentSleepReady]);

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

  // The hero "so what" line: open Drona with a band-specific next move.
  function askAction(r: ReadinessResult) {
    if (!r.band) return;
    setCoachPrompt(actionLine(r.band).prompt);
    setCoachOpen(true);
  }

  // A one-shot status (synced / logged / error) should not stay pinned forever.
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
        // Remember we connected, so status reads 'granted' even before data lands.
        await markHealthConnected(userId);
      }
      const { synced } = await runHealthSyncAndReadiness(supabase, userId);
      setStatus({ kind: 'done', written: synced });
      await load();
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Something went wrong.' });
    }
  }

  function openSleepSheet() {
    if (!userId) {
      setStatus({ kind: 'error', message: 'Sign in first so your sleep saves to your account.' });
      return;
    }
    setSheetOpen(true);
  }

  async function handleSaveSleep(minutes: number, quality: number | null) {
    if (!userId) {
      setSheetOpen(false);
      setStatus({ kind: 'error', message: 'Sign in first so your sleep saves to your account.' });
      return;
    }
    setSaving(true);
    try {
      await logSleepForToday(supabase, userId, { minutes, quality });
      haptics.success();
      setSheetOpen(false);
      setStatus({ kind: 'logged' });
      await load();
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Could not save your sleep just now.' });
    } finally {
      setSaving(false);
    }
  }

  const hasScore = result?.score != null && result.band != null;
  const connected = connStatus === 'granted' || deviceMetrics.size > 0;
  const hasData = metrics.size > 0;
  const anyPresence = connected || hasData;
  const notConnected = !anyPresence;
  const working = status.kind === 'working';

  const contributors = result?.contributors ?? [];
  const sleepManual = recentSleep.today?.source === 'manual';
  const prefillMinutes = recentSleep.today?.minutes ?? recentSleep.yesterday?.minutes ?? DEFAULT_SLEEP_MINUTES;
  const prefillQuality = recentSleep.today?.quality ?? null;

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
                  {result!.provisional && (
                    <Text style={[styles.earlyTag, { color: C.textMuted }]}>Early read. Sharpens as I learn your normal.</Text>
                  )}
                  <Text style={[styles.tierChip, { color: C.textMuted }]}>
                    {result!.tier === 'A1' ? 'From HRV, resting heart rate and sleep'
                      : result!.tier === 'A2' ? 'From resting heart rate and sleep'
                      : 'From your sleep'}
                  </Text>
                  <Text style={[styles.rationale, { color: C.textSecondary }]}>{result!.rationale}</Text>
                  <ContributorBars contributors={contributors} tier={result!.tier} C={C} />
                  <Pressable
                    onPress={() => askAction(result!)}
                    style={({ pressed }) => [styles.actionLine, { borderColor: C.borderSubtle }, pressed && { opacity: 0.7 }]}
                  >
                    <Feather name="message-circle" size={IconSize.sm} color={C.accentText} />
                    <Text style={[styles.actionText, { color: C.foreground }]}>{actionLine(result!.band!).text}</Text>
                    <Feather name="chevron-right" size={IconSize.sm} color={C.textMuted} />
                  </Pressable>
                </View>
              ) : anyPresence ? (
                <View style={styles.heroBody}>
                  <ReadinessRing score={0} color={accent} track={C.muted} size={140} stroke={12}>
                    {working ? <ActivityIndicator color={accent} /> : <Feather name="moon" size={26} color={C.textMuted} />}
                  </ReadinessRing>
                  <Text style={[styles.emptyTitle, { color: C.foreground }]}>Log last night</Text>
                  <Text style={[styles.emptySub, { color: C.textMuted }]}>
                    Sleep is the one signal readiness needs. Takes ten seconds.
                  </Text>
                  <Pressable
                    onPress={openSleepSheet}
                    style={({ pressed }) => [styles.cta, styles.heroCta, { backgroundColor: Colors.primary }, pressed && { opacity: 0.85 }]}
                  >
                    <Feather name="moon" size={IconSize.md} color={Colors.primaryFg} />
                    <Text style={[styles.ctaText, { color: Colors.primaryFg }]}>Log last night</Text>
                  </Pressable>
                  {connected && !deviceMetrics.has('sleep_minutes') && (
                    <Text style={[styles.emptySub, { color: C.textMuted }]}>
                      Have a tracker? Wear it to bed and sleep syncs on its own.
                    </Text>
                  )}
                </View>
              ) : (
                <View style={styles.heroBody}>
                  <ReadinessRing score={0} color={accent} track={C.muted} size={140} stroke={12}>
                    {working ? <ActivityIndicator color={accent} /> : <Feather name="plus-circle" size={26} color={C.textMuted} />}
                  </ReadinessRing>
                  <Text style={[styles.emptyTitle, { color: C.foreground }]}>Connect health</Text>
                  <Text style={[styles.emptySub, { color: C.textMuted }]}>
                    Sync your sleep and recovery and Drona reads how recovered you are each morning. No wearable? Log sleep by hand.
                  </Text>
                </View>
              )}
            </View>

            {/* SHARPEN THE READ — honest, unpushy: what would tighten the score */}
            {hasScore && (
              <SharpenSection
                result={result!}
                metrics={metrics}
                sleepManual={sleepManual}
                onEditSleep={openSleepSheet}
                C={C}
              />
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
                    autoScale
                    refLines={[40, 66]}
                    lastPointColor={bandColor(bandForScore(history[history.length - 1].value))}
                    formatValue={(v) => String(Math.round(v))}
                    accessibilityLabel={`Readiness over ${history.length} days, today ${Math.round(history[history.length - 1].value)} out of 100`}
                    tooltipBgColor={C.elevated}
                    tooltipTextColor={C.foreground}
                  />
                </View>
                <Text style={[styles.caption, { color: C.textMuted, marginTop: Spacing.sm }]}>
                  Dashes mark the low and high zones. Measured against your own baseline.
                </Text>
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

            {/* Compact, honest connection line. */}
            {anyPresence && (
              <View style={styles.connLine}>
                <View style={[styles.statusDot, { backgroundColor: deviceMetrics.size > 0 ? Colors.success : C.textMuted }]} />
                <Text style={[styles.connText, { color: C.textMuted }]}>
                  {deviceMetrics.size > 0
                    ? `Syncing from ${HUB_LABEL}.`
                    : 'Logged by hand. Connect a wearable any time and it syncs on its own.'}
                </Text>
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
                <Pressable
                  onPress={openSleepSheet}
                  disabled={working}
                  style={({ pressed }) => [styles.ghost, { borderColor: C.border }, (pressed || working) && { opacity: 0.7 }]}
                >
                  <Feather name="moon" size={IconSize.md} color={C.foreground} />
                  <Text style={[styles.ghostText, { color: C.foreground }]}>Log sleep by hand</Text>
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
                      status.kind === 'done' || status.kind === 'logged' ? colorWithAlpha(Colors.success, 0.1)
                        : status.kind === 'error' ? Colors.dangerBg
                        : C.muted,
                  },
                ]}
              >
                <Text style={[styles.statusText, { color: C.foreground }]}>
                  {status.kind === 'logged'
                    ? 'Logged. Drona folded it into your readiness.'
                    : status.kind === 'done'
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

      <SleepLogSheet
        visible={sheetOpen}
        initialMinutes={prefillMinutes}
        initialQuality={prefillQuality}
        editing={sleepManual}
        saving={saving}
        onSave={handleSaveSleep}
        onClose={() => setSheetOpen(false)}
      />

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
  const latest = Math.round(history[history.length - 1].value);
  const mean = (arr: { value: number }[]) => arr.reduce((a, p) => a + p.value, 0) / (arr.length || 1);
  // Last 3 days vs the prior 3, so one stale morning cannot flip the read.
  const recent = history.slice(-3);
  const prior = history.slice(-6, -3);
  const delta = prior.length ? Math.round(mean(recent) - mean(prior)) : 0;
  const col = delta > 0 ? C.successText : delta < 0 ? C.dangerText : C.textMuted;
  const sign = delta > 0 ? '+' : '';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
      <Text style={{ fontSize: FontSize.base, fontWeight: FontWeight.black, color: C.foreground }}>{latest}</Text>
      {prior.length > 0 && (
        <Text style={{ fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: col }}>{sign}{delta}</Text>
      )}
    </View>
  );
}

// Ranked "what moved my score today": diverging bars, length = weight x deviation,
// right = lifted the score, left = dragged it down.
function ContributorBars({ contributors, tier, C }: {
  contributors: ReadinessContributor[];
  tier: ReadinessTier;
  C: ReturnType<typeof useTheme>['C'];
}) {
  const rows = contributors
    .filter((c) => c.z != null && (c.key === 'hrv' || c.key === 'rhr' || c.key === 'sleep'))
    .map((c) => ({ c, impact: contributorImpact(tier, c) }))
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  if (rows.length === 0) return null;
  const maxImpact = Math.max(...rows.map((r) => Math.abs(r.impact)), 0.01);
  return (
    <View style={styles.cbWrap}>
      {rows.map(({ c, impact }) => {
        const def = dailyMetricDef(CONTRIB_METRIC[c.key]);
        const neutral = Math.abs(c.z ?? 0) < 0.3;
        const good = impact >= 0;
        const barColor = neutral ? C.textMuted : good ? C.successText : C.dangerText;
        const frac = Math.min(Math.abs(impact) / maxImpact, 1);
        return (
          <View key={c.key} style={styles.cbRow}>
            <Text style={[styles.cbLabel, { color: C.textSecondary }]} numberOfLines={1}>{def?.shortLabel ?? c.key}</Text>
            <View style={[styles.cbTrack, { backgroundColor: C.muted }]}>
              <View style={[styles.cbMid, { backgroundColor: C.border }]} />
              {neutral ? (
                <View style={[styles.cbDot, { backgroundColor: C.textMuted }]} />
              ) : (
                <View style={[styles.cbBar, { backgroundColor: barColor, width: `${frac * 50}%`, left: good ? '50%' : `${50 - frac * 50}%` }]} />
              )}
            </View>
          </View>
        );
      })}
      <Text style={[styles.cbNote, { color: C.textMuted }]}>{contributorNote(rows[0].c)}</Text>
    </View>
  );
}

type SharpenState = 'active' | 'building' | 'missing';

// Honest "what would tighten the read" panel. One row per recovery signal plus
// training load, each with its live status. Never nags; it just tells the truth
// about which inputs are feeding the score and what a wearable would add.
function SharpenSection({
  result,
  metrics,
  sleepManual,
  onEditSleep,
  C,
}: {
  result: ReadinessResult;
  metrics: Set<ReadableMetric>;
  sleepManual: boolean;
  onEditSleep: () => void;
  C: ReturnType<typeof useTheme>['C'];
}) {
  const contribKeys = new Set(result.contributors.map((c) => c.key));
  const rhrState: SharpenState = contribKeys.has('rhr') ? 'active' : metrics.has('resting_hr_bpm') ? 'building' : 'missing';
  const hrvState: SharpenState = contribKeys.has('hrv') ? 'active' : metrics.has('hrv_sdnn_ms') ? 'building' : 'missing';
  // Diet is factored in only when the user logs food (a 'diet' contributor exists).
  const dietContrib = result.contributors.find((c) => c.key === 'diet');

  const rows: { icon: keyof typeof Feather.glyphMap; label: string; state: SharpenState; note: string; onEdit?: () => void }[] = [
    {
      icon: 'moon',
      label: 'Sleep',
      state: 'active',
      note: sleepManual ? 'Logged by hand.' : 'Synced from your tracker.',
      onEdit: sleepManual ? onEditSleep : undefined,
    },
    {
      icon: 'heart',
      label: 'Resting heart rate',
      state: rhrState,
      note: rhrState === 'active' ? 'Reading your recovery.'
        : rhrState === 'building' ? 'Coming in. A few more days and it joins your score.'
        : 'Add a heart rate wearable and I can read recovery, not just rest.',
    },
    {
      icon: 'wind',
      label: 'HRV',
      state: hrvState,
      note: hrvState === 'active' ? 'Tuning how recovered you are.'
        : hrvState === 'building' ? 'Coming in. A few more days and it joins your score.'
        : 'HRV needs a tracker worn overnight (watch, ring, or band).',
    },
    { icon: 'activity', label: 'Training load', state: 'active', note: 'Already tracked from your workouts.' },
    {
      icon: 'pie-chart',
      label: 'Nutrition',
      state: dietContrib ? 'active' : 'missing',
      note: dietContrib ? dietContrib.note : 'Log your food and I factor your fueling into recovery.',
    },
  ];

  return (
    <View style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
      <Text style={[styles.sectionTitle, { color: C.foreground, marginBottom: Spacing.sm }]}>Sharpen the read</Text>
      {rows.map((row) => {
        const statusColor = row.state === 'active' ? C.successText : row.state === 'building' ? C.warningText : C.textMuted;
        const statusIcon: keyof typeof Feather.glyphMap = row.state === 'active' ? 'check-circle' : row.state === 'building' ? 'clock' : 'plus-circle';
        return (
          <View key={row.label} style={styles.sharpRow}>
            <View style={[styles.sharpTile, { backgroundColor: colorWithAlpha(statusColor, 0.12) }]}>
              <Feather name={row.icon} size={IconSize.sm} color={statusColor} />
            </View>
            <View style={styles.sharpBody}>
              <View style={styles.sharpLabelRow}>
                <Text style={[styles.sharpLabel, { color: C.foreground }]}>{row.label}</Text>
                {row.onEdit && (
                  <Pressable onPress={row.onEdit} hitSlop={8}>
                    <Text style={[styles.sharpEdit, { color: C.accentText }]}>Edit</Text>
                  </Pressable>
                )}
              </View>
              <Text style={[styles.sharpNote, { color: C.textMuted }]}>{row.note}</Text>
            </View>
            <Feather name={statusIcon} size={IconSize.sm} color={statusColor} />
          </View>
        );
      })}
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
            formatValue={def.format}
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
  earlyTag: { fontSize: FontSize.xs, fontStyle: 'italic' },
  tierChip: { fontSize: FontSize.xs },
  rationale: { fontSize: FontSize.base, lineHeight: 21, textAlign: 'center', paddingHorizontal: Spacing.md },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, marginTop: Spacing.xs },
  emptySub: { fontSize: FontSize.sm, lineHeight: 19, textAlign: 'center', paddingHorizontal: Spacing.lg },
  heroCta: { alignSelf: 'stretch', marginTop: Spacing.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.md },
  sectionHeaderSplit: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tile: { width: 28, height: 28, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  caption: { fontSize: FontSize.xs, marginTop: Spacing.sm },
  actionLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, alignSelf: 'stretch', marginTop: Spacing.md, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, borderWidth: 1, borderRadius: Radius.lg },
  actionText: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  cbWrap: { width: '100%', gap: 8, marginTop: Spacing.md },
  cbRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  cbLabel: { width: 52, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  cbTrack: { flex: 1, height: 8, borderRadius: 4, position: 'relative', justifyContent: 'center' },
  cbMid: { position: 'absolute', left: '50%', width: 1, height: 8 },
  cbBar: { position: 'absolute', height: 8, borderRadius: 4 },
  cbDot: { position: 'absolute', left: '50%', marginLeft: -3, width: 6, height: 6, borderRadius: 3 },
  cbNote: { fontSize: FontSize.sm, lineHeight: 18, marginTop: 4 },
  sharpRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.sm },
  sharpTile: { width: 32, height: 32, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  sharpBody: { flex: 1 },
  sharpLabelRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  sharpLabel: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  sharpEdit: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  sharpNote: { fontSize: FontSize.sm, lineHeight: 17, marginTop: 1 },
  signalsTitle: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: 0.6, textTransform: 'uppercase' },
  sigHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sigHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 },
  signalLabel: { flex: 1, fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: 0.4, textTransform: 'uppercase' },
  askChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.full },
  askText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  sigValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.sm, marginTop: Spacing.sm, flexWrap: 'wrap' },
  sigValue: { fontSize: FontSize.xxl, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  sigCaption: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  sigMeaning: { fontSize: FontSize.sm, lineHeight: 18, marginTop: 2 },
  connLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.xs },
  connText: { flex: 1, fontSize: FontSize.sm },
  worksWith: { fontSize: FontSize.sm, lineHeight: 18, textAlign: 'center', marginTop: Spacing.xs, paddingHorizontal: Spacing.lg },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg, borderRadius: Radius.lg, minHeight: 52 },
  ctaText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  ghost: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingVertical: Spacing.md, borderRadius: Radius.lg, borderWidth: 1, minHeight: 48 },
  ghostText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  statusBox: { padding: Spacing.lg, borderRadius: Radius.md },
  statusText: { fontSize: FontSize.base, lineHeight: 20 },
});
