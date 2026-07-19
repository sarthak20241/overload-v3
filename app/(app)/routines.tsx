import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  BackHandler,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, {
  FadeInDown,
  SlideInDown,
  SlideOutDown,
  Easing,
  FadeIn,
  FadeOut,
  useSharedValue,
  useAnimatedScrollHandler,
} from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight, Shadow, colorWithAlpha } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/hooks/useTheme';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import { useExerciseNotes } from '@/hooks/useExerciseNotes';
import { supabase, useSupabaseClient } from '@/lib/supabase';
import { getGuestRoutines, addGuestRoutine, updateGuestRoutine, removeGuestRoutine, findGuestRoutine } from '@/lib/guestStore';
import { useIsGuestSession } from '@/lib/guestMode';
import { hydrateCache, readCache, writeCache } from '@/lib/localCache';
import { newClientId } from '@/lib/syncQueue';
import { enqueueRoutine, applyRoutineToCache, mergePendingRoutines, type PendingRoutine } from '@/lib/routineQueue';
import { useSync } from '@/components/SyncProvider';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import { useToast } from '@/components/ui/Toast';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { Portal } from '@/components/ui/Portal';
import { ExercisePickerSheet, type CustomExerciseDetails } from '@/components/routines/ExercisePickerSheet';
import { RoutineDetailSheet } from '@/components/routines/RoutineDetailSheet';
import ReorderableList, {
  useReorderableDrag,
  useIsActive,
  reorderItems,
  type ReorderableListReorderEvent,
} from 'react-native-reorderable-list';
import type { ExerciseDef } from '@/lib/exercises';

const ROUTINE_COLORS = Colors.routineColors;

interface RoutineExerciseRaw {
  exercise_id: string;
  sets: number;
  reps_min: number;
  reps_max: number;
  rest_seconds: number;
  order: number;
  // Phase 2.5: AI-generated routines carry the coach's per-exercise cue.
  // Optional — null/missing on editor-built routines.
  note?: string | null;
  // Supersets (migration 0060): grouping ordinal; null/missing = solo.
  superset_group?: number | null;
  exercises: {
    id: string;
    name: string;
    muscle_group: string;
    category: string;
  };
}

interface RoutineRaw {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  color?: string;
  created_at: string;
  routine_exercises: RoutineExerciseRaw[];
}

// Editor exercise shape (local state only)
interface EditorExercise {
  // Per-ROW unique id — the React key and the identity used by onChange/onRemove
  // and drag-reorder. Deliberately NOT the catalog exercise id: a routine may
  // list the same exercise twice (warmup + working, supersets, AI cues), and a
  // shared id would collide keys and make an edit/delete hit both rows.
  id: string;
  /** Catalog exercises.id, when this row came from a saved routine. Undefined
   *  for hand-built rows (the signed-in save resolves those by name). */
  exerciseId?: string;
  name: string;
  muscleGroup: string;
  /** Equipment category from the picker (custom creations choose one);
   *  undefined for hand-typed rows — findOrCreateExercise falls back to 'Other'. */
  category?: string;
  targetSets: number;
  targetReps: string;
  restSeconds: number;
  notes: string;
  /** Superset grouping ordinal (migration 0060); null = solo. Members share a value
   *  and are kept contiguous in the list (order = list position). */
  supersetGroup?: number | null;
}

// A fresh, collision-proof row id (Date.now() can repeat within a .map(), so mix
// in a random suffix).
let _rowSeq = 0;
function makeRowId(): string {
  return `er-${Date.now()}-${_rowSeq++}-${Math.random().toString(36).slice(2, 7)}`;
}

function newExercise(): EditorExercise {
  return {
    id: makeRowId(),
    name: '',
    muscleGroup: '',
    targetSets: 3,
    targetReps: '8-12',
    restSeconds: 90,
    notes: '',
    supersetGroup: null,
  };
}

// Supersets (migration 0060): a group is a CONTIGUOUS run of rows sharing a value
// (order = list position). This re-numbers each maximal contiguous run to a fresh
// sequential id and dissolves singletons (a "group of 1" = solo). Run after any
// link/unlink or reorder so groups stay contiguous + cleanly numbered.
function normalizeGroups(exs: EditorExercise[]): EditorExercise[] {
  const out = exs.map((e) => ({ ...e }));
  let nextId = 1;
  let i = 0;
  while (i < out.length) {
    const g = out[i].supersetGroup ?? null;
    if (g == null) { i++; continue; }
    let j = i;
    while (j < out.length && (out[j].supersetGroup ?? null) === g) j++;
    if (j - i >= 2) {
      const id = nextId++;
      for (let k = i; k < j; k++) out[k].supersetGroup = id;
    } else {
      out[i].supersetGroup = null;
    }
    i = j;
  }
  return out;
}

// ─── Exercise Tag Pills ───────────────────────────────────────────────────────
function ExerciseTags({ exercises }: { exercises: string[] }) {
  const { C } = useTheme();
  const visible = exercises.slice(0, 3);
  const extra = exercises.length - 3;
  return (
    <View style={styles.tagsRow}>
      {visible.map((name, i) => (
        <View key={i} style={[styles.tag, { backgroundColor: C.muted }]}>
          <Text style={[styles.tagText, { color: C.textSecondary }]} numberOfLines={1}>
            {name}
          </Text>
        </View>
      ))}
      {extra > 0 && (
        <View style={[styles.tag, { backgroundColor: C.muted }]}>
          <Text style={[styles.tagText, { color: C.textMuted }]}>+{extra} more</Text>
        </View>
      )}
    </View>
  );
}

// ─── Routine Card ─────────────────────────────────────────────────────────────
function RoutineCard({
  routine,
  colorIndex,
  onPress,
  onPlay,
  onMenu,
}: {
  routine: RoutineRaw;
  colorIndex: number;
  onPress: () => void;
  onPlay: () => void;
  onMenu: () => void;
}) {
  const { C } = useTheme();
  const dotColor = ROUTINE_COLORS[colorIndex % ROUTINE_COLORS.length];
  const exerciseNames = routine.routine_exercises
    .sort((a, b) => a.order - b.order)
    .map((re) => re.exercises?.name)
    .filter(Boolean) as string[];

  const muscleGroups = [
    ...new Set(
      routine.routine_exercises
        .map((re) => re.exercises?.muscle_group)
        .filter(Boolean)
    ),
  ].join(', ');

  // How many supersets this routine contains, so a grouped routine doesn't read
  // identical to a flat one on the collapsed card.
  const supersetCount = new Set(
    routine.routine_exercises
      .map((re) => re.superset_group)
      .filter((g): g is number => g != null),
  ).size;

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
      <Animated.View
        entering={FadeInDown.delay(colorIndex * 60).duration(350)}
        style={[styles.routineCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
      >
        <View style={[styles.dotWrap, { backgroundColor: `${dotColor}18` }]}>
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
        </View>
        <View style={styles.routineContent}>
          <Text style={[styles.routineName, { color: C.foreground }]} numberOfLines={1}>
            {routine.name}
          </Text>
          {muscleGroups ? (
            <Text style={[styles.routineMuscles, { color: C.mutedFg }]} numberOfLines={1}>
              {muscleGroups}
            </Text>
          ) : routine.description ? (
            <Text style={[styles.routineMuscles, { color: C.mutedFg }]} numberOfLines={1}>
              {routine.description}
            </Text>
          ) : null}
          <Text style={[styles.exerciseCount, { color: C.textMuted }]}>
            {routine.routine_exercises.length} exercise{routine.routine_exercises.length !== 1 ? 's' : ''}
            {supersetCount > 0 ? ` · ${supersetCount} superset${supersetCount !== 1 ? 's' : ''}` : ''}
          </Text>
          {exerciseNames.length > 0 && <ExerciseTags exercises={exerciseNames} />}
        </View>
        <View style={styles.routineActions}>
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); onPlay(); }}
            style={[styles.playBtn, { backgroundColor: C.primaryMuted }]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={`Start ${routine.name}`}
          >
            <Feather name="play" size={14} color={C.accentText} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); onMenu(); }}
            style={styles.menuBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={`${routine.name} options`}
          >
            <Feather name="more-vertical" size={16} color={C.textMuted} />
          </TouchableOpacity>
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
}

