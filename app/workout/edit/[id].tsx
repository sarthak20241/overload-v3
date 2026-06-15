import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Colors, Radius, FontSize, FontWeight, Spacing, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { useSupabaseClient } from '@/lib/supabase';
import { useToast } from '@/components/ui/Toast';
import { useSync } from '@/components/SyncProvider';
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import { roundVolume } from '@/lib/format';
import { hydrateCache, readCache } from '@/lib/localCache';
import { getGuestWorkouts, updateGuestWorkout, type GuestWorkout } from '@/lib/guestStore';
import { getPendingWorkouts, updatePendingWorkout, hydrateSyncQueue, type PendingExercise } from '@/lib/syncQueue';
import { getPendingEdit, enqueueEdit, hydrateEditQueue, type PendingEditExercise } from '@/lib/editQueue';
import { ExercisePickerSheet, type CustomExerciseDetails } from '@/components/routines/ExercisePickerSheet';
import type { ExerciseDef } from '@/lib/exercises';

type Backend = 'guest' | 'pending' | 'synced';

// Set/exercise values are edited as strings so typing feels natural (clearing a
// field, partial decimals); they're parsed back to numbers on save.
interface EditSet { weight: string; reps: string }
interface EditExercise {
  exerciseId: string | null; // real exercises.id (synced) | null (resolve by name at flush)
  name: string;
  muscle_group?: string;
  category?: string;
  sets: EditSet[];
}

