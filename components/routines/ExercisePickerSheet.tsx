/**
 * Bottom-sheet exercise picker with search, muscle group tabs,
 * and custom exercise creation. Matches Figma design.
 */
import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, BackHandler, Pressable, ScrollView, Keyboard, Platform,
  useWindowDimensions, Image,
} from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Portal } from '@/components/ui/Portal';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import {
  EXERCISE_LIBRARY, MUSCLE_GROUPS, CATEGORIES, searchExercises,
  METRIC_TYPES, metricTypeDef, metricTypeOf, DEFAULT_METRIC_TYPE,
} from '@/lib/exercises';
import type { ExerciseDef, MetricType } from '@/lib/exercises';
import { useSupabaseClient, isSupabaseConfigured } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { addGuestExercise, getGuestExercises } from '@/lib/guestStore';
import { hydrateCache, readCache, writeCache } from '@/lib/localCache';
import { saveLocalCustomExercise, type CachedExercise } from '@/lib/exerciseResolve';
import { useExerciseNotes } from '@/hooks/useExerciseNotes';

// Custom exercises can be tagged beyond the library's lifting groups — the
// routine editor's old custom drawer offered these, so keep parity.
const CUSTOM_MUSCLE_GROUPS = [...MUSCLE_GROUPS, 'Cardio', 'Other'] as const;

// Generous ceiling on per-exercise set targets (10x10 GVT still fits).
const MAX_CUSTOM_SETS = 20;

// Module-level cache of the user's custom exercises so reopening the picker
// shows them instantly and rapid open/close cycles don't refire the query.
// A fetch still runs in the background when the cache is older than the TTL.
// Keyed by Clerk user id: the module outlives sign-out, so without the key a
// freshly signed-in user (or a guest) would inherit the previous account's
// private list for up to the TTL.
let customExercisesCache: { userId: string; rows: ExerciseDef[]; at: number } | null = null;
const CUSTOM_CACHE_TTL_MS = 30_000;

// Module cache of the GLOBAL catalog (the ~800 DB library rows, created_by null).
// Globals are identical for every user, so this isn't keyed by user. The picker
// reads this instead of the static EXERCISE_LIBRARY; the static list is only the
// offline cold-start seed (hybrid). Longer TTL — the global catalog rarely changes.
let globalCatalogCache: { rows: ExerciseDef[]; at: number } | null = null;
const GLOBAL_CACHE_TTL_MS = 10 * 60_000;

// Drop the cache after a mutation elsewhere (e.g. the My Exercises screen
// renames or deletes a custom) so the picker can't serve the stale list for
// the rest of the TTL.
export function invalidateCustomExercisesCache() {
  customExercisesCache = null;
}

// Drop rows whose names collide with the built-in library (or each other) —
// the FlatList keys by name and the library is always appended, so a custom
// named after a library exercise would otherwise render twice.
function dedupeAgainstLibrary(
  rows: { name: string; muscle_group: string; category: string; metric_type?: string }[]
): ExerciseDef[] {
  const seen = new Set(EXERCISE_LIBRARY.map(e => e.name.toLowerCase()));
  const own: ExerciseDef[] = [];
  for (const row of rows) {
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    own.push({
      name: row.name,
      muscle_group: row.muscle_group,
      category: row.category,
      metric_type: metricTypeOf(row),
    });
  }
  return own;
}

/** Set/rep/rest targets collected by the custom-exercise form. Passed as the
 * second onSelect argument only for custom creations — library picks leave it
 * undefined and the consumer keeps its own defaults. */
export interface CustomExerciseDetails {
  sets: number;
  repsMin: number;
  repsMax: number;
  restSeconds: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (exercise: ExerciseDef, custom?: CustomExerciseDetails) => void;
  /** Already-added exercise names (to show check mark) */
  selectedNames?: string[];
}

