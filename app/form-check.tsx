/**
 * Form check — full screen.
 *
 * Prop the phone, do a set, get one thing to fix. Pose estimation runs on the
 * device; only per-rep angles ever leave it.
 *
 * The screen is a small state machine because each step has a genuinely
 * different job: work out the rules, place the camera, watch the set, then hand
 * back one note. Mixing those into one view is what makes camera screens feel
 * chaotic.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';

import { useTheme } from '@/hooks/useTheme';
import { Colors, FontSize, FontWeight, LetterSpacing, Radius, Spacing } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import { useSupabaseClient } from '@/lib/supabase';
import { PoseOverlay } from '@/components/form/PoseOverlay';
import { useFormSession } from '@/components/form/useFormSession';
import {
  isCapError,
  requestAuthoredRules,
  requestFormNote,
  type FormNote,
  type FormNoteResult,
} from '@/lib/form/api';
import { isPersistableId, resolveFormRules, type RuleResolution } from '@/lib/form/resolve';
import { summarize, unusableMessage, type FormSummary } from '@/lib/form/summarize';

type Phase = 'resolving' | 'unsupported' | 'setup' | 'recording' | 'analyzing' | 'result';

export default function FormCheckScreen() {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const client = useSupabaseClient();

  const params = useLocalSearchParams<{ exerciseId?: string; name?: string }>();
  const exerciseId = typeof params.exerciseId === 'string' ? params.exerciseId : null;
  const exerciseName = typeof params.name === 'string' ? params.name : 'this lift';

  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraDevice = useCameraDevice('back');
  const [phase, setPhase] = useState<Phase>('resolving');
  const [rules, setRules] = useState<RuleResolution | null>(null);
  const [note, setNote] = useState<FormNote | null>(null);
  const [summary, setSummary] = useState<FormSummary | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const session = useFormSession({
    spec: rules?.spec ?? null,
    paused: phase !== 'recording',
  });

  // ── resolve the rules for this exercise ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!exerciseId) {
        setProblem('I do not know which lift to watch.');
        setPhase('unsupported');
        return;
      }
      try {
        const resolution = await resolveFormRules({
          client,
          exercise: { id: exerciseId, name: exerciseName },
          authorSpec: (name) => requestAuthoredRules(client, name),
        });
        if (cancelled) return;
        setRules(resolution);
        if (!resolution.spec) {
          setProblem(
            resolution.unsupported
              ? `I cannot judge ${exerciseName} from a phone camera. Pick a big compound lift and I will watch that instead.`
              : `I do not have rules for ${exerciseName} yet.`
          );
          setPhase('unsupported');
          return;
        }
        setPhase('setup');
      } catch (e) {
        if (cancelled) return;
        // Working out the rules for a new lift costs a check. Running out
        // there is a "come back tomorrow", not a "this lift cannot be judged".
        setProblem(
          isCapError(e)
            ? capMessage(e.result)
            : 'Something went wrong setting that up. Try again in a moment.'
        );
        setPhase('unsupported');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, exerciseId, exerciseName]);

  useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

  // ── finish the set and get the note ───────────────────────────────────────
  const handleFinish = useCallback(async () => {
    const spec = rules?.spec;
    if (!spec) return;
    haptics.medium();

    const analysis = session.finish();
    if (!analysis) {
      // Returning here without moving the phase would leave the screen in
      // `recording` with a Done button that visibly does nothing.
      setNote(null);
      setSummary(null);
      setProblem('I did not get a usable read on that set. Try another one.');
      setPhase('result');
      return;
    }

    const built = summarize({
      analysis,
      spec,
      exerciseName,
      pattern: rules?.pattern ?? null,
      source: 'live',
    });
    setSummary(built);
    setPhase('analyzing');

    if (built.unusableReason) {
      setNote(null);
      setProblem(unusableMessage(built.unusableReason, spec));
      setPhase('result');
      return;
    }

    // Bundled library rows and guest customs have no database row to attach the
    // check to; the coaching still works, it just is not filed against an id.
    const res = await requestFormNote({
      client,
      summary: built,
      exerciseId: exerciseId && isPersistableId(exerciseId) ? exerciseId : null,
    });
    if (res.kind === 'ok') {
      setNote(res.note);
      setProblem(null);
    } else if (res.kind === 'unusable') {
      setProblem(unusableMessage(res.reason, spec));
    } else if (res.kind === 'cap' || res.kind === 'no_access') {
      setProblem(capMessage(res));
    } else {
      setProblem(res.message);
    }
    setPhase('result');
  }, [client, exerciseId, exerciseName, rules, session]);

  const startRecording = useCallback(() => {
    haptics.medium();
    session.reset();
    setNote(null);
    setProblem(null);
    setPhase('recording');
  }, [session]);

  const goAgain = useCallback(() => {
    setNote(null);
    setSummary(null);
    setProblem(null);
    session.reset();
    setPhase('setup');
  }, [session]);

  const close = useCallback(() => router.back(), []);

  // ── render ────────────────────────────────────────────────────────────────

  const showCamera = phase === 'setup' || phase === 'recording';

  return (
    <View style={[styles.root, { backgroundColor: C.background }]}>
      {showCamera && hasPermission && cameraDevice && session.frameOutput && (
        <>
          <Camera
            style={StyleSheet.absoluteFill}
            isActive
            device={cameraDevice}
            outputs={[session.frameOutput]}
          />
          <PoseOverlay
            pose={session.pose}
            width={width}
            height={height}
            frameAspect={session.frameAspect}
            muted={session.live.wrongView || session.live.lowConfidence}
          />
        </>
      )}
      {showCamera && hasPermission && !cameraDevice && (
        <Centered>
          <Feather name="camera-off" size={28} color={C.textMuted} />
          <Text style={[styles.body, { color: C.textSecondary }]}>
            No back camera found. This needs a real device.
          </Text>
          <PrimaryButton label="Back" onPress={close} />
        </Centered>
      )}

      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Pressable onPress={close} hitSlop={12} style={styles.closeBtn}>
          <Feather name="x" size={20} color={showCamera ? '#fff' : C.foreground} />
        </Pressable>
        <Text
          style={[styles.title, { color: showCamera ? '#fff' : C.foreground }]}
          numberOfLines={1}
        >
          {exerciseName}
        </Text>
        <View style={styles.closeBtn} />
      </View>

      {phase === 'resolving' && <Centered><ActivityIndicator color={Colors.primary} /></Centered>}

      {phase === 'unsupported' && (
        <Centered>
          <Feather name="eye-off" size={28} color={C.textMuted} />
          <Text style={[styles.body, { color: C.textSecondary }]}>{problem}</Text>
          <PrimaryButton label="Back" onPress={close} />
        </Centered>
      )}

      {phase === 'setup' && (
        <SetupPanel
          bottomInset={insets.bottom}
          setup={rules?.spec?.setup ?? ''}
          status={session.status}
          error={session.error}
          hasPermission={hasPermission}
          onRequestPermission={requestPermission}
          onStart={startRecording}
        />
      )}

      {phase === 'recording' && (
        <RecordingPanel
          bottomInset={insets.bottom}
          live={session.live}
          onDone={handleFinish}
        />
      )}

      {phase === 'analyzing' && (
        <Centered>
          <ActivityIndicator color={Colors.primary} />
          <Text style={[styles.body, { color: C.textSecondary }]}>
            Give me a second, I&apos;m looking at that.
          </Text>
        </Centered>
      )}

      {phase === 'result' && (
        <ResultPanel
          bottomInset={insets.bottom}
          note={note}
          summary={summary}
          problem={problem}
          onAgain={goAgain}
          onClose={close}
        />
      )}
    </View>
  );
}

/**
 * One wording for a spent allowance, wherever it is hit.
 *
 * Both the rule-authoring step and the analysis step are metered, so the same
 * user can meet this from two different places in the flow and must hear the
 * same thing.
 */
