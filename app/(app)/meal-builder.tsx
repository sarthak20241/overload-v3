/**
 * Meal builder / editor — create a saved meal by PICKING foods, no coach
 * required (the MyFitnessPal "Create a Meal" flow), and re-open a saved one to
 * edit or log it. Reached from the food-search My Meals tab: "Create a meal"
 * opens it empty; tapping a saved meal opens it preloaded (edit mode).
 *
 * Modes: the form (name, the running item list + macro ring/totals, Save/Log)
 * and an inline food search (tap a catalog result → portion picker → add).
 * Saving goes through the same createSavedMeal / updateSavedMeal paths the AI
 * "Save" uses, so a built meal is identical to a parsed one.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, ScrollView, StyleSheet, ActivityIndicator, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { useSupabaseClient } from '@/lib/supabase';
import {
  searchCatalog, createSavedMeal, updateSavedMeal, logSavedMeal, loadServings, getLogMeal,
  type PickerFood, type ParsedMealItem, type SavedMeal, type SavedMealItem,
} from '@/lib/dietData';
import { defaultServing, resolveBaseAmount, nutrientsForAmount, type FoodServing, type ResolvedNutrients, type MealType } from '@/lib/foods';
import { FoodCompositionCard, NutritionFactsPanel } from '@/components/diet/FoodFacts';
import { haptics } from '@/lib/haptics';

const round = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

const MEAL_LABEL: Record<MealType, string> = {
  breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks',
};

/** A saved-meal item (as stored) → the builder's working ParsedMealItem. */
function savedItemToParsed(it: SavedMealItem): ParsedMealItem {
  return {
    food_id: it.food_id, food_name: it.food_name, quantity: it.quantity,
    serving_label: it.serving_unit, grams: it.grams_logged ?? 0,
    kcal: it.kcal, protein_g: it.protein_g, carb_g: it.carb_g, fat_g: it.fat_g,
    fiber_g: it.fiber_g ?? null, source: 'catalog', assumption: null, confidence: 'high',
  };
}

/** The builder's working item → a saved-meal item (for logging the current, possibly-edited list). */
function parsedToSavedItem(it: ParsedMealItem): SavedMealItem {
  return {
    food_id: it.food_id, food_name: it.food_name, quantity: it.quantity,
    serving_unit: it.serving_label, grams_logged: it.grams,
    kcal: it.kcal, protein_g: it.protein_g, carb_g: it.carb_g, fat_g: it.fat_g,
    fiber_g: it.fiber_g ?? null,
  };
}

