import { useState, useEffect, useCallback, useRef } from 'react';
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
  Keyboard,
  Platform,
  FlatList,
  BackHandler,
  useWindowDimensions,
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
} from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useClerkUser } from '@/hooks/useClerkUser';
import { isSupabaseConfigured, supabase, useSupabaseClient } from '@/lib/supabase';
import { mockRoutines, getAllRoutines, addGuestRoutine, updateGuestRoutine, removeGuestRoutine } from '@/lib/mockData';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import { useToast } from '@/components/ui/Toast';
import { AICoachModal } from '@/components/ai/AICoachModal';
import { Portal } from '@/components/ui/Portal';
import { EXERCISE_LIBRARY, MUSCLE_GROUPS, searchExercises } from '@/lib/exercises';
import type { ExerciseDef } from '@/lib/exercises';

const ROUTINE_COLORS = Colors.routineColors;
const CUSTOM_MUSCLE_GROUPS = [...MUSCLE_GROUPS, 'Cardio', 'Other'] as const;

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
  id: string;
  name: string;
  muscleGroup: string;
  targetSets: number;
  targetReps: string;
  restSeconds: number;
  notes: string;
}

function newExercise(): EditorExercise {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: '',
    muscleGroup: '',
    targetSets: 3,
    targetReps: '8-12',
    restSeconds: 90,
    notes: '',
  };
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
          </Text>
          {exerciseNames.length > 0 && <ExerciseTags exercises={exerciseNames} />}
        </View>
        <View style={styles.routineActions}>
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); onPlay(); }}
            style={[styles.playBtn, Shadow.playBtn]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="play" size={14} color={Colors.primaryFg} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); onMenu(); }}
            style={styles.menuBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="more-vertical" size={16} color={C.textMuted} />
          </TouchableOpacity>
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
}

// ─── Routine Detail Sheet ────────────────────────────────────────────────────
function RoutineDetailSheet({
  routine,
  onClose,
  onStartWorkout,
  onEdit,
}: {
  routine: RoutineRaw | null;
  onClose: () => void;
  onStartWorkout: () => void;
  onEdit: () => void;
}) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();

  // <Portal> has no onRequestClose (unlike RN <Modal>), so wire the Android
  // hardware back button to dismiss the sheet while it's open.
  useEffect(() => {
    if (!routine) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [routine, onClose]);

  if (!routine) return null;

  const sortedExercises = [...routine.routine_exercises].sort((a, b) => a.order - b.order);

  return (
    // Rendered via the root <Portal>, not RN <Modal> — on Android edge-to-edge
    // a <Modal> is a separate Dialog window inset by the system nav bar, so a
    // bottom sheet floats above it with a gap (see components/ui/Portal.tsx).
    <Portal>
      <View style={styles.backdrop}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]}
          onPress={onClose}
        />
        <Animated.View
          entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[styles.detailSheet, {
            backgroundColor: C.card,
            borderColor: C.border,
            // Flush with the screen bottom now, so pad past the gesture bar.
            paddingBottom: insets.bottom + Spacing.md,
          }]}
        >
            <View style={[styles.handle, { backgroundColor: C.handle }]} />

            {/* Header */}
            <View style={styles.detailHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.detailTitle, { color: C.foreground }]} numberOfLines={1}>
                  {routine.name}
                </Text>
                {routine.description ? (
                  <Text style={[styles.detailDesc, { color: C.mutedFg }]} numberOfLines={2}>
                    {routine.description}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity onPress={onClose} style={[styles.sheetCloseBtn, { backgroundColor: C.closeBtn }]}>
                <Feather name="x" size={15} color={C.foreground} />
              </TouchableOpacity>
            </View>

            {/* Exercises list */}
            <View style={styles.detailExercisesLabel}>
              <Text style={[styles.exercisesLabel, { color: C.textMuted }]}>
                EXERCISES ({sortedExercises.length})
              </Text>
            </View>

            <ScrollView
              style={{ flexShrink: 1, flexGrow: 1 }}
              contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md }}
              showsVerticalScrollIndicator
            >
              {sortedExercises.map((re, i) => (
                <View
                  key={`${re.exercise_id}-${i}`}
                  style={[styles.detailExRow, { borderBottomColor: C.borderSubtle }]}
                >
                  <View style={[styles.detailExDot, { backgroundColor: C.primaryMuted }]}>
                    <Text style={[styles.detailExIdx, { color: C.accentText }]}>{i + 1}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.detailExName, { color: C.foreground }]}>
                      {re.exercises?.name || 'Unknown'}
                    </Text>
                    <Text style={[styles.detailExMeta, { color: C.textMuted }]}>
                      {re.sets} sets · {re.reps_min === re.reps_max ? re.reps_min : `${re.reps_min}-${re.reps_max}`} reps · {re.rest_seconds}s rest
                    </Text>
                    {re.note ? (
                      <Text style={[styles.detailExNote, { color: C.accentText }]} numberOfLines={3}>
                        {re.note}
                      </Text>
                    ) : null}
                  </View>
                  {re.exercises?.muscle_group ? (
                    <View style={[styles.detailExBadge, { backgroundColor: C.muted }]}>
                      <Text style={[styles.detailExBadgeText, { color: C.textSecondary }]}>
                        {re.exercises.muscle_group}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ))}
            </ScrollView>

            {/* Footer Actions */}
            <View style={styles.detailFooter}>
              <TouchableOpacity
                onPress={onEdit}
                style={[styles.editRoutineBtn, { backgroundColor: C.muted, borderColor: C.border }]}
                activeOpacity={0.8}
              >
                <Feather name="edit-2" size={14} color={C.foreground} />
                <Text style={[styles.editRoutineBtnText, { color: C.foreground }]}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onStartWorkout}
                style={styles.startWorkoutBtn}
                activeOpacity={0.8}
              >
                <Feather name="play" size={16} color={Colors.primaryFg} />
                <Text style={styles.startWorkoutBtnText}>Start Workout</Text>
              </TouchableOpacity>
            </View>
        </Animated.View>
      </View>
    </Portal>
  );
}

