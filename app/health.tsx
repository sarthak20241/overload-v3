/**
 * Health connect screen (holistic tracking, v1).
 *
 * Root-level full-screen route (like workout/[id]) so it sits outside the tab
 * layout. Reachable now via router.push('/health') or the deep link
 * overload://health; a polished entry point (a Drona-framed dashboard card) lands
 * with the readiness work in Phase 2. Lets the user connect Apple Health /
 * Health Connect and pull a first sync. Plan: .planning/holistic-tracking-plan.md.
 */
import { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Platform,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '@clerk/clerk-expo';
import { useSupabaseClient } from '@/lib/supabase';
import { requestHealthAuthorization, syncHealthData } from '@/lib/healthSync';
import { sourcesForHub, type HealthHub } from '@/lib/healthSources';
import { Colors, Spacing, Radius, FontSize, FontWeight, IconSize, colorWithAlpha } from '@/constants/theme';

const C = Colors.light;
const HUB: HealthHub = Platform.OS === 'ios' ? 'healthkit' : 'health_connect';
const HUB_LABEL = Platform.OS === 'ios' ? 'Apple Health' : 'Health Connect';

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; written: number }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

export default function HealthConnectScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { userId } = useAuth();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const sources = sourcesForHub(HUB);
  const busy = status.kind === 'working';

  async function onConnect() {
    if (!userId) {
      setStatus({ kind: 'error', message: 'Sign in first so your data can sync to your account.' });
      return;
    }
    setStatus({ kind: 'working' });
    try {
      const authorized = await requestHealthAuthorization();
      if (!authorized) {
        setStatus({ kind: 'unavailable' });
        return;
      }
      const result = await syncHealthData(supabase, userId);
      setStatus({ kind: 'done', written: result?.written ?? 0 });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Something went wrong.' });
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Feather name="chevron-left" size={IconSize.lg} color={C.foreground} />
        </Pressable>
        <Text style={styles.headerTitle}>Health</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: Spacing.xl, paddingBottom: insets.bottom + Spacing.xxxl }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.lede}>
          Connect {HUB_LABEL} and Drona can read your sleep, steps, heart rate and bodyweight to gauge
          how recovered you are. Nothing leaves your account, and you can disconnect any time in {HUB_LABEL}.
        </Text>

        <Pressable
          onPress={onConnect}
          disabled={busy}
          style={({ pressed }) => [styles.cta, (pressed || busy) && styles.ctaPressed]}
        >
          {busy ? (
            <ActivityIndicator color={Colors.primaryFg} />
          ) : (
            <>
              <Feather name="link" size={IconSize.md} color={Colors.primaryFg} />
              <Text style={styles.ctaText}>Connect {HUB_LABEL}</Text>
            </>
          )}
        </Pressable>

        {status.kind !== 'idle' && status.kind !== 'working' && (
          <View
            style={[
              styles.statusBox,
              {
                backgroundColor:
                  status.kind === 'done'
                    ? colorWithAlpha(Colors.success, 0.1)
                    : status.kind === 'error'
                      ? Colors.dangerBg
                      : C.muted,
              },
            ]}
          >
            <Text style={styles.statusText}>
              {status.kind === 'done'
                ? status.written > 0
                  ? `Synced ${status.written} readings. Drona will fold these into your readiness.`
                  : 'Connected. No new readings yet, so nothing to pull right now.'
                : status.kind === 'unavailable'
                  ? `${HUB_LABEL} is not set up on this device yet. Open it, allow Overload, then try again.`
                  : status.message}
            </Text>
          </View>
        )}

        <Text style={styles.sectionLabel}>Works with</Text>
        {sources.map((s) => (
          <View key={s.id} style={styles.sourceRow}>
            <View style={styles.sourceIcon}>
              <Feather name={s.icon as keyof typeof Feather.glyphMap} size={IconSize.sm} color={C.textSecondary} />
            </View>
            <View style={styles.sourceText}>
              <Text style={styles.sourceName}>{s.name}</Text>
              <Text style={styles.sourceHint}>{s.caveat ?? s.setupHint}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: C.foreground },
  lede: { fontSize: FontSize.base, lineHeight: 21, color: C.textSecondary, marginBottom: Spacing.xl },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.primary,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.lg,
    minHeight: 52,
  },
  ctaPressed: { opacity: 0.85 },
  ctaText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  statusBox: { marginTop: Spacing.lg, padding: Spacing.lg, borderRadius: Radius.md },
  statusText: { fontSize: FontSize.base, lineHeight: 20, color: C.foreground },
  sectionLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: C.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: Spacing.xxxl,
    marginBottom: Spacing.md,
  },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.md },
  sourceIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: C.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceText: { flex: 1 },
  sourceName: { fontSize: FontSize.base, fontWeight: FontWeight.medium, color: C.foreground },
  sourceHint: { fontSize: FontSize.sm, color: C.textMuted, marginTop: 2, lineHeight: 17 },
});