function capMessage(res: FormNoteResult): string {
  if (res.kind === 'no_access') {
    return 'Form checks come with Drona. Start a plan to have me watch your sets.';
  }
  if (res.kind === 'cap' && res.scope === 'free') {
    return 'That is your form checks for today. Come back tomorrow, or go Pro for more.';
  }
  return "You have used all of today's form checks. They reset in a day.";
}

// ── panels ──────────────────────────────────────────────────────────────────

function SetupPanel({
  bottomInset,
  setup,
  status,
  error,
  hasPermission,
  onRequestPermission,
  onStart,
}: {
  bottomInset: number;
  setup: string;
  status: string;
  error: string | null;
  hasPermission: boolean;
  onRequestPermission: () => void;
  onStart: () => void;
}) {
  if (!hasPermission) {
    return (
      <Sheet bottomInset={bottomInset}>
        <Text style={styles.sheetLead}>I need the camera to watch your set.</Text>
        <Text style={styles.sheetSub}>
          Everything is worked out on your phone. Your video is never uploaded.
        </Text>
        <PrimaryButton label="Allow camera" onPress={onRequestPermission} />
      </Sheet>
    );
  }

  return (
    <Sheet bottomInset={bottomInset}>
      <Text style={styles.sheetLead}>{setup}</Text>
      {status === 'error' ? (
        <Text style={styles.sheetError}>{error}</Text>
      ) : status === 'loading' ? (
        <Text style={styles.sheetSub}>Warming up.</Text>
      ) : (
        <Text style={styles.sheetSub}>
          When you are set, start your work set. I will count and watch.
        </Text>
      )}
      <PrimaryButton label="I'm ready" onPress={onStart} disabled={status !== 'ready'} />
    </Sheet>
  );
}