// ─── Inline Exercise Picker ──────────────────────────────────────────────────
function InlineExercisePicker({
  onSelect,
  onClose,
  onCreateCustom,
}: {
  onSelect: (ex: ExerciseDef) => void;
  onClose: () => void;
  onCreateCustom: (prefill: string) => void;
}) {
  const { C } = useTheme();
  const [search, setSearch] = useState('');
  const filtered = searchExercises(search);

  return (
    <View style={[styles.pickerContainer, { backgroundColor: C.card, borderColor: C.border }]}>
      <View style={[styles.pickerSearchRow, { borderBottomColor: C.borderLight }]}>
        <Feather name="search" size={13} color={C.textMuted} />
        <TextInput
          autoFocus
          value={search}
          onChangeText={setSearch}
          placeholder="Search exercises..."
          placeholderTextColor={C.textMuted}
          style={[styles.pickerSearchInput, { color: C.foreground }]}
        />
        <TouchableOpacity onPress={onClose}>
          <Feather name="x" size={13} color={C.textMuted} />
        </TouchableOpacity>
      </View>
      <ScrollView style={styles.pickerList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
        {/* Create Custom — always visible at the top */}
        <TouchableOpacity
          onPress={() => {
            onCreateCustom(search);
            onClose();
          }}
          style={[styles.pickerItem, { borderBottomWidth: 1, borderBottomColor: C.borderSubtle }]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Feather name="plus" size={13} color={Colors.primary} />
            <Text style={[styles.pickerItemName, { color: C.foreground }]}>
              {search.trim() ? `Create "${search.trim()}"` : 'Create Custom Exercise'}
            </Text>
          </View>
        </TouchableOpacity>
        {filtered.map((ex) => (
          <TouchableOpacity
            key={ex.name}
            onPress={() => onSelect(ex)}
            style={styles.pickerItem}
          >
            <Text style={[styles.pickerItemName, { color: C.foreground }]}>{ex.name}</Text>
            <Text style={[styles.pickerItemMuscle, { color: C.textMuted }]}>{ex.muscle_group}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Exercise Editor Card ────────────────────────────────────────────────────
function ExerciseEditorCard({
  exercise,
  onChange,
  onRemove,
  onCreateCustom,
  index,
}: {
  exercise: EditorExercise;
  onChange: (ex: EditorExercise) => void;
  onRemove: () => void;
  onCreateCustom: (prefill: string) => void;
  index: number;
}) {
  const { C } = useTheme();
  const [expanded, setExpanded] = useState(index === 0);
  const [showPicker, setShowPicker] = useState(false);

  return (
    <View style={[styles.editorCard, { backgroundColor: C.muted, borderColor: C.borderLight }]}>
      {/* Header - always visible */}
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        style={styles.editorHeader}
        activeOpacity={0.7}
      >
        <Feather name="menu" size={14} color={C.textDim} style={{ marginRight: 8 }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.editorExName, { color: exercise.name ? C.foreground : C.textMuted }]} numberOfLines={1}>
            {exercise.name || 'Unnamed exercise'}
          </Text>
          <Text style={[styles.editorExSub, { color: C.textMuted }]}>
            {exercise.targetSets} sets · {exercise.targetReps} reps
            {exercise.muscleGroup ? ` · ${exercise.muscleGroup}` : ''}
          </Text>
        </View>
        <TouchableOpacity
          onPress={(e) => { onRemove(); }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.editorRemoveBtn}
        >
          <Feather name="x" size={13} color={C.textMuted} />
        </TouchableOpacity>
        <Feather
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={14}
          color={C.textMuted}
          style={{ marginLeft: 4 }}
        />
      </TouchableOpacity>

      {/* Expandable body */}
      {expanded && (
        <View style={[styles.editorBody, { borderTopColor: C.borderSubtle }]}>
          {/* Exercise picker */}
          <View>
            <Text style={[styles.editorLabel, { color: C.textMuted }]}>Exercise</Text>
            {showPicker ? (
              <InlineExercisePicker
                onSelect={(ex) => {
                  onChange({ ...exercise, name: ex.name, muscleGroup: ex.muscle_group });
                  setShowPicker(false);
                }}
                onClose={() => setShowPicker(false)}
                onCreateCustom={(prefill) => {
                  setShowPicker(false);
                  onCreateCustom(prefill);
                }}
              />
            ) : (
              <TouchableOpacity
                onPress={() => setShowPicker(true)}
                style={[styles.editorInput, { backgroundColor: C.card, borderColor: C.border }]}
              >
                <Text style={[styles.editorInputText, { color: exercise.name ? C.foreground : C.textMuted }]}>
                  {exercise.name || 'Select exercise...'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Sets / Reps / Rest row */}
          <View style={styles.editorRow3}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.editorLabel, { color: C.textMuted }]}>Sets</Text>
              <TextInput
                value={String(exercise.targetSets)}
                onChangeText={(v) => onChange({ ...exercise, targetSets: Math.max(1, Math.min(10, Number(v) || 0)) })}
                keyboardType="number-pad"
                style={[styles.editorNumInput, { backgroundColor: C.card, borderColor: C.border, color: C.foreground }]}
                textAlign="center"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.editorLabel, { color: C.textMuted }]}>Reps</Text>
              <TextInput
                value={exercise.targetReps}
                onChangeText={(v) => onChange({ ...exercise, targetReps: v })}
                placeholder="8-12"
                placeholderTextColor={C.textMuted}
                style={[styles.editorNumInput, { backgroundColor: C.card, borderColor: C.border, color: C.foreground }]}
                textAlign="center"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.editorLabel, { color: C.textMuted }]}>Rest (s)</Text>
              <TextInput
                value={String(exercise.restSeconds)}
                onChangeText={(v) => onChange({ ...exercise, restSeconds: Math.max(0, Number(v) || 0) })}
                keyboardType="number-pad"
                style={[styles.editorNumInput, { backgroundColor: C.card, borderColor: C.border, color: C.foreground }]}
                textAlign="center"
              />
            </View>
          </View>

          {/* Notes */}
          <View>
            <Text style={[styles.editorLabel, { color: C.textMuted }]}>Notes (optional)</Text>
            <TextInput
              value={exercise.notes}
              onChangeText={(v) => onChange({ ...exercise, notes: v })}
              placeholder="Form tip or reminder..."
              placeholderTextColor={C.textMuted}
              style={[styles.editorInput, styles.editorInputText, { backgroundColor: C.card, borderColor: C.border, color: C.foreground }]}
            />
          </View>
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
  const supabase = useSupabaseClient();
  const toast = useToast();
  // SafeAreaView reports zero insets inside a fullScreen RN Modal (separate
  // native view hierarchy the provider never measures), so the header collided
  // with the status bar / Dynamic Island. Read the device inset via the hook —
  // it returns the correct value from the root provider — and pad manually.
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [exercises, setExercises] = useState<EditorExercise[]>([newExercise()]);
  const [errorMsg, setErrorMsg] = useState('');
  // Sub-frame double-tap guard — modal closes on save, so we don't need a
  // disabled-button render state; just block reentry.
  const inFlightRef = useRef(false);

  // Custom exercise drawer state
  const [showCustomDrawer, setShowCustomDrawer] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customMuscle, setCustomMuscle] = useState('Other');
  const [customSets, setCustomSets] = useState('3');
  const [customReps, setCustomReps] = useState('8-12');
  const [customRest, setCustomRest] = useState('90');
  const [customTargetIdx, setCustomTargetIdx] = useState<number | null>(null);
  const [showMuscleDropdown, setShowMuscleDropdown] = useState(false);

  // Keyboard avoidance for the custom-exercise drawer. The name input gets
  // focused on open, so the keyboard appears immediately and would otherwise
  // cover the inputs + Add Exercise button. KeyboardAvoidingView doesn't work
  // inside a transparent Modal on iOS, so we track the keyboard height
  // ourselves and lift the sheet via marginBottom (the same pattern used by
  // analytics.tsx's BottomDrawer).
  const [customKbHeight, setCustomKbHeight] = useState(0);
  const nameInputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (!showCustomDrawer) { setCustomKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setCustomKbHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setCustomKbHeight(0));
    // Focus the name field ourselves AFTER the listeners are attached, rather
    // than via autoFocus. autoFocus raised the keyboard during mount, before
    // this effect ran, so the first keyboardWillShow fired with no listener
    // attached and the sheet never lifted: the keyboard covered the inputs
    // until you manually dismissed and refocused. Deferring the focus a tick
    // guarantees we catch the show event and lift on the first open.
    const focusTimer = setTimeout(() => nameInputRef.current?.focus(), 100);
    return () => { showSub.remove(); hideSub.remove(); clearTimeout(focusTimer); };
  }, [showCustomDrawer]);

  // The editor renders via <Portal> (the main app window) instead of a native
  // <Modal>. That's deliberate: on Android a <Modal> is a separate Dialog
  // window, and RN's Keyboard events fire only for the main activity window —
  // so the custom-exercise drawer's keyboard listener never fired inside the
  // Modal, customKbHeight stayed 0, and the IME covered the inputs. In the main
  // window the listener works and the drawer lifts. <Portal> has no
  // onRequestClose, so wire the Android hardware back button ourselves: close
  // the custom drawer first if it's open, otherwise dismiss the editor.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showCustomDrawer) { setShowCustomDrawer(false); return true; }
      handleClose();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, showCustomDrawer]);

  const openCustomDrawer = (prefill: string, targetIdx: number) => {
    setCustomName(prefill);
    setCustomMuscle('Other');
    setCustomSets('3');
    setCustomReps('8-12');
    setCustomRest('90');
    setCustomTargetIdx(targetIdx);
    setShowCustomDrawer(true);
  };

  const confirmCustomExercise = () => {
    if (!customName.trim()) {
      setErrorMsg('Exercise name is required');
      return;
    }
    const newEx: EditorExercise = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: customName.trim(),
      muscleGroup: customMuscle,
      targetSets: Math.max(1, Number(customSets) || 3),
      targetReps: customReps || '8-12',
      restSeconds: Math.max(0, Number(customRest) || 90),
      notes: '',
    };
    if (customTargetIdx !== null) {
      setExercises((prev) => prev.map((e, i) => (i === customTargetIdx ? newEx : e)));
    } else {
      setExercises((prev) => [...prev, newEx]);
    }
    setShowCustomDrawer(false);
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
    if (!isSupabaseConfigured) return;
    const { data } = await supabase
      .from('routine_exercises')
      .select('*, exercises(*)')
      .eq('routine_id', routineId)
      .order('order');
    if (data && data.length > 0) {
      setExercises(
        data.map((re: any) => ({
          id: re.exercise_id || re.id,
          name: re.exercises?.name || '',
          muscleGroup: re.exercises?.muscle_group || '',
          targetSets: re.sets || 3,
          targetReps: re.reps_min === re.reps_max
            ? String(re.reps_min)
            : `${re.reps_min}-${re.reps_max}`,
          restSeconds: re.rest_seconds || 90,
          // The DB column is `note` (singular). `re.notes` was a typo that
          // silently read undefined, so opening an AI-generated routine in
          // the editor dropped its coach cues.
          notes: re.note || re.notes || '',
        }))
      );
    } else {
      setExercises([newExercise()]);
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
    if (!isSupabaseConfigured || !clerkId) {
      const routineId = editingId || `guest-r-${Date.now()}`;
      const routineExercises = validExercises.map((ex, i) => {
        const [repsMin, repsMax] = parseReps(ex.targetReps);
        return {
          id: `gre-${Date.now()}-${i}`,
          exercise_id: ex.id,
          order: i,
          sets: ex.targetSets,
          reps_min: repsMin,
          reps_max: repsMax,
          rest_seconds: ex.restSeconds,
          exercises: {
            id: ex.id,
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
        // Try in-place update first; if the id belongs to a hardcoded mockRoutine
        // (read-only sample data, updateGuestRoutine returns false), fall back
        // to creating a new guest copy so the user's edits aren't silently lost.
        if (!updateGuestRoutine(guestRoutine)) {
          addGuestRoutine({ ...guestRoutine, id: `guest-r-${Date.now()}` });
        }
      } else {
        addGuestRoutine(guestRoutine);
      }
      return;
    }

    if (editingId) {
      const { error: updErr } = await supabase
        .from('routines')
        .update({ name: trimmedName, description: trimmedDescription })
        .eq('id', editingId);
      if (updErr) throw updErr;

      // Without this check a failed delete would silently leave stale
      // routine_exercises attached, and the subsequent inserts below would
      // result in duplicates rather than the user's intended edit.
      const { error: delErr } = await supabase
        .from('routine_exercises')
        .delete()
        .eq('routine_id', editingId);
      if (delErr) throw delErr;

      // Parallelize per-exercise: select-or-create + link insert.
      await Promise.all(validExercises.map(async (ex, i) => {
        const exerciseId = await findOrCreateExercise(ex);
        const [repsMin, repsMax] = parseReps(ex.targetReps);
        const { error: insErr } = await supabase.from('routine_exercises').insert({
          routine_id: editingId,
          exercise_id: exerciseId,
          sets: ex.targetSets,
          reps_min: repsMin,
          reps_max: repsMax,
          rest_seconds: ex.restSeconds,
          order: i,
          // Round-trip the coach cue (from PR #6) so editing an AI-generated
          // routine and re-saving doesn't silently drop it.
          note: ex.notes?.trim() ? ex.notes.trim() : null,
        });
        if (insErr) throw insErr;
      }));
    } else {
      const { data: routineData, error: routineErr } = await supabase
        .from('routines')
        .insert({ user_id: clerkId, name: trimmedName, description: trimmedDescription })
        .select()
        .single();
      if (routineErr) throw routineErr;

      await Promise.all(validExercises.map(async (ex, i) => {
        const exerciseId = await findOrCreateExercise(ex);
        const [repsMin, repsMax] = parseReps(ex.targetReps);
        const { error: insErr } = await supabase.from('routine_exercises').insert({
          routine_id: routineData.id,
          exercise_id: exerciseId,
          sets: ex.targetSets,
          reps_min: repsMin,
          reps_max: repsMax,
          rest_seconds: ex.restSeconds,
          order: i,
          note: ex.notes?.trim() ? ex.notes.trim() : null,
        });
        if (insErr) throw insErr;
      }));
    }
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
    const validExercises = exercises.filter((e) => e.name.trim());
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

            {/* Sheet Body */}
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={styles.sheetBody}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {/* Routine Name */}
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

              {/* Description */}
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

              {/* Exercises Section */}
              <View>
                <View style={styles.exercisesHeader}>
                  <Text style={[styles.exercisesLabel, { color: C.textMuted }]}>
                    EXERCISES ({exercises.length})
                  </Text>
                </View>
                <View style={{ gap: 8 }}>
                  {exercises.map((ex, i) => (
                    <ExerciseEditorCard
                      key={ex.id}
                      exercise={ex}
                      index={i}
                      onChange={(updated) =>
                        setExercises((prev) => prev.map((e, idx) => (idx === i ? updated : e)))
                      }
                      onRemove={() => setExercises((prev) => prev.filter((_, idx) => idx !== i))}
                      onCreateCustom={(prefill) => openCustomDrawer(prefill, i)}
                    />
                  ))}
                </View>

                {/* Add Exercise Button */}
                <TouchableOpacity
                  onPress={() => setExercises((prev) => [...prev, newExercise()])}
                  style={[styles.addExerciseBtn, { borderColor: C.border }]}
                >
                  <Feather name="plus" size={14} color={C.textMuted} />
                  <Text style={[styles.addExerciseBtnText, { color: C.textMuted }]}>Add Exercise</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>

          {/* Custom Exercise Drawer — an in-window overlay INSIDE the editor
              Modal, NOT a nested <Modal>. iOS can't present a second modal over
              an already-open one, so the old nested Modal stayed queued
              (invisible) until the editor was dismissed — that was the "Create
              Custom does nothing" bug. An overlay renders correctly over the
              editor. */}
          {/* Custom Exercise Drawer — its OWN <Portal> node, a sibling overlay
              in the SAME main window as the editor (which is also a Portal).
              This mirrors analytics' BottomDrawer, the keyboard-lift pattern
              that works on Android here. Nesting the drawer inside the editor's
              absolute-fill subtree defeated Android's keyboard handling, so the
              IME covered the inputs. */}
          <Portal>
          {showCustomDrawer && (
            <View style={{ flex: 1, justifyContent: 'flex-end' }}>
              <Pressable
                style={[StyleSheet.absoluteFillObject, { backgroundColor: C.overlay }]}
                onPress={() => setShowCustomDrawer(false)}
              />
          <Animated.View
            entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[
              styles.customDrawer,
              {
                backgroundColor: C.card,
                borderColor: C.border,
                // Lift above the keyboard via marginBottom, and cap the height
                // to the space that remains above it. customKbHeight comes from
                // the keyboard listener effect above.
                marginBottom: customKbHeight,
                maxHeight: (windowHeight - customKbHeight) * 0.85,
                paddingBottom: insets.bottom,
              },
            ]}
          >
            {/* Tapping the sheet chrome (handle, header, padding) dismisses the
                keyboard. Taps on the inputs and buttons are captured by those
                children, so they keep working normally. */}
            <Pressable onPress={() => Keyboard.dismiss()}>
              <View style={[styles.handle, { backgroundColor: C.handle }]} />

              {/* Drawer Header */}
              <View style={[styles.customDrawerHeader, { borderBottomColor: C.borderLight }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={[styles.customDrawerIcon, { backgroundColor: C.primaryMuted }]}>
                    <Feather name="activity" size={14} color={C.accentText} />
                  </View>
                  <Text style={[styles.customDrawerTitle, { color: C.foreground }]}>Create Custom Exercise</Text>
                </View>
                <TouchableOpacity onPress={() => setShowCustomDrawer(false)}>
                  <Feather name="x" size={16} color={C.textMuted} />
                </TouchableOpacity>
              </View>

              {/* Drawer Form */}
              <ScrollView
                contentContainerStyle={styles.customDrawerBody}
                // "handled": a tap on empty space inside the form dismisses the
                // keyboard, while taps the children handle (the inputs and the
                // "Add Exercise" button) still fire in a single tap. The sheet
                // now lifts above the keyboard on open, so the button is no
                // longer hidden behind it.
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {/* Exercise Name */}
                <View>
                  <Text style={[styles.customDrawerLabel, { color: C.textDim }]}>EXERCISE NAME</Text>
                  <TextInput
                    ref={nameInputRef}
                    value={customName}
                    onChangeText={setCustomName}
                    placeholder="e.g. Cable Lateral Raise"
                    placeholderTextColor={C.textMuted}
                    style={[styles.customDrawerInput, { backgroundColor: C.muted, color: C.foreground }]}
                  />
                </View>

                {/* Muscle Group dropdown */}
                <View style={styles.customDrawerRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.customDrawerLabel, { color: C.textDim }]}>MUSCLE GROUP</Text>
                    <TouchableOpacity
                      onPress={() => setShowMuscleDropdown(!showMuscleDropdown)}
                      style={[styles.customDrawerInput, styles.dropdownBtn, { backgroundColor: C.muted }]}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.dropdownBtnText, { color: C.mutedFg }]}>{customMuscle}</Text>
                      <Feather name={showMuscleDropdown ? 'chevron-up' : 'chevron-down'} size={14} color={C.textMuted} />
                    </TouchableOpacity>
                    {showMuscleDropdown && (
                      <View style={[styles.dropdownList, { backgroundColor: C.muted, borderColor: C.border }]}>
                        <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                          {CUSTOM_MUSCLE_GROUPS.map((mg) => (
                            <TouchableOpacity
                              key={mg}
                              onPress={() => { setCustomMuscle(mg); setShowMuscleDropdown(false); }}
                              style={[
                                styles.dropdownItem,
                                customMuscle === mg && { backgroundColor: C.primaryMuted },
                              ]}
                            >
                              <Text style={[styles.dropdownItemText, { color: customMuscle === mg ? C.accentText : C.foreground }]}>
                                {mg}
                              </Text>
                              {customMuscle === mg && (
                                <Feather name="check" size={13} color={C.accentText} />
                              )}
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                      </View>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.customDrawerLabel, { color: C.textDim }]}>TARGET SETS</Text>
                    <TextInput
                      value={customSets}
                      onChangeText={setCustomSets}
                      keyboardType="number-pad"
                      style={[styles.customDrawerInput, { backgroundColor: C.muted, color: C.mutedFg }]}
                      textAlign="center"
                    />
                  </View>
                </View>

                {/* Reps + Rest row */}
                <View style={styles.customDrawerRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.customDrawerLabel, { color: C.textDim }]}>TARGET REPS</Text>
                    <TextInput
                      value={customReps}
                      onChangeText={setCustomReps}
                      style={[styles.customDrawerInput, { backgroundColor: C.muted, color: C.mutedFg }]}
                      textAlign="center"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.customDrawerLabel, { color: C.textDim }]}>REST SECONDS</Text>
                    <TextInput
                      value={customRest}
                      onChangeText={setCustomRest}
                      keyboardType="number-pad"
                      style={[styles.customDrawerInput, { backgroundColor: C.muted, color: C.mutedFg }]}
                      textAlign="center"
                    />
                  </View>
                </View>

                {/* Confirm Button */}
                <TouchableOpacity
                  onPress={confirmCustomExercise}
                  disabled={!customName.trim()}
                  style={[styles.customDrawerConfirmBtn, !customName.trim() && { opacity: 0.5 }]}
                  activeOpacity={0.8}
                >
                  <Feather name="check" size={15} color={Colors.primaryFg} />
                  <Text style={styles.customDrawerConfirmText}>Add Exercise</Text>
                </TouchableOpacity>
              </ScrollView>
            </Pressable>
          </Animated.View>
            </View>
          )}
          </Portal>
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
                <Feather name="trash-2" size={16} color={Colors.danger} />
                <Text style={[styles.menuItemText, { color: Colors.danger }]}>Delete</Text>
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
        Create one manually or generate with AI
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
          <Text style={[styles.emptyBtnAIText, { color: C.accentText }]}>AI Generate</Text>
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
  // First try to find existing exercise by name. Avoid .single() — it errors when 0 or >1
  // rows match. The `exercises` table has no UNIQUE(name) constraint, so a stray duplicate
  // would force this branch to throw and we'd fall through to insert another copy.
  const { data: existing } = await supabase
    .from('exercises')
    .select('id')
    .ilike('name', ex.name.trim())
    .order('created_at', { ascending: true })
    .limit(1);

  if (existing && existing.length > 0) return existing[0].id;

  // Create new exercise
  const { data: created, error } = await supabase
    .from('exercises')
    .insert({
      name: ex.name.trim(),
      muscle_group: ex.muscleGroup || 'Other',
      category: 'Other',
    })
    .select('id')
    .single();

  if (error) throw error;
  return created.id;
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function RoutinesScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const { user } = useClerkUser();
  const supabase = useSupabaseClient();
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
    if (!isSupabaseConfigured || !clerkId) {
      setRoutines(getAllRoutines() as unknown as RoutineRaw[]);
      return;
    }
    const { data } = await supabase
      .from('routines')
      .select('*, routine_exercises(*, exercises(*))')
      .eq('user_id', clerkId)
      .order('created_at', { ascending: false });
    setRoutines((data as RoutineRaw[]) || []);
  }, [user?.id]);

  useEffect(() => {
    fetchRoutines().finally(() => setLoading(false));
  }, [fetchRoutines]);

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

    if (!isSupabaseConfigured) {
      // Persist the delete in the guest store so it stays gone after the next
      // fetchRoutines() (which reads from getAllRoutines). Hardcoded
      // mockRoutines return false here and aren't removable — that's by design.
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
    backgroundColor: Colors.primary,
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
  sheetBody: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.xl,
    paddingBottom: 40,
    gap: 16,
  },
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
  editorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
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

  // Inline Exercise Picker
  pickerContainer: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },
  pickerSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  pickerSearchInput: {
    flex: 1,
    fontSize: FontSize.base,
    padding: 0,
  },
  pickerList: {
    maxHeight: 192,
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
  },
  pickerItemName: { fontSize: FontSize.base },
  pickerItemMuscle: { fontSize: FontSize.xs },

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

  // Custom Exercise Drawer
  customDrawer: {
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    borderTopWidth: 1,
    maxHeight: '80%',
  },
  customDrawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  customDrawerIcon: {
    width: 32,
    height: 32,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  customDrawerTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },
  customDrawerBody: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: 48,
    gap: 16,
  },
  customDrawerLabel: {
    fontSize: 10,
    fontWeight: FontWeight.semibold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  customDrawerInput: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderRadius: Radius.xl,
    fontSize: FontSize.base,
  },
  customDrawerRow: {
    flexDirection: 'row',
    gap: 12,
  },
  dropdownBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownBtnText: {
    fontSize: FontSize.base,
  },
  dropdownList: {
    marginTop: 4,
    borderRadius: Radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
  },
  dropdownItemText: {
    fontSize: FontSize.base,
  },
  customDrawerConfirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    backgroundColor: Colors.primary,
    marginTop: 8,
  },
  customDrawerConfirmText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.black,
    color: Colors.primaryFg,
  },

  // Routine Detail Sheet
  detailSheet: {
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    borderTopWidth: 1,
    paddingBottom: Spacing.xxl,
    height: '80%',
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
    gap: 12,
    flexShrink: 0,
  },
  detailTitle: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    letterSpacing: -0.3,
  },
  detailDesc: {
    fontSize: FontSize.sm,
    marginTop: 4,
    lineHeight: 18,
  },
  detailExercisesLabel: {
    paddingHorizontal: Spacing.xl,
    marginBottom: Spacing.sm,
    flexShrink: 0,
  },
  detailExRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  detailExDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailExIdx: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
  },
  detailExName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  detailExMeta: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  detailExNote: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
    marginTop: 4,
    lineHeight: 14,
  },
  detailExBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  detailExBadgeText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
  },
  detailFooter: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    flexShrink: 0,
  },
  editRoutineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    borderWidth: 1,
    flexShrink: 0,
  },
  editRoutineBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  startWorkoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    backgroundColor: Colors.primary,
    flex: 1,
  },
  startWorkoutBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.black,
    color: Colors.primaryFg,
  },
});