// ─── Rep Range Input ─────────────────────────────────────────────────────────
// Two small number fields with a fixed "-" between them, so the user types the
// low and high ends and never the separator. The canonical value stays a string
// ("8-12", or just "8" for a fixed count) so the save path (parseReps) and the
// collapsed-card summary keep working unchanged.
function splitRange(value: string): { min: string; max: string } {
  const t = (value ?? '').trim();
  const dash = t.indexOf('-');
  if (dash >= 0) return { min: t.slice(0, dash).trim(), max: t.slice(dash + 1).trim() };
  return { min: t, max: '' };
}

function joinRange(min: string, max: string): string {
  const a = min.trim();
  const b = max.trim();
  // Collapse to a single number when both ends match (or only one is set), so a
  // fixed-rep target reads as "8 reps", not "8-8".
  if (a && b) return a === b ? a : `${a}-${b}`;
  return a || b;
}

function RepRangeInput({
  value,
  onChange,
  onFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onFocus?: () => void;
}) {
  const { C } = useTheme();
  const initial = splitRange(value);
  const [min, setMin] = useState(initial.min);
  const [max, setMax] = useState(initial.max);
  // Mirror state into refs so the deferred blur handler reads current values.
  const minRef = useRef(min);
  minRef.current = min;
  const maxRef = useRef(max);
  maxRef.current = max;
  // How many of the two fields currently hold focus, so we only tidy up once
  // focus leaves the range entirely (not while tabbing low <-> high).
  const focusCount = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Re-sync from the parent only when `value` changes from OUTSIDE this field
  // (e.g. a custom-exercise pick rewrites targetReps). After our own edits the
  // parent already equals joinRange(min,max), so this no-ops and never clobbers
  // a half-typed range.
  useEffect(() => {
    if (joinRange(min, max) !== (value ?? '').trim()) {
      const next = splitRange(value);
      setMin(next.min);
      setMax(next.max);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (nextMin: string, nextMax: string) => {
    setMin(nextMin);
    setMax(nextMax);
    onChange(joinRange(nextMin, nextMax));
  };

  const handleFocus = () => {
    focusCount.current += 1;
    onFocus?.();
  };

  // When focus leaves the whole range, fold a lone high value (the low end was
  // cleared) into the low field. A single value is stored as just "12", which
  // reloads into the low field — so settling it here keeps the two boxes showing
  // exactly what a reopen would, instead of the number hopping high -> low.
  const handleBlur = () => {
    focusCount.current = Math.max(0, focusCount.current - 1);
    // Defer past the sibling focus switch (blur fires before the new focus).
    setTimeout(() => {
      if (!mountedRef.current || focusCount.current > 0) return;
      if (minRef.current === '' && maxRef.current !== '') {
        commit(maxRef.current, '');
      }
    }, 0);
  };

  const digits = (v: string) => v.replace(/[^0-9]/g, '');
  const inputStyle = [
    styles.editorRangeInput,
    { backgroundColor: C.card, borderColor: C.border, color: C.foreground },
  ];

  return (
    <View style={styles.editorRangeRow}>
      <TextInput
        value={min}
        onChangeText={(v) => commit(digits(v), max)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        keyboardType="number-pad"
        placeholder="8"
        placeholderTextColor={C.textMuted}
        maxLength={3}
        style={inputStyle}
        textAlign="center"
      />
      <Text style={[styles.editorRangeSep, { color: C.textMuted }]}>-</Text>
      <TextInput
        value={max}
        onChangeText={(v) => commit(min, digits(v))}
        onFocus={handleFocus}
        onBlur={handleBlur}
        keyboardType="number-pad"
        placeholder="12"
        placeholderTextColor={C.textMuted}
        maxLength={3}
        style={inputStyle}
        textAlign="center"
      />
    </View>
  );
}

// ─── Exercise Editor Card ────────────────────────────────────────────────────
// Rendered as a ReorderableList item, so it can use the library's drag hooks.
function ExerciseEditorCard({
  exercise,
  onChange,
  onRemove,
  onOpenPicker,
  onInputFocus,
  stickyNote = null,
  canReorder = true,
  grouped = false,
}: {
  exercise: EditorExercise;
  onChange: (ex: EditorExercise) => void;
  onRemove: () => void;
  onOpenPicker: () => void;
  onInputFocus?: () => void;
  /** The user's sticky note for this exercise (user_exercise_notes), shown
   * read-only so it's clear what the exercise already carries into every
   * routine. Passed down rather than read per card: one hook in the parent
   * means one server refresh instead of one per row. Edited in a session. */
  stickyNote?: string | null;
  canReorder?: boolean;
  /** Part of a superset — show a left accent so the group reads as a block. */
  grouped?: boolean;
}) {
  const { C } = useTheme();
  // react-native-reorderable-list: `drag` begins the drag for this row; isActive
  // is true while it's the one being dragged (needs shouldUpdateActiveItem).
  const drag = useReorderableDrag();
  const isActive = useIsActive();
  // Open unfilled rows so a freshly added card is ready to pick into. Keyed off
  // content, not position, so the expanded card follows the item across a
  // reorder instead of being pinned to index 0.
  const [expanded, setExpanded] = useState(!exercise.name);
  // Collapse the body while this card is the one being dragged so the floating
  // row is compact and the list shuffles around a small footprint.
  const showBody = expanded && !isActive;

  return (
    <View style={[styles.editorCard, { backgroundColor: C.muted, borderColor: C.borderLight }]}>
      {/* Superset accent as an overlay strip, NOT a borderLeftWidth toggle: changing a
          per-side border on this rounded overflow-hidden card reconfigures its Android
          drawable and (Fabric bug) stops the children painting — split a superset and
          the card went blank until relinked. A mounted/unmounted child is safe. */}
      {grouped && <View pointerEvents="none" style={styles.groupAccent} />}
      {/* Header - always visible. The grip is the drag handle (hold to grab);
          the rest of the row still taps to expand / collapse. */}
      <View style={styles.editorHeader}>
        {canReorder ? (
          <Pressable
            onLongPress={drag}
            delayLongPress={140}
            style={styles.dragHandle}
            hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel={`Reorder ${exercise.name || 'exercise'}`}
          >
            <Feather name="menu" size={16} color={isActive ? C.accentText : C.textDim} />
          </Pressable>
        ) : (
          <View style={styles.dragHandleSpacer} />
        )}
        <TouchableOpacity
          onPress={() => setExpanded(!expanded)}
          style={styles.editorHeaderMain}
          activeOpacity={0.7}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.editorExName, { color: exercise.name ? C.foreground : C.textMuted }]} numberOfLines={1}>
              {exercise.name || 'Unnamed exercise'}
            </Text>
            <Text style={[styles.editorExSub, { color: C.textMuted }]}>
              {exercise.targetSets} sets · {exercise.targetReps} reps
              {exercise.muscleGroup ? ` · ${exercise.muscleGroup}` : ''}
            </Text>
          </View>
          <Feather
            name={showBody ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={C.textMuted}
            style={{ marginLeft: 4 }}
          />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onRemove}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.editorRemoveBtn}
        >
          <Feather name="x" size={13} color={C.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Expandable body */}
      {showBody && (
        <View style={[styles.editorBody, { borderTopColor: C.borderSubtle }]}>
          {/* Exercise picker — opens the bottom-sheet library. The inline
              dropdown it replaces expanded downward into the IME, so the
              results were hidden behind the keyboard while typing. */}
          <View>
            <Text style={[styles.editorLabel, { color: C.textMuted }]}>Exercise</Text>
            <TouchableOpacity
              onPress={onOpenPicker}
              style={[
                styles.editorInput,
                { backgroundColor: C.card, borderColor: C.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
              ]}
            >
              <Text
                style={[styles.editorInputText, { color: exercise.name ? C.foreground : C.textMuted, flex: 1 }]}
                numberOfLines={1}
              >
                {exercise.name || 'Select exercise...'}
              </Text>
              <Feather name="chevron-down" size={14} color={C.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Sets / Reps / Rest row */}
          <View style={styles.editorRow3}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.editorLabel, { color: C.textMuted }]}>Sets</Text>
              <TextInput
                value={String(exercise.targetSets)}
                onChangeText={(v) => onChange({ ...exercise, targetSets: Math.max(1, Math.min(10, Number(v) || 0)) })}
                onFocus={onInputFocus}
                keyboardType="number-pad"
                style={[styles.editorNumInput, { backgroundColor: C.card, borderColor: C.border, color: C.foreground }]}
                textAlign="center"
              />
            </View>
            <View style={{ flex: 1.5 }}>
              <Text style={[styles.editorLabel, { color: C.textMuted }]}>Reps</Text>
              <RepRangeInput
                value={exercise.targetReps}
                onChange={(v) => onChange({ ...exercise, targetReps: v })}
                onFocus={onInputFocus}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.editorLabel, { color: C.textMuted }]}>Rest (s)</Text>
              <TextInput
                value={String(exercise.restSeconds)}
                onChangeText={(v) => onChange({ ...exercise, restSeconds: Math.max(0, Number(v) || 0) })}
                onFocus={onInputFocus}
                keyboardType="number-pad"
                style={[styles.editorNumInput, { backgroundColor: C.card, borderColor: C.border, color: C.foreground }]}
                textAlign="center"
              />
            </View>
          </View>

          {/* Notes. Two of them can apply to this row, so the labels have to
              carry the difference: this field is the cue for THIS routine slot
              (routine_exercises.note, also where the coach writes), while the
              line below it is the user's own note riding along with the
              exercise itself. That one is read-only here — it's edited in a
              session, and the write path (local store + debounced flush) lives
              on the workout screen. */}
          <View>
            <Text style={[styles.editorLabel, { color: C.textMuted }]}>Note for this routine (optional)</Text>
            <TextInput
              value={exercise.notes}
              onChangeText={(v) => onChange({ ...exercise, notes: v })}
              onFocus={onInputFocus}
              placeholder="Form tip or reminder..."
              placeholderTextColor={C.textMuted}
              style={[styles.editorInput, styles.editorInputText, { backgroundColor: C.card, borderColor: C.border, color: C.foreground }]}
            />
          </View>

          {stickyNote ? (
            <View style={styles.editorStickyNoteRow}>
              <Feather name="bookmark" size={11} color={C.textMuted} style={styles.editorStickyNoteIcon} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.editorStickyNoteLabel, { color: C.textMuted }]}>
                  Your note on this exercise, in every routine
                </Text>
                <Text style={[styles.editorStickyNoteText, { color: C.mutedFg }]}>{stickyNote}</Text>
              </View>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

// ─── Routine Editor Sheet (Full-screen) ──────────────────────────────────────
function RoutineEditorSheet({
  visible,
  editingRoutine,
  onClose,
  onSaved,
}: {
  visible: boolean;
  editingRoutine: { id?: string; name: string; description: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { C } = useTheme();
  const { user } = useClerkUser();
  const isGuestSession = useIsGuestSession();
  const supabase = useSupabaseClient();
  const { flushNow } = useSync();
  const toast = useToast();
  // One lookup for the whole list — each card gets its note as a prop. The
  // sheet stays mounted while closed, so gate the load on `visible`.
  const { noteFor } = useExerciseNotes(visible);
  // SafeAreaView reports zero insets inside a fullScreen RN Modal (separate
  // native view hierarchy the provider never measures), so the header collided
  // with the status bar / Dynamic Island. Read the device inset via the hook —
  // it returns the correct value from the root provider — and pad manually.
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [exercises, setExercises] = useState<EditorExercise[]>([newExercise()]);
  const [errorMsg, setErrorMsg] = useState('');
  // Sub-frame double-tap guard — modal closes on save, so we don't need a
  // disabled-button render state; just block reentry.
  const inFlightRef = useRef(false);

  // Which exercise card the bottom-sheet picker is choosing for (null = closed).
  // The sheet handles its own search, keyboard lift, and custom creation.
  const [pickerTargetIdx, setPickerTargetIdx] = useState<number | null>(null);

  // Supersets: link row i with the one above into a group (or split it off).
  // normalizeGroups renumbers contiguous runs + dissolves singletons.
  const toggleSupersetLink = (i: number) => {
    if (i < 1) return;
    haptics.selection();
    setExercises((prev) => {
      const next = prev.map((e) => ({ ...e }));
      const linked = next[i].supersetGroup != null && next[i].supersetGroup === next[i - 1].supersetGroup;
      if (linked) {
        // Split the contiguous run AT this boundary: row i and everything below it in
        // the same run start a fresh group; rows above keep the old id. (Nulling just
        // row i would leave a 3+ giant set non-contiguous, and normalizeGroups would
        // then dissolve BOTH remaining singletons — ejecting the member, not splitting.)
        const oldGid = next[i].supersetGroup;
        const newGid = 9000 + i;
        for (let k = i; k < next.length && next[k].supersetGroup === oldGid; k++) {
          next[k].supersetGroup = newGid;
        }
      } else {
        const gid = next[i - 1].supersetGroup ?? 9000 + i;
        next[i - 1].supersetGroup = gid;
        next[i].supersetGroup = gid;
      }
      return normalizeGroups(next);
    });
  };

  // The reorderable list is its own scroller. On Android (SDK 54 edge-to-edge
  // doesn't resize the window for the IME) lower inputs would stay buried under
  // the keyboard, so we lift the focused field above it ourselves. We hand the
  // keyboard hook an imperative scroller backed by this list so it can reuse its
  // measure-the-focused-field choreography rather than just scrolling the whole
  // card to the top (a tall expanded card left its Reps/Notes fields behind the
  // IME). getOffset reads the live scroll Y from an animated scroll handler (a
  // shared value, readable on the JS thread); scrollToOffset drives the list.
  // Disabled while the picker is open (it lifts itself).
  const listRef = useRef<any>(null);
  const listScrollY = useSharedValue(0);
  const onListScroll = useAnimatedScrollHandler((e) => {
    listScrollY.value = e.contentOffset.y;
  });
  const listScroller = useMemo(
    () => ({
      scrollToOffset: (y: number) => {
        try {
          listRef.current?.scrollToOffset?.({ offset: Math.max(0, y), animated: true });
        } catch {}
      },
      getOffset: () => listScrollY.value,
    }),
    [listScrollY],
  );
  const { kbHeight, scrollFocusedIntoView, scrollProps } = useKeyboardAwareScroll(
    pickerTargetIdx === null,
    listScroller,
  );

  // The editor renders via <Portal> (the main app window) instead of a native
  // <Modal>. That's deliberate: on Android a <Modal> is a separate Dialog
  // window, and RN's Keyboard events fire only for the main activity window —
  // so keyboard listeners never fired inside the Modal and the IME covered
  // the inputs. In the main window the listeners work and sheets lift.
  // <Portal> has no onRequestClose, so wire the Android hardware back button
  // ourselves. The exercise picker registers its own back handler while open
  // (registered later, so it runs first); this one only dismisses the editor.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleClose();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handlePickExercise = (ex: ExerciseDef, custom?: CustomExerciseDetails) => {
    if (pickerTargetIdx !== null) {
      setExercises((prev) =>
        prev.map((e, i) => {
          if (i !== pickerTargetIdx) return e;
          // The picker identifies exercises by name (ExerciseDef carries no id),
          // so a re-picked row's old catalog exerciseId is now stale — clear it
          // so the save resolves the new exercise by name, not the wrong id.
          const next = { ...e, name: ex.name, muscleGroup: ex.muscle_group, category: ex.category, exerciseId: undefined };
          // Custom creations carry set/rep/rest targets from the form; library
          // picks keep whatever the card already has.
          if (custom) {
            next.targetSets = custom.sets;
            next.targetReps =
              custom.repsMin === custom.repsMax
                ? String(custom.repsMin)
                : `${custom.repsMin}-${custom.repsMax}`;
            next.restSeconds = custom.restSeconds;
          }
          return next;
        })
      );
    }
    setPickerTargetIdx(null);
  };

  // Reset state when opening
  useEffect(() => {
    if (visible && editingRoutine) {
      setName(editingRoutine.name);
      setDescription(editingRoutine.description);
      setErrorMsg('');
    }
  }, [visible, editingRoutine]);

  // Load existing exercises when editing
  useEffect(() => {
    if (visible && editingRoutine?.id) {
      loadExistingExercises(editingRoutine.id);
    } else if (visible && !editingRoutine?.id) {
      setExercises([newExercise()]);
    }
  }, [visible, editingRoutine?.id]);

  const loadExistingExercises = async (routineId: string) => {
    if (isGuestSession) {
      // Guest routines live in the local store - hydrate the editor from there
      // instead of querying Supabase (a guest-r/mock-r id is not a valid uuid,
      // so the query below would error and silently blank the editor).
      const routine = findGuestRoutine(routineId);
      if (!routine) {
        // Stale/unknown guest routine id — surface it instead of silently
        // showing a blank exercise card.
        console.warn(`[routines] guest routine not found for id ${routineId}, opening empty editor`);
      }
      const rows = routine?.routine_exercises || [];
      setExercises(
        rows.length > 0
          ? rows.map((re: any) => ({
              id: makeRowId(),
              exerciseId: re.exercises?.id || re.exercise_id || re.id,
              name: re.exercises?.name || '',
              muscleGroup: re.exercises?.muscle_group || '',
              category: re.exercises?.category || undefined,
              targetSets: re.sets || 3,
              targetReps: re.reps_min === re.reps_max
                ? String(re.reps_min)
                : `${re.reps_min}-${re.reps_max}`,
              restSeconds: re.rest_seconds || 90,
              notes: re.note || '',
              supersetGroup: typeof re.superset_group === 'number' ? re.superset_group : null,
            }))
          : [newExercise()]
      );
      return;
    }
    const mapRow = (re: any) => ({
      id: makeRowId(),
      exerciseId: re.exercise_id || re.exercises?.id || re.id,
      name: re.exercises?.name || '',
      muscleGroup: re.exercises?.muscle_group || '',
      category: re.exercises?.category || undefined,
      targetSets: re.sets || 3,
      targetReps: re.reps_min === re.reps_max
        ? String(re.reps_min)
        : `${re.reps_min}-${re.reps_max}`,
      restSeconds: re.rest_seconds || 90,
      // The DB column is `note` (singular). `re.notes` was a typo that silently
      // read undefined, so opening an AI-generated routine dropped its cues.
      notes: re.note || re.notes || '',
      supersetGroup: typeof re.superset_group === 'number' ? re.superset_group : null,
    });

    // Cache-first: hydrate the editor from the cached routine so it is never
    // blank offline. A blank editor saved over a real routine would wipe its
    // exercises (performSave deletes + reinserts), so showing the cached rows
    // protects against that data loss. The 'routines' cache nests
    // routine_exercises(*, exercises(*)).
    await hydrateCache(user?.id);
    const cachedRows: any[] =
      readCache<any[]>('routines', user?.id)?.find((r) => r.id === routineId)?.routine_exercises ?? [];
    if (cachedRows.length > 0) setExercises(cachedRows.map(mapRow));

    try {
      const { data, error } = await supabase
        .from('routine_exercises')
        .select('*, exercises(*)')
        .eq('routine_id', routineId)
        .order('order');
      if (error) throw error;
      if (data && data.length > 0) {
        setExercises(data.map(mapRow));
      } else if (cachedRows.length === 0) {
        setExercises([newExercise()]);
      }
    } catch {
      // Offline — keep the cache-hydrated rows; only fall back to a blank card
      // when there was no cache (a fresh editor session with no signal).
      if (cachedRows.length === 0) setExercises([newExercise()]);
    }
  };

  // Pure save worker — takes a snapshot so the closure is independent of any
  // post-close state changes. Used by both the initial save and the toast Retry.
  const performSave = async (snapshot: {
    trimmedName: string;
    trimmedDescription: string;
    validExercises: EditorExercise[];
    editingId?: string;
  }) => {
    const clerkId = user?.id;
    const { trimmedName, trimmedDescription, validExercises, editingId } = snapshot;

    // Guest mode: no Supabase / no Clerk id — persist locally only.
    if (isGuestSession || !clerkId) {
      const routineId = editingId || `guest-r-${Date.now()}`;
      const routineExercises = validExercises.map((ex, i) => {
        const [repsMin, repsMax] = parseReps(ex.targetReps);
        // Persist the catalog exercise id (loaded rows) or fall back to the
        // row id for hand-built rows — the same identity the old code stored,
        // now that `ex.id` is a per-row key rather than the exercise id.
        const exId = ex.exerciseId ?? ex.id;
        return {
          id: `gre-${Date.now()}-${i}`,
          exercise_id: exId,
          order: i,
          sets: ex.targetSets,
          reps_min: repsMin,
          reps_max: repsMax,
          rest_seconds: ex.restSeconds,
          superset_group: ex.supersetGroup ?? null,
          exercises: {
            id: exId,
            name: ex.name,
            muscle_group: ex.muscleGroup || 'Other',
            category: 'Custom',
          },
        };
      });
      const guestRoutine = {
        id: routineId,
        user_id: 'guest',
        name: trimmedName,
        description: trimmedDescription,
        color: undefined as any,
        created_at: new Date().toISOString(),
        routine_exercises: routineExercises,
      };
      if (editingId) {
        // Try in-place update first; if the id is stale (not in the guest
        // store, updateGuestRoutine returns false), fall back to creating a
        // new guest copy so the user's edits aren't silently lost.
        if (!updateGuestRoutine(guestRoutine)) {
          addGuestRoutine({ ...guestRoutine, id: `guest-r-${Date.now()}` });
        }
      } else {
        addGuestRoutine(guestRoutine);
      }
      return;
    }

    // Signed-in: local-first. A new routine gets a client-generated id (used as
    // its primary key on insert, so retries are idempotent and a workout can
    // link to it before it syncs); an edit reuses the existing id. We
    // optimistically update the cache and enqueue the write — never delete the
    // live routine's exercises from the client, so an offline/mid-flight failure
    // can't wipe them (the flusher replaces them server-side, idempotently).
    const routineId = editingId || newClientId();
    const entry: PendingRoutine = {
      schema: 1,
      routineId,
      ownerId: clerkId,
      name: trimmedName,
      description: trimmedDescription || null,
      color: null,
      createdAtIso: new Date().toISOString(),
      exercises: validExercises.map((ex, i) => {
        const [reps_min, reps_max] = parseReps(ex.targetReps);
        return {
          def: { name: ex.name, muscle_group: ex.muscleGroup || 'Other', category: ex.category || 'Custom' },
          // Loaded-from-routine rows carry a real catalog id — attach it directly
          // so the flusher skips name re-resolution (which can mis-match a
          // duplicate name). Picked/hand-typed rows clear it and resolve by name.
          resolvedExerciseId: ex.exerciseId ?? null,
          order: i,
          sets: ex.targetSets,
          reps_min,
          reps_max,
          rest_seconds: ex.restSeconds,
          note: ex.notes?.trim() ? ex.notes.trim() : null,
          superset_group: ex.supersetGroup ?? null,
        };
      }),
      phase: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    };
    applyRoutineToCache(clerkId, entry);
    await enqueueRoutine(clerkId, entry);
    void flushNow();
  };

  const runSave = (snapshot: Parameters<typeof performSave>[0]) => {
    inFlightRef.current = true;
    toast.info(`Saving “${snapshot.trimmedName}”…`);
    performSave(snapshot)
      .then(() => {
        toast.success(snapshot.editingId ? 'Routine updated' : 'Routine saved');
        onSaved();
      })
      .catch(() => {
        toast.error(`Couldn't save “${snapshot.trimmedName}”`, {
          action: { label: 'Retry', onPress: () => runSave(snapshot) },
        });
      })
      .finally(() => { inFlightRef.current = false; });
  };

  const handleSave = () => {
    // Validation must stay inline so error messages display in the modal
    // before we close it — otherwise the user loses their unsaved work
    // without knowing why.
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMsg('Please enter a routine name');
      return;
    }
    // Re-normalize after dropping blank-named rows: a filtered-out member could leave
    // a superset with a single remaining member, which must dissolve to solo.
    const validExercises = normalizeGroups(exercises.filter((e) => e.name.trim()));
    if (validExercises.length === 0) {
      setErrorMsg('Add at least one exercise');
      return;
    }
    if (inFlightRef.current) return;

    const snapshot = {
      trimmedName,
      trimmedDescription: description.trim(),
      validExercises,
      editingId: editingRoutine?.id,
    };
    handleClose();
    runSave(snapshot);
  };

  const handleClose = () => {
    setName('');
    setDescription('');
    setExercises([newExercise()]);
    setErrorMsg('');
    onClose();
  };

  return (
    <Portal>
      {visible && (
        <Animated.View
          entering={SlideInDown.duration(300).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(250)}
          style={[StyleSheet.absoluteFill, styles.editorSafe, { backgroundColor: C.elevated, paddingTop: insets.top }]}
        >

          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            {/* Sheet Header */}
            <View style={[styles.sheetHeader, { borderBottomColor: C.borderLight }]}>
              <TouchableOpacity
                onPress={handleClose}
                style={[styles.sheetCloseBtn, { backgroundColor: C.glowBg }]}
              >
                <Feather name="x" size={15} color={C.foreground} />
              </TouchableOpacity>
              <Text style={[styles.sheetTitle, { color: C.foreground }]}>
                {editingRoutine?.id ? 'Edit Routine' : 'New Routine'}
              </Text>
              <TouchableOpacity
                onPress={handleSave}
                style={styles.sheetSaveBtn}
              >
                <Feather name="check" size={13} color={Colors.primaryFg} />
                <Text style={styles.sheetSaveBtnText}>Save</Text>
              </TouchableOpacity>
            </View>

            {/* Inline validation error. The editor is a full-screen Modal, so a
                Portal-based ThemedAlert renders BEHIND it (invisible) — show the
                reminder inline here instead so the user actually sees it. */}
            {errorMsg ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.xl, marginTop: Spacing.md, paddingVertical: 10, paddingHorizontal: 12, borderRadius: Radius.md, backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)' }}>
                <Feather name="alert-circle" size={14} color="#ef4444" />
                <Text style={{ color: '#ef4444', fontSize: FontSize.sm, fontWeight: FontWeight.semibold, flex: 1 }}>{errorMsg}</Text>
              </View>
            ) : null}

            {/* Pinned fields — kept ABOVE the reorderable list (not inside it),
                so the Name/Description inputs don't lose focus when the list
                re-renders, and the list owns its own scroll for dragging. */}
            <View style={styles.pinnedFields}>
              <View>
                <Text style={[styles.editorLabel, { color: C.textMuted }]}>Routine Name</Text>
                <TextInput
                  value={name}
                  onChangeText={(v) => { setName(v); if (errorMsg) setErrorMsg(''); }}
                  placeholder="e.g. Push Day A"
                  placeholderTextColor={C.textMuted}
                  style={[styles.sheetInput, { backgroundColor: C.muted, borderColor: C.border, color: C.foreground }]}
                />
              </View>

              <View>
                <Text style={[styles.editorLabel, { color: C.textMuted }]}>Description (optional)</Text>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  placeholder="Brief description..."
                  placeholderTextColor={C.textMuted}
                  style={[styles.sheetInput, { backgroundColor: C.muted, borderColor: C.border, color: C.foreground }]}
                />
              </View>

              <View style={styles.exercisesHeader}>
                <Text style={[styles.exercisesLabel, { color: C.textMuted }]}>
                  EXERCISES ({exercises.length})
                </Text>
              </View>
            </View>

            {/* Exercise list — drag-to-reorder (react-native-reorderable-list).
                The library owns activation (hold the grip), the shuffle, and
                autoscroll, so it's the scroller for the cards. */}
            <ReorderableList
              ref={listRef}
              data={exercises}
              keyExtractor={(ex) => ex.id}
              shouldUpdateActiveItem
              onReorder={({ from, to }: ReorderableListReorderEvent) =>
                // Re-normalize so a reorder can't leave a superset's members
                // non-contiguous (a split run dissolves; see normalizeGroups).
                setExercises((prev) => normalizeGroups(reorderItems(prev, from, to)))
              }
              renderItem={({ item: ex, index: i }) => {
                const linkedAbove = i > 0 && ex.supersetGroup != null
                  && ex.supersetGroup === exercises[i - 1].supersetGroup;
                return (
                <View style={styles.cardWrap}>
                  {i > 0 && (
                    <TouchableOpacity
                      onPress={() => toggleSupersetLink(i)}
                      style={[styles.linkRow, linkedAbove && { backgroundColor: colorWithAlpha(Colors.primary, 0.12) }]}
                      hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel={linkedAbove ? 'Split this superset' : 'Make a superset with the exercise above'}
                    >
                      <Feather name={linkedAbove ? 'link' : 'link-2'} size={11} color={linkedAbove ? Colors.primary : C.textMuted} />
                      <Text style={[styles.linkRowText, { color: linkedAbove ? Colors.primary : C.textMuted }]}>
                        {linkedAbove ? 'Superset — tap to split' : 'Superset with above'}
                      </Text>
                    </TouchableOpacity>
                  )}
                  <ExerciseEditorCard
                    exercise={ex}
                    stickyNote={noteFor(ex.name)}
                    grouped={ex.supersetGroup != null}
                    canReorder={exercises.length > 1}
                    onChange={(updated) =>
                      setExercises((prev) => prev.map((e) => (e.id === ex.id ? updated : e)))
                    }
                    onRemove={() => setExercises((prev) => normalizeGroups(prev.filter((e) => e.id !== ex.id)))}
                    onOpenPicker={() => setPickerTargetIdx(i)}
                    onInputFocus={scrollFocusedIntoView}
                  />
                </View>
                );
              }}
              style={{ flex: 1 }}
              contentContainerStyle={[
                styles.editorListContent,
                // Android edge-to-edge: make room for the IME so a focused lower
                // card can scroll clear of the keyboard.
                Platform.OS === 'android' && kbHeight > 0 && { paddingBottom: kbHeight + 120 },
              ]}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              // Track scroll position (animated handler → shared value) and the
              // moment the IME padding lands, so the keyboard hook can lift the
              // focused field above the keyboard. See the listScroller note above.
              onScroll={onListScroll}
              onContentSizeChange={scrollProps.onContentSizeChange}
              ListFooterComponent={
                <TouchableOpacity
                  onPress={() => setExercises((prev) => [...prev, newExercise()])}
                  style={[styles.addExerciseBtn, { borderColor: C.border }]}
                >
                  <Feather name="plus" size={14} color={C.textMuted} />
                  <Text style={[styles.addExerciseBtnText, { color: C.textMuted }]}>Add Exercise</Text>
                </TouchableOpacity>
              }
            />
          </KeyboardAvoidingView>

          {/* Exercise Picker — shared bottom-sheet library (search, muscle
              filters, custom creation). It renders in its OWN <Portal> node, a
              sibling overlay in the SAME main window as the editor (also a
              Portal): nesting overlays inside the editor's absolute-fill
              subtree defeated Android's keyboard handling, and a nested native
              <Modal> never presents on iOS over an already-open one. */}
          <ExercisePickerSheet
            visible={pickerTargetIdx !== null}
            onClose={() => setPickerTargetIdx(null)}
            onSelect={handlePickExercise}
            selectedNames={exercises.map((e) => e.name).filter(Boolean)}
          />
        </Animated.View>
      )}
    </Portal>
  );
}