function RecordingPanel({
  bottomInset,
  live,
  onDone,
}: {
  bottomInset: number;
  live: ReturnType<typeof useFormSession>['live'];
  onDone: () => void;
}) {
  // Haptic tick per rep, so the lifter gets confirmation without looking.
  const lastRep = useRef(0);
  useEffect(() => {
    if (live.reps > lastRep.current) {
      lastRep.current = live.reps;
      haptics.tick();
    }
  }, [live.reps]);

  return (
    <>
      <View style={styles.repBadge}>
        <Text style={styles.repCount}>{live.reps}</Text>
        <Text style={styles.repLabel}>{live.reps === 1 ? 'rep' : 'reps'}</Text>
      </View>

      {live.wrongView && <Banner text="Turn the phone. I need your side." tone="warn" />}
      {!live.wrongView && live.lowConfidence && (
        <Banner text="Step back so I can see all of you." tone="warn" />
      )}
      {!live.wrongView && !live.lowConfidence && live.cues.length > 0 && (
        <Banner text={live.cues[0].live} tone={live.cues[0].severity === 'bad' ? 'bad' : 'warn'} />
      )}

      <Sheet bottomInset={bottomInset} transparent>
        <View style={styles.depthTrack}>
          <View style={[styles.depthFill, { width: `${Math.round(live.depth * 100)}%` }]} />
        </View>
        <PrimaryButton label="Done" onPress={onDone} />
      </Sheet>
    </>
  );
}

