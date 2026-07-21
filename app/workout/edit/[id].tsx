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
import { roundVolume, formatDuration as fmtDur, parseDuration, formatDistanceKm, parseDistanceKm } from '@/lib/format';
import { setVolumeKg } from '@/lib/sets';
import { hydrateCache, readCache } from '@/lib/localCache';
import { getGuestWorkouts, updateGuestWorkout, type GuestWorkout } from '@/lib/guestStore';
import { getPendingWorkouts, updatePendingWorkout, hydrateSyncQueue, type PendingExercise } from '@/lib/syncQueue';
import { getPendingEdit, enqueueEdit, hydrateEditQueue, type PendingEditExercise } from '@/lib/editQueue';
import { ExercisePickerSheet, type CustomExerciseDetails } from '@/components/routines/ExercisePickerSheet';
import { metricTypeOf, metricTypeDef, type ExerciseDef, type MetricType, type MetricAxis } from '@/lib/exercises';
import type { SetType } from '@/lib/types';
import { SET_TYPE_META } from '@/components/workout/SetTypeBadge';

type Backend = 'guest' | 'pending' | 'synced';

// Set/exercise values are edited as strings so typing feels natural (clearing a
// field, partial decimals); they're parsed back to numbers on save.
// Strings so typing feels natural; duration is "m:ss", distance is km. Only the
// axes the exercise's metric_type uses are rendered/parsed.
interface EditSet { uid: string; weight: string; reps: string; duration: string; distance: string; resistance: string; set_type: SetType; rpe: string;
  // Unilateral "L+R" (migration 0056). Created only by the in-workout logger. The
  // edit screen renders the right side (weight_kg_right / reps_right) as its own L/R
  // inputs so a left-only edit can't silently desync the sides. Edited as strings,
  // like weight/reps; rpe_right round-trips silently. weight = the left side.
  is_unilateral: boolean; reps_right: string; rpe_right: number | null; weight_kg_right: string }
interface EditExercise {
  uid: string;
  exerciseId: string | null; // real exercises.id (synced) | null (resolve by name at flush)
  name: string;
  muscle_group?: string;
  category?: string;
  metric_type?: MetricType;
  // Superset grouping ordinal (migration 0060), per exercise; round-tripped silently
  // (no editor UI to change it). null = solo. Read from the first set's column.
  supersetGroup?: number | null;
  // The session note the user wrote on this exercise during the workout
  // (migration 0080). Round-tripped silently like supersetGroup: this screen
  // edits sets, not notes, but it rebuilds the queue entry wholesale, so a field
  // it doesn't carry is a field it deletes. Only populated for the guest and
  // pending backends, whose notes live in the entry being rewritten; synced
  // notes are their own server rows and the edit never touches them.
  note?: string | null;
  sets: EditSet[];
}

// Stable per-row keys. Without them, rows keyed by array index make React reuse
// a row's component for a different item when a middle one is removed (or two
// exercises share a name), shuffling focus / IME state. Each set and exercise
// carries a uid for the duration of the edit.
let _setSeq = 0;
const mkSet = (
  weight: string | number,
  reps: string | number,
  durationSeconds?: number | null,
  distanceM?: number | null,
  resistance?: number | null,
  setType?: string | null,
  rpe?: number | null,
  isUnilateral?: boolean | null,
  repsRight?: number | null,
  rpeRight?: number | null,
  weightRight?: number | null,
): EditSet => ({
  uid: `set-${_setSeq++}`,
  weight: String(weight),
  reps: String(reps),
  duration: durationSeconds ? fmtDur(durationSeconds) : '',
  distance: distanceM ? formatDistanceKm(distanceM).replace(/[^\d.]/g, '') : '',
  resistance: resistance != null ? String(resistance) : '',
  set_type: (setType && setType in SET_TYPE_META ? setType : 'normal') as SetType,
  rpe: rpe != null ? String(rpe) : '',
  is_unilateral: !!isUnilateral,
  reps_right: repsRight != null ? String(repsRight) : '',
  rpe_right: rpeRight ?? null,
  weight_kg_right: weightRight != null ? String(weightRight) : '',
});

let _exSeq = 0;
const mkExUid = (): string => `ex-${_exSeq++}`;