export function ExercisePickerSheet({ visible, onClose, onSelect, selectedNames = [] }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const isGuest = useIsGuestSession();
  const userId = user?.id ?? null;
  const [search, setSearch] = useState('');
  const [muscleFilter, setMuscleFilter] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  // Sub-screen: the "Select Exercise Type" card list, opened from the Type row.
  const [showTypePicker, setShowTypePicker] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customMuscle, setCustomMuscle] = useState('Other');
  const [customCategory, setCustomCategory] = useState('Other');
  const [customType, setCustomType] = useState<MetricType>(DEFAULT_METRIC_TYPE);
  const [customSets, setCustomSets] = useState('3');
  const [customRepsMin, setCustomRepsMin] = useState('8');
  const [customRepsMax, setCustomRepsMax] = useState('12');
  const [customRest, setCustomRest] = useState('90');

  // Keyboard avoidance: the custom-exercise form autofocuses the name input,
  // and the library view has a search input — both bring the keyboard up and
  // (on iOS, inside a transparent Modal) end up covering the inputs and the
  // "Create & Add" button. KeyboardAvoidingView doesn't help here (Modal
  // doesn't resize on iOS), so we track keyboard height and lift the sheet
  // via marginBottom — same pattern as analytics.tsx's BottomDrawer.
  const [kbHeight, setKbHeight] = useState(0);
  const searchInputRef = useRef<TextInput>(null);
  // Gated on `visible` like every other fetch in this sheet — it stays mounted
  // behind the active-workout and routine-editor screens, so an ungated load
  // would fetch on screens where the picker is never opened.
  const { noteFor } = useExerciseNotes(visible);

  // The user's own custom exercises, fetched fresh on every open. RLS scopes
  // the query to rows this user created (plus global rows, which the
  // created_by filter excludes), so a custom exercise made in one routine or
  // workout is reusable everywhere the picker opens. Guests read the local
  // guest store instead — they have no Supabase session to query.
  const [customExercises, setCustomExercises] = useState<ExerciseDef[]>(() => {
    // Only seed from the cache when it was written by this same signed-in
    // user — never hand a guest (or a different account) someone else's list.
    const cached = customExercisesCache;
    return !isGuest && cached && cached.userId === userId ? cached.rows : [];
  });
  // The DB global catalog (~800 rows). Seeded from the module cache; revalidated
  // below. When non-empty it REPLACES the static EXERCISE_LIBRARY as the picker's
  // base list (see the `library` memo).
  const [globalCatalog, setGlobalCatalog] = useState<ExerciseDef[]>(() => globalCatalogCache?.rows ?? []);
  useEffect(() => {
    if (!visible) return;
    // Guest sessions never touch the signed-in cache: read the local store
    // synchronously and bail before any of the cache/fetch logic below.
    if (isGuest) {
      setCustomExercises(dedupeAgainstLibrary(getGuestExercises()));
      return;
    }
    if (!isSupabaseConfigured || !userId) return;
    let cancelled = false;
    (async () => {
      // Cache-first so the user's customs (including any created offline) show
      // instantly and survive no signal. Prefer this user's fresh in-memory
      // module cache; otherwise seed from the persistent 'exercises' cache that
      // My Exercises also maintains.
      const moduleFresh =
        customExercisesCache?.userId === userId &&
        Date.now() - customExercisesCache.at < CUSTOM_CACHE_TTL_MS;
      if (customExercisesCache?.userId === userId) {
        setCustomExercises(customExercisesCache.rows);
      } else {
        await hydrateCache(userId);
        const cached = readCache<CachedExercise[]>('exercises', userId);
        setCustomExercises(
          cached ? dedupeAgainstLibrary(cached.filter((r) => r.created_by !== null)) : [],
        );
      }
      if (moduleFresh) return; // module cache still fresh — skip the refetch
      try {
        const { data, error } = await supabase
          .from('exercises')
          .select('name, muscle_group, category, metric_type')
          .not('created_by', 'is', null)
          .order('created_at', { ascending: false });
        if (error) throw error;
        if (cancelled || !data) return;
        // Keep any offline-created customs that haven't synced yet, so this
        // wholesale refetch doesn't drop them until a server row exists.
        const serverNames = new Set((data as any[]).map((r) => String(r.name).toLowerCase()));
        const localCustoms = (readCache<CachedExercise[]>('exercises', userId) ?? [])
          .filter((r) => typeof r.id === 'string' && r.id.startsWith('local-ex-') && !serverNames.has(r.name.toLowerCase()))
          .map((r) => ({ name: r.name, muscle_group: r.muscle_group, category: r.category, metric_type: r.metric_type }));
        const own = dedupeAgainstLibrary([...localCustoms, ...data]);
        customExercisesCache = { userId, rows: own, at: Date.now() };
        setCustomExercises(own);
      } catch {
        // Offline — keep the cache-seeded customs.
      }
    })();
    return () => { cancelled = true; };
  }, [visible, isGuest, userId]);

  // Global catalog (created_by null) — the DB-backed library. Cache-first, then
  // revalidate. Guests never fetch (no session): they fall back to the static
  // EXERCISE_LIBRARY via the `library` memo.
  useEffect(() => {
    if (!visible || isGuest || !isSupabaseConfigured || !userId) return;
    if (globalCatalogCache && Date.now() - globalCatalogCache.at < GLOBAL_CACHE_TTL_MS) {
      setGlobalCatalog(globalCatalogCache.rows);
      return; // module cache fresh — skip refetch
    }
    let cancelled = false;
    (async () => {
      await hydrateCache(userId);
      const cached = readCache<ExerciseDef[]>('catalog', userId);
      if (cached?.length) setGlobalCatalog(cached);
      try {
        const { data, error } = await supabase
          .from('exercises')
          .select('name, muscle_group, category, metric_type, image_urls')
          .is('created_by', null)
          .order('name', { ascending: true });
        if (error) throw error;
        if (cancelled || !data) return;
        const rows: ExerciseDef[] = (data as any[]).map((r) => ({
          name: r.name,
          muscle_group: r.muscle_group,
          category: r.category,
          metric_type: metricTypeOf(r),
          image_urls: r.image_urls ?? [],
        }));
        globalCatalogCache = { rows, at: Date.now() };
        writeCache('catalog', userId, rows);
        setGlobalCatalog(rows);
      } catch {
        // Offline — keep the cache-seeded catalog (or the static seed downstream).
      }
    })();
    return () => { cancelled = true; };
  }, [visible, isGuest, userId]);

  // Customs first, then the catalog base. Base = the DB global catalog once
  // loaded, else the static EXERCISE_LIBRARY (offline cold-start / guests).
  // Deduped by name (customs win) so a custom named like a global — or the dirty
  // duplicate global rows — never collide on the FlatList key.
  const library = useMemo(() => {
    const base = (!isGuest && globalCatalog.length > 0) ? globalCatalog : EXERCISE_LIBRARY;
    const merged = [...customExercises, ...base];
    const seen = new Set<string>();
    const out: ExerciseDef[] = [];
    for (const e of merged) {
      const k = e.name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  }, [customExercises, globalCatalog, isGuest]);
  const customNames = useMemo(
    () => new Set(customExercises.map(e => e.name.toLowerCase())),
    [customExercises]
  );
  // Customs (Cardio/Other) and catalog rows mapped to "Other" aren't in the base
  // filter pills — surface any extra groups present so those rows stay reachable.
  const muscleOptions = useMemo(() => {
    const extras = [...new Set(library.map(e => e.muscle_group))]
      .filter(mg => !(MUSCLE_GROUPS as readonly string[]).includes(mg));
    return [...MUSCLE_GROUPS, ...extras];
  }, [library]);
  useEffect(() => {
    if (!visible) { setKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKbHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    // No auto-focus: the keyboard should only come up when the user taps the
    // search bar themselves. The listeners above are attached on open, so the
    // sheet still lifts whenever that manual focus happens.
    return () => { showSub.remove(); hideSub.remove(); };
  }, [visible]);

  // Reset on every close, not just resetAndClose(): selecting an exercise
  // closes the sheet from the parent (visible -> false), which would otherwise
  // leave the previous search/filter behind for the next open.
  useEffect(() => {
    if (!visible) {
      setSearch('');
      setMuscleFilter(null);
      setShowCustom(false);
      setShowTypePicker(false);
      setCustomName('');
      Keyboard.dismiss();
    }
  }, [visible]);

  const filtered = useMemo(() => {
    let list = searchExercises(search, library);
    if (muscleFilter) list = list.filter(e => e.muscle_group === muscleFilter);
    return list;
  }, [search, muscleFilter, library]);

  const handleSelectExercise = (ex: ExerciseDef) => {
    onSelect(ex);
  };

  // Enter the custom form with fresh defaults, carrying the search text over —
  // "hey" with no matches becomes the custom exercise's prefilled name.
  const openCustomForm = () => {
    setCustomName(search.trim());
    setCustomMuscle('Other');
    setCustomCategory('Other');
    setCustomType(DEFAULT_METRIC_TYPE);
    setCustomSets('3');
    setCustomRepsMin('8');
    setCustomRepsMax('12');
    setCustomRest('90');
    setShowCustom(true);
  };

  const handleCreateCustom = () => {
    const trimmed = customName.trim();
    if (!trimmed) return;
    // Cap sets: consumers render one row per set (Array.from({ length: sets })),
    // so an unbounded paste like "9999" would freeze the workout screen.
    const sets = Math.min(MAX_CUSTOM_SETS, Math.max(1, parseInt(customSets, 10) || 3));
    const repsMin = Math.max(1, parseInt(customRepsMin, 10) || 8);
    const repsMax = Math.max(repsMin, parseInt(customRepsMax, 10) || repsMin);
    const restSeconds = Math.max(0, parseInt(customRest, 10) || 90);
    const key = trimmed.toLowerCase();
    const details = { sets, repsMin, repsMax, restSeconds };
    // If the name already lives in the merged library (customs + DB catalog +
    // static seed), hand back that canonical def. Emitting a fresh one here
    // would shadow the catalog row with a possibly different metric_type and
    // race the backend's name-uniqueness on insert.
    const existing = library.find(e => e.name.toLowerCase() === key);
    if (existing) {
      onSelect(existing, details);
      return;
    }
    // Optimistically remember the new custom (state + cache) so it shows on
    // the next open even before the consumer's background insert lands.
    const row: ExerciseDef = { name: trimmed, muscle_group: customMuscle, category: customCategory, metric_type: customType };
    setCustomExercises(prev => [row, ...prev]);
    if (isGuest) {
      // No Supabase insert happens downstream for guests — persist to the
      // local store so the custom survives restarts (dedupes internally).
      addGuestExercise({ name: trimmed, muscle_group: customMuscle, category: customCategory, metric_type: customType });
    } else {
      // Persist to the durable 'exercises' cache so the custom is reusable
      // offline (picker + My Exercises) before it syncs to the server.
      saveLocalCustomExercise(userId, { name: trimmed, muscle_group: customMuscle, category: customCategory, metric_type: customType });
      if (customExercisesCache && customExercisesCache.userId === userId) {
        customExercisesCache = { ...customExercisesCache, rows: [row, ...customExercisesCache.rows] };
      }
    }
    onSelect(row, details);
  };

  const resetAndClose = () => {
    setSearch('');
    setMuscleFilter(null);
    setShowCustom(false);
    onClose();
  };

  // <Portal> has no onRequestClose, so wire the Android hardware back button:
  // pop the custom form back to the library first, then dismiss the sheet.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showTypePicker) { setShowTypePicker(false); return true; }
      if (showCustom) { setShowCustom(false); return true; }
      resetAndClose();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, showCustom, showTypePicker]);

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
          <Pressable style={{ flexShrink: 1 }}>
            <View style={[s.handle, { backgroundColor: C.handle }]} />

            {/* Header */}
            <View style={s.header}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}>
                {showTypePicker && (
                  <TouchableOpacity
                    onPress={() => setShowTypePicker(false)}
                    style={[s.closeBtn, { backgroundColor: C.closeBtn }]}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Back to create exercise"
                  >
                    <Feather name="arrow-left" size={15} color={C.foreground} />
                  </TouchableOpacity>
                )}
                <View style={{ flexShrink: 1 }}>
                  <Text style={[s.title, { color: C.foreground }]}>
                    {showTypePicker ? 'Exercise Type' : showCustom ? 'Create Exercise' : 'Add Exercise'}
                  </Text>
                  <Text style={[s.subtitle, { color: C.mutedFg }]}>
                    {showTypePicker
                      ? 'How is this exercise measured?'
                      : showCustom
                        ? 'Set name, muscle group, sets & reps'
                        : `${library.length} exercises available`}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={resetAndClose}
                style={[s.closeBtn, { backgroundColor: C.closeBtn }]}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close exercise picker"
              >
                <Feather name="x" size={15} color={C.foreground} />
              </TouchableOpacity>
            </View>

            {showTypePicker ? (
              /* ── Select Exercise Type — 8 cards, one per measurement type.
                    Picking one sets customType and returns to the custom form. ── */
              <ScrollView
                style={{ flexGrow: 0, flexShrink: 1 }}
                contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xl, gap: 8 }}
                showsVerticalScrollIndicator
                keyboardShouldPersistTaps="handled"
              >
                {METRIC_TYPES.map((mt) => {
                  const active = customType === mt.value;
                  return (
                    <TouchableOpacity
                      key={mt.value}
                      onPress={() => { setCustomType(mt.value); setShowTypePicker(false); }}
                      activeOpacity={0.7}
                      style={[
                        s.typeCard,
                        { borderColor: active ? Colors.primary : C.border, backgroundColor: active ? C.primarySubtle : C.muted },
                      ]}
                    >
                      <View style={[s.typeIcon, { backgroundColor: active ? Colors.primary : C.elevated }]}>
                        <MaterialCommunityIcons
                          name={mt.icon as any}
                          size={20}
                          color={active ? Colors.primaryFg : C.mutedFg}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.typeCardTitle, { color: C.foreground }]}>{mt.label}</Text>
                        <Text style={[s.typeCardSub, { color: C.textMuted }]}>{mt.sublabel}</Text>
                      </View>
                      {active && <Feather name="check" size={18} color={Colors.primary} />}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : showCustom ? (
              /* ── Custom Exercise Form — mirrors the active workout screen's
                    "Create Exercise" sheet: wrapped chip rows, set/rep/rest
                    targets, pinned save button. ── */
              <>
                <ScrollView
                  style={{ flexGrow: 0, flexShrink: 1 }}
                  contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: Spacing.lg }}
                  showsVerticalScrollIndicator={true}
                  keyboardShouldPersistTaps="handled"
                >
                  {/* Name */}
                  <Text style={[s.formLabel, { color: C.textDim }]}>EXERCISE NAME</Text>
                  <TextInput
                    value={customName}
                    onChangeText={setCustomName}
                    placeholder="e.g. Cable Crossover"
                    placeholderTextColor={C.textMuted}
                    style={[s.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                  />

                  {/* Muscle Group */}
                  <Text style={[s.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>MUSCLE GROUP</Text>
                  <View style={s.chipRow}>
                    {CUSTOM_MUSCLE_GROUPS.map(mg => {
                      const active = customMuscle === mg;
                      return (
                        <TouchableOpacity
                          key={mg}
                          onPress={() => setCustomMuscle(mg)}
                          style={[
                            s.chip,
                            {
                              backgroundColor: active ? Colors.primary : C.muted,
                              borderColor: active ? Colors.primary : C.border,
                            },
                          ]}
                        >
                          <Text style={[s.chipText, { color: active ? Colors.primaryFg : C.textMuted }]}>{mg}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Category */}
                  <Text style={[s.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>CATEGORY</Text>
                  <View style={s.chipRow}>
                    {CATEGORIES.map(cat => {
                      const active = customCategory === cat;
                      return (
                        <TouchableOpacity
                          key={cat}
                          onPress={() => setCustomCategory(cat)}
                          style={[
                            s.chip,
                            {
                              backgroundColor: active ? Colors.primary : C.muted,
                              borderColor: active ? Colors.primary : C.border,
                            },
                          ]}
                        >
                          <Text style={[s.chipText, { color: active ? Colors.primaryFg : C.textMuted }]}>{cat}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Type — opens the Select Exercise Type sub-screen */}
                  <Text style={[s.formLabel, { color: C.textDim, marginTop: Spacing.lg }]}>TYPE</Text>
                  <TouchableOpacity
                    onPress={() => { Keyboard.dismiss(); setShowTypePicker(true); }}
                    activeOpacity={0.7}
                    style={[s.typeRow, { backgroundColor: C.muted, borderColor: C.border }]}
                  >
                    <View style={[s.typeRowIcon, { backgroundColor: C.elevated }]}>
                      <MaterialCommunityIcons name={metricTypeDef(customType).icon as any} size={16} color={C.mutedFg} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.typeRowLabel, { color: C.foreground }]}>{metricTypeDef(customType).label}</Text>
                      <Text style={[s.typeRowSub, { color: C.textMuted }]}>{metricTypeDef(customType).sublabel}</Text>
                    </View>
                    <Feather name="chevron-right" size={18} color={C.textMuted} />
                  </TouchableOpacity>

                  {/* Sets / Rest */}
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: Spacing.lg }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.formLabel, { color: C.textDim }]}>SETS</Text>
                      <TextInput
                        value={customSets}
                        onChangeText={setCustomSets}
                        keyboardType="number-pad"
                        style={[s.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.formLabel, { color: C.textDim }]}>REST (S)</Text>
                      <TextInput
                        value={customRest}
                        onChangeText={setCustomRest}
                        keyboardType="number-pad"
                        style={[s.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                      />
                    </View>
                  </View>

                  {/* Reps Min / Max */}
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: Spacing.md }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.formLabel, { color: C.textDim }]}>REPS MIN</Text>
                      <TextInput
                        value={customRepsMin}
                        onChangeText={setCustomRepsMin}
                        keyboardType="number-pad"
                        style={[s.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.formLabel, { color: C.textDim }]}>REPS MAX</Text>
                      <TextInput
                        value={customRepsMax}
                        onChangeText={setCustomRepsMax}
                        keyboardType="number-pad"
                        style={[s.formInput, { backgroundColor: C.muted, color: C.foreground, borderColor: C.border }]}
                      />
                    </View>
                  </View>
                </ScrollView>

                <View style={[s.formFooter, { borderTopColor: C.borderSubtle }]}>
                  <TouchableOpacity
                    onPress={handleCreateCustom}
                    disabled={!customName.trim()}
                    style={[s.formSaveBtn, { backgroundColor: Colors.primary, opacity: customName.trim() ? 1 : 0.4 }]}
                  >
                    <Feather name="check" size={15} color={Colors.primaryFg} />
                    <Text style={s.formSaveBtnText}>Add Exercise</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              /* ── Exercise Library ── */
              <>
                {/* Search */}
                <View style={[s.searchWrap, { marginHorizontal: Spacing.xl }]}>
                  <View style={[s.searchBox, { backgroundColor: C.inputBg, borderColor: C.border }]}>
                    <Feather name="search" size={14} color={C.textMuted} />
                    <TextInput
                      ref={searchInputRef}
                      value={search}
                      onChangeText={setSearch}
                      placeholder="Search exercises..."
                      placeholderTextColor={C.textMuted}
                      style={[s.searchInput, { color: C.foreground }]}
                    />
                    {search.length > 0 && (
                      <TouchableOpacity onPress={() => setSearch('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
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
                  {muscleOptions.map(mg => (
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
                  // Single tap selects even while the keyboard is up — without
                  // this the first tap only dismisses the keyboard.
                  keyboardShouldPersistTaps="handled"
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
                        <View style={[s.thumb, { backgroundColor: C.muted }]}>
                          {item.image_urls && item.image_urls[0] ? (
                            <Image source={{ uri: item.image_urls[0] }} style={s.thumbImg} resizeMode="cover" />
                          ) : (
                            <MaterialCommunityIcons name={metricTypeDef(item.metric_type).icon as any} size={16} color={C.textMuted} />
                          )}
                        </View>
                        <View style={s.exerciseInfo}>
                          <View style={s.exerciseNameRow}>
                            <Text style={[s.exerciseName, { color: C.foreground }]}>{item.name}</Text>
                            {customNames.has(item.name.toLowerCase()) && (
                              <View style={[s.customTag, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}>
                                <Text style={[s.customTagText, { color: C.accentText }]}>Custom</Text>
                              </View>
                            )}
                          </View>
                          <Text style={[s.exerciseMeta, { color: C.textMuted }]}>
                            {item.muscle_group} · {item.category}
                          </Text>
                          {/* The user's sticky note, so a setup they already
                              worked out is in front of them at the moment they
                              pick the exercise. One line only: the list is for
                              scanning, the full note lives in the session. */}
                          {(() => {
                            const own = noteFor(item.name);
                            return own ? (
                              <View style={s.exerciseNoteRow}>
                                <Feather name="bookmark" size={9} color={C.textMuted} />
                                <Text style={[s.exerciseNote, { color: C.mutedFg }]} numberOfLines={1}>
                                  {own}
                                </Text>
                              </View>
                            ) : null;
                          })()}
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
                    onPress={openCustomForm}
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
  // Custom form — values copied from the active workout screen's
  // "Create Exercise" sheet so the two read as the same surface.
  formLabel: { fontSize: 10, fontWeight: FontWeight.semibold, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 },
  formInput: { height: 44, paddingHorizontal: Spacing.md, borderRadius: Radius.lg, borderWidth: 1, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: Radius.full, borderWidth: 1 },
  chipText: { fontSize: 11, fontWeight: FontWeight.semibold },
  // Type row (in the custom form) + the Select Exercise Type cards.
  typeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: Radius.lg, borderWidth: 1 },
  typeRowIcon: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  typeRowLabel: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  typeRowSub: { fontSize: FontSize.sm, marginTop: 1 },
  typeCard: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, borderRadius: Radius.xl, borderWidth: 1 },
  typeIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  typeCardTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  typeCardSub: { fontSize: FontSize.sm, marginTop: 2 },
  formFooter: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, borderTopWidth: 1 },
  formSaveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: Radius.xl },
  formSaveBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  searchWrap: { marginBottom: 10 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: Radius.lg, paddingHorizontal: 12, paddingVertical: 10 },
  searchInput: { flex: 1, fontSize: FontSize.base, padding: 0 },
  filterPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.full, borderWidth: 1 },
  filterPillText: { fontSize: 11, fontWeight: FontWeight.semibold },
  exerciseRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1 },
  thumb: { width: 40, height: 40, borderRadius: 8, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  thumbImg: { width: '100%', height: '100%' },
  exerciseInfo: { flex: 1 },
  exerciseNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  exerciseName: { fontSize: FontSize.base, fontWeight: FontWeight.medium, flexShrink: 1 },
  customTag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: Radius.full, borderWidth: 1 },
  customTagText: { fontSize: 10, fontWeight: FontWeight.semibold },
  exerciseMeta: { fontSize: FontSize.sm, marginTop: 2 },
  exerciseNoteRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  exerciseNote: { flex: 1, fontSize: FontSize.xs },
  emptyText: { fontSize: FontSize.sm },
  customBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: Radius.xl, borderWidth: 1 },
  customBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
});
