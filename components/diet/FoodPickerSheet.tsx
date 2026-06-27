/**
 * FoodPickerSheet — search the catalog, pick a serving + quantity, log to a meal.
 *
 * Two steps in one Portal sheet (Portal, not RN Modal — Android edge-to-edge): a
 * search list over the bundled FOOD_LIBRARY + the Supabase `foods` catalog, then a
 * serving/quantity step with a live macro preview. "Add" calls logFood() and fires
 * onLogged so the day view + FUEL card reload. Mirrors ExercisePickerSheet's shell.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, StyleSheet, BackHandler,
  ActivityIndicator, Keyboard, useWindowDimensions,
} from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Portal } from '@/components/ui/Portal';
import { useTheme } from '@/hooks/useTheme';
import { Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow } from '@/constants/theme';
import { useSupabaseClient } from '@/lib/supabase';
import { searchCatalog, loadServings, logFood, type PickerFood } from '@/lib/dietData';
import {
  defaultServing, nutrientsForAmount, resolveBaseAmount,
  type FoodServing, type MealType,
} from '@/lib/foods';
import { haptics } from '@/lib/haptics';

const MEAL_LABEL: Record<MealType, string> = {
  breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'snacks',
};

interface Props {
  visible: boolean;
  mealType: MealType;
  onClose: () => void;
  onLogged: () => void;
}

export function FoodPickerSheet({ visible, mealType, onClose, onLogged }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const supabase = useSupabaseClient();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickerFood[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<PickerFood | null>(null);
  const [servings, setServings] = useState<FoodServing[]>([]);
  const [servingLabel, setServingLabel] = useState('');
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [kb, setKb] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKb(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKb(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Reset + load the bundled library when opened.
  useEffect(() => {
    if (!visible) return;
    setQuery(''); setSelected(null); setBusy(false);
    let cancelled = false;
    (async () => {
      setSearching(true);
      const r = await searchCatalog(supabase, '');
      if (!cancelled) { setResults(r); setSearching(false); }
    })();
    return () => { cancelled = true; };
  }, [visible, supabase]);

  // Debounced search.
  useEffect(() => {
    if (!visible || selected) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      const r = await searchCatalog(supabase, query);
      if (!cancelled) { setResults(r); setSearching(false); }
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, visible, selected, supabase]);

  // Android back: serving step -> list -> close.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selected) { setSelected(null); return true; }
      onClose(); return true;
    });
    return () => sub.remove();
  }, [visible, selected, onClose]);

  async function pickFood(food: PickerFood) {
    Keyboard.dismiss();
    setSelected(food);
    const s = await loadServings(supabase, food);
    setServings(s);
    setServingLabel(defaultServing({ ...food, servings: s }).label);
    setQty(1);
  }

  const preview = useMemo(() => {
    if (!selected) return null;
    const grams = resolveBaseAmount({ ...selected, servings }, servingLabel, qty) ?? 100 * qty;
    return nutrientsForAmount(selected, grams);
  }, [selected, servings, servingLabel, qty]);

  async function add() {
    if (!selected || !supabase || busy) return;
    setBusy(true);
    const { error } = await logFood(supabase, { mealType, food: selected, servingLabel, quantity: qty });
    setBusy(false);
    if (error) { haptics.warning(); return; }
    haptics.success();
    onLogged();
    onClose();
  }

  if (!visible) return null;
  const s = makeStyles(C);

  return (
    <Portal>
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose} />
      <Animated.View
        entering={SlideInDown.duration(320).easing(Easing.out(Easing.cubic))}
        exiting={SlideOutDown.duration(200)}
        style={[s.sheet, { backgroundColor: C.elevated, marginBottom: kb, maxHeight: (winH - kb) * 0.9, paddingBottom: insets.bottom + Spacing.md }]}
      >
        <View style={[s.handle, { backgroundColor: C.handle }]} />

        {!selected ? (
          <>
            <View style={s.header}>
              <Text style={s.title}>Add to {MEAL_LABEL[mealType]}</Text>
              <Pressable onPress={onClose} style={[s.close, { backgroundColor: C.closeBtn }]} hitSlop={8}>
                <Feather name="x" size={15} color={C.textMuted} />
              </Pressable>
            </View>
            <View style={[s.search, { backgroundColor: C.inputBg, borderColor: C.border }]}>
              <Feather name="search" size={14} color={C.textMuted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search foods"
                placeholderTextColor={C.textDim}
                style={s.searchInput}
                autoCorrect={false}
              />
              {query ? (
                <Pressable onPress={() => setQuery('')} hitSlop={8}><Feather name="x" size={14} color={C.textMuted} /></Pressable>
              ) : null}
            </View>
            <FlatList
              data={results}
              keyExtractor={(f, i) => `${f.id ?? f.name}-${i}`}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable style={s.row} onPress={() => pickFood(item)}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName} numberOfLines={1}>{item.name}</Text>
                    <Text style={s.rowMeta}>{Math.round(item.kcal)} kcal · {Math.round(item.protein_g)}g P / 100{item.base_unit}</Text>
                  </View>
                  <Feather name="plus-circle" size={18} color={C.accentText} />
                </Pressable>
              )}
              ListEmptyComponent={
                searching
                  ? <ActivityIndicator style={{ marginTop: 24 }} color={C.textMuted} />
                  : <Text style={s.empty}>No foods found</Text>
              }
            />
          </>
        ) : (
          <View style={{ paddingHorizontal: Spacing.xl }}>
            <View style={s.header2}>
              <Pressable onPress={() => setSelected(null)} hitSlop={10}><Feather name="chevron-left" size={20} color={C.foreground} /></Pressable>
              <Text style={[s.title, { flex: 1 }]} numberOfLines={1}>{selected.name}</Text>
            </View>

            <Text style={s.label}>SERVING</Text>
            <View style={s.chipRow}>
              {servings.map((sv) => {
                const active = sv.label.toLowerCase() === servingLabel.toLowerCase();
                return (
                  <Pressable
                    key={sv.label}
                    onPress={() => { setServingLabel(sv.label); haptics.tick(); }}
                    style={[s.chip, { borderColor: active ? Colors.primary : C.border, backgroundColor: active ? Colors.primary : 'transparent' }]}
                  >
                    <Text style={[s.chipTxt, { color: active ? Colors.primaryFg : C.textSecondary }]}>{sv.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[s.label, { marginTop: Spacing.md }]}>QUANTITY</Text>
            <View style={s.qtyRow}>
              <Pressable onPress={() => { setQty((q) => Math.max(0.5, Math.round((q - 0.5) * 2) / 2)); haptics.tick(); }} style={[s.stepBtn, { borderColor: C.border }]}>
                <Feather name="minus" size={16} color={C.textSecondary} />
              </Pressable>
              <Text style={s.qtyTxt}>{qty}</Text>
              <Pressable onPress={() => { setQty((q) => Math.min(50, q + 0.5)); haptics.tick(); }} style={[s.stepBtn, { borderColor: C.border }]}>
                <Feather name="plus" size={16} color={C.textSecondary} />
              </Pressable>
            </View>

            {preview && (
              <View style={s.preview}>
                <View><Text style={s.previewNum}>{Math.round(preview.kcal)}</Text><Text style={s.previewLbl}>calories</Text></View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[s.previewNum, { color: Colors.macro.protein }]}>{Math.round(preview.protein_g)} g</Text>
                  <Text style={s.previewLbl}>protein</Text>
                </View>
              </View>
            )}

            <Pressable onPress={add} disabled={busy} style={[s.addBtn, { opacity: busy ? 0.6 : 1 }]}>
              <Text style={s.addBtnTxt}>{busy ? 'Adding…' : `Add to ${MEAL_LABEL[mealType]}`}</Text>
            </Pressable>
          </View>
        )}
      </Animated.View>
    </Portal>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    backdrop: { ...StyleSheet.absoluteFillObject },
    sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 24, borderTopRightRadius: 24, ...Shadow.elevated },
    handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md },
    header2: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: Spacing.md },
    title: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: C.foreground },
    close: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.xl, borderWidth: 1, borderRadius: Radius.lg, paddingHorizontal: Spacing.md, paddingVertical: 10, marginBottom: Spacing.sm },
    searchInput: { flex: 1, fontSize: FontSize.base, color: C.foreground, padding: 0 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: Spacing.xl, borderBottomWidth: 1, borderBottomColor: C.borderSubtle },
    rowName: { fontSize: FontSize.base, fontWeight: FontWeight.medium, color: C.foreground },
    rowMeta: { fontSize: FontSize.sm, color: C.textMuted, marginTop: 1, fontVariant: ['tabular-nums'] },
    empty: { textAlign: 'center', marginTop: 24, fontSize: FontSize.sm, color: C.textDim },
    label: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase', color: C.textDim, marginBottom: 6 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: Radius.full, borderWidth: 1 },
    chipTxt: { fontSize: 12, fontWeight: FontWeight.semibold },
    qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 18 },
    stepBtn: { width: 38, height: 38, borderRadius: Radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    qtyTxt: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: C.foreground, fontVariant: ['tabular-nums'], minWidth: 28, textAlign: 'center' },
    preview: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: Spacing.lg, paddingTop: Spacing.md, borderTopWidth: 1, borderTopColor: C.borderSubtle },
    previewNum: { fontSize: FontSize.xxl, fontWeight: FontWeight.black, color: C.foreground, letterSpacing: LetterSpacing.tight, fontVariant: ['tabular-nums'] },
    previewLbl: { fontSize: FontSize.sm, color: C.textMuted },
    addBtn: { height: 48, borderRadius: Radius.xl, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.lg },
    addBtnTxt: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  });
}
