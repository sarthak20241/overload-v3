/**
 * Cardio from the dashboard's cardio row. Pick the exercise, then either start
 * it now (a live session in the workout screen, timed like any workout) or log
 * one you already did (minutes, optional distance, the day).
 *
 * Both go through the normal workout paths: Start opens /workout/new with the
 * exercise handed over (lib/cardioLog), and a log is a finished workout on the
 * offline queue, flushed by the SyncProvider like any Finish. Rules and the
 * entry shape live in lib/cardioLog.ts.
 *
 * Portal-based, never RN <Modal> (Android edge-to-edge). No text inputs, only
 * steppers and chips, so the sheet never fights the keyboard.
 */
import { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, TouchableOpacity, ScrollView, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors, Spacing, Radius, FontSize, FontWeight, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useWorkout } from '@/hooks/useWorkout';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useSupabaseClient } from '@/lib/supabase';
import { useSync } from '@/components/SyncProvider';
import { Portal } from '@/components/ui/Portal';
import { useToast } from '@/components/ui/Toast';
import { OrbLoader } from '@/components/ui/OrbLoader';
import { haptics } from '@/lib/haptics';
import { markWorkoutSource, track } from '@/lib/analytics';
import { enqueueWorkout, newClientId, type PendingWorkout } from '@/lib/syncQueue';
import { CARDIO_METRIC_TYPES, CARDIO_MUSCLE_GROUP } from '@/lib/activityGoals';
import {
  buildCardioLogEntry, cardioChoices, cardioDays, setCardioStart, usesDistance,
  DEFAULT_MINUTES, FALLBACK_CARDIO, MAX_MINUTES, MIN_MINUTES, type CardioExercise,
} from '@/lib/cardioLog';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** A session was logged: the parent re-reads its count. */
  onLogged: () => void;
}

type Mode = 'start' | 'log';

const MINUTE_STEP = 5;
const KM_STEP = 0.5;
const MAX_KM = 100;

// The catalog's cardio list, kept for the app session: it changes only when a
// migration adds a row, and the sheet should open with it already there.
let cachedChoices: CardioExercise[] | null = null;