function ResultPanel({
  bottomInset,
  note,
  summary,
  problem,
  onAgain,
  onClose,
}: {
  bottomInset: number;
  note: FormNote | null;
  summary: FormSummary | null;
  problem: string | null;
  onAgain: () => void;
  onClose: () => void;
}) {
  const { C } = useTheme();

  return (
    <ScrollView
      contentContainerStyle={[styles.resultScroll, { paddingBottom: bottomInset + Spacing.xl }]}
    >
      {note ? (
        <>
          <View style={styles.scoreRing}>
            <Text style={styles.scoreValue}>{note.score}</Text>
            <Text style={styles.scoreOutOf}>out of 100</Text>
          </View>
          {note.headline && (
            <Text style={[styles.resultHeadline, { color: C.foreground }]}>{note.headline}</Text>
          )}
          <Text style={[styles.resultNote, { color: C.textSecondary }]}>{note.note}</Text>

          {summary && summary.cues.length > 0 && (
            <View style={styles.cueList}>
              {summary.cues.slice(0, 3).map((cue) => (
                <View key={cue.id} style={[styles.cueRow, { borderColor: C.borderSubtle }]}>
                  <View
                    style={[
                      styles.cueDot,
                      { backgroundColor: cue.severity === 'bad' ? C.dangerText : C.warningText },
                    ]}
                  />
                  <View style={styles.cueText}>
                    <Text style={[styles.cueTitle, { color: C.foreground }]}>{cue.live}</Text>
                    <Text style={[styles.cueDetail, { color: C.textMuted }]}>{cue.detail}</Text>
                  </View>
                  <Text style={[styles.cueCount, { color: C.textDim }]}>
                    {cue.count} {cue.count === 1 ? 'rep' : 'reps'}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {summary && (
            <Text style={[styles.resultMeta, { color: C.textDim }]}>
              {summary.repCount} {summary.repCount === 1 ? 'rep' : 'reps'} counted
            </Text>
          )}
        </>
      ) : (
        <View style={styles.problemBox}>
          <Feather name="eye-off" size={24} color={C.textMuted} />
          <Text style={[styles.resultNote, { color: C.textSecondary }]}>{problem}</Text>
        </View>
      )}

      <PrimaryButton label="Check another set" onPress={onAgain} />
      <Pressable onPress={onClose} style={styles.secondaryBtn}>
        <Text style={[styles.secondaryLabel, { color: C.textMuted }]}>Done for now</Text>
      </Pressable>
    </ScrollView>
  );
}

// ── small pieces ────────────────────────────────────────────────────────────

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

function Sheet({
  children,
  bottomInset,
  transparent,
}: {
  children: React.ReactNode;
  bottomInset: number;
  transparent?: boolean;
}) {
  return (
    <View
      style={[
        styles.sheet,
        { paddingBottom: bottomInset + Spacing.lg },
        transparent && styles.sheetTransparent,
      ]}
    >
      {children}
    </View>
  );
}

function Banner({ text, tone }: { text: string; tone: 'warn' | 'bad' }) {
  return (
    <View style={[styles.banner, tone === 'bad' ? styles.bannerBad : styles.bannerWarn]}>
      <Text style={styles.bannerText}>{text}</Text>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.primaryBtn,
        disabled && styles.primaryBtnDisabled,
        pressed && !disabled && styles.primaryBtnPressed,
      ]}
    >
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  closeBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
  },
  body: { fontSize: FontSize.base, textAlign: 'center', lineHeight: 22 },

  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: Spacing.lg,
    gap: Spacing.md,
    backgroundColor: 'rgba(10,10,10,0.82)',
  },
  sheetTransparent: { backgroundColor: 'transparent' },
  sheetLead: {
    color: '#fff',
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    lineHeight: 26,
  },
  sheetSub: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.sm, lineHeight: 20 },
  sheetError: { color: '#ef4444', fontSize: FontSize.sm, lineHeight: 20 },

  repBadge: { position: 'absolute', top: '18%', alignSelf: 'center', alignItems: 'center' },
  repCount: { color: '#fff', fontSize: 72, fontWeight: FontWeight.bold, lineHeight: 78 },
  repLabel: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: FontSize.sm,
    letterSpacing: LetterSpacing.eyebrow,
    textTransform: 'uppercase',
  },

  banner: {
    position: 'absolute',
    top: '42%',
    alignSelf: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
  },
  bannerWarn: { backgroundColor: 'rgba(245,158,11,0.92)' },
  bannerBad: { backgroundColor: 'rgba(239,68,68,0.92)' },
  bannerText: { color: '#0a0a0a', fontSize: FontSize.base, fontWeight: FontWeight.semibold },

  depthTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
    overflow: 'hidden',
  },
  depthFill: { height: '100%', backgroundColor: Colors.primary },

  resultScroll: { padding: Spacing.lg, gap: Spacing.md },
  scoreRing: { alignItems: 'center', paddingVertical: Spacing.lg },
  scoreValue: { color: Colors.primary, fontSize: 56, fontWeight: FontWeight.bold, lineHeight: 60 },
  scoreOutOf: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: FontSize.xs,
    letterSpacing: LetterSpacing.eyebrow,
    textTransform: 'uppercase',
  },
  resultHeadline: { fontSize: FontSize.xl, fontWeight: FontWeight.semibold, textAlign: 'center' },
  resultNote: { fontSize: FontSize.base, lineHeight: 24, textAlign: 'center' },
  resultMeta: { fontSize: FontSize.sm, textAlign: 'center' },

  cueList: { gap: Spacing.sm, marginTop: Spacing.md },
  cueRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderWidth: 1,
    borderRadius: Radius.lg,
  },
  cueDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  cueText: { flex: 1, gap: 2 },
  cueTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  cueDetail: { fontSize: FontSize.sm, lineHeight: 19 },
  cueCount: { fontSize: FontSize.xs },

  problemBox: { alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.xl },

  primaryBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  primaryBtnPressed: { opacity: 0.85 },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryLabel: {
    color: Colors.primaryFg,
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  secondaryBtn: { alignItems: 'center', paddingVertical: Spacing.md },
  secondaryLabel: { fontSize: FontSize.sm },
});