// ─── Menu Modal ───────────────────────────────────────────────────────────────
function RoutineMenuModal({
  visible,
  routineName,
  onClose,
  onEdit,
  onDelete,
}: {
  visible: boolean;
  routineName: string;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // <Portal> has no onRequestClose (unlike RN <Modal>), so wire the Android
  // hardware back button to dismiss the menu while it's open.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  return (
    <>
      {/* Rendered via the root <Portal>, not RN <Modal> — on Android
          edge-to-edge a <Modal> is a separate Dialog window inset by the
          system nav bar, so a bottom sheet floats above it with a gap. */}
      <Portal>
        {visible && (
        <Pressable style={[styles.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
          <Animated.View
            entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[styles.menuSheet, {
              backgroundColor: C.elevated,
              // Flush with the screen bottom now, so pad past the gesture bar.
              paddingBottom: insets.bottom + Spacing.md,
            }]}
          >
            <Pressable>
              <View style={[styles.handle, { backgroundColor: C.handle }]} />
              <Text style={[styles.menuTitle, { color: C.foreground }]} numberOfLines={1}>
                {routineName}
              </Text>
              <TouchableOpacity
                onPress={() => { onClose(); onEdit(); }}
                style={[styles.menuItem, { borderColor: C.border }]}
              >
                <Feather name="edit-2" size={16} color={C.mutedFg} />
                <Text style={[styles.menuItemText, { color: C.foreground }]}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setShowDeleteConfirm(true)}
                style={[styles.menuItem, { borderColor: C.border }]}
              >
                <Feather name="trash-2" size={16} color={C.dangerText} />
                <Text style={[styles.menuItemText, { color: C.dangerText }]}>Delete</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onClose}
                style={[styles.menuCancel, { backgroundColor: C.muted }]}
              >
                <Text style={[styles.menuCancelText, { color: C.mutedFg }]}>Cancel</Text>
              </TouchableOpacity>
            </Pressable>
          </Animated.View>
        </Pressable>
        )}
      </Portal>

      <ThemedAlert
        visible={showDeleteConfirm}
        icon="trash-2"
        iconColor="#ef4444"
        title="Delete Routine"
        message={`Are you sure you want to delete "${routineName}"? This cannot be undone.`}
        buttons={[
          { text: 'Cancel', onPress: () => { setShowDeleteConfirm(false); onClose(); } },
          { text: 'Delete', style: 'destructive', onPress: () => { setShowDeleteConfirm(false); onClose(); onDelete(); } },
        ]}
        onClose={() => { setShowDeleteConfirm(false); onClose(); }}
      />
    </>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────
function EmptyState({ onAdd, onAI }: { onAdd: () => void; onAI: () => void }) {
  const { C } = useTheme();
  return (
    <View style={styles.emptyWrap}>
      <View style={[styles.emptyIcon, { backgroundColor: C.card }]}>
        <Feather name="plus" size={24} color={C.textDim} />
      </View>
      <Text style={[styles.emptyTitle, { color: C.textMuted }]}>No routines yet</Text>
      <Text style={[styles.emptySub, { color: C.textDim }]}>
        Tell Coach Drona your goal and he'll build your first one. Or make one yourself.
      </Text>
      <View style={styles.emptyBtnRow}>
        <TouchableOpacity
          onPress={onAdd}
          style={[styles.emptyBtnOutline, { borderColor: C.border, backgroundColor: C.muted }]}
        >
          <Text style={[styles.emptyBtnOutlineText, { color: C.foreground }]}>Create Routine</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onAI}
          style={[styles.emptyBtnAI, { borderColor: C.primaryBorder, backgroundColor: C.primaryMuted }]}
        >
          <Feather name="zap" size={13} color={C.accentText} />
          <Text style={[styles.emptyBtnAIText, { color: C.accentText }]}>Build with Drona</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseReps(reps: string): [number, number] {
  const parts = reps.split('-').map(Number);
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return [parts[0], parts[1]];
  }
  const n = Number(reps) || 10;
  return [n, n];
}

async function findOrCreateExercise(ex: EditorExercise): Promise<string> {
  const name = ex.name.trim();
  // Find by name first. Avoid .single() — it errors when 0 or >1 rows match;
  // the oldest row is the canonical one (it's the row migration 0037 kept
  // when deduping). Global library rows sort before customs, so a library
  // match wins over creating a same-named private copy.
  const findByName = async () => {
    const { data } = await supabase
      .from('exercises')
      .select('id')
      .ilike('name', name)
      .order('created_at', { ascending: true })
      .limit(1);
    return data && data.length > 0 ? data[0].id : null;
  };

  const existingId = await findByName();
  if (existingId) return existingId;

  // Create new exercise. created_by is filled by the column default (the
  // caller's JWT sub), so the row is private to this user.
  const { data: created, error } = await supabase
    .from('exercises')
    .insert({
      name,
      muscle_group: ex.muscleGroup || 'Other',
      category: ex.category || 'Other',
    })
    .select('id')
    .single();

  if (!error) return created.id;

  // 23505 unique violation: another session created this exercise between our
  // find and insert (unique index from migration 0037). The row we lost to is
  // exactly the one we wanted — re-select it.
  if (error.code === '23505') {
    const winnerId = await findByName();
    if (winnerId) return winnerId;
  }
  throw error;
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function RoutinesScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const { user, isLoaded: clerkLoaded } = useClerkUser();
  const isGuestSession = useIsGuestSession();
  const supabase = useSupabaseClient();
  const { pendingCount } = useSync();
  const toast = useToast();
  const [routines, setRoutines] = useState<RoutineRaw[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingRoutine, setEditingRoutine] = useState<{ id?: string; name: string; description: string } | null>(null);
  const [menuRoutine, setMenuRoutine] = useState<RoutineRaw | null>(null);
  const [detailRoutine, setDetailRoutine] = useState<RoutineRaw | null>(null);
  const [aiCoachOpen, setAiCoachOpen] = useState(false);

  const fetchRoutines = useCallback(async () => {
    const clerkId = user?.id;
    if (isGuestSession || !clerkId) {
      setRoutines(getGuestRoutines() as unknown as RoutineRaw[]);
      return;
    }
    // Cache-first so routines are available to start a workout with no signal.
    await hydrateCache(clerkId);
    const cached = readCache<RoutineRaw[]>('routines', clerkId);
    // Merge not-yet-synced routine writes on top so an optimistic create/edit
    // shows immediately and survives offline.
    if (cached) setRoutines(mergePendingRoutines(cached, clerkId) as RoutineRaw[]);
    // Clear the spinner after the cache read; the network revalidation below
    // runs in the background and must not hold the spinner (offline it hangs).
    setLoading(false);
    try {
      const { data, error } = await supabase
        .from('routines')
        .select('*, routine_exercises(*, exercises(*))')
        .eq('user_id', clerkId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = (data as RoutineRaw[]) || [];
      // Re-merge pending writes onto the fresh server list and cache the merged
      // result so the workout screen can start a still-pending routine offline.
      const merged = mergePendingRoutines(rows, clerkId) as RoutineRaw[];
      writeCache('routines', clerkId, merged);
      setRoutines(merged);
    } catch {
      // Offline — keep the cached routines instead of blanking the list.
    }
  }, [user?.id, isGuestSession]);

  useEffect(() => {
    // Mid-hydration Clerk has no user yet, so isGuestSession reads true and a
    // signed-in user would flash the (likely empty) guest list on cold launch.
    // Hold the spinner until Clerk settles; the effect re-runs when it does.
    if (!clerkLoaded) return;
    fetchRoutines().finally(() => setLoading(false));
  }, [fetchRoutines, clerkLoaded, pendingCount]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchRoutines();
    setRefreshing(false);
  }, [fetchRoutines]);

  const handleDelete = async (id: string) => {
    const target = routines.find((r) => r.id === id);
    if (!target) return;

    // Optimistic: remove from list immediately. Snapshot the previous list so
    // we can restore exact order on error rather than re-sorting.
    const previous = routines;
    setRoutines((prev) => prev.filter((r) => r.id !== id));

    if (isGuestSession) {
      // Persist the delete in the guest store so it stays gone after the next
      // fetchRoutines() (which reads from getGuestRoutines).
      removeGuestRoutine(id);
      toast.success(`Deleted “${target.name}”`);
      return;
    }

    try {
      let q = supabase.from('routines').delete().eq('id', id);
      if (user?.id) q = q.eq('user_id', user.id);
      const { error } = await q;
      if (error) throw error;
      toast.success(`Deleted “${target.name}”`);
    } catch {
      setRoutines(previous);
      toast.error(`Couldn't delete “${target.name}”`, {
        action: { label: 'Retry', onPress: () => handleDelete(id) },
      });
    }
  };

  const openCreate = () => {
    setEditingRoutine({ name: '', description: '' });
    setSheetOpen(true);
  };

  const openEdit = (routine: RoutineRaw) => {
    setEditingRoutine({
      id: routine.id,
      name: routine.name,
      description: routine.description || '',
    });
    setSheetOpen(true);
  };

  const closeSheet = () => {
    setSheetOpen(false);
    setEditingRoutine(null);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={[styles.screenTitle, { color: C.foreground }]}>Routines</Text>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            // typed-routes hasn't regenerated for /exercises yet — cast is
            // fine, route exists at runtime (same as /admin/research).
            onPress={() => router.push('/exercises' as any)}
            style={[styles.libBtn, { backgroundColor: C.muted, borderColor: C.border }]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="book-open" size={14} color={C.foreground} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setAiCoachOpen(true)}
            style={[styles.aiBtn, { borderColor: C.primaryBorder, backgroundColor: C.primarySubtle }]}
          >
            <Feather name="zap" size={13} color={C.accentText} />
            <Text style={[styles.aiBtnText, { color: C.accentText }]}>AI</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={openCreate}
            style={[styles.newBtn, { backgroundColor: C.muted, borderColor: C.border }]}
          >
            <Feather name="plus" size={14} color={C.foreground} />
            <Text style={[styles.newBtnText, { color: C.foreground }]}>New</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* List */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.listContent,
          routines.length === 0 && !loading && styles.listContentEmpty,
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
          />
        }
      >
        {loading ? (
          <ActivityIndicator color={Colors.primary} style={styles.loader} />
        ) : routines.length === 0 ? (
          <EmptyState onAdd={openCreate} onAI={() => setAiCoachOpen(true)} />
        ) : (
          routines.map((routine, idx) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              colorIndex={idx}
              onPress={() => setDetailRoutine(routine)}
              onPlay={() => router.push(`/workout/${routine.id}` as any)}
              onMenu={() => setMenuRoutine(routine)}
            />
          ))
        )}
      </ScrollView>

      {/* Modals */}
      <RoutineDetailSheet
        routine={detailRoutine}
        onClose={() => setDetailRoutine(null)}
        onStartWorkout={() => {
          if (detailRoutine) {
            setDetailRoutine(null);
            router.push(`/workout/${detailRoutine.id}` as any);
          }
        }}
        onEdit={() => {
          if (detailRoutine) {
            const target = detailRoutine;
            setDetailRoutine(null);
            openEdit(target);
          }
        }}
      />
      <RoutineEditorSheet
        visible={sheetOpen}
        editingRoutine={editingRoutine}
        onClose={closeSheet}
        onSaved={fetchRoutines}
      />
      <RoutineMenuModal
        visible={menuRoutine !== null}
        routineName={menuRoutine?.name ?? ''}
        onClose={() => setMenuRoutine(null)}
        onEdit={() => {
          if (menuRoutine) openEdit(menuRoutine);
        }}
        onDelete={() => {
          if (menuRoutine) handleDelete(menuRoutine.id);
          setMenuRoutine(null);
        }}
      />
      <AICoachModal
        visible={aiCoachOpen}
        onClose={() => setAiCoachOpen(false)}
        onRoutineCreated={() => fetchRoutines()}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  headerLeft: { flex: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  screenTitle: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.black,
    letterSpacing: -0.5,
  },
  aiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.md,
    paddingVertical: 7,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  aiBtnText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.md,
    paddingVertical: 7,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  newBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  libBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },

  // List
  listContent: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.sm,
    paddingBottom: 100,
    gap: 10,
  },
  listContentEmpty: {
    flex: 1,
    justifyContent: 'center',
  },
  loader: { marginTop: 60 },

  // Routine Card
  routineCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  dotWrap: {
    width: 42,
    height: 42,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 2,
  },
  dot: { width: 14, height: 14, borderRadius: 7 },
  routineContent: { flex: 1, gap: 3 },
  routineName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    letterSpacing: -0.2,
  },
  routineMuscles: { fontSize: FontSize.sm },
  exerciseCount: { fontSize: FontSize.xs, marginTop: 1 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
    maxWidth: 120,
  },
  tagText: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },

  // Actions
  routineActions: {
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingTop: 2,
  },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Empty State
  emptyWrap: {
    alignItems: 'center',
    paddingHorizontal: Spacing.xxl,
    paddingVertical: 64,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: Radius.xxl,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
    marginBottom: 4,
    textAlign: 'center',
  },
  emptySub: {
    fontSize: FontSize.sm,
    textAlign: 'center',
    marginBottom: 16,
  },
  emptyBtnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  emptyBtnOutline: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  emptyBtnOutlineText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  emptyBtnAI: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  emptyBtnAIText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },

  // Modals
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  menuSheet: {
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    paddingBottom: Spacing.xxl,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 4,
    flexShrink: 0,
  },

  // Menu
  menuTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.md,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderTopWidth: 1,
    marginHorizontal: Spacing.xl,
  },
  menuItemText: { fontSize: FontSize.base, fontWeight: FontWeight.medium },
  menuCancel: {
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.md,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    alignItems: 'center',
  },
  menuCancelText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },

  // ─── Routine Editor Sheet ──────────────────────────────────────────
  editorSafe: { flex: 1 },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
  },
  sheetCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  sheetSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    borderRadius: Radius.xl,
    backgroundColor: Colors.primary,
  },
  sheetSaveBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.primaryFg,
  },
  // Pinned Name/Description/label above the reorderable list.
  pinnedFields: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.sm,
    gap: 16,
  },
  // Content padding for the reorderable exercise list.
  editorListContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 40,
  },
  // Spacing between exercise cards (the list renders items flush).
  cardWrap: { marginBottom: 8 },
  linkRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 4, paddingVertical: 3, paddingHorizontal: 10, borderRadius: Radius.full, marginBottom: 4 },
  linkRowText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  sheetInput: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    borderWidth: 1,
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },

  // Exercises section
  exercisesHeader: {
    marginBottom: Spacing.md,
  },
  exercisesLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },

  // Exercise Editor Card
  editorCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },
  // Lime left strip marking a superset member. Absolute overlay (the card's
  // overflow:hidden clips it to the rounded corner) so the card's own border
  // config never changes — see the render-site comment.
  groupAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: Colors.primary,
  },
  editorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: Spacing.lg,
    paddingLeft: Spacing.sm,
  },
  // Long-press drag grip — spans the row height so it's an easy target.
  dragHandle: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Keeps the header left-aligned with multi-item cards when the grip is hidden
  // (a single-exercise routine has nothing to reorder).
  dragHandleSpacer: { width: Spacing.sm },
  editorHeaderMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    minWidth: 0,
  },
  editorExName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  editorExSub: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  editorRemoveBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editorBody: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    gap: 12,
  },
  editorLabel: {
    fontSize: FontSize.xs,
    marginBottom: 6,
  },
  // Read-only sticky-note line under the routine-slot note field.
  editorStickyNoteRow: {
    flexDirection: 'row',
    gap: 6,
  },
  editorStickyNoteIcon: {
    marginTop: 2,
  },
  editorStickyNoteLabel: {
    fontSize: FontSize.xs,
    marginBottom: 2,
  },
  editorStickyNoteText: {
    fontSize: FontSize.xs,
    lineHeight: 16,
  },
  editorInput: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  editorInputText: {
    fontSize: FontSize.base,
  },
  editorRow3: {
    flexDirection: 'row',
    gap: 8,
  },
  editorNumInput: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.xl,
    borderWidth: 1,
    fontSize: FontSize.base,
  },
  editorRangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  editorRangeInput: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 4,
    paddingVertical: 10,
    borderRadius: Radius.xl,
    borderWidth: 1,
    fontSize: FontSize.base,
  },
  editorRangeSep: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },

  // Add Exercise Button
  addExerciseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderStyle: 'dashed',
    marginTop: 12,
  },
  addExerciseBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
  },
});