export function CardioSheet({ visible, onClose, onLogged }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const workout = useWorkout();
  const { flushNow } = useSync();
  const toast = useToast();

  const [choices, setChoices] = useState<CardioExercise[]>(cachedChoices ?? FALLBACK_CARDIO);
  const [picked, setPicked] = useState<CardioExercise | null>(null);
  const [mode, setMode] = useState<Mode>('start');
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  const [km, setKm] = useState(0);
  const [dayIso, setDayIso] = useState('');
  const [saving, setSaving] = useState(false);
  const days = useMemo(() => cardioDays(new Date()), [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fresh form each time it opens.
  useEffect(() => {
    if (!visible) return;
    setPicked(null);
    setMode('start');
    setMinutes(DEFAULT_MINUTES);
    setKm(0);
    setDayIso(days[0].iso);
    setSaving(false);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Catalog cardio plus the user's own (RLS returns both). Offline keeps the
  // fallback list, which resolves by name at sync time.
  useEffect(() => {
    if (!visible || cachedChoices) return;
    let live = true;
    (async () => {
      const { data, error } = await supabase
        .from('exercises')
        .select('id, name, category, muscle_group, metric_type')
        .eq('muscle_group', CARDIO_MUSCLE_GROUP)
        .in('metric_type', CARDIO_METRIC_TYPES as string[]);
      if (error || !data) return;
      const list = cardioChoices(data);
      if (list.length === 0) return;
      cachedChoices = list;
      if (live) setChoices(list);
    })().catch(() => {});
    return () => { live = false; };
  }, [visible, supabase]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { if (!saving) onClose(); return true; });
    return () => sub.remove();
  }, [visible, onClose, saving]);

  const accent = Colors.stat.streak;
  const busyWorkout = workout.isActive;
  const showDistance = !!picked && usesDistance(picked);

  const pick = (ex: CardioExercise) => {
    haptics.selection();
    setPicked(ex);
    if (!usesDistance(ex)) setKm(0);
  };

  const start = () => {
    if (!picked || busyWorkout) return;
    haptics.tap();
    track('cardio_started', { exercise: picked.name, metric_type: picked.metric_type });
    setCardioStart(picked);
    markWorkoutSource('cardio_sheet');
    onClose();
    router.push('/workout/new' as any);
  };

  const save = async () => {
    const ownerId = user?.id;
    if (!picked || !ownerId || saving) return;
    setSaving(true);
    try {
      const entry: PendingWorkout = buildCardioLogEntry({
        clientId: newClientId(),
        ownerId,
        exercise: picked,
        minutes,
        distanceKm: km,
        dayIso,
        now: new Date(),
      });
      await enqueueWorkout(ownerId, entry);
      track('cardio_logged', {
        exercise: picked.name,
        metric_type: picked.metric_type,
        minutes,
        has_distance: showDistance && km > 0,
        days_ago: Math.max(0, days.findIndex((d) => d.iso === dayIso)),
      });
      // The card counts the queued entry, so nothing waits on the upload.
      void flushNow();
      haptics.success();
      toast.success('Cardio logged');
      onLogged();
      onClose();
    } catch {
      toast.error("Couldn't save that. Try again.");
      setSaving(false);
    }
  };

  const stepMinutes = (delta: number) => {
    haptics.tick();
    setMinutes((m) => Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, m + delta)));
  };
  const stepKm = (delta: number) => {
    haptics.tick();
    setKm((k) => Math.min(MAX_KM, Math.max(0, Math.round((k + delta) * 10) / 10)));
  };

  return (
    <Portal>
      {visible && (
        <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={saving ? undefined : onClose}>
          <Animated.View
            entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.md }]}
          >
            <Pressable>
              <View style={[s.handle, { backgroundColor: C.handle }]} />
              <View style={s.header}>
                <Text style={[s.title, { color: C.foreground }]}>Cardio</Text>
                <View style={{ flex: 1 }} />
                {/* The card's cardio half opens this sheet, so the way to the
                    goals themselves lives here (a cardio-only card has no other). */}
                <TouchableOpacity
                  onPress={() => { haptics.tap(); onClose(); router.push('/goal-plan'); }}
                  disabled={saving}
                  style={s.planLink}
                  accessibilityRole="link"
                  accessibilityLabel="See your plan"
                >
                  <Text style={[s.planLinkText, { color: C.textSecondary }]}>See your plan</Text>
                  <Feather name="chevron-right" size={13} color={C.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity onPress={onClose} disabled={saving} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityRole="button" accessibilityLabel="Close">
                  <Feather name="x" size={15} color={C.foreground} />
                </TouchableOpacity>
              </View>

              <View style={[s.segment, { backgroundColor: C.muted }]}>
                {(['start', 'log'] as const).map((m) => {
                  const active = mode === m;
                  return (
                    <TouchableOpacity
                      key={m}
                      onPress={() => { haptics.selection(); setMode(m); }}
                      disabled={saving}
                      style={[s.segmentBtn, active && { backgroundColor: C.card }]}
                      activeOpacity={0.8}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: active }}
                    >
                      <Text style={[s.segmentText, { color: active ? C.foreground : C.textMuted }]}>
                        {m === 'start' ? 'Start now' : 'Already done'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={[s.label, { color: C.textMuted }]}>
                {mode === 'start' ? 'What are you doing?' : 'What did you do?'}
              </Text>
              <ScrollView style={s.chipScroll} contentContainerStyle={s.chipWrap} showsVerticalScrollIndicator={false}>
                {choices.map((ex) => {
                  const active = picked?.name === ex.name;
                  return (
                    <TouchableOpacity
                      key={ex.name}
                      onPress={() => pick(ex)}
                      disabled={saving}
                      style={[s.chip, { borderColor: active ? accent : C.border, backgroundColor: active ? colorWithAlpha(accent, 0.14) : 'transparent' }]}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <Text style={[s.chipText, { color: active ? accent : C.textSecondary }]}>{ex.name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {mode === 'log' && (
                <>
                  <View style={s.stepRow}>
                    <Text style={[s.stepLabel, { color: C.textSecondary }]}>Time</Text>
                    <View style={s.stepper}>
                      <TouchableOpacity onPress={() => stepMinutes(-MINUTE_STEP)} disabled={saving || minutes <= MIN_MINUTES} style={[s.stepBtn, { borderColor: C.border }]} accessibilityLabel="5 minutes less">
                        <Feather name="minus" size={14} color={C.foreground} />
                      </TouchableOpacity>
                      <Text style={[s.stepValue, { color: C.foreground }]}>{minutes} min</Text>
                      <TouchableOpacity onPress={() => stepMinutes(MINUTE_STEP)} disabled={saving || minutes >= MAX_MINUTES} style={[s.stepBtn, { borderColor: C.border }]} accessibilityLabel="5 minutes more">
                        <Feather name="plus" size={14} color={C.foreground} />
                      </TouchableOpacity>
                    </View>
                  </View>

                  {showDistance && (
                    <View style={s.stepRow}>
                      <Text style={[s.stepLabel, { color: C.textSecondary }]}>Distance</Text>
                      <View style={s.stepper}>
                        <TouchableOpacity onPress={() => stepKm(-KM_STEP)} disabled={saving || km <= 0} style={[s.stepBtn, { borderColor: C.border }]} accessibilityLabel="Half a kilometre less">
                          <Feather name="minus" size={14} color={C.foreground} />
                        </TouchableOpacity>
                        <Text style={[s.stepValue, { color: km > 0 ? C.foreground : C.textMuted }]}>{km > 0 ? `${km} km` : 'Skip'}</Text>
                        <TouchableOpacity onPress={() => stepKm(KM_STEP)} disabled={saving || km >= MAX_KM} style={[s.stepBtn, { borderColor: C.border }]} accessibilityLabel="Half a kilometre more">
                          <Feather name="plus" size={14} color={C.foreground} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}

                  <Text style={[s.label, { color: C.textMuted }]}>When</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.dayRow}>
                    {days.map((d) => {
                      const active = dayIso === d.iso;
                      return (
                        <TouchableOpacity
                          key={d.iso}
                          onPress={() => { haptics.selection(); setDayIso(d.iso); }}
                          disabled={saving}
                          style={[s.chip, { borderColor: active ? accent : C.border, backgroundColor: active ? colorWithAlpha(accent, 0.14) : 'transparent' }]}
                          activeOpacity={0.7}
                        >
                          <Text style={[s.chipText, { color: active ? accent : C.textSecondary }]}>{d.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </>
              )}

              {mode === 'start' && (
                <Text style={[s.hint, { color: C.textMuted }]}>
                  {busyWorkout
                    ? 'You have a workout going. Finish that one first.'
                    : "Timed like any workout. Tap Finish when you're done."}
                </Text>
              )}

              {(() => {
                const disabled = !picked || saving || (mode === 'start' && busyWorkout);
                const label = !picked
                  ? 'Pick one above'
                  : mode === 'start' ? `Start ${picked.name}` : 'Save session';
                return (
                  <TouchableOpacity
                    onPress={mode === 'start' ? start : save}
                    disabled={disabled}
                    style={[s.saveBtn, { backgroundColor: disabled ? C.muted : Colors.primary }]}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                  >
                    {saving ? (
                      <OrbLoader color={Colors.primaryFg} />
                    ) : (
                      <Text style={[s.saveText, { color: disabled ? C.textMuted : Colors.primaryFg }]}>{label}</Text>
                    )}
                  </TouchableOpacity>
                );
              })()}
            </Pressable>
          </Animated.View>
        </Pressable>
      )}
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.md },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  planLink: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 6, paddingHorizontal: 8, marginRight: Spacing.sm },
  planLinkText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  segment: { flexDirection: 'row', borderRadius: Radius.md, padding: 3, marginBottom: Spacing.lg },
  segmentBtn: { flex: 1, paddingVertical: 8, borderRadius: Radius.sm, alignItems: 'center' },
  segmentText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  label: { fontSize: FontSize.sm, marginBottom: Spacing.sm },
  chipScroll: { maxHeight: 156, marginBottom: Spacing.lg },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.full, borderWidth: 1 },
  chipText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  stepRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.md },
  stepLabel: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  stepBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepValue: { minWidth: 72, textAlign: 'center', fontSize: FontSize.lg, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  dayRow: { gap: 8, paddingBottom: Spacing.lg },
  hint: { fontSize: FontSize.sm, marginBottom: Spacing.lg },
  saveBtn: { height: 52, borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
});