function formatDateLong(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(sec?: number) {
  if (!sec) return null;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

export default function EditWorkoutScreen() {
  const { C } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, isLoaded: clerkLoaded } = useClerkUser();
  const isGuestSession = useIsGuestSession();
  const supabase = useSupabaseClient();
  const toast = useToast();
  const { flushNow } = useSync();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAddExercise, setShowAddExercise] = useState(false);

  const [backend, setBackend] = useState<Backend | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [exercises, setExercises] = useState<EditExercise[]>([]);
  const [meta, setMeta] = useState<{ startedAt?: string; durationSeconds?: number }>({});
  // Original server set count + volume — the baseline for the synced XP delta.
  const [base, setBase] = useState<{ setCount: number; volume: number }>({ setCount: 0, volume: 0 });
  // The full original guest workout, kept so a guest save preserves its other fields.
  const [guestOriginal, setGuestOriginal] = useState<GuestWorkout | null>(null);

  // Keep focused inputs above the Android IME (edge-to-edge), disabled while the
  // picker sheet is up so the two don't fight over the scroll.
  const { kbHeight, scrollRef, scrollFocusedIntoView, scrollProps } = useKeyboardAwareScroll(!showAddExercise);

  const mapServerSetsToExercises = (rows: any[]): EditExercise[] => {
    const ordered = [...rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const map = new Map<string, EditExercise>();
    for (const s of ordered) {
      const exId = s.exercise_id;
      let ex = map.get(exId);
      if (!ex) {
        ex = {
          exerciseId: exId,
          name: s.exercises?.name ?? 'Exercise',
          muscle_group: s.exercises?.muscle_group,
          category: s.exercises?.category,
          sets: [],
        };
        map.set(exId, ex);
      }
      ex.sets.push({ weight: String(s.weight_kg ?? 0), reps: String(s.reps ?? 0) });
    }
    return [...map.values()];
  };

  useEffect(() => {
    if (!clerkLoaded) return;
    let cancelled = false;
    const setIfLive = (fn: () => void) => { if (!cancelled) fn(); };

    (async () => {
      // GUEST — local store.
      if (isGuestSession) {
        const w = getGuestWorkouts().find((x) => x.id === id);
        if (!w) { setIfLive(() => { setLoadError("Couldn't find this workout."); setLoading(false); }); return; }
        setIfLive(() => {
          setBackend('guest');
          setGuestOriginal(w);
          setName(w.name);
          setNotes(w.notes ?? '');
          setExercises((w.exercises ?? []).map((ex) => ({
            exerciseId: null,
            name: ex.name,
            muscle_group: ex.muscle_group,
            category: ex.category,
            sets: ex.sets.map((s) => ({ weight: String(s.weight_kg), reps: String(s.reps) })),
          })));
          setMeta({ startedAt: w.started_at, durationSeconds: w.duration_seconds });
          setLoading(false);
        });
        return;
      }

      const uid = user?.id;
      await hydrateCache(uid);
      // Make sure the queues are loaded before classifying the workout — a cold
      // deep-link to the editor could otherwise misread a pending/edited workout.
      if (uid) await Promise.all([hydrateSyncQueue(uid), hydrateEditQueue(uid)]);

      // PENDING-new — edit the queued entry in place.
      const pending = uid ? getPendingWorkouts(uid).find((e) => e.clientId === id) : null;
      if (pending) {
        setIfLive(() => {
          setBackend('pending');
          setName(pending.name);
          setNotes(pending.notes ?? '');
          setExercises(pending.exercises.map((ex) => ({
            exerciseId: ex.resolvedExerciseId,
            name: ex.def.name,
            muscle_group: ex.def.muscle_group,
            category: ex.def.category,
            sets: ex.sets.map((s) => ({ weight: String(s.weight_kg), reps: String(s.reps) })),
          })));
          setMeta({ startedAt: pending.startedAtIso, durationSeconds: pending.durationSeconds });
          setLoading(false);
        });
        return;
      }

      // SYNCED — server row. Date/duration come from the history cache (offline-safe).
      const cacheRow = uid ? readCache<any[]>('historyWorkouts', uid)?.find((w) => w?.id === id) : null;
      const cacheMeta = { startedAt: cacheRow?.started_at, durationSeconds: cacheRow?.duration_seconds };

      // Re-editing before the previous edit synced: load the queued edit so this
      // save supersedes it, with the XP base preserved.
      const existingEdit = uid ? getPendingEdit(uid, id!) : null;
      if (existingEdit) {
        setIfLive(() => {
          setBackend('synced');
          setName(existingEdit.name);
          setNotes(existingEdit.notes ?? '');
          setExercises(existingEdit.exercises.map((ex) => ({
            exerciseId: ex.resolvedExerciseId,
            name: ex.def.name,
            muscle_group: ex.def.muscle_group,
            category: ex.def.category,
            sets: ex.sets.map((s) => ({ weight: String(s.weight_kg), reps: String(s.reps) })),
          })));
          setBase({ setCount: existingEdit.baseSetCount, volume: existingEdit.baseVolumeKg });
          setMeta(cacheMeta);
          setLoading(false);
        });
        return;
      }

      try {
        const { data, error } = await supabase
          .from('workouts')
          .select('id, name, notes, total_volume_kg, started_at, duration_seconds, workout_sets(id, exercise_id, weight_kg, reps, "order", exercises(id, name, muscle_group, category))')
          .eq('id', id)
          .single();
        if (error || !data) throw error ?? new Error('not found');
        const rows = (data as any).workout_sets ?? [];
        setIfLive(() => {
          setBackend('synced');
          setName((data as any).name ?? '');
          setNotes((data as any).notes ?? '');
          setExercises(mapServerSetsToExercises(rows));
          setBase({ setCount: rows.length, volume: Number((data as any).total_volume_kg ?? 0) });
          setMeta({ startedAt: (data as any).started_at, durationSeconds: (data as any).duration_seconds });
          setLoading(false);
        });
      } catch {
        // Offline fallback: rebuild from the history cache (names only — the
        // exercise rows resolve by name at flush time).
        if (cacheRow) {
          setIfLive(() => {
            setBackend('synced');
            setName(cacheRow.name ?? '');
            setNotes(cacheRow.notes ?? '');
            setExercises((cacheRow.exercises ?? []).map((ex: any) => ({
              exerciseId: null,
              name: ex.name,
              muscle_group: ex.muscle_group,
              category: ex.category,
              sets: (ex.sets ?? []).map((s: any) => ({ weight: String(s.weight_kg), reps: String(s.reps) })),
            })));
            setBase({ setCount: cacheRow.workout_sets?.length ?? 0, volume: Number(cacheRow.total_volume_kg ?? 0) });
            setMeta(cacheMeta);
            setLoading(false);
          });
        } else {
          setIfLive(() => { setLoadError("Couldn't load this workout. You may be offline."); setLoading(false); });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [id, clerkLoaded, isGuestSession, user?.id]);

  // --- set / exercise mutations ---
  const updateSet = (ei: number, si: number, field: keyof EditSet, value: string) => {
    setExercises((prev) => prev.map((ex, i) => {
      if (i !== ei) return ex;
      const sets = ex.sets.map((s, j) => (j === si ? { ...s, [field]: value } : s));
      return { ...ex, sets };
    }));
  };

  const addSet = (ei: number) => {
    setExercises((prev) => prev.map((ex, i) => {
      if (i !== ei) return ex;
      const last = ex.sets[ex.sets.length - 1];
      return { ...ex, sets: [...ex.sets, { weight: last?.weight ?? '0', reps: last?.reps ?? '10' }] };
    }));
  };

  const removeSet = (ei: number, si: number) => {
    setExercises((prev) => prev.map((ex, i) => (
      i === ei ? { ...ex, sets: ex.sets.filter((_, j) => j !== si) } : ex
    )));
  };

  const removeExercise = (ei: number) => {
    setExercises((prev) => prev.filter((_, i) => i !== ei));
  };

  const addExercise = (def: ExerciseDef, custom?: CustomExerciseDetails) => {
    const count = custom?.sets ?? 1;
    const reps = String(custom?.repsMin ?? 10);
    setExercises((prev) => [
      ...prev,
      {
        exerciseId: null,
        name: def.name,
        muscle_group: def.muscle_group,
        category: def.category,
        sets: Array.from({ length: count }, () => ({ weight: '0', reps })),
      },
    ]);
    setShowAddExercise(false);
  };

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(app)/history');
  };

  // --- save ---
  const handleSave = async () => {
    if (saving || loading) return;

    // Parse + clean: a set counts when reps > 0 (weight 0 is valid bodyweight);
    // drop empty sets and any exercise left with none.
    const cleaned = exercises
      .map((ex) => ({
        ex,
        sets: ex.sets
          .map((s) => ({ weight_kg: Math.max(0, parseFloat(s.weight) || 0), reps: Math.max(0, parseInt(s.reps, 10) || 0) }))
          .filter((s) => s.reps > 0),
      }))
      .filter((e) => e.sets.length > 0);

    const allSets = cleaned.flatMap((e) => e.sets);
    if (allSets.length === 0) {
      toast.error('Add at least one set, or delete the workout from History.');
      return;
    }
    const newVolume = roundVolume(allSets.reduce((s, x) => s + x.weight_kg * x.reps, 0));
    const cleanName = name.trim() || 'Workout';
    const cleanNotes = notes.trim() ? notes.trim() : null;

    setSaving(true);
    try {
      if (backend === 'guest') {
        if (!guestOriginal) throw new Error('missing original');
        const updated: GuestWorkout = {
          ...guestOriginal,
          name: cleanName,
          notes: cleanNotes ?? undefined,
          total_volume_kg: newVolume,
          workout_sets: allSets.map((_, i) => ({ id: `${guestOriginal.id}-s-${i}` })),
          exercises: cleaned.map((e) => ({
            name: e.ex.name,
            muscle_group: e.ex.muscle_group,
            category: e.ex.category,
            sets: e.sets.map((s) => ({ weight_kg: s.weight_kg, reps: s.reps })),
          })),
        };
        if (!updateGuestWorkout(updated)) {
          toast.error("Couldn't save changes");
          setSaving(false);
          return;
        }
        toast.success('Workout updated');
        leave();
        return;
      }

      const uid = user?.id;
      if (!uid) throw new Error('Not signed in');

      // Common shape for both the pending-new and synced-edit queues.
      const toQueueExercises = (): PendingExercise[] => cleaned.map((e) => ({
        def: {
          name: e.ex.name,
          muscle_group: e.ex.muscle_group || 'Other',
          category: e.ex.category || 'Custom',
        },
        resolvedExerciseId: e.ex.exerciseId && !String(e.ex.exerciseId).startsWith('temp-') ? e.ex.exerciseId : null,
        sets: e.sets.map((s, idx) => ({ weight_kg: s.weight_kg, reps: s.reps, order: idx })),
      }));

      if (backend === 'pending') {
        const ok = updatePendingWorkout(uid, id!, {
          name: cleanName,
          notes: cleanNotes,
          exercises: toQueueExercises(),
          totalVolumeKg: newVolume,
        });
        if (!ok) {
          // It just synced out of the queue — reopen edits it as a synced workout.
          toast.info('That workout just synced. Reopen it to edit.');
          leave();
          return;
        }
        toast.success('Workout updated');
        void flushNow();
        leave();
        return;
      }

      // synced — enqueue an offline-first edit; the overlay shows it immediately.
      await enqueueEdit(uid, {
        workoutId: id!,
        ownerId: uid,
        name: cleanName,
        notes: cleanNotes,
        exercises: toQueueExercises() as PendingEditExercise[],
        totalVolumeKg: newVolume,
        baseSetCount: base.setCount,
        baseVolumeKg: base.volume,
      });
      toast.success('Workout updated');
      void flushNow();
      leave();
    } catch {
      setSaving(false);
      toast.error("Couldn't save changes");
    }
  };

  const durationLabel = formatDuration(meta.durationSeconds);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: C.borderSubtle }]}>
        <TouchableOpacity onPress={leave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.headerBtn}>
          <Feather name="x" size={20} color={C.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: C.foreground }]}>Edit Workout</Text>
        <TouchableOpacity
          onPress={handleSave}
          disabled={saving || loading || !!loadError}
          style={[styles.saveBtn, { backgroundColor: Colors.primary, opacity: saving || loading || loadError ? 0.6 : 1 }]}
        >
          {saving ? (
            <ActivityIndicator size="small" color={Colors.primaryFg} />
          ) : (
            <Text style={styles.saveBtnText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Feather name="cloud-off" size={28} color={C.textDim} />
          <Text style={[styles.errorText, { color: C.textMuted }]}>{loadError}</Text>
          <TouchableOpacity onPress={leave} style={[styles.backBtn, { backgroundColor: C.muted }]}>
            <Text style={[styles.backBtnText, { color: C.foreground }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[
            styles.scrollContent,
            Platform.OS === 'android' && kbHeight > 0 ? { paddingBottom: kbHeight + 120 } : null,
          ]}
          automaticallyAdjustKeyboardInsets
          {...scrollProps}
        >
          {/* Workout name */}
          <Text style={[styles.fieldLabel, { color: C.textDim }]}>WORKOUT NAME</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Workout name"
            placeholderTextColor={C.textMuted}
            style={[styles.textField, { backgroundColor: C.card, borderColor: C.borderSubtle, color: C.foreground }]}
            onFocus={scrollFocusedIntoView}
          />

          {/* Date / duration (read-only) */}
          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <Feather name="calendar" size={12} color={C.textMuted} />
              <Text style={[styles.metaText, { color: C.textMuted }]}>{formatDateLong(meta.startedAt)}</Text>
            </View>
            {durationLabel && (
              <View style={styles.metaItem}>
                <Feather name="clock" size={12} color={C.textMuted} />
                <Text style={[styles.metaText, { color: C.textMuted }]}>{durationLabel}</Text>
              </View>
            )}
          </View>

          {/* Notes */}
          <Text style={[styles.fieldLabel, { color: C.textDim }]}>NOTES</Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="How did it go?"
            placeholderTextColor={C.textMuted}
            style={[styles.textField, styles.notesField, { backgroundColor: C.card, borderColor: C.borderSubtle, color: C.foreground }]}
            multiline
            onFocus={scrollFocusedIntoView}
          />

          {/* Exercises */}
          <Text style={[styles.fieldLabel, { color: C.textDim, marginTop: Spacing.lg }]}>EXERCISES</Text>
          {exercises.length === 0 ? (
            <View style={[styles.emptyExercises, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              <Text style={[styles.emptyText, { color: C.textMuted }]}>No exercises. Add one below.</Text>
            </View>
          ) : (
            exercises.map((ex, ei) => (
              <View key={`${ex.name}-${ei}`} style={[styles.exerciseCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
                <View style={styles.exerciseHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.exerciseName, { color: C.foreground }]} numberOfLines={1}>{ex.name}</Text>
                    {!!ex.muscle_group && (
                      <Text style={[styles.exerciseMuscle, { color: C.textMuted }]}>{ex.muscle_group}</Text>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={() => removeExercise(ei)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={styles.removeExBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${ex.name}`}
                  >
                    <Feather name="trash-2" size={14} color={C.textDim} />
                  </TouchableOpacity>
                </View>

                {/* Column labels */}
                <View style={styles.setHeaderRow}>
                  <Text style={[styles.setColIdx, styles.setColLabel, { color: C.textDim }]}>SET</Text>
                  <Text style={[styles.setColInput, styles.setColLabel, { color: C.textDim }]}>WEIGHT (KG)</Text>
                  <Text style={[styles.setColInput, styles.setColLabel, { color: C.textDim }]}>REPS</Text>
                  <View style={styles.setColDelete} />
                </View>

                {ex.sets.map((s, si) => (
                  <View key={si} style={styles.setRow}>
                    <Text style={[styles.setColIdx, styles.setIdxText, { color: C.textMuted }]}>{si + 1}</Text>
                    <TextInput
                      value={s.weight}
                      onChangeText={(t) => updateSet(ei, si, 'weight', t)}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                      onFocus={scrollFocusedIntoView}
                      style={[styles.setColInput, styles.setInput, { backgroundColor: C.muted, color: C.foreground }]}
                    />
                    <TextInput
                      value={s.reps}
                      onChangeText={(t) => updateSet(ei, si, 'reps', t)}
                      keyboardType="number-pad"
                      selectTextOnFocus
                      onFocus={scrollFocusedIntoView}
                      style={[styles.setColInput, styles.setInput, { backgroundColor: C.muted, color: C.foreground }]}
                    />
                    <TouchableOpacity
                      onPress={() => removeSet(ei, si)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={[styles.setColDelete, styles.deleteSetBtn]}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete set ${si + 1}`}
                    >
                      <Feather name="x" size={12} color="#ef4444" />
                    </TouchableOpacity>
                  </View>
                ))}

                <TouchableOpacity onPress={() => addSet(ei)} style={[styles.addSetBtn, { borderColor: C.borderSubtle }]}>
                  <Feather name="plus" size={13} color={C.accentText} />
                  <Text style={[styles.addSetText, { color: C.accentText }]}>Add set</Text>
                </TouchableOpacity>
              </View>
            ))
          )}

          {/* Add exercise */}
          <TouchableOpacity
            onPress={() => setShowAddExercise(true)}
            style={[styles.addExerciseBtn, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}
          >
            <Feather name="plus" size={16} color={C.accentText} />
            <Text style={[styles.addExerciseText, { color: C.accentText }]}>Add Exercise</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      <ExercisePickerSheet
        visible={showAddExercise}
        onClose={() => setShowAddExercise(false)}
        onSelect={addExercise}
        selectedNames={exercises.map((e) => e.name)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
  saveBtn: {
    minWidth: 64,
    height: 36,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: { color: Colors.primaryFg, fontSize: FontSize.sm, fontWeight: FontWeight.bold },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, padding: Spacing.xl },
  errorText: { fontSize: FontSize.sm, textAlign: 'center' },
  backBtn: { paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md, borderRadius: Radius.lg, marginTop: Spacing.sm },
  backBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  scrollContent: { padding: Spacing.lg, paddingBottom: 60 },
  fieldLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    letterSpacing: 1,
    marginBottom: 6,
  },
  textField: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    fontSize: FontSize.sm,
  },
  notesField: { minHeight: 64, textAlignVertical: 'top' },
  metaRow: { flexDirection: 'row', gap: Spacing.lg, marginTop: 8, marginBottom: Spacing.lg },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaText: { fontSize: FontSize.xs },

  emptyExercises: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  emptyText: { fontSize: FontSize.sm },

  exerciseCard: {
    borderWidth: 1,
    borderRadius: Radius.xl,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  exerciseHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm },
  exerciseName: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  exerciseMuscle: { fontSize: FontSize.xs, marginTop: 1 },
  removeExBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },

  setHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  setColLabel: { fontSize: 9, fontWeight: FontWeight.semibold, letterSpacing: 0.5 },
  setRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  setColIdx: { width: 28 },
  setIdxText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'center' },
  setColInput: { flex: 1 },
  setInput: {
    height: 40,
    borderRadius: Radius.md,
    textAlign: 'center',
    fontSize: FontSize.sm,
    paddingHorizontal: 4,
  },
  setColDelete: { width: 28, alignItems: 'center' },
  deleteSetBtn: { height: 40, justifyContent: 'center' },

  addSetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    marginTop: 4,
  },
  addSetText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },

  addExerciseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    marginTop: Spacing.sm,
  },
  addExerciseText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
});
