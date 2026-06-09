/**
 * Bottom-sheet exercise picker with search, muscle group tabs,
 * and custom exercise creation. Matches Figma design.
 */
import React, { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, BackHandler, Pressable, ScrollView, Keyboard, Platform,
  useWindowDimensions,
} from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Portal } from '@/components/ui/Portal';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { EXERCISE_LIBRARY, MUSCLE_GROUPS, CATEGORIES, searchExercises } from '@/lib/exercises';
import type { ExerciseDef } from '@/lib/exercises';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (exercise: ExerciseDef) => void;
  /** Already-added exercise names (to show check mark) */
  selectedNames?: string[];
}

export function ExercisePickerSheet({ visible, onClose, onSelect, selectedNames = [] }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [search, setSearch] = useState('');
  const [muscleFilter, setMuscleFilter] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customMuscle, setCustomMuscle] = useState('Chest');
  const [customCategory, setCustomCategory] = useState('Barbell');

  // Keyboard avoidance: the custom-exercise form autofocuses the name input,
  // and the library view has a search input — both bring the keyboard up and
  // (on iOS, inside a transparent Modal) end up covering the inputs and the
  // "Create & Add" button. KeyboardAvoidingView doesn't help here (Modal
  // doesn't resize on iOS), so we track keyboard height and lift the sheet
  // via marginBottom — same pattern as analytics.tsx's BottomDrawer.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    if (!visible) { setKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKbHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, [visible]);

  const filtered = useMemo(() => {
    let list = searchExercises(search);
    if (muscleFilter) list = list.filter(e => e.muscle_group === muscleFilter);
    return list;
  }, [search, muscleFilter]);

  const handleSelectExercise = (ex: ExerciseDef) => {
    onSelect(ex);
  };

  const handleCreateCustom = () => {
    const trimmed = customName.trim();
    if (!trimmed) return;
    onSelect({ name: trimmed, muscle_group: customMuscle, category: customCategory });
    setCustomName('');
    setShowCustom(false);
  };

  const resetAndClose = () => {
    setSearch('');
    setMuscleFilter(null);
    setShowCustom(false);
    onClose();
  };

  // <Portal> has no onRequestClose, so wire the Android hardware back button.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      resetAndClose();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  return (
    <Portal>
      {visible && (
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={resetAndClose}>
        <Animated.View
          entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[
            s.sheet,
            {
              backgroundColor: C.elevated,
              // Lift above the keyboard (both platforms — rendered in the app's
              // own window via <Portal>, which isn't auto-resized for the keyboard).
              marginBottom: kbHeight,
              // Clamp against the keyboard-reduced viewport too — the static
              // maxHeight: '90%' is relative to the full window, so without this
              // the lifted sheet can run off the top on smaller screens (same
              // guard analytics.tsx's BottomDrawer uses).
              maxHeight: (windowHeight - kbHeight) * 0.9,
              // Flush to the screen bottom now, so clear the gesture/nav bar.
              paddingBottom: insets.bottom,
            },
          ]}
        >
          <Pressable>
            <View style={[s.handle, { backgroundColor: C.handle }]} />

            {/* Header */}
            <View style={s.header}>
              <View>
                <Text style={[s.title, { color: C.foreground }]}>
                  {showCustom ? 'Custom Exercise' : 'Add Exercise'}
                </Text>
                <Text style={[s.subtitle, { color: C.mutedFg }]}>
                  {showCustom ? 'Create your own exercise' : `${EXERCISE_LIBRARY.length} exercises available`}
                </Text>
              </View>
              <TouchableOpacity onPress={resetAndClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]}>
                <Feather name="x" size={15} color={C.foreground} />
              </TouchableOpacity>
            </View>

            {showCustom ? (
              /* ── Custom Exercise Form ── */
              <View style={s.body}>
                <Text style={[s.label, { color: C.mutedFg }]}>Exercise Name</Text>
                <TextInput
                  value={customName}
                  onChangeText={setCustomName}
                  placeholder="e.g. Cable Lateral Raise"
                  placeholderTextColor={C.textMuted}
                  autoFocus
                  style={[s.input, { backgroundColor: C.inputBg, color: C.foreground, borderColor: C.border }]}
                />

                <Text style={[s.label, { color: C.mutedFg, marginTop: 16 }]}>Muscle Group</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                  <View style={s.chipRow}>
                    {MUSCLE_GROUPS.map(mg => (
                      <TouchableOpacity
                        key={mg}
                        onPress={() => setCustomMuscle(mg)}
                        style={[
                          s.chip,
                          { borderColor: C.border },
                          customMuscle === mg && { backgroundColor: Colors.primary, borderColor: Colors.primary },
                        ]}
                      >
                        <Text style={[
                          s.chipText,
                          { color: C.mutedFg },
                          customMuscle === mg && { color: Colors.primaryFg },
                        ]}>
                          {mg}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>

                <Text style={[s.label, { color: C.mutedFg }]}>Category</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
                  <View style={s.chipRow}>
                    {CATEGORIES.map(cat => (
                      <TouchableOpacity
                        key={cat}
                        onPress={() => setCustomCategory(cat)}
                        style={[
                          s.chip,
                          { borderColor: C.border },
                          customCategory === cat && { backgroundColor: Colors.primary, borderColor: Colors.primary },
                        ]}
                      >
                        <Text style={[
                          s.chipText,
                          { color: C.mutedFg },
                          customCategory === cat && { color: Colors.primaryFg },
                        ]}>
                          {cat}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>

                <View style={s.customActions}>
                  <TouchableOpacity onPress={() => setShowCustom(false)} style={[s.backBtn, { backgroundColor: C.muted }]}>
                    <Feather name="arrow-left" size={14} color={C.foreground} />
                    <Text style={[s.backBtnText, { color: C.foreground }]}>Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleCreateCustom}
                    disabled={!customName.trim()}
                    style={[s.addBtn, { backgroundColor: customName.trim() ? Colors.primary : C.muted }]}
                  >
                    <Feather name="plus" size={14} color={customName.trim() ? Colors.primaryFg : C.textMuted} />
                    <Text style={[s.addBtnText, { color: customName.trim() ? Colors.primaryFg : C.textMuted }]}>
                      Create & Add
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              /* ── Exercise Library ── */
              <>
                {/* Search */}
                <View style={[s.searchWrap, { marginHorizontal: Spacing.xl }]}>
                  <View style={[s.searchBox, { backgroundColor: C.inputBg, borderColor: C.border }]}>
                    <Feather name="search" size={14} color={C.textMuted} />
                    <TextInput
                      value={search}
                      onChangeText={setSearch}
                      placeholder="Search exercises..."
                      placeholderTextColor={C.textMuted}
                      style={[s.searchInput, { color: C.foreground }]}
                    />
                    {search.length > 0 && (
                      <TouchableOpacity onPress={() => setSearch('')}>
                        <Feather name="x" size={14} color={C.textMuted} />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                {/* Muscle group filter pills */}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: Spacing.xl, gap: 6, paddingBottom: 8 }}
                >
                  <TouchableOpacity
                    onPress={() => setMuscleFilter(null)}
                    style={[
                      s.filterPill,
                      { borderColor: C.border },
                      !muscleFilter && { backgroundColor: Colors.primary, borderColor: Colors.primary },
                    ]}
                  >
                    <Text style={[
                      s.filterPillText,
                      { color: C.mutedFg },
                      !muscleFilter && { color: Colors.primaryFg },
                    ]}>All</Text>
                  </TouchableOpacity>
                  {MUSCLE_GROUPS.map(mg => (
                    <TouchableOpacity
                      key={mg}
                      onPress={() => setMuscleFilter(muscleFilter === mg ? null : mg)}
                      style={[
                        s.filterPill,
                        { borderColor: C.border },
                        muscleFilter === mg && { backgroundColor: Colors.primary, borderColor: Colors.primary },
                      ]}
                    >
                      <Text style={[
                        s.filterPillText,
                        { color: C.mutedFg },
                        muscleFilter === mg && { color: Colors.primaryFg },
                      ]}>{mg}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                {/* Exercise list */}
                <FlatList
                  data={filtered}
                  keyExtractor={(item) => item.name}
                  style={{ maxHeight: 340 }}
                  contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 20 }}
                  renderItem={({ item }) => {
                    const isSelected = selectedNames.includes(item.name);
                    return (
                      <TouchableOpacity
                        onPress={() => handleSelectExercise(item)}
                        style={[s.exerciseRow, { borderColor: C.borderSubtle }]}
                        activeOpacity={0.7}
                      >
                        <View style={s.exerciseInfo}>
                          <Text style={[s.exerciseName, { color: C.foreground }]}>{item.name}</Text>
                          <Text style={[s.exerciseMeta, { color: C.textMuted }]}>
                            {item.muscle_group} · {item.category}
                          </Text>
                        </View>
                        {isSelected ? (
                          <Feather name="check-circle" size={18} color={Colors.primary} />
                        ) : (
                          <Feather name="plus-circle" size={18} color={C.textMuted} />
                        )}
                      </TouchableOpacity>
                    );
                  }}
                  ListEmptyComponent={
                    <View style={{ alignItems: 'center', paddingVertical: 30 }}>
                      <Text style={[s.emptyText, { color: C.textMuted }]}>No exercises found</Text>
                    </View>
                  }
                />

                {/* Create custom button */}
                <View style={{ paddingHorizontal: Spacing.xl, paddingBottom: 30 }}>
                  <TouchableOpacity
                    onPress={() => setShowCustom(true)}
                    style={[s.customBtn, { borderColor: C.primaryBorder, backgroundColor: C.primarySubtle }]}
                  >
                    <Feather name="edit-3" size={14} color={C.accentText} />
                    <Text style={[s.customBtnText, { color: C.accentText }]}>Create Custom Exercise</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </Pressable>
        </Animated.View>
      </Pressable>
      )}
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '90%' },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  header: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg },
  title: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: Spacing.xl, paddingBottom: 30 },
  label: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { borderWidth: 1, borderRadius: Radius.lg, paddingHorizontal: 16, paddingVertical: 12, fontSize: FontSize.base },
  chipRow: { flexDirection: 'row', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.full, borderWidth: 1 },
  chipText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  customActions: { flexDirection: 'row', gap: 10 },
  backBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: Radius.xl },
  backBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  addBtn: { flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: Radius.xl },
  addBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  searchWrap: { marginBottom: 10 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: Radius.lg, paddingHorizontal: 12, paddingVertical: 10 },
  searchInput: { flex: 1, fontSize: FontSize.base, padding: 0 },
  filterPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.full, borderWidth: 1 },
  filterPillText: { fontSize: 11, fontWeight: FontWeight.semibold },
  exerciseRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1 },
  exerciseInfo: { flex: 1 },
  exerciseName: { fontSize: FontSize.base, fontWeight: FontWeight.medium },
  exerciseMeta: { fontSize: FontSize.sm, marginTop: 2 },
  emptyText: { fontSize: FontSize.sm },
  customBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: Radius.xl, borderWidth: 1 },
  customBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
});
