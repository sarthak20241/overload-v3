/**
 * Exercise Library — browse and manage every exercise the user can train with.
 *
 * Library rows (created_by null in the DB, mirrored by lib/exercises.ts) are
 * read-only. The user's custom rows can be renamed, re-tagged, or deleted.
 * For guests, customs live in the local guest store (lib/guestStore.ts)
 * instead of Supabase. Hidden tab route (like admin/research) — reached from
 * the Routines header book icon and Profile > My Exercises.
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  BackHandler,
  Pressable,
  Keyboard,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { useIsGuestSession } from '@/lib/guestMode';
import { getGuestExercises, updateGuestExercise, removeGuestExercise } from '@/lib/guestStore';
import { invalidateCustomExercisesCache } from '@/components/routines/ExercisePickerSheet';
import { EXERCISE_LIBRARY, MUSCLE_GROUPS, CATEGORIES } from '@/lib/exercises';
import { Portal } from '@/components/ui/Portal';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import { useToast } from '@/components/ui/Toast';

// Same extended tag set the picker's custom form offers.
const CUSTOM_MUSCLE_GROUPS = [...MUSCLE_GROUPS, 'Cardio', 'Other'] as const;

interface DbExercise {
  id: string;
  name: string;
  muscle_group: string;
  category: string;
  created_by: string | null;
}

export default function ExerciseLibraryScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const supabase = useSupabaseClient();
  const isGuest = useIsGuestSession();
  const toast = useToast();

  const [rows, setRows] = useState<DbExercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [muscleFilter, setMuscleFilter] = useState<string | null>(null);

  // Edit sheet state (only ever opens for the user's own rows)
  const [editTarget, setEditTarget] = useState<DbExercise | null>(null);
  const [editName, setEditName] = useState('');
  const [editMuscle, setEditMuscle] = useState('Other');
  const [editCategory, setEditCategory] = useState('Other');
  const [saving, setSaving] = useState(false);

  // Delete confirmation (with usage counts so the warning is concrete)
  const [deleteTarget, setDeleteTarget] = useState<DbExercise | null>(null);
  const [deleteUsage, setDeleteUsage] = useState<{ routines: number; sets: number } | null>(null);

  // Keyboard lift for the edit sheet — same pattern as ExercisePickerSheet.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    if (!editTarget) { setKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, [editTarget]);

  const fetchExercises = useCallback(async () => {
    if (isGuest) {
      // Guest mode: customs come from the local guest store, then the static
      // library. created_by 'guest' marks them editable — library rows stay null.
      const guestCustoms: DbExercise[] = [...getGuestExercises()]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(e => ({
          id: e.id,
          name: e.name,
          muscle_group: e.muscle_group,
          category: e.category,
          created_by: 'guest',
        }));
      setRows([
        ...guestCustoms,
        ...EXERCISE_LIBRARY.map((e, i) => ({
          id: `lib-${i}`,
          name: e.name,
          muscle_group: e.muscle_group,
          category: e.category,
          created_by: null,
        })),
      ]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('exercises')
      .select('id, name, muscle_group, category, created_by')
      .order('created_at', { ascending: false });
    if (!error && data) setRows(data as DbExercise[]);
    setLoading(false);
  }, [supabase, isGuest]);

  useEffect(() => { fetchExercises(); }, [fetchExercises]);

  // RLS already scopes the query to global + own rows; split them here.
  // Customs keep newest-first (fetch order); library reads better A→Z.
  const customs = useMemo(() => rows.filter(r => r.created_by !== null), [rows]);
  const library = useMemo(
    () => rows.filter(r => r.created_by === null).sort((a, b) => a.name.localeCompare(b.name)),
    [rows]
  );

  const matches = useCallback((e: DbExercise) => {
    if (muscleFilter && e.muscle_group !== muscleFilter) return false;
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return (
      e.name.toLowerCase().includes(q) ||
      e.muscle_group.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q)
    );
  }, [search, muscleFilter]);

  const filteredCustoms = useMemo(() => customs.filter(matches), [customs, matches]);
  const filteredLibrary = useMemo(() => library.filter(matches), [library, matches]);

  const muscleOptions = useMemo(() => {
    const extras = [...new Set(customs.map(e => e.muscle_group))]
      .filter(mg => !(MUSCLE_GROUPS as readonly string[]).includes(mg));
    return [...MUSCLE_GROUPS, ...extras];
  }, [customs]);

  const openEdit = (ex: DbExercise) => {
    setEditTarget(ex);
    setEditName(ex.name);
    setEditMuscle(ex.muscle_group);
    setEditCategory(ex.category);
  };

  const closeEdit = () => {
    setEditTarget(null);
    Keyboard.dismiss();
  };

  // <Portal> has no onRequestClose, so wire the Android hardware back button
  // to dismiss the edit sheet — same pattern as ExercisePickerSheet. The
  // delete ThemedAlert registers its own handler while open, which runs first.
  useEffect(() => {
    if (!editTarget) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeEdit();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTarget]);

  const handleSave = async () => {
    if (!editTarget || saving) return;
    const trimmed = editName.trim();
    if (!trimmed) return;
    const clash = rows.some(
      r => r.id !== editTarget.id && r.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (clash) {
      toast.error('You already have an exercise with that name');
      return;
    }
    setSaving(true);
    if (isGuest) {
      // Guest customs live on-device — patch the guest store directly.
      const ok = updateGuestExercise(editTarget.id, {
        name: trimmed,
        muscle_group: editMuscle,
        category: editCategory,
      });
      setSaving(false);
      if (!ok) {
        toast.error("Couldn't save those changes, try again");
        return;
      }
    } else {
      const { error } = await supabase
        .from('exercises')
        .update({ name: trimmed, muscle_group: editMuscle, category: editCategory })
        .eq('id', editTarget.id);
      setSaving(false);
      if (error) {
        toast.error("Couldn't save those changes, try again");
        return;
      }
    }
    setRows(prev => prev.map(r =>
      r.id === editTarget.id
        ? { ...r, name: trimmed, muscle_group: editMuscle, category: editCategory }
        : r
    ));
    // The picker caches the signed-in customs list for a short TTL — drop it
    // so the renamed exercise can't show under its old name there.
    invalidateCustomExercisesCache();
    toast.success(`Updated “${trimmed}”`);
    closeEdit();
  };

  // Look up how much history rides on this exercise before asking to confirm —
  // workout_sets.exercise_id cascades on delete, so the warning must be honest.
  const askDelete = async (ex: DbExercise) => {
    setDeleteUsage(null);
    setDeleteTarget(ex);
    if (isGuest) {
      // Guest routines and workouts embed exercises by value, so deleting the
      // catalog entry doesn't cascade into anything — no usage to count.
      setDeleteUsage({ routines: 0, sets: 0 });
      return;
    }
    const [re, ws] = await Promise.all([
      supabase.from('routine_exercises').select('id', { count: 'exact', head: true }).eq('exercise_id', ex.id),
      supabase.from('workout_sets').select('id', { count: 'exact', head: true }).eq('exercise_id', ex.id),
    ]);
    setDeleteUsage({ routines: re.count ?? 0, sets: ws.count ?? 0 });
  };

  const handleDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    closeEdit();
    if (isGuest) {
      if (!removeGuestExercise(target.id)) {
        toast.error(`Couldn't delete “${target.name}”, try again`);
        return;
      }
    } else {
      const { error } = await supabase.from('exercises').delete().eq('id', target.id);
      if (error) {
        toast.error(`Couldn't delete “${target.name}”, try again`);
        return;
      }
    }
    setRows(prev => prev.filter(r => r.id !== target.id));
    // Mirror the optimistic-add path: the picker's cached customs list must
    // not keep serving the deleted exercise for the rest of its TTL.
    invalidateCustomExercisesCache();
    toast.success(`Deleted “${target.name}”`);
  };

  const renderRow = (ex: DbExercise, isCustom: boolean) => (
    <TouchableOpacity
      key={ex.id}
      onPress={isCustom ? () => openEdit(ex) : undefined}
      activeOpacity={isCustom ? 0.7 : 1}
      style={[styles.row, { borderColor: C.borderSubtle }]}
    >
      <View style={{ flex: 1 }}>
        <View style={styles.rowNameLine}>
          <Text style={[styles.rowName, { color: C.foreground }]}>{ex.name}</Text>
          {isCustom && (
            <View style={[styles.customTag, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}>
              <Text style={[styles.customTagText, { color: C.accentText }]}>Custom</Text>
            </View>
          )}
        </View>
        <Text style={[styles.rowMeta, { color: C.textMuted }]}>
          {ex.muscle_group} · {ex.category}
        </Text>
      </View>
      {isCustom && <Feather name="edit-2" size={14} color={C.textMuted} />}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: C.muted, borderColor: C.border }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="chevron-left" size={18} color={C.foreground} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: C.foreground }]}>Exercise Library</Text>
          <Text style={[styles.subtitle, { color: C.mutedFg }]}>
            {customs.length > 0
              ? `${customs.length} of your own, ${library.length} built in`
              : `${library.length} exercises ready to go`}
          </Text>
        </View>
      </View>

      {/* Search */}
      <View style={{ paddingHorizontal: Spacing.xl, marginBottom: 10 }}>
        <View style={[styles.searchBox, { backgroundColor: C.inputBg, borderColor: C.border }]}>
          <Feather name="search" size={14} color={C.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search exercises..."
            placeholderTextColor={C.textMuted}
            style={[styles.searchInput, { color: C.foreground }]}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <Feather name="x" size={14} color={C.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Muscle filter pills */}
      <View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: Spacing.xl, gap: 6, paddingBottom: 8 }}
        >
          <TouchableOpacity
            onPress={() => setMuscleFilter(null)}
            style={[
              styles.filterPill,
              { borderColor: C.border },
              !muscleFilter && { backgroundColor: Colors.primary, borderColor: Colors.primary },
            ]}
          >
            <Text style={[styles.filterPillText, { color: !muscleFilter ? Colors.primaryFg : C.mutedFg }]}>
              All
            </Text>
          </TouchableOpacity>
          {muscleOptions.map(mg => (
            <TouchableOpacity
              key={mg}
              onPress={() => setMuscleFilter(muscleFilter === mg ? null : mg)}
              style={[
                styles.filterPill,
                { borderColor: C.border },
                muscleFilter === mg && { backgroundColor: Colors.primary, borderColor: Colors.primary },
              ]}
            >
              <Text style={[styles.filterPillText, { color: muscleFilter === mg ? Colors.primaryFg : C.mutedFg }]}>
                {mg}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* List */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <ActivityIndicator color={Colors.primary} style={{ marginTop: 40 }} />
        ) : (
          <>
            {filteredCustoms.length > 0 && (
              <>
                <Text style={[styles.sectionLabel, { color: C.textDim }]}>
                  YOUR EXERCISES ({filteredCustoms.length})
                </Text>
                {filteredCustoms.map(ex => renderRow(ex, true))}
              </>
            )}
            {customs.length === 0 && !search && !muscleFilter && (
              <View style={[styles.emptyCustomCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
                <Feather name="edit-3" size={16} color={C.textMuted} />
                <Text style={[styles.emptyCustomText, { color: C.textMuted }]}>
                  Exercises you create show up here. Make one from the picker when building a routine or mid-workout.
                </Text>
              </View>
            )}
            {filteredLibrary.length > 0 && (
              <>
                <Text style={[styles.sectionLabel, { color: C.textDim, marginTop: filteredCustoms.length > 0 ? Spacing.xl : 0 }]}>
                  LIBRARY ({filteredLibrary.length})
                </Text>
                {filteredLibrary.map(ex => renderRow(ex, false))}
              </>
            )}
            {filteredCustoms.length === 0 && filteredLibrary.length === 0 && (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <Text style={{ color: C.textMuted, fontSize: FontSize.sm }}>No exercises found</Text>
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* ── Edit sheet (own exercises only) ── */}
      <Portal>
        {editTarget && (
          <Pressable style={[styles.backdrop, { backgroundColor: C.overlay }]} onPress={closeEdit}>
            <Animated.View
              entering={SlideInDown.duration(300).easing(Easing.out(Easing.cubic))}
              exiting={SlideOutDown.duration(200)}
              style={[
                styles.sheet,
                {
                  backgroundColor: C.elevated,
                  marginBottom: kbHeight,
                  maxHeight: (windowHeight - kbHeight) * 0.9,
                  paddingBottom: insets.bottom + Spacing.lg,
                },
              ]}
            >
              <Pressable>
                <View style={[styles.handle, { backgroundColor: C.handle }]} />
                <View style={styles.sheetHeader}>
                  <Text style={[styles.sheetTitle, { color: C.foreground }]}>Edit Exercise</Text>
                  <TouchableOpacity onPress={closeEdit} style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}>
                    <Feather name="x" size={15} color={C.foreground} />
                  </TouchableOpacity>
                </View>

                <ScrollView
                  style={{ flexGrow: 0 }}
                  contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: Spacing.lg }}
                  keyboardShouldPersistTaps="handled"
                >
                  <Text style={[styles.formLabel, { color: C.textDim }]}>EXERCISE NAME</Text>
                  <TextInput
                    value={editName}
                    onChangeText={setEditName}
                    placeholderTextColor={C.textMuted}
                    style={[styles.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                  />

                  <Text style={[styles.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>MUSCLE GROUP</Text>
                  <View style={styles.chipRow}>
                    {CUSTOM_MUSCLE_GROUPS.map(mg => {
                      const active = editMuscle === mg;
                      return (
                        <TouchableOpacity
                          key={mg}
                          onPress={() => setEditMuscle(mg)}
                          style={[styles.chip, {
                            backgroundColor: active ? Colors.primary : C.muted,
                            borderColor: active ? Colors.primary : C.border,
                          }]}
                        >
                          <Text style={[styles.chipText, { color: active ? Colors.primaryFg : C.textMuted }]}>{mg}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={[styles.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>CATEGORY</Text>
                  <View style={styles.chipRow}>
                    {CATEGORIES.map(cat => {
                      const active = editCategory === cat;
                      return (
                        <TouchableOpacity
                          key={cat}
                          onPress={() => setEditCategory(cat)}
                          style={[styles.chip, {
                            backgroundColor: active ? Colors.primary : C.muted,
                            borderColor: active ? Colors.primary : C.border,
                          }]}
                        >
                          <Text style={[styles.chipText, { color: active ? Colors.primaryFg : C.textMuted }]}>{cat}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </ScrollView>

                <View style={{ paddingHorizontal: Spacing.xl, gap: 8 }}>
                  <TouchableOpacity
                    onPress={handleSave}
                    disabled={!editName.trim() || saving}
                    style={[styles.saveBtn, { backgroundColor: Colors.primary, opacity: editName.trim() && !saving ? 1 : 0.4 }]}
                  >
                    <Feather name="check" size={15} color={Colors.primaryFg} />
                    <Text style={styles.saveBtnText}>Save Changes</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => askDelete(editTarget)}
                    style={[styles.deleteBtn, { borderColor: 'rgba(239,68,68,0.3)', backgroundColor: 'rgba(239,68,68,0.08)' }]}
                  >
                    <Feather name="trash-2" size={14} color="#f87171" />
                    <Text style={styles.deleteBtnText}>Delete Exercise</Text>
                  </TouchableOpacity>
                </View>
              </Pressable>
            </Animated.View>
          </Pressable>
        )}
      </Portal>

      {/* ── Delete confirmation ── */}
      <ThemedAlert
        visible={deleteTarget !== null}
        icon="trash-2"
        iconColor="#f87171"
        title={`Delete “${deleteTarget?.name}”?`}
        message={
          deleteUsage
            ? isGuest
              ? 'Your routines and logged workouts keep their own copy, so nothing else changes.'
              : deleteUsage.routines === 0 && deleteUsage.sets === 0
              ? "You haven't logged anything with this exercise yet, so it goes quietly."
              : `It comes out of ${deleteUsage.routines} routine${deleteUsage.routines === 1 ? '' : 's'} and erases ${deleteUsage.sets} logged set${deleteUsage.sets === 1 ? '' : 's'}. That history is gone for good.`
            : 'Checking where this exercise is used...'
        }
        buttons={[
          { text: 'Keep It', style: 'default' },
          { text: 'Delete', style: 'destructive', onPress: handleDelete },
        ]}
        onClose={() => setDeleteTarget(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, padding: 0 },
  filterPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.full, borderWidth: 1 },
  filterPillText: { fontSize: 11, fontWeight: FontWeight.semibold },
  sectionLabel: {
    fontSize: 10,
    fontWeight: FontWeight.semibold,
    letterSpacing: 1.5,
    marginBottom: 4,
    marginTop: Spacing.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, gap: 10 },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: { fontSize: FontSize.base, fontWeight: FontWeight.medium, flexShrink: 1 },
  rowMeta: { fontSize: FontSize.sm, marginTop: 2 },
  customTag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: Radius.full, borderWidth: 1 },
  customTagText: { fontSize: 10, fontWeight: FontWeight.semibold },
  emptyCustomCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
    marginTop: Spacing.md,
    marginBottom: Spacing.md,
  },
  emptyCustomText: { flex: 1, fontSize: FontSize.sm, lineHeight: 18 },
  // Edit sheet
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  sheetTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  formLabel: { fontSize: 10, fontWeight: FontWeight.semibold, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 },
  formInput: { height: 44, paddingHorizontal: Spacing.md, borderRadius: Radius.lg, borderWidth: 1, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: Radius.full, borderWidth: 1 },
  chipText: { fontSize: 11, fontWeight: FontWeight.semibold },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: Radius.xl },
  saveBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: Radius.xl, borderWidth: 1 },
  deleteBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: '#f87171' },
});
