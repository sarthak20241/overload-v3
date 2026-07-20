/**
 * Import Data — bring workout history in from other apps.
 *
 * Currently supports Hevy's "Export Workouts" CSV. The user picks their export
 * file; we parse + map it on-device (lib/hevyImport.ts) and enqueue each workout
 * through the normal offline-sync write path (lib/syncQueue) — so imported
 * workouts insert exactly like ones finished in-app: RLS-safe, idempotent
 * (re-importing the same file doesn't duplicate, thanks to a deterministic
 * client_id), exercise-resolving (unknown names become customs), and cached so
 * they show up in History immediately.
 *
 * Hidden tab route (like exercises / admin/research). Reached from Profile.
 * Requires sign-in — guests are prompted to sign in first.
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, BackHandler,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { useToast } from '@/components/ui/Toast';
import { useSync } from '@/components/SyncProvider';
import { enqueueWorkout, getPendingWorkouts } from '@/lib/syncQueue';
import { buildHevyImport, type ImportUnit, type HevyImportSummary } from '@/lib/hevyImport';

type Phase = 'idle' | 'parsed' | 'importing' | 'done';

interface ImportOutcome {
  requested: number;
  synced: number;
  queued: number;   // enqueued but not yet on the server (offline / mid-flush)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// How long to keep nudging the sync queue before calling the rest "will finish
// later". Generous — a big import is many inserts over gym wifi.
const SYNC_WAIT_MS = 60_000;

// Sources we can import from. Only Hevy is wired up today; the list keeps the
// screen ready for CSV exports from other apps later.
const SOURCES = [
  { key: 'hevy', name: 'Hevy', blurb: 'Export Workouts → CSV, then pick the file here.', enabled: true },
] as const;

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ImportScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const isGuest = useIsGuestSession();
  const { user } = useClerkUser();
  const toast = useToast();
  const { flushNow } = useSync();

  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [unit, setUnit] = useState<ImportUnit>('kg');
  const [phase, setPhase] = useState<Phase>('idle');
  const [parseError, setParseError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [syncedSoFar, setSyncedSoFar] = useState(0);

  // Hardware back returns to Profile.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { router.back(); return true; });
    return () => sub.remove();
  }, [router]);

  // Re-map whenever the file or unit changes. Cheap (a few thousand rows), pure.
  const built = useMemo(() => {
    if (!csvText || !user?.id) return null;
    try {
      return buildHevyImport({ csvText, userId: user.id, unit });
    } catch {
      return null;
    }
  }, [csvText, user?.id, unit]);

  const summary: HevyImportSummary | null = built?.summary ?? null;

  const pickFile = useCallback(async () => {
    setParseError(null);
    setOutcome(null);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        // Broad set: iOS/Android surface CSVs under several MIME/UTI names.
        type: ['text/csv', 'text/comma-separated-values', 'application/csv', 'application/vnd.ms-excel', 'text/plain', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      const text = await new File(asset.uri).text();

      // Guard: make sure this actually looks like a Hevy export before previewing.
      const head = text.slice(0, 500).toLowerCase();
      if (!head.includes('exercise_title') || !head.includes('start_time')) {
        setCsvText(null);
        setPhase('idle');
        setParseError("That file doesn't look like a Hevy export. In Hevy: Settings → Export & Import Data → Export Workouts.");
        return;
      }
      setFileName(asset.name ?? 'workouts.csv');
      setCsvText(text);
      setPhase('parsed');
    } catch (err: any) {
      setParseError(`Couldn't read that file: ${String(err?.message ?? err)}`);
    }
  }, []);

  const runImport = useCallback(async () => {
    if (!built || !user?.id) return;
    const userId = user.id;
    const { workouts } = built;
    if (workouts.length === 0) {
      toast.error('Nothing to import from that file.');
      return;
    }
    setPhase('importing');
    setSyncedSoFar(0);
    try {
      // Skip any workout already queued this session (deterministic clientId
      // means re-importing is also DB-safe; the unique index dedupes server-side).
      const queuedIds = new Set(getPendingWorkouts(userId).map((w) => w.clientId));
      const fresh = workouts.filter((w) => !queuedIds.has(w.clientId));
      for (const w of fresh) await enqueueWorkout(userId, w);

      const importedIds = new Set(workouts.map((w) => w.clientId));
      const total = workouts.length;
      const remaining = () => getPendingWorkouts(userId).filter((w) => importedIds.has(w.clientId)).length;

      // Drive the flush and poll actual queue state. flushNow() is single-in-
      // flight (a background retry may already be flushing), so we can't trust one
      // call to have flushed *our* entries — poll until they clear (or time out),
      // nudging another flush whenever the queue goes idle with work left.
      const flushP = flushNow();
      const deadline = Date.now() + SYNC_WAIT_MS;
      let left = remaining();
      while (left > 0 && Date.now() < deadline) {
        setSyncedSoFar(total - left);
        await sleep(600);
        void flushNow(); // no-op while a flush is in flight; resumes it once idle
        left = remaining();
      }
      await flushP.catch(() => {});
      left = remaining();
      const synced = total - left;
      setSyncedSoFar(synced);
      setOutcome({ requested: total, synced, queued: left });
      setPhase('done');
      if (left === 0) toast.success(`Imported ${synced} workout${synced === 1 ? '' : 's'}.`);
      else toast.info(`${synced} imported, ${left} will finish syncing when you're online.`);
    } catch (err: any) {
      setPhase('parsed');
      toast.error(`Import failed: ${String(err?.message ?? err)}`);
    }
  }, [built, user?.id, flushNow, toast]);

  const reset = useCallback(() => {
    setCsvText(null);
    setFileName('');
    setParseError(null);
    setOutcome(null);
    setPhase('idle');
  }, []);

  // ─── Guest gate ────────────────────────────────────────────────────────────
  if (isGuest) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top']}>
        <Header C={C} onBack={() => router.back()} />
        <View style={styles.guestWrap}>
          <View style={[styles.guestIcon, { backgroundColor: C.glowBg }]}>
            <Feather name="lock" size={22} color={C.mutedFg} />
          </View>
          <Text style={[styles.guestTitle, { color: C.foreground }]}>Sign in to import</Text>
          <Text style={[styles.guestBody, { color: C.mutedFg }]}>
            Importing writes workouts to your account, so you'll need to be signed in first.
          </Text>
          <TouchableOpacity
            onPress={() => router.replace('/(auth)')}
            activeOpacity={0.85}
            style={[styles.primaryBtn, { backgroundColor: Colors.primary }]}
          >
            <Text style={[styles.primaryBtnText, { color: Colors.primaryFg }]}>Sign in</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top']}>
      <Header C={C} onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={{ padding: Spacing.xl, paddingBottom: insets.bottom + 40 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Source card — Hevy */}
        {SOURCES.map((src) => (
          <View key={src.key} style={[styles.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
            <View style={styles.srcRow}>
              <View style={[styles.srcBadge, { backgroundColor: `${Colors.primary}22` }]}>
                <Feather name="download-cloud" size={16} color={C.accentText} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.srcName, { color: C.foreground }]}>{src.name}</Text>
                <Text style={[styles.srcBlurb, { color: C.mutedFg }]}>{src.blurb}</Text>
              </View>
            </View>
          </View>
        ))}

        {parseError && (
          <Animated.View entering={FadeIn} style={[styles.errorCard, { borderColor: 'rgba(239,68,68,0.25)', backgroundColor: 'rgba(239,68,68,0.08)' }]}>
            <Feather name="alert-triangle" size={13} color="#f87171" />
            <Text style={[styles.errorText, { color: C.foreground }]}>{parseError}</Text>
          </Animated.View>
        )}

        {/* Pick / preview */}
        {phase === 'idle' && (
          <TouchableOpacity
            onPress={pickFile}
            activeOpacity={0.85}
            style={[styles.pickBtn, { borderColor: C.border, backgroundColor: C.muted }]}
          >
            <Feather name="upload" size={16} color={C.accentText} />
            <Text style={[styles.pickBtnText, { color: C.foreground }]}>Choose Hevy CSV file</Text>
          </TouchableOpacity>
        )}

        {(phase === 'parsed' || phase === 'importing') && summary && (
          <Animated.View entering={FadeInDown}>
            {/* File chip */}
            <View style={[styles.fileChip, { backgroundColor: C.muted, borderColor: C.border }]}>
              <Feather name="file-text" size={13} color={C.mutedFg} />
              <Text style={[styles.fileName, { color: C.foreground }]} numberOfLines={1}>{fileName}</Text>
              {phase === 'parsed' && (
                <TouchableOpacity onPress={reset} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={14} color={C.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            {/* Unit toggle */}
            <Text style={[styles.sectionLabel, { color: C.textMuted }]}>WEIGHT UNIT IN HEVY</Text>
            <View style={[styles.unitRow, { backgroundColor: C.muted, borderColor: C.border }]}>
              {(['kg', 'lbs'] as ImportUnit[]).map((u) => {
                const active = unit === u;
                return (
                  <TouchableOpacity
                    key={u}
                    onPress={() => setUnit(u)}
                    disabled={phase === 'importing'}
                    activeOpacity={0.85}
                    style={[styles.unitBtn, active && { backgroundColor: Colors.primary }]}
                  >
                    <Text style={[styles.unitBtnText, { color: active ? Colors.primaryFg : C.mutedFg }]}>{u}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={[styles.hint, { color: C.textMuted }]}>
              Hevy exports weights in whichever unit your account uses. Pick the same one so the numbers land right.
            </Text>

            {/* Preview stats */}
            <View style={[styles.statsCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              <Stat C={C} label="Workouts" value={String(summary.workoutCount)} />
              <View style={[styles.statDiv, { backgroundColor: C.borderSubtle }]} />
              <Stat C={C} label="Sets" value={summary.setCount.toLocaleString()} />
              <View style={[styles.statDiv, { backgroundColor: C.borderSubtle }]} />
              <Stat C={C} label="Exercises" value={String(summary.exerciseCount)} />
            </View>
            {(summary.earliest || summary.newExerciseCount > 0 || summary.skippedWorkoutCount > 0) && (
              <View style={{ marginTop: 8, gap: 4 }}>
                {summary.earliest && (
                  <Note C={C} icon="calendar" text={`${fmtDate(summary.earliest)} – ${fmtDate(summary.latest)}`} />
                )}
                {summary.newExerciseCount > 0 && (
                  <Note C={C} icon="plus-circle" text={`${summary.newExerciseCount} new exercise${summary.newExerciseCount === 1 ? '' : 's'} added to your library`} />
                )}
                {summary.skippedWorkoutCount > 0 && (
                  <Note C={C} icon="alert-circle" text={`${summary.skippedWorkoutCount} workout${summary.skippedWorkoutCount === 1 ? '' : 's'} skipped (unreadable date)`} />
                )}
              </View>
            )}

            <TouchableOpacity
              onPress={runImport}
              disabled={phase === 'importing' || summary.workoutCount === 0}
              activeOpacity={0.85}
              style={[styles.primaryBtn, { backgroundColor: Colors.primary, marginTop: Spacing.xl, opacity: phase === 'importing' ? 0.7 : 1 }]}
            >
              {phase === 'importing' ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <ActivityIndicator size="small" color={Colors.primaryFg} />
                  <Text style={[styles.primaryBtnText, { color: Colors.primaryFg }]}>
                    Importing… {syncedSoFar}/{summary.workoutCount}
                  </Text>
                </View>
              ) : (
                <Text style={[styles.primaryBtnText, { color: Colors.primaryFg }]}>
                  Import {summary.workoutCount} workout{summary.workoutCount === 1 ? '' : 's'}
                </Text>
              )}
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Result */}
        {phase === 'done' && outcome && (
          <Animated.View entering={FadeInDown} style={[styles.doneCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
            <View style={[styles.doneIcon, { backgroundColor: `${Colors.primary}22` }]}>
              <Feather name="check" size={22} color={C.accentText} />
            </View>
            <Text style={[styles.doneTitle, { color: C.foreground }]}>
              Imported {outcome.synced} workout{outcome.synced === 1 ? '' : 's'}
            </Text>
            {outcome.queued > 0 && (
              <Text style={[styles.doneBody, { color: C.mutedFg }]}>
                {outcome.queued} more will finish syncing when you're back online.
              </Text>
            )}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: Spacing.lg }}>
              <TouchableOpacity
                onPress={() => router.replace('/(app)/history')}
                activeOpacity={0.85}
                style={[styles.primaryBtn, { backgroundColor: Colors.primary, flex: 1 }]}
              >
                <Text style={[styles.primaryBtnText, { color: Colors.primaryFg }]}>View History</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={reset}
                activeOpacity={0.85}
                style={[styles.secondaryBtn, { borderColor: C.border, backgroundColor: C.muted }]}
              >
                <Text style={[styles.secondaryBtnText, { color: C.foreground }]}>Import another</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────────────
function Header({ C, onBack }: { C: any; onBack: () => void }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={onBack}
        style={[styles.backBtn, { backgroundColor: C.muted, borderColor: C.border }]}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Feather name="chevron-left" size={18} color={C.foreground} />
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: C.foreground }]}>Import Data</Text>
        <Text style={[styles.subtitle, { color: C.mutedFg }]}>Bring your history in from another app</Text>
      </View>
    </View>
  );
}

function Stat({ C, label, value }: { C: any; label: string; value: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={[styles.statValue, { color: C.foreground }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: C.textMuted }]}>{label}</Text>
    </View>
  );
}

function Note({ C, icon, text }: { C: any; icon: any; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Feather name={icon} size={12} color={C.textMuted} />
      <Text style={{ fontSize: FontSize.xs, color: C.mutedFg }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: Spacing.md,
  },
  backBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },

  card: { borderWidth: 1, borderRadius: Radius.lg, padding: Spacing.lg, marginBottom: Spacing.lg },
  srcRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  srcBadge: { width: 40, height: 40, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  srcName: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  srcBlurb: { fontSize: FontSize.xs, marginTop: 2 },

  pickBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1, borderRadius: Radius.lg, paddingVertical: 16, borderStyle: 'dashed',
  },
  pickBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },

  fileChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: 12, paddingVertical: 10, marginBottom: Spacing.lg,
  },
  fileName: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.medium },

  sectionLabel: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1.5, marginBottom: 6 },
  unitRow: { flexDirection: 'row', borderWidth: 1, borderRadius: Radius.md, padding: 3, gap: 3 },
  unitBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: Radius.sm },
  unitBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, textTransform: 'uppercase' },
  hint: { fontSize: FontSize.xs, marginTop: 6, lineHeight: 16 },

  statsCard: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: Radius.lg,
    paddingVertical: Spacing.lg, marginTop: Spacing.xl,
  },
  statDiv: { width: 1, alignSelf: 'stretch', marginVertical: 4 },
  statValue: { fontSize: FontSize.xl, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  statLabel: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1, marginTop: 2, textTransform: 'uppercase' },

  primaryBtn: { alignItems: 'center', justifyContent: 'center', borderRadius: Radius.lg, paddingVertical: 15 },
  primaryBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  secondaryBtn: { alignItems: 'center', justifyContent: 'center', borderRadius: Radius.lg, paddingVertical: 15, paddingHorizontal: 18, borderWidth: 1 },
  secondaryBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },

  errorCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    borderWidth: 1, borderRadius: Radius.md, padding: 12, marginBottom: Spacing.lg,
  },
  errorText: { flex: 1, fontSize: FontSize.sm, lineHeight: 18 },

  doneCard: { borderWidth: 1, borderRadius: Radius.lg, padding: Spacing.xl, alignItems: 'center' },
  doneIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md },
  doneTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.black, letterSpacing: -0.4 },
  doneBody: { fontSize: FontSize.sm, textAlign: 'center', marginTop: 6, lineHeight: 18 },

  guestWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xl, gap: 10 },
  guestIcon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  guestTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.black },
  guestBody: { fontSize: FontSize.sm, textAlign: 'center', lineHeight: 20, marginBottom: 8 },
});
