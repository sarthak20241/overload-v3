/**
 * Food detail / "Add Food" — full screen (MyFitnessPal model).
 *
 * The considered log path: pick a serving + quantity, see the food's full
 * composition (calorie donut + carb/fat/protein split by calorie share + a real
 * Nutrition Facts panel with fiber / sugar / saturated fat / sodium), retarget the
 * meal, then commit with the one lime action. Everything scales live with the
 * serving × quantity. Reached from food-search; the food is passed as a JSON param
 * so this screen is stateless and deep-linkable. Calm/mature system throughout.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow } from '@/constants/theme';
import { FoodCompositionCard, NutritionFactsPanel } from '@/components/diet/FoodFacts';
import { useSupabaseClient } from '@/lib/supabase';
import { loadServings, logFood, logParsedMeal, getLogMeal, setLogMeal, type PickerFood, type ParsedMealItem } from '@/lib/dietData';
import {
  defaultServing, nutrientsForAmount, resolveBaseAmount,
  type FoodServing, type MealType,
} from '@/lib/foods';
import { haptics } from '@/lib/haptics';

const MEALS: { type: MealType; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { type: 'breakfast', label: 'Breakfast', icon: 'sunrise' },
  { type: 'lunch', label: 'Lunch', icon: 'sun' },
  { type: 'dinner', label: 'Dinner', icon: 'sunset' },
  { type: 'snack', label: 'Snacks', icon: 'coffee' },
];
const labelOf = (m: MealType) => MEALS.find((x) => x.type === m)?.label ?? 'Meal';
const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

export default function FoodDetailScreen() {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const supabase = useSupabaseClient();
  const params = useLocalSearchParams<{ meal?: string; food?: string; source?: string; assumption?: string }>();

  const food = useMemo<PickerFood | null>(() => {
    try { return params.food ? JSON.parse(decodeURIComponent(params.food)) : null; } catch { return null; }
  }, [params.food]);

  // Set when the food came from Drona's fallback (off/web/estimate) rather than a
  // catalog tap — drives the provenance badge and logs the entry as AI-found.
  const aiSource = (params.source as 'off' | 'web' | 'estimate' | undefined) || null;
  const provenance =
    aiSource === 'off' ? 'Drona found this on a product label'
    : aiSource === 'web' ? 'Drona found this on the web'
    : aiSource === 'estimate' ? "Drona's estimate — numbers are approximate"
    : null;

  const [meal, setMeal] = useState<MealType>(getLogMeal());
  // Sync the target meal from the store on focus (params go stale on this retained
  // screen). setMeal stays the source of truth for what the chips show + what logs.
  useFocusEffect(useCallback(() => { setMeal(getLogMeal()); }, []));
  const [servings, setServings] = useState<FoodServing[]>(food?.servings ?? []);
  const [servingLabel, setServingLabel] = useState<string>('');
  const [qty, setQty] = useState('1');
  const [busy, setBusy] = useState(false);
  const [loadingServ, setLoadingServ] = useState(true);

  useEffect(() => {
    if (!food) { setLoadingServ(false); return; }
    let on = true;
    (async () => {
      try {
        const s = await loadServings(supabase, food);
        if (!on) return;
        setServings(s);
        setServingLabel(defaultServing({ ...food, servings: s }).label);
      } finally {
        // Always drop the spinner, even if loadServings rejects — otherwise the
        // serving chips stay in a permanent loading state for this screen.
        if (on) setLoadingServ(false);
      }
    })();
    return () => { on = false; };
  }, [food, supabase]);

  const qtyNum = Math.max(parseFloat(qty) || 0, 0);

  const nutr = useMemo(() => {
    if (!food) return null;
    const grams = resolveBaseAmount({ ...food, servings }, servingLabel, qtyNum || 0) ?? 100 * (qtyNum || 0);
    return { grams, n: nutrientsForAmount(food, grams) };
  }, [food, servings, servingLabel, qtyNum]);

  if (!food) {
    return (
      <View style={{ flex: 1, backgroundColor: C.background, paddingTop: insets.top }}>
        <Pressable onPress={() => router.back()} style={{ padding: Spacing.xl }}>
          <Feather name="chevron-left" size={24} color={C.foreground} />
        </Pressable>
        <Text style={{ color: C.textMuted, textAlign: 'center', marginTop: 40 }}>Food not found.</Text>
      </View>
    );
  }

  const n = nutr!.n;

  function step(delta: number) {
    const next = Math.min(Math.max(r1((qtyNum || 0) + delta), 0.1), 999);
    setQty(String(next));
    haptics.tick();
  }

  async function add() {
    if (busy || !supabase || qtyNum <= 0) return;
    setBusy(true);
    try {
      let error: string | undefined;
      if (aiSource) {
        // AI-found food: log through the parse path so the entry is marked
        // logged_via='ai' and its source (off/web/estimate) is persisted on the
        // meal_entries snapshot (migration 0076). assumption is carried on the
        // item only for shape parity with the parser; it isn't stored.
        const item: ParsedMealItem = {
          food_id: food!.id ?? null, food_name: food!.name, quantity: qtyNum,
          serving_label: servingLabel, grams: nutr!.grams,
          kcal: n.kcal, protein_g: n.protein_g, carb_g: n.carb_g, fat_g: n.fat_g, fiber_g: n.fiber_g ?? null,
          source: aiSource, assumption: params.assumption || null,
          confidence: aiSource === 'estimate' ? 'low' : aiSource === 'web' ? 'medium' : 'high',
        };
        ({ error } = await logParsedMeal(supabase, { meal_type: meal, items: [item], drona_line: '' }));
      } else {
        ({ error } = await logFood(supabase, {
          mealType: meal,
          food: { ...food!, servings },
          servingLabel,
          quantity: qtyNum,
        }));
      }
      if (error) { haptics.warning(); return; }
      haptics.success();
      // Return to the day view (MFP: logging a food returns you to the diary). The
      // (app) group is a Tabs navigator, so navigate() jumps back to the nutrition
      // tab (dismissTo is Stack-only and no-ops here); it refetches on focus.
      router.navigate('/nutrition');
    } catch {
      haptics.warning();
    } finally {
      // Re-enable the button whether the write succeeded, errored, or threw.
      setBusy(false);
    }
  }

  const s = makeStyles(C);

  return (
    <View style={[s.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={s.back}>
          <Feather name="chevron-left" size={24} color={C.foreground} />
        </Pressable>
        <Text style={s.headerTitle}>Add Food</Text>
        <View style={s.back} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 110 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={s.title}>{food.name}</Text>

        {provenance && (
          <View style={[s.provenance, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}>
            <Feather name="zap" size={12} color={C.accentText} />
            <Text style={[s.provenanceTxt, { color: C.accentText }]}>{provenance}</Text>
          </View>
        )}

        {/* Composition: donut + macro split */}
        <FoodCompositionCard n={n} C={C} />

        {/* Serving size */}
        <Text style={s.eyebrow}>Serving size</Text>
        {loadingServ ? (
          <ActivityIndicator color={C.textMuted} style={{ alignSelf: 'flex-start', marginLeft: Spacing.xl }} />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow} keyboardShouldPersistTaps="handled">
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
          </ScrollView>
        )}

        {/* Number of servings */}
        <Text style={[s.eyebrow, { marginTop: Spacing.lg }]}>Number of servings</Text>
        <View style={s.qtyRow}>
          <Pressable onPress={() => step(-0.5)} style={[s.stepBtn, { borderColor: C.border }]} hitSlop={6}>
            <Feather name="minus" size={18} color={C.textSecondary} />
          </Pressable>
          <TextInput
            value={qty}
            onChangeText={(t) => setQty(t.replace(/[^0-9.]/g, ''))}
            keyboardType="decimal-pad"
            style={[s.qtyInput, { borderColor: C.border, color: C.foreground }]}
            selectTextOnFocus
          />
          <Pressable onPress={() => step(0.5)} style={[s.stepBtn, { borderColor: C.border }]} hitSlop={6}>
            <Feather name="plus" size={18} color={C.textSecondary} />
          </Pressable>
          <Text style={s.qtyHint}>× {servingLabel}{nutr!.grams > 0 ? `  ·  ${r0(nutr!.grams)} ${food.base_unit}` : ''}</Text>
        </View>

        {/* Meal */}
        <Text style={[s.eyebrow, { marginTop: Spacing.lg }]}>Meal</Text>
        <View style={s.mealChips}>
          {MEALS.map((m) => {
            const active = m.type === meal;
            return (
              <Pressable
                key={m.type}
                onPress={() => { setMeal(m.type); setLogMeal(m.type); haptics.tick(); }}
                style={[s.mealChip, { borderColor: active ? Colors.primary : C.border, backgroundColor: active ? Colors.primary : 'transparent' }]}
              >
                <Feather name={m.icon} size={12} color={active ? Colors.primaryFg : C.textSecondary} />
                <Text style={[s.mealChipTxt, { color: active ? Colors.primaryFg : C.textSecondary }]}>{m.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {/* Nutrition facts */}
        <Text style={[s.eyebrow, { marginTop: Spacing.xl }]}>Nutrition facts</Text>
        <NutritionFactsPanel n={n} C={C} />
      </ScrollView>

      {/* Commit */}
      <View style={[s.footer, { paddingBottom: insets.bottom + 12, backgroundColor: C.background, borderTopColor: C.borderSubtle }]}>
        <Pressable onPress={add} disabled={busy || qtyNum <= 0} style={[s.addBtn, { opacity: busy || qtyNum <= 0 ? 0.5 : 1 }]}>
          <Text style={s.addBtnTxt}>{busy ? 'Adding…' : `Add to ${labelOf(meal)}`}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, height: 48 },
    back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
    headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: C.foreground },

    title: { fontSize: FontSize.xxl, fontWeight: FontWeight.black, letterSpacing: LetterSpacing.tight, color: C.foreground, paddingHorizontal: Spacing.xl, marginTop: Spacing.sm },
    provenance: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginHorizontal: Spacing.xl, marginTop: Spacing.sm, paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.full, borderWidth: 1 },
    provenanceTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },

    eyebrow: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase', color: C.textDim, paddingHorizontal: Spacing.xl, marginTop: Spacing.xl, marginBottom: Spacing.sm },

    chipRow: { paddingHorizontal: Spacing.xl, gap: 8 },
    chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.full, borderWidth: 1 },
    chipTxt: { fontSize: 13, fontWeight: FontWeight.semibold },

    qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: Spacing.xl },
    stepBtn: { width: 40, height: 40, borderRadius: Radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    qtyInput: { width: 72, height: 40, borderWidth: 1, borderRadius: Radius.md, textAlign: 'center', fontSize: FontSize.lg, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
    qtyHint: { flex: 1, fontSize: FontSize.sm, color: C.textMuted, fontVariant: ['tabular-nums'] },

    mealChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: Spacing.xl },
    mealChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: Radius.full, borderWidth: 1 },
    mealChipTxt: { fontSize: 12, fontWeight: FontWeight.semibold },

    facts: { marginHorizontal: Spacing.xl, backgroundColor: C.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: C.borderSubtle, ...Shadow.card },

    footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, borderTopWidth: 1 },
    addBtn: { height: 52, borderRadius: Radius.xl, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
    addBtnTxt: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  });
}
