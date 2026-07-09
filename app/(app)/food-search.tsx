/**
 * Food search — full screen (MyFitnessPal model, not a drawer).
 *
 * Arrived at from a meal's "Add" on the day view. Header carries a meal selector
 * so you can retarget without going back. Empty query shows the user's Recents
 * (global — no regional seed); typing hits the relevance-ranked catalog
 * (search_foods_ranked RPC). A row's "+" quick-logs one default serving and keeps
 * you here for multi-add; tapping the row opens the full food detail to choose a
 * portion. Calm/mature system: Inter, tabular figures, lime only on the action.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, StyleSheet, ActivityIndicator, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';
import { Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow } from '@/constants/theme';
import { useSupabaseClient } from '@/lib/supabase';
import {
  searchCatalog, recentFoods, logFood, getLogMeal, setLogMeal,
  listSavedMeals, logSavedMeal, type PickerFood, type SavedMeal,
} from '@/lib/dietData';
import { defaultServing, type MealType } from '@/lib/foods';
import { haptics } from '@/lib/haptics';

type SearchTab = 'all' | 'meals';
const TABS: { key: SearchTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'meals', label: 'My Meals' },
];

const MEALS: { type: MealType; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { type: 'breakfast', label: 'Breakfast', icon: 'sunrise' },
  { type: 'lunch', label: 'Lunch', icon: 'sun' },
  { type: 'dinner', label: 'Dinner', icon: 'sunset' },
  { type: 'snack', label: 'Snacks', icon: 'coffee' },
];
const labelOf = (m: MealType) => MEALS.find((x) => x.type === m)?.label ?? 'Meal';
const round = (n: number) => Math.round(n);

export default function FoodSearchScreen() {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const supabase = useSupabaseClient();

  const [meal, setMeal] = useState<MealType>(getLogMeal());
  const [mealOpen, setMealOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SearchTab>('all');
  const [savedMeals, setSavedMeals] = useState<SavedMeal[]>([]);

  // Re-sync the target meal from the store + clear the stale query each time this
  // retained Tabs screen is reopened (focus fires reliably even when router params
  // go stale — which was making every food log land in breakfast). Also reload
  // saved meals so one just created in the builder shows up on return.
  useFocusEffect(
    useCallback(() => {
      setMeal(getLogMeal());
      setQuery('');
      setTab('all'); // retained Tabs screen: reset to the catalog every reopen (deterministic)
      if (supabase) listSavedMeals(supabase).then(setSavedMeals).catch(() => {});
    }, [supabase]),
  );
  const [results, setResults] = useState<PickerFood[]>([]);
  const [recents, setRecents] = useState<PickerFood[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let on = true;
    (async () => { const r = await recentFoods(supabase, 20); if (on) setRecents(r); })();
    return () => { on = false; };
  }, [supabase]);

  useEffect(() => {
    const qq = query.trim();
    if (!qq) { setResults([]); setSearching(false); return; }
    setSearching(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await searchCatalog(supabase, qq);
        if (!cancelled) setResults(r);
      } finally {
        // Always clear the spinner, even if searchCatalog rejects — otherwise
        // the search stays stuck "searching…" for the rest of the session.
        if (!cancelled) setSearching(false);
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, supabase]);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const showingRecents = query.trim().length === 0;
  const data = showingRecents ? recents : results;

  const keyOf = (f: PickerFood, i: number) => `${f.id ?? f.name}-${i}`;

  function openDetail(food: PickerFood) {
    Keyboard.dismiss();
    setLogMeal(meal); // detail reads the target meal from the store on focus
    router.push({
      pathname: '/food-detail',
      params: { meal, food: encodeURIComponent(JSON.stringify(food)) },
    });
  }

  function openBuilder() {
    Keyboard.dismiss();
    setLogMeal(meal);
    router.push({ pathname: '/meal-builder', params: { meal } });
  }

  async function quickAdd(food: PickerFood, key: string) {
    if (!supabase || busyKey) return;
    setBusyKey(key);
    try {
      const ds = defaultServing(food);
      const { error } = await logFood(supabase, {
        mealType: meal,
        food: { ...food, servings: food.servings.length ? food.servings : [ds] },
        servingLabel: ds.label,
        quantity: 1,
      });
      if (error) { haptics.warning(); return; }
      haptics.success();
      setToast(`Added to ${labelOf(meal)}`);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 1600);
      const r = await recentFoods(supabase, 20);
      setRecents(r);
    } catch {
      haptics.warning();
    } finally {
      // Always unlock the row, even if logFood/recentFoods rejects.
      setBusyKey(null);
    }
  }

  // One-tap log a saved meal into the target meal (MFP "My Meals" +), then return
  // to the diet day view — same as logging a single food from food-detail.
  async function logSaved(m: SavedMeal, key: string) {
    if (!supabase || busyKey) return;
    setBusyKey(key);
    try {
      const { error } = await logSavedMeal(supabase, m, meal, 1);
      if (error) { haptics.warning(); return; }
      haptics.success();
      router.navigate('/nutrition');
    } catch {
      haptics.warning();
    } finally {
      setBusyKey(null); // food-search is a retained Tabs screen, so always clear
    }
  }

  // Tap a saved meal's row → open it in the builder to edit or log (detail view).
  function openEditMeal(m: SavedMeal) {
    Keyboard.dismiss();
    setLogMeal(meal); // the builder's "Log" writes to this section
    router.push({ pathname: '/meal-builder', params: { saved: encodeURIComponent(JSON.stringify(m)), meal } });
  }

  const savedFiltered = savedMeals.filter((m) => {
    const q = query.trim().toLowerCase();
    return !q || m.name.toLowerCase().includes(q);
  });

  const s = makeStyles(C);

  const renderSaved = ({ item }: { item: SavedMeal }) => {
    const key = `saved-${item.id}`;
    return (
      <View style={s.row}>
        {/* Tap the row → open the meal to edit or log; tap + → quick-log it. */}
        <Pressable style={{ flex: 1, paddingRight: Spacing.md }} onPress={() => openEditMeal(item)} android_ripple={{ color: C.surfaceHover }}>
          <Text style={s.rowName} numberOfLines={2}>{item.name}</Text>
          <Text style={s.rowMeta}>
            {round(item.kcal)} cal<Text style={s.rowDot}>  ·  </Text>
            {`${item.items.length} item${item.items.length === 1 ? '' : 's'}`}
          </Text>
          <View style={s.rowMacros}>
            <Text style={[s.macro, { color: C.macro.protein }]}>{round(item.protein_g)}<Text style={s.macroU}> P</Text></Text>
            <Text style={[s.macro, { color: C.macro.carbs }]}>{round(item.carb_g)}<Text style={s.macroU}> C</Text></Text>
            <Text style={[s.macro, { color: C.macro.fat }]}>{round(item.fat_g)}<Text style={s.macroU}> F</Text></Text>
          </View>
        </Pressable>
        <Pressable
          onPress={() => logSaved(item, key)}
          hitSlop={10}
          style={[s.addBtn, { borderColor: C.primaryBorder, backgroundColor: C.primarySubtle }]}
        >
          {busyKey === key
            ? <ActivityIndicator size="small" color={C.accentText} />
            : <Feather name="plus" size={18} color={C.accentText} />}
        </Pressable>
      </View>
    );
  };

  const renderItem = ({ item, index }: { item: PickerFood; index: number }) => {
    const ds = defaultServing(item);
    const f = ds.grams / 100;
    const kc = item.kcal * f;
    const key = keyOf(item, index);
    return (
      <Pressable style={s.row} onPress={() => openDetail(item)} android_ripple={{ color: C.surfaceHover }}>
        <View style={{ flex: 1, paddingRight: Spacing.md }}>
          <Text style={s.rowName} numberOfLines={2}>{item.name}</Text>
          <Text style={s.rowMeta}>{round(kc)} cal<Text style={s.rowDot}>  ·  </Text>{ds.label}</Text>
          <View style={s.rowMacros}>
            <Text style={[s.macro, { color: C.macro.protein }]}>{round(item.protein_g * f)}<Text style={s.macroU}> P</Text></Text>
            <Text style={[s.macro, { color: C.macro.carbs }]}>{round(item.carb_g * f)}<Text style={s.macroU}> C</Text></Text>
            <Text style={[s.macro, { color: C.macro.fat }]}>{round(item.fat_g * f)}<Text style={s.macroU}> F</Text></Text>
          </View>
        </View>
        <Pressable
          onPress={() => quickAdd(item, key)}
          hitSlop={10}
          style={[s.addBtn, { borderColor: C.primaryBorder, backgroundColor: C.primarySubtle }]}
        >
          {busyKey === key
            ? <ActivityIndicator size="small" color={C.accentText} />
            : <Feather name="plus" size={18} color={C.accentText} />}
        </Pressable>
      </Pressable>
    );
  };

  return (
    <View style={[s.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      {/* Header with meal selector */}
      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={s.back}>
          <Feather name="chevron-left" size={24} color={C.foreground} />
        </Pressable>
        <Pressable style={s.mealSel} onPress={() => setMealOpen((o) => !o)} hitSlop={8}>
          <Text style={s.mealSelTxt}>Add to {labelOf(meal)}</Text>
          <Feather name={mealOpen ? 'chevron-up' : 'chevron-down'} size={16} color={C.textMuted} />
        </Pressable>
        <View style={s.back} />
      </View>

      {mealOpen && (
        <Animated.View entering={FadeIn.duration(140)} exiting={FadeOut.duration(120)} style={s.mealChips}>
          {MEALS.map((m) => {
            const active = m.type === meal;
            return (
              <Pressable
                key={m.type}
                onPress={() => { setMeal(m.type); setLogMeal(m.type); setMealOpen(false); haptics.tick(); }}
                style={[s.mealChip, { borderColor: active ? Colors.primary : C.border, backgroundColor: active ? Colors.primary : 'transparent' }]}
              >
                <Feather name={m.icon} size={12} color={active ? Colors.primaryFg : C.textSecondary} />
                <Text style={[s.mealChipTxt, { color: active ? Colors.primaryFg : C.textSecondary }]}>{m.label}</Text>
              </Pressable>
            );
          })}
        </Animated.View>
      )}

      {/* Search bar */}
      <View style={[s.search, { backgroundColor: C.inputBg, borderColor: C.border }]}>
        <Feather name="search" size={16} color={C.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={tab === 'meals' ? 'Search for a meal' : 'Search foods'}
          placeholderTextColor={C.textDim}
          style={s.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          autoFocus={tab === 'all'}
        />
        {query.length > 0 && (
          <Pressable onPress={() => setQuery('')} hitSlop={8}>
            <Feather name="x" size={16} color={C.textMuted} />
          </Pressable>
        )}
      </View>

      {/* Tabs — All / My Meals (MFP model). */}
      <View style={s.tabs}>
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <Pressable key={t.key} onPress={() => { setTab(t.key); haptics.tick(); }} style={s.tab}>
              <Text style={[s.tabTxt, { color: on ? C.foreground : C.textMuted }]}>{t.label}</Text>
              <View style={[s.tabUnderline, { backgroundColor: on ? C.accentText : 'transparent' }]} />
            </Pressable>
          );
        })}
      </View>

      {tab !== 'all' ? (
        <FlatList
          data={savedFiltered}
          keyExtractor={(m) => m.id}
          renderItem={renderSaved}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingBottom: insets.bottom + 80, flexGrow: 1 }}
          ItemSeparatorComponent={() => <View style={[s.sep, { backgroundColor: C.borderSubtle }]} />}
          ListHeaderComponent={
            <Pressable style={s.createRow} onPress={openBuilder}>
              <View style={[s.createIcon, { borderColor: C.primaryBorder, backgroundColor: C.primarySubtle }]}>
                <Feather name="plus" size={16} color={C.accentText} />
              </View>
              <Text style={s.createTxt}>Create a meal</Text>
            </Pressable>
          }
          ListEmptyComponent={
            <View style={s.empty}>
              <Feather name="bookmark" size={26} color={C.textDim} />
              <Text style={s.emptyTitle}>No meals yet</Text>
              <Text style={s.emptySub}>
                Tap “Create a meal” to build one, or save one from a meal you logged.
              </Text>
            </View>
          }
        />
      ) : (
        <>
      {showingRecents && (
        <View style={s.listHead}>
          <Text style={s.listHeadTxt}>Recent</Text>
        </View>
      )}

      <FlatList
        data={data}
        keyExtractor={keyOf}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + 80, flexGrow: 1 }}
        ItemSeparatorComponent={() => <View style={[s.sep, { backgroundColor: C.borderSubtle }]} />}
        ListEmptyComponent={
          searching ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={C.textMuted} />
          ) : (
            <View style={s.empty}>
              <Feather name={showingRecents ? 'clock' : 'search'} size={26} color={C.textDim} />
              <Text style={s.emptyTitle}>
                {showingRecents ? 'No recent foods yet' : `No matches for “${query.trim()}”`}
              </Text>
              <Text style={s.emptySub}>
                {showingRecents
                  ? 'Search the catalog to log your first food. It’ll show up here next time.'
                  : 'Try a simpler or more common name.'}
              </Text>
            </View>
          )
        }
      />
        </>
      )}

      {toast && (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(200)} style={[s.toast, { bottom: insets.bottom + 20 }]}>
          <Feather name="check" size={15} color={Colors.primaryFg} />
          <Text style={s.toastTxt}>{toast}</Text>
        </Animated.View>
      )}
    </View>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, height: 48 },
    back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
    mealSel: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    mealSelTxt: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, letterSpacing: LetterSpacing.snug, color: C.foreground },

    mealChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: Spacing.xl, paddingBottom: Spacing.sm, justifyContent: 'center' },
    mealChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: Radius.full, borderWidth: 1 },
    mealChipTxt: { fontSize: 12, fontWeight: FontWeight.semibold },

    search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.xl, marginTop: Spacing.xs, borderWidth: 1, borderRadius: Radius.lg, paddingHorizontal: Spacing.md, height: 44 },
    searchInput: { flex: 1, fontSize: FontSize.lg, color: C.foreground, padding: 0 },

    tabs: { flexDirection: 'row', marginTop: Spacing.md, marginHorizontal: Spacing.xl, borderBottomWidth: 1, borderBottomColor: C.borderSubtle },
    tab: { flex: 1, alignItems: 'center', paddingBottom: Spacing.sm, gap: 6 },
    tabTxt: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
    tabUnderline: { height: 2, width: '70%', borderRadius: 1 },

    createRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.xl, paddingVertical: 16 },
    createIcon: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    createTxt: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: C.accentText },

    listHead: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: Spacing.xs },
    listHeadTxt: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase', color: C.textDim },

    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, paddingVertical: 14 },
    rowName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: C.foreground, lineHeight: 19 },
    rowMeta: { fontSize: FontSize.sm, color: C.textMuted, marginTop: 3, fontVariant: ['tabular-nums'] },
    rowDot: { color: C.textDim },
    rowMacros: { flexDirection: 'row', gap: 12, marginTop: 4 },
    macro: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
    macroU: { fontSize: 10, fontWeight: FontWeight.semibold },
    addBtn: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    sep: { height: 1, marginLeft: Spacing.xl },

    empty: { alignItems: 'center', paddingTop: 64, paddingHorizontal: Spacing.xxxl, gap: 8 },
    emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: C.textSecondary, marginTop: 4 },
    emptySub: { fontSize: FontSize.sm, color: C.textMuted, textAlign: 'center', lineHeight: 19 },

    toast: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: Colors.primary, paddingHorizontal: Spacing.lg, paddingVertical: 10, borderRadius: Radius.full, ...Shadow.elevated },
    toastTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  });
}