function formatDateLong(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

const axisLabel = (a: MetricAxis): string =>
  a === 'weight' ? 'WEIGHT (KG)'
  : a === 'added_weight' ? '+KG'
  : a === 'assist_weight' ? '−KG'
  : a === 'reps' ? 'REPS'
  : a === 'duration' ? 'TIME'
  : a === 'resistance' ? 'LEVEL'
  : 'KM';
// The string-valued, user-editable axis fields of EditSet (the only ones bound to
// a TextInput). Excludes set_type and the unilateral fields, which round-trip silently.
type AxisField = 'weight' | 'reps' | 'duration' | 'distance' | 'resistance';
const axisField = (a: MetricAxis): AxisField =>
  a === 'reps' ? 'reps' : a === 'duration' ? 'duration' : a === 'distance' ? 'distance'
  : a === 'resistance' ? 'resistance' : 'weight';
// The right-side counterpart field for a unilateral set, or null for axes with no
// per-side column (duration/distance/resistance — unilateral only stores L/R weight+reps).
type RightField = 'weight_kg_right' | 'reps_right';
const rightField = (a: MetricAxis): RightField | null =>
  a === 'reps' ? 'reps_right'
  : (a === 'weight' || a === 'added_weight' || a === 'assist_weight') ? 'weight_kg_right'
  : null;

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

  /**
   * @param noteRows workout_exercise_notes for this workout. Required, not
   *   optional: an exercise can be in a workout for its note alone (no sets),
   *   so building this list from workout_sets by itself silently omits it. The
   *   save path rebuilds the workout from what's loaded here and deletes note
   *   rows for anything absent, so omitting one deletes a note the user never
   *   touched.
   */
  const mapServerSetsToExercises = (rows: any[], noteRows: any[] = []): EditExercise[] => {
    const noteByExercise = new Map<string, { note: string; ex?: any }>();
    for (const n of noteRows) {
      if (n?.exercise_id && typeof n.note === 'string') {
        noteByExercise.set(n.exercise_id, { note: n.note, ex: n.exercises });
      }
    }
    const ordered = [...rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const map = new Map<string, EditExercise>();
    for (const s of ordered) {
      const exId = s.exercise_id;
      let ex = map.get(exId);
      if (!ex) {
        ex = {
          uid: mkExUid(),
          exerciseId: exId,
          name: s.exercises?.name ?? 'Exercise',
          muscle_group: s.exercises?.muscle_group,
          category: s.exercises?.category,
          metric_type: metricTypeOf(s.exercises),
          supersetGroup: typeof s.superset_group === 'number' ? s.superset_group : null,
          note: noteByExercise.get(exId)?.note ?? null,
          sets: [],
        };
        map.set(exId, ex);
      }
      ex.sets.push(mkSet(s.weight_kg ?? 0, s.reps ?? 0, s.duration_seconds, s.distance_m, s.resistance, s.set_type, s.rpe, s.is_unilateral, s.reps_right, s.rpe_right, s.weight_kg_right));
    }
    // Exercises that are in this workout for their note alone. No workout_sets
    // rows to have enumerated them above, so they're appended here; they show
    // as an exercise with no sets and round-trip through the save like any
    // other, which is what keeps their note from being cleaned up as an orphan.
    for (const [exId, n] of noteByExercise) {
      if (map.has(exId)) continue;
      map.set(exId, {
        uid: mkExUid(),
        exerciseId: exId,
        name: n.ex?.name ?? 'Exercise',
        muscle_group: n.ex?.muscle_group,
        category: n.ex?.category,
        metric_type: metricTypeOf(n.ex),
        supersetGroup: null,
        note: n.note,
        sets: [],
      });
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
            uid: mkExUid(),
            exerciseId: null,
            name: ex.name,
            muscle_group: ex.muscle_group,
            category: ex.category,
            metric_type: ex.metric_type,
            supersetGroup: typeof ex.superset_group === 'number' ? ex.superset_group : null,
            note: ex.note ?? null,
            sets: ex.sets.map((s) => mkSet(s.weight_kg, s.reps, s.duration_seconds, s.distance_m, s.resistance, s.set_type, s.rpe, s.is_unilateral, s.reps_right, s.rpe_right, s.weight_kg_right)),
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
            uid: mkExUid(),
            exerciseId: ex.resolvedExerciseId,
            name: ex.def.name,
            muscle_group: ex.def.muscle_group,
            category: ex.def.category,
            metric_type: metricTypeOf(ex.def),
            supersetGroup: ex.supersetGroup ?? null,
            note: ex.note ?? null,
            sets: ex.sets.map((s) => mkSet(s.weight_kg, s.reps, s.duration_seconds, s.distance_m, s.resistance, s.set_type, s.rpe, s.is_unilateral, s.reps_right, s.rpe_right, s.weight_kg_right)),
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
            uid: mkExUid(),
            exerciseId: ex.resolvedExerciseId,
            name: ex.def.name,
            muscle_group: ex.def.muscle_group,
            category: ex.def.category,
            metric_type: metricTypeOf(ex.def),
            supersetGroup: ex.supersetGroup ?? null,
            sets: ex.sets.map((s) => mkSet(s.weight_kg, s.reps, s.duration_seconds, s.distance_m, s.resistance, s.set_type, s.rpe, s.is_unilateral, s.reps_right, s.rpe_right, s.weight_kg_right)),
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
          // The notes embed carries its own exercises() join because a note-only
          // exercise has no workout_sets row to read the name/type from.
          .select('id, name, notes, total_volume_kg, started_at, duration_seconds, workout_exercise_notes(exercise_id, note, exercises(id, name, muscle_group, category, metric_type)), workout_sets(id, exercise_id, weight_kg, reps, "order", duration_seconds, distance_m, resistance, set_type, rpe, is_unilateral, reps_right, rpe_right, weight_kg_right, superset_group, exercises(id, name, muscle_group, category, metric_type))')
          .eq('id', id)
          .single();
        if (error || !data) throw error ?? new Error('not found');
        const rows = (data as any).workout_sets ?? [];
        setIfLive(() => {
          setBackend('synced');
          setName((data as any).name ?? '');
          setNotes((data as any).notes ?? '');
          setExercises(mapServerSetsToExercises(rows, (data as any).workout_exercise_notes ?? []));
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
              uid: mkExUid(),
              exerciseId: null,
              name: ex.name,
              muscle_group: ex.muscle_group,
              category: ex.category,
              metric_type: ex.metric_type,
              supersetGroup: typeof ex.sets?.[0]?.superset_group === 'number' ? ex.sets[0].superset_group : null,
              // The history cache already folds note-only exercises into
              // exercises[], so this path gets them for free.
              note: ex.note ?? null,
              sets: (ex.sets ?? []).map((s: any) => mkSet(s.weight_kg, s.reps, s.duration_seconds, s.distance_m, s.resistance, s.set_type, s.rpe, s.is_unilateral, s.reps_right, s.rpe_right, s.weight_kg_right)),
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
  const updateSet = (ei: number, si: number, field: AxisField, value: string) => {
    setExercises((prev) => prev.map((ex, i) => {
      if (i !== ei) return ex;
      const sets = ex.sets.map((s, j) => (j === si ? { ...s, [field]: value } : s));
      return { ...ex, sets };
    }));
  };

  // Right ("R") side of a unilateral set. Same shape as updateSet; the side is its
  // own field so editing one side never touches the other.
  const updateSetRight = (ei: number, si: number, field: RightField, value: string) => {
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
      return { ...ex, sets: [...ex.sets, mkSet(last?.weight ?? '0', last?.reps ?? '10')] };
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
        uid: mkExUid(),
        exerciseId: null,
        name: def.name,
        muscle_group: def.muscle_group,
        category: def.category,
        metric_type: metricTypeOf(def),
        supersetGroup: null,
        sets: Array.from({ length: count }, () => mkSet('0', reps)),
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

    // Parse + clean, per the exercise's metric_type. A set counts when its
    // primary axis has a value (reps for rep types, time for duration, distance
    // for cardio); weight 0 stays valid for bodyweight. Drop empty sets and any
    // exercise left with none.
    const cleaned = exercises
      .map((ex) => {
        const axes = metricTypeDef(ex.metric_type).axes;
        const usesReps = axes.includes('reps');
        const usesDuration = axes.includes('duration');
        const usesDistance = axes.includes('distance');
        const usesResistance = axes.includes('resistance');
        const sets = ex.sets
          .map((s) => ({
            weight_kg: Math.max(0, parseFloat(s.weight) || 0),
            reps: Math.max(0, parseFloat(s.reps) || 0),
            duration_seconds: usesDuration ? parseDuration(s.duration) : null,
            distance_m: usesDistance ? parseDistanceKm(s.distance) : null,
            resistance: usesResistance ? (parseFloat(s.resistance) || 0) : null,
            set_type: s.set_type ?? 'normal',
            rpe: s.rpe ? parseFloat(s.rpe) : null,
            // Unilateral: the right side is now user-editable; parse it like the left.
            // Non-unilateral sets keep null right-side columns.
            is_unilateral: s.is_unilateral,
            reps_right: s.is_unilateral ? Math.max(0, parseFloat(s.reps_right) || 0) : null,
            rpe_right: s.rpe_right,
            // Blank R weight => null, so setVolumeKg/setLabel's `weight_kg_right ?? weight_kg`
            // inherit-from-left contract fires (a cleared R load means "same as left", not 0kg).
            weight_kg_right: s.is_unilateral
              ? (s.weight_kg_right.trim() === '' ? null : Math.max(0, parseFloat(s.weight_kg_right) || 0))
              : null,
          }))
          // Count the right side of a unilateral set too: a set whose left reps is blank
          // but whose right side has reps is real work (its right volume counts), so it
          // must not be dropped as "empty".
          .filter((s) =>
            (usesReps && (s.reps > 0 || (s.is_unilateral && (s.reps_right ?? 0) > 0))) ||
            (usesDuration && (s.duration_seconds ?? 0) > 0) ||
            (usesDistance && (s.distance_m ?? 0) > 0),
          );
        return { ex, sets };
      })
      // An exercise with no sets left is dropped, unless it carries a session
      // note (migration 0080) — that note is the only reason it's in the
      // workout at all, and dropping the row would delete it. Mirrors
      // keepInSavedWorkout on the workout screen.
      .filter((e) => e.sets.length > 0 || !!e.ex.note?.trim());

    const allSets = cleaned.flatMap((e) => e.sets);
    // Same rule as the finish gate: a workout with no sets is only empty if it
    // also has no notes. Blocking a notes-only workout here would strand it,
    // uneditable, with no way to fix a typo short of deleting the whole thing.
    if (allSets.length === 0 && !cleaned.some((e) => e.ex.note?.trim())) {
      toast.error('Add at least one set, or delete the workout from History.');
      return;
    }
    // Warmups persist as rows but are excluded from total_volume_kg (match the
    // logger + server recompute, migration 0053).
    const newVolume = roundVolume(allSets.reduce((s, x) => s + setVolumeKg(x), 0));
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
            metric_type: metricTypeOf(e.ex),
            superset_group: e.ex.supersetGroup ?? null,
            note: e.ex.note ?? null,
            sets: e.sets.map((s) => ({
              weight_kg: s.weight_kg, reps: s.reps,
              duration_seconds: s.duration_seconds, distance_m: s.distance_m, resistance: s.resistance,
              set_type: s.set_type, rpe: s.rpe,
              is_unilateral: s.is_unilateral, reps_right: s.reps_right, rpe_right: s.rpe_right, weight_kg_right: s.weight_kg_right,
            })),
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
          metric_type: metricTypeOf(e.ex),
        },
        resolvedExerciseId: e.ex.exerciseId && !String(e.ex.exerciseId).startsWith('temp-') ? e.ex.exerciseId : null,
        supersetGroup: e.ex.supersetGroup ?? null,
        // Undefined for the synced backend (its notes are separate server rows
        // this screen never loads), so this only ever carries the guest and
        // pending notes back into the entry it just rebuilt.
        note: e.ex.note ?? null,
        sets: e.sets.map((s, idx) => ({
          weight_kg: s.weight_kg, reps: s.reps, order: idx,
          duration_seconds: s.duration_seconds, distance_m: s.distance_m, resistance: s.resistance,
          set_type: s.set_type, rpe: s.rpe,
          is_unilateral: s.is_unilateral, reps_right: s.reps_right, rpe_right: s.rpe_right, weight_kg_right: s.weight_kg_right,
        })),
      }));

      if (backend === 'pending') {
        const ok = updatePendingWorkout(uid, id!, {
          name: cleanName,
          notes: cleanNotes,
          exercises: toQueueExercises(),
          totalVolumeKg: newVolume,
        });
        if (!ok) {
          // Either it finished syncing (gone from the queue) or its upload is
          // mid-flight (phase past 'queued') — both unsafe to edit in place.
          // Once it lands on the server, reopening edits it as a synced workout.
          toast.info("That workout's still syncing. Give it a moment, then reopen to edit.");
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
              <View key={ex.uid} style={[styles.exerciseCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
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

                {/* Column labels — driven by the exercise's measurement type. */}
                <View style={styles.setHeaderRow}>
                  <Text style={[styles.setColIdx, styles.setColLabel, { color: C.textDim }]}>SET</Text>
                  {metricTypeDef(ex.metric_type).axes.map((a) => (
                    <Text key={a} style={[styles.setColInput, styles.setColLabel, { color: C.textDim }]}>{axisLabel(a)}</Text>
                  ))}
                  <View style={styles.setColDelete} />
                </View>

                {ex.sets.map((s, si) => {
                  const axes = metricTypeDef(ex.metric_type).axes;
                  const kbdFor = (a: MetricAxis) => a === 'duration'
                    ? (Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default')
                    : 'decimal-pad'; // reps included — allow partial reps like 8.5
                  const deleteBtn = (
                    <TouchableOpacity
                      onPress={() => removeSet(ei, si)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={[styles.setColDelete, styles.deleteSetBtn]}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete set ${si + 1}`}
                    >
                      <Feather name="x" size={12} color="#ef4444" />
                    </TouchableOpacity>
                  );
                  const leftInput = (a: MetricAxis) => {
                    const field = axisField(a);
                    return (
                      <TextInput
                        key={a}
                        value={s[field]}
                        onChangeText={(t) => updateSet(ei, si, field, t)}
                        keyboardType={kbdFor(a) as any}
                        placeholder={a === 'duration' ? '0:00' : '0'}
                        placeholderTextColor={C.textMuted}
                        selectTextOnFocus
                        onFocus={scrollFocusedIntoView}
                        style={[styles.setColInput, styles.setInput, { backgroundColor: C.muted, color: C.foreground }]}
                      />
                    );
                  };

                  // Unilateral: two aligned input lines (L / R) under a "SET n · L+R"
                  // badge, so each side is editable and a left edit can't silently
                  // desync the right. Only weight/reps have per-side columns.
                  if (s.is_unilateral) {
                    return (
                      <View key={s.uid} style={styles.uniBlock}>
                        <Text style={styles.uniBadge}>
                          <Text style={{ color: C.textDim }}>{`SET ${si + 1}`}</Text>
                          <Text style={{ color: C.accentText }}>{'   ·   L + R'}</Text>
                        </Text>
                        <View style={styles.setRow}>
                          <Text style={[styles.setColIdx, styles.setIdxText, { color: C.accentText }]}>L</Text>
                          {axes.map(leftInput)}
                          {deleteBtn}
                        </View>
                        <View style={styles.setRow}>
                          <Text style={[styles.setColIdx, styles.setIdxText, { color: C.textMuted }]}>R</Text>
                          {axes.map((a) => {
                            const rf = rightField(a);
                            if (!rf) return <View key={a} style={styles.setColInput} />;
                            return (
                              <TextInput
                                key={a}
                                value={s[rf]}
                                onChangeText={(t) => updateSetRight(ei, si, rf, t)}
                                keyboardType="decimal-pad"
                                placeholder="0"
                                placeholderTextColor={C.textMuted}
                                selectTextOnFocus
                                onFocus={scrollFocusedIntoView}
                                style={[styles.setColInput, styles.setInput, { backgroundColor: C.muted, color: C.foreground }]}
                              />
                            );
                          })}
                          <View style={styles.setColDelete} />
                        </View>
                      </View>
                    );
                  }

                  return (
                    <View key={s.uid} style={styles.setRow}>
                      <Text style={[styles.setColIdx, styles.setIdxText, { color: C.textMuted }]}>{si + 1}</Text>
                      {axes.map(leftInput)}
                      {deleteBtn}
                    </View>
                  );
                })}

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
  // Unilateral L/R pair: badge + two input rows, grouped as one set.
  uniBlock: { marginBottom: 8 },
  uniBadge: { fontSize: 9, fontWeight: FontWeight.semibold, letterSpacing: 0.5, marginBottom: 4, marginLeft: 2 },
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