export default function MealBuilderScreen() {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const supabase = useSupabaseClient();
  const params = useLocalSearchParams<{ saved?: string }>();

  // Edit mode: reached by tapping a saved meal. Parse it once so the form
  // preloads with its name + items (create mode leaves both empty).
  const [saved] = useState<SavedMeal | null>(() => {
    if (!params.saved) return null;
    try { return JSON.parse(decodeURIComponent(params.saved)) as SavedMeal; } catch { return null; }
  });
  const isEdit = !!saved;
  const targetMeal = getLogMeal(); // which day section a "Log" writes to

  const [name, setName] = useState(saved?.name ?? '');
  const [items, setItems] = useState<ParsedMealItem[]>(saved ? saved.items.map(savedItemToParsed) : []);
  const [saving, setSaving] = useState(false);

  // Inline food search (mode = 'adding')
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickerFood[]>([]);
  const [searching, setSearching] = useState(false);

  // Portion picker (mode = 'picking'): choose serving + quantity before adding.
  // editIndex >= 0 means we're re-portioning an item already in the list.
  const [picking, setPicking] = useState<PickerFood | null>(null);
  const [pickServings, setPickServings] = useState<FoodServing[]>([]);
  const [pickLabel, setPickLabel] = useState('');
  const [pickQty, setPickQty] = useState('1');
  const [pickLoading, setPickLoading] = useState(false);
  const [editIndex, setEditIndex] = useState(-1);

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
        if (!cancelled) setSearching(false);
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, supabase]);

  const total = items.reduce(
    (a, it) => ({ kcal: a.kcal + it.kcal, p: a.p + it.protein_g, c: a.c + it.carb_g, f: a.f + it.fat_g }),
    { kcal: 0, p: 0, c: 0, f: 0 },
  );

  // Tap a search result → open the portion picker (serving + quantity) for it,
  // loading the food's full serving list (curated + label rows) first.
  const openPicker = async (food: PickerFood, atIndex = -1, presetLabel?: string, presetQty?: number) => {
    haptics.selection();
    Keyboard.dismiss();
    setPicking(food);
    setEditIndex(atIndex);
    setPickQty(presetQty != null ? String(presetQty) : '1');
    setPickServings(food.servings ?? []);
    setPickLabel(presetLabel ?? defaultServing(food).label);
    setPickLoading(true);
    try {
      const sv = await loadServings(supabase, food);
      setPickServings(sv);
      if (!presetLabel) setPickLabel(defaultServing({ ...food, servings: sv }).label);
    } finally {
      setPickLoading(false);
    }
  };

  const closePicker = () => { setPicking(null); setEditIndex(-1); };

  const pickQtyNum = Math.max(parseFloat(pickQty) || 0, 0);
  const pickGrams = picking
    ? (resolveBaseAmount({ ...picking, servings: pickServings }, pickLabel, pickQtyNum) ?? 100 * pickQtyNum)
    : 0;
  const pickNutr = picking ? nutrientsForAmount(picking, pickGrams) : null;

  // Commit the picked portion → append (or replace) a ParsedMealItem at the chosen serving × qty.
  const confirmPick = () => {
    if (!picking || pickQtyNum <= 0 || !pickNutr) return;
    const item: ParsedMealItem = {
      food_id: picking.id ?? null,
      food_name: picking.name,
      quantity: pickQtyNum,
      serving_label: pickLabel,
      grams: pickGrams,
      kcal: pickNutr.kcal, protein_g: pickNutr.protein_g, carb_g: pickNutr.carb_g, fat_g: pickNutr.fat_g,
      fiber_g: pickNutr.fiber_g ?? null,
      source: 'catalog', assumption: null, confidence: 'high',
    };
    haptics.success();
    setItems((prev) => (editIndex >= 0 ? prev.map((it, i) => (i === editIndex ? item : it)) : [...prev, item]));
    setQuery('');
    setAdding(false);
    closePicker();
  };

  // Re-open the picker for an item already in the list. Reconstruct a per-100 food
  // from its denormalized snapshot (macros are unrounded floats, so exact); loadServings
  // fills the fuller serving list, and we preset the picker to its current serving × qty.
  const editItem = (it: ParsedMealItem, i: number) => {
    const per100 = it.grams > 0 ? 100 / it.grams : 1;
    const perServingGrams = it.quantity > 0 ? it.grams / it.quantity : it.grams;
    const food: PickerFood = {
      id: it.food_id ?? null,
      name: it.food_name,
      base_unit: 'g',
      food_category: 'other',
      kcal: it.kcal * per100, protein_g: it.protein_g * per100, carb_g: it.carb_g * per100, fat_g: it.fat_g * per100,
      fiber_g: (it.fiber_g ?? 0) * per100,
      servings: [{ label: it.serving_label, grams: perServingGrams, is_default: true }],
    };
    openPicker(food, i, it.serving_label, it.quantity);
  };

  const removeItem = (i: number) => { haptics.tick(); setItems((prev) => prev.filter((_, idx) => idx !== i)); };

  const canSave = name.trim().length > 0 && items.length > 0 && !saving;
  // In edit mode, only allow saving when something actually changed.
  const dirty = isEdit && (
    name.trim() !== saved!.name ||
    items.length !== saved!.items.length ||
    items.some((it, i) => {
      const o = saved!.items[i];
      return !o || it.food_name !== o.food_name || it.quantity !== o.quantity ||
        it.serving_label !== o.serving_unit || it.kcal !== o.kcal;
    })
  );
  const canPersist = canSave && (!isEdit || dirty);

  // Aggregate the item macros into the ring's ResolvedNutrients. We only reliably
  // store fiber per item (not sugar/sat-fat/sodium), so those stay 0 — the ring
  // uses kcal + the three macros, which we do have.
  const mealNutrients: ResolvedNutrients = {
    kcal: total.kcal, protein_g: total.p, carb_g: total.c, fat_g: total.f,
    fiber_g: items.reduce((a, it) => a + (it.fiber_g ?? 0), 0),
    sugar_g: 0, sat_fat_g: 0, sodium_mg: 0,
  };

  // Save: create a new saved meal, or update the one being edited. Create returns
  // to the diet day view (the user's stated preference); edit returns to the meal
  // list so the update shows. The (app) group is a Tabs navigator, so navigate()
  // jumps to the tab — router.back() would pop to the Dashboard instead.
  const persist = async () => {
    if (!supabase || !canPersist) return;
    setSaving(true);
    haptics.selection();
    const res = isEdit
      ? await updateSavedMeal(supabase, saved!.id, { name, items })
      : await createSavedMeal(supabase, { name, kind: 'meal', servings: 1, serving_label: null, items });
    setSaving(false);
    if (res.error) { haptics.warning(); return; }
    haptics.success();
    router.navigate(isEdit ? '/food-search' : '/nutrition');
  };

  // Log the CURRENT items (edits included, even if unsaved) into the target
  // section, then return to the diet day view.
  const doLog = async () => {
    if (!supabase || items.length === 0 || saving) return;
    setSaving(true);
    haptics.selection();
    const snapshot: SavedMeal = {
      id: saved?.id ?? '', name: name.trim() || 'Meal', kind: 'meal', servings: 1, serving_label: null,
      kcal: total.kcal, protein_g: total.p, carb_g: total.c, fat_g: total.f,
      items: items.map(parsedToSavedItem), created_at: saved?.created_at ?? '',
    };
    const { error } = await logSavedMeal(supabase, snapshot, targetMeal, 1);
    setSaving(false);
    if (error) { haptics.warning(); return; }
    haptics.success();
    router.navigate('/nutrition');
  };

  const s = makeStyles(C);

  // ── Portion picker mode ────────────────────────────────────────────────────
  if (picking) {
    const stepPick = (d: number) => { setPickQty(String(Math.min(Math.max(r1(pickQtyNum + d), 0.1), 999))); haptics.tick(); };
    return (
      <View style={[s.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
        <View style={s.header}>
          <Pressable onPress={closePicker} hitSlop={12} style={s.hBtn}>
            <Feather name="chevron-left" size={24} color={C.foreground} />
          </Pressable>
          <Text style={s.hTitle} numberOfLines={1}>{editIndex >= 0 ? 'Edit portion' : 'Add food'}</Text>
          <View style={s.hBtn} />
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
          <Text style={[s.pickName, { color: C.foreground }]}>{picking.name}</Text>

          {pickNutr && <FoodCompositionCard n={pickNutr} C={C} />}

          <Text style={s.sectionLabel}>Serving size</Text>
          {pickLoading ? (
            <ActivityIndicator style={{ alignSelf: 'flex-start', marginLeft: Spacing.xl, marginTop: 4 }} color={C.textMuted} />
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow} keyboardShouldPersistTaps="handled">
              {pickServings.map((sv) => {
                const on = sv.label.toLowerCase() === pickLabel.toLowerCase();
                return (
                  <Pressable key={sv.label} onPress={() => { setPickLabel(sv.label); haptics.tick(); }} style={[s.chip, { borderColor: on ? Colors.primary : C.border, backgroundColor: on ? Colors.primary : 'transparent' }]}>
                    <Text style={[s.chipTxt, { color: on ? Colors.primaryFg : C.textSecondary }]}>{sv.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          <Text style={[s.sectionLabel, { marginTop: Spacing.lg }]}>Number of servings</Text>
          <View style={s.qtyRow}>
            <Pressable onPress={() => stepPick(-0.5)} style={[s.qtyStep, { borderColor: C.border }]} hitSlop={6}><Feather name="minus" size={18} color={C.textSecondary} /></Pressable>
            <TextInput value={pickQty} onChangeText={(t) => setPickQty(t.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" selectTextOnFocus style={[s.qtyInput, { borderColor: C.border, color: C.foreground }]} />
            <Pressable onPress={() => stepPick(0.5)} style={[s.qtyStep, { borderColor: C.border }]} hitSlop={6}><Feather name="plus" size={18} color={C.textSecondary} /></Pressable>
            <Text style={s.qtyHint}>× {pickLabel}{pickGrams > 0 ? `  ·  ${round(pickGrams)} ${picking.base_unit}` : ''}</Text>
          </View>

          {pickNutr && (
            <>
              <Text style={[s.sectionLabel, { marginTop: Spacing.xl }]}>Nutrition facts</Text>
              <NutritionFactsPanel n={pickNutr} C={C} />
            </>
          )}
        </ScrollView>

        <View style={[s.footer, { paddingBottom: insets.bottom + 12, borderTopColor: C.borderSubtle }]}>
          <Pressable onPress={confirmPick} disabled={pickQtyNum <= 0} style={[s.footerBtn, { opacity: pickQtyNum <= 0 ? 0.5 : 1 }]}>
            <Text style={s.footerBtnTxt}>{editIndex >= 0 ? 'Update' : 'Add food'}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Inline food-search mode ────────────────────────────────────────────────
  if (adding) {
    return (
      <View style={[s.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
        <View style={s.header}>
          <Pressable onPress={() => { setAdding(false); setQuery(''); }} hitSlop={12} style={s.hBtn}>
            <Feather name="chevron-left" size={24} color={C.foreground} />
          </Pressable>
          <Text style={s.hTitle}>Add food</Text>
          <View style={s.hBtn} />
        </View>
        <View style={[s.search, { backgroundColor: C.inputBg, borderColor: C.border }]}>
          <Feather name="search" size={16} color={C.textMuted} />
          <TextInput
            value={query} onChangeText={setQuery}
            placeholder="Search foods" placeholderTextColor={C.textDim}
            style={s.searchInput} autoCorrect={false} autoCapitalize="none" autoFocus returnKeyType="search"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} hitSlop={8}><Feather name="x" size={16} color={C.textMuted} /></Pressable>
          )}
        </View>
        <FlatList
          data={results}
          keyExtractor={(f, i) => `${f.id ?? f.name}-${i}`}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          ItemSeparatorComponent={() => <View style={[s.sep, { backgroundColor: C.borderSubtle }]} />}
          renderItem={({ item }) => {
            const ds = defaultServing(item);
            const f = ds.grams / 100;
            return (
              <Pressable style={s.row} onPress={() => openPicker(item)} android_ripple={{ color: C.surfaceHover }}>
                <View style={{ flex: 1, paddingRight: Spacing.md }}>
                  <Text style={s.rowName} numberOfLines={2}>{item.name}</Text>
                  <Text style={s.rowMeta}>{round(item.kcal * f)} cal · {ds.label}</Text>
                </View>
                <View style={[s.addBtn, { borderColor: C.primaryBorder, backgroundColor: C.primarySubtle }]}>
                  <Feather name="plus" size={18} color={C.accentText} />
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            searching
              ? <ActivityIndicator style={{ marginTop: 40 }} color={C.textMuted} />
              : query.trim()
                ? <Text style={s.hint}>No matches for “{query.trim()}”.</Text>
                : <Text style={s.hint}>Search the catalog to add a food.</Text>
          }
        />
      </View>
    );
  }

  // ── Form mode ──────────────────────────────────────────────────────────────
  return (
    <View style={[s.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      <View style={s.header}>
        {/* Reached from food-search; navigate() returns there (router.back() would
            pop to the Dashboard in this Tabs navigator). */}
        <Pressable onPress={() => router.navigate('/food-search')} hitSlop={12} style={s.hBtn}>
          <Feather name="chevron-left" size={24} color={C.foreground} />
        </Pressable>
        <Text style={s.hTitle}>{isEdit ? 'Edit meal' : 'New meal'}</Text>
        <Pressable onPress={persist} disabled={!canPersist} hitSlop={12} style={s.hBtn}>
          <Feather name="check" size={22} color={canPersist ? C.accentText : C.textDim} />
        </Pressable>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {/* Name */}
        <TextInput
          style={[s.nameInput, { color: C.foreground, backgroundColor: C.card, borderColor: C.borderSubtle }]}
          value={name} onChangeText={setName}
          placeholder="Meal name"
          placeholderTextColor={C.textDim} maxLength={60} returnKeyType="done"
        />

        {/* Macro ring + split — the whole meal read like any other food */}
        {items.length > 0 && <FoodCompositionCard n={mealNutrients} C={C} />}

        {/* Items */}
        <Text style={s.sectionLabel}>Foods</Text>
        {items.length === 0 ? (
          <Text style={s.emptyItems}>No foods yet. Add a few to build your meal.</Text>
        ) : (
          items.map((it, i) => (
            <View key={i} style={[s.item, { borderColor: C.borderSubtle }]}>
              <Pressable style={{ flex: 1 }} onPress={() => editItem(it, i)}>
                <Text style={s.itemName} numberOfLines={1}>{it.food_name}<Text style={s.itemServ}>{'  '}{round(it.quantity * 10) / 10} × {it.serving_label}</Text></Text>
                <View style={s.itemMacros}>
                  <Text style={[s.macro, { color: C.foreground }]}>{round(it.kcal)}</Text>
                  <Text style={[s.macro, { color: C.macro.protein }]}>{round(it.protein_g)} P</Text>
                  <Text style={[s.macro, { color: C.macro.carbs }]}>{round(it.carb_g)} C</Text>
                  <Text style={[s.macro, { color: C.macro.fat }]}>{round(it.fat_g)} F</Text>
                </View>
              </Pressable>
              <Pressable onPress={() => removeItem(i)} hitSlop={8} style={s.remove}><Feather name="x" size={16} color={C.textMuted} /></Pressable>
            </View>
          ))
        )}

        <Pressable style={s.addFood} onPress={() => setAdding(true)}>
          <Feather name="plus" size={16} color={C.accentText} />
          <Text style={s.addFoodTxt}>Add food</Text>
        </Pressable>

        {isEdit ? (
          // Edit mode: the header check saves your changes; this logs the meal
          // (current edits included) into the section you came from.
          <Pressable onPress={doLog} disabled={saving || items.length === 0} style={[s.saveBtn, { opacity: saving || items.length === 0 ? 0.4 : 1 }]}>
            <Text style={s.saveTxt}>{saving ? 'Working...' : `Log to ${MEAL_LABEL[targetMeal]}`}</Text>
          </Pressable>
        ) : (
          <Pressable onPress={persist} disabled={!canPersist} style={[s.saveBtn, { opacity: canPersist ? 1 : 0.4 }]}>
            <Text style={s.saveTxt}>{saving ? 'Saving...' : 'Save meal'}</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, height: 48 },
    hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    hTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, letterSpacing: LetterSpacing.snug, color: C.foreground, textTransform: 'capitalize' },

    search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.xl, marginTop: Spacing.xs, borderWidth: 1, borderRadius: Radius.lg, paddingHorizontal: Spacing.md, height: 44 },
    searchInput: { flex: 1, fontSize: FontSize.lg, color: C.foreground, padding: 0 },
    hint: { fontSize: FontSize.sm, color: C.textMuted, textAlign: 'center', marginTop: 40, paddingHorizontal: Spacing.xxl },

    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, paddingVertical: 14 },
    rowName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: C.foreground, lineHeight: 19 },
    rowMeta: { fontSize: FontSize.sm, color: C.textMuted, marginTop: 3, fontVariant: ['tabular-nums'] },
    addBtn: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    sep: { height: 1, marginLeft: Spacing.xl },

    nameInput: { marginHorizontal: Spacing.xl, marginTop: Spacing.md, borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 12, fontSize: FontSize.base, fontWeight: FontWeight.medium },

    sectionLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, textTransform: 'uppercase', letterSpacing: 1, color: C.textDim, marginHorizontal: Spacing.xl, marginTop: Spacing.xl, marginBottom: Spacing.xs },
    emptyItems: { fontSize: FontSize.sm, color: C.textDim, marginHorizontal: Spacing.xl, marginTop: 4 },

    item: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginHorizontal: Spacing.xl, paddingVertical: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
    itemName: { fontSize: FontSize.base, fontWeight: FontWeight.medium, color: C.foreground },
    itemServ: { fontSize: FontSize.sm, color: C.textMuted, fontWeight: FontWeight.regular },
    itemMacros: { flexDirection: 'row', gap: Spacing.md, marginTop: 4 },
    macro: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
    remove: { padding: 4 },

    addFood: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.xl, marginTop: Spacing.md, paddingVertical: 10 },
    addFoodTxt: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: C.accentText },

    saveBtn: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, marginHorizontal: Spacing.xl, marginTop: Spacing.xl },
    saveTxt: { fontSize: FontSize.base, color: Colors.primaryFg, fontWeight: FontWeight.bold },

    // Portion picker
    pickName: { fontSize: FontSize.xl, fontWeight: FontWeight.black, letterSpacing: LetterSpacing.tight, marginHorizontal: Spacing.xl, marginTop: Spacing.md },
    chipRow: { paddingHorizontal: Spacing.xl, gap: 8 },
    chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.full, borderWidth: 1 },
    chipTxt: { fontSize: 13, fontWeight: FontWeight.semibold },
    qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: Spacing.xl },
    qtyStep: { width: 40, height: 40, borderRadius: Radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    qtyInput: { width: 72, height: 40, borderWidth: 1, borderRadius: Radius.md, textAlign: 'center', fontSize: FontSize.lg, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
    qtyHint: { flex: 1, fontSize: FontSize.sm, color: C.textMuted, fontVariant: ['tabular-nums'] },
    footer: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, borderTopWidth: 1 },
    footerBtn: { height: 52, borderRadius: Radius.xl, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
    footerBtnTxt: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  });
}
