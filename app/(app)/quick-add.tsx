/**
 * Quick add — log calories you already know, with no catalog match behind them.
 *
 * The escape hatch beside the catalog (MyFitnessPal's "Quick add", the one thing
 * every tracker needs): a restaurant plate, a home dish, a label in your hand.
 * Title is optional and falls back to "Quick add"; calories are the only thing
 * required; protein/carbs/fat are there if you have them. A switch also keeps it
 * in My Meals, so a dish you eat weekly is typed once and re-logged in one tap.
 *
 * Reached from food-search (the All tab's header row, and the no-match empty
 * state). The target meal + day come from the same module store every other
 * logging screen reads on focus, so a quick add on a past day lands on that day.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Switch, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { track } from '@/lib/analytics';
import { useSupabaseClient } from '@/lib/supabase';
import {
  logQuickAdd, createSavedMeal, quickAddToItem, quickAddName,
  getLogMeal, setLogMeal, takeQuickAddSeed, macroKcal, QUICK_ADD_NAME,
  type QuickAddDraft,
} from '@/lib/dietData';
import { haptics } from '@/lib/haptics';
import type { MealType } from '@/lib/foods';

const MEALS: { type: MealType; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { type: 'breakfast', label: 'Breakfast', icon: 'sunrise' },
  { type: 'lunch', label: 'Lunch', icon: 'sun' },
  { type: 'dinner', label: 'Dinner', icon: 'sunset' },
  { type: 'snack', label: 'Snacks', icon: 'coffee' },
];
const labelOf = (m: MealType) => MEALS.find((x) => x.type === m)?.label ?? 'Meal';
const round = (n: number) => Math.round(n);

/** Digits with at most ONE decimal point (a plain [^0-9.] strip lets "1.2.3"
 *  through, which parseFloat quietly reads as 1.2). Same rule as EntryEditSheet. */
const sanitize = (raw: string, maxLen: number) => {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const first = cleaned.indexOf('.');
  if (first === -1) return cleaned.slice(0, maxLen);
  return (cleaned.slice(0, first + 1) + cleaned.slice(first + 1).replace(/\./g, '')).slice(0, maxLen);
};

/** A typed macro field: blank means "I don't know", which is NOT 0 — it's what
 *  keeps the calorie cross-check below from comparing against numbers nobody
 *  entered. (The diary column itself is NOT NULL, so the writer stores 0.) */
const macroOf = (raw: string): number | null => {
  const t = raw.trim();
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export default function QuickAddScreen() {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const supabase = useSupabaseClient();

  const [meal, setMeal] = useState<MealType>(getLogMeal());

  const [name, setName] = useState('');
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carb, setCarb] = useState('');
  const [fat, setFat] = useState('');
  const [saveAsMeal, setSaveAsMeal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the entry is in the diary. The screen stays put (so a failed
  // "save to My Meals" can be told honestly) and the action becomes "Done" —
  // never a second button that would log the same food twice.
  const [logged, setLogged] = useState(false);
  const kcalRef = useRef<TextInput>(null);

  // This is a RETAINED Tabs screen, so every re-open would otherwise show the
  // last quick add's numbers. Start each visit clean: the target meal re-read
  // from the store (params go stale — the bug that used to land every log in
  // breakfast), the title seeded from the search that came up empty, the
  // amounts blank, and the calorie field focused.
  useFocusEffect(useCallback(() => {
    setMeal(getLogMeal());
    setName(takeQuickAddSeed());
    setKcal(''); setProtein(''); setCarb(''); setFat('');
    setSaveAsMeal(false); setBusy(false); setError(null); setLogged(false);
    const t = setTimeout(() => kcalRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, []));
  const draft: QuickAddDraft = useMemo(() => ({
    name,
    kcal: parseFloat(kcal) || 0,
    protein_g: macroOf(protein), carb_g: macroOf(carb), fat_g: macroOf(fat),
  }), [name, kcal, protein, carb, fat]);

  const kcalNum = draft.kcal;
  const anyMacro = draft.protein_g != null || draft.carb_g != null || draft.fat_g != null;
  // What the macros themselves come to (4/4/9). Shown as a quiet cross-check,
  // never a blocker: a partial entry (protein only) is a legitimate quick add.
  const fromMacros = anyMacro
    ? macroKcal({ protein: draft.protein_g ?? 0, carb: draft.carb_g ?? 0, fat: draft.fat_g ?? 0 })
    : 0;
  const mismatch = anyMacro && kcalNum > 0 && Math.abs(fromMacros - kcalNum) > Math.max(50, kcalNum * 0.2);

  const canLog = kcalNum > 0 && !busy && !!supabase;

  async function submit() {
    if (logged) { router.navigate('/nutrition'); return; }
    if (!canLog || !supabase) return;
    setBusy(true);
    setError(null);
    try {
      const { error: logErr } = await logQuickAdd(supabase, { mealType: meal, draft });
      if (logErr) {
        // The writer's message is a Postgres error, not copy. Say what the user
        // can act on and leave the entry un-logged so the button still works.
        haptics.warning();
        setError('Could not add that. Check your connection and try again.');
        return;
      }
      haptics.success();
      setLogged(true);

      if (saveAsMeal) {
        const item = quickAddToItem(draft, meal);
        const { error: saveErr } = await createSavedMeal(supabase, {
          name: quickAddName(draft), kind: 'meal', servings: 1, serving_label: null, items: [item],
        });
        if (saveErr) {
          // The diary write already landed, so this is not a failed log — say
          // exactly what did and didn't happen instead of retrying either half.
          haptics.warning();
          setError('Logged it, but could not keep it in My Meals.');
          return;
        }
        track('saved_meal_saved', { mode: 'create', source: 'quick_add', item_count: 1, kcal: round(kcalNum) });
      }
      // Back to the diary, like every other log path in this flow.
      router.navigate('/nutrition');
    } catch {
      haptics.warning();
      setError('Could not add that. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const s = makeStyles(C);

  const macroField = (
    label: string, color: string, value: string, set: (v: string) => void,
  ) => (
    <View style={s.macroField}>
      <Text style={[s.macroLabel, { color }]}>{label}</Text>
      <View style={[s.macroInputWrap, { borderColor: C.border, backgroundColor: C.inputBg }]}>
        <TextInput
          value={value}
          onChangeText={(t) => set(sanitize(t, 6))}
          placeholder="—"
          placeholderTextColor={C.textDim}
          keyboardType="decimal-pad"
          style={s.macroInput}
          selectTextOnFocus
          accessibilityLabel={`${label} in grams, optional`}
        />
        <Text style={s.macroUnit}>g</Text>
      </View>
    </View>
  );

  return (
    <View style={[s.root, { backgroundColor: C.background, paddingTop: insets.top }]}>
      <View style={s.header}>
        {/* Reached from food-search; the (app) group is a Tabs navigator, so
            navigate() returns there (back() would pop to the Dashboard). */}
        <Pressable onPress={() => router.navigate('/food-search')} hitSlop={12} style={s.hBtn}>
          <Feather name="chevron-left" size={24} color={C.foreground} />
        </Pressable>
        <Text style={s.hTitle}>Quick add</Text>
        <View style={s.hBtn} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.lede}>
          Calories you already know — a restaurant plate, a home dish, a label in your hand.
        </Text>

        {/* Title — optional. Blank logs as "Quick add". */}
        <Text style={s.eyebrow}>Title</Text>
        <TextInput
          style={[s.nameInput, { color: C.foreground, backgroundColor: C.inputBg, borderColor: C.border }]}
          value={name}
          onChangeText={setName}
          placeholder={QUICK_ADD_NAME}
          placeholderTextColor={C.textDim}
          maxLength={60}
          returnKeyType="done"
          accessibilityLabel={`Title, optional. Defaults to ${QUICK_ADD_NAME}.`}
        />

        {/* Calories — the one required number. */}
        <Text style={s.eyebrow}>Calories</Text>
        <View style={[s.kcalWrap, { borderColor: kcalNum > 0 ? C.primaryBorder : C.border, backgroundColor: C.inputBg }]}>
          <TextInput
            ref={kcalRef}
            value={kcal}
            onChangeText={(t) => { setKcal(sanitize(t, 5)); setError(null); }}
            placeholder="0"
            placeholderTextColor={C.textDim}
            keyboardType="number-pad"
            style={s.kcalInput}
            selectTextOnFocus
            accessibilityLabel="Calories, required"
          />
          <Text style={s.kcalUnit}>cal</Text>
        </View>

        {/* Macros — optional, each independently. */}
        <Text style={s.eyebrow}>Macros <Text style={s.eyebrowSoft}>· optional</Text></Text>
        <View style={s.macroRow}>
          {macroField('Protein', C.macro.protein, protein, setProtein)}
          {macroField('Carbs', C.macro.carbs, carb, setCarb)}
          {macroField('Fat', C.macro.fat, fat, setFat)}
        </View>
        {anyMacro && (
          <View style={s.macroSumRow}>
            <Text style={s.macroSum}>
              Those macros come to {round(fromMacros)} cal
              {mismatch ? ` — you entered ${round(kcalNum)}. Yours is what gets logged.` : '.'}
            </Text>
            {/* Typed the macros off a label and not the calories: offer the 4/4/9
                number rather than making them do the arithmetic. */}
            {kcalNum <= 0 && fromMacros > 0 && (
              <Pressable onPress={() => { setKcal(String(round(fromMacros))); haptics.tick(); }} hitSlop={10}>
                <Text style={s.macroSumUse}>Use it</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Meal */}
        <Text style={s.eyebrow}>Meal</Text>
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

        {/* Keep it for next time */}
        <View style={[s.toggleRow, { borderColor: C.borderSubtle, backgroundColor: C.card }]}>
          <View style={[s.rowIcon, { backgroundColor: saveAsMeal ? C.primarySubtle : C.muted }]}>
            <Feather name="bookmark" size={11} color={saveAsMeal ? C.accentText : C.textSecondary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.rowTitle}>Save it as a meal</Text>
            <Text style={s.rowSub}>Keeps it in My Meals, so next time is one tap.</Text>
          </View>
          <Switch
            value={saveAsMeal}
            onValueChange={(v) => { haptics.selection(); setSaveAsMeal(v); }}
            trackColor={{ true: Colors.primary, false: C.border }}
            thumbColor={Platform.OS === 'android' ? (saveAsMeal ? Colors.primaryFg : '#f4f4f5') : undefined}
            ios_backgroundColor={C.border}
            accessibilityLabel="Save it as a meal, so you can re-log it in one tap"
          />
        </View>

        {error && <Text style={[s.error, { color: C.textMuted }]}>{error}</Text>}

        <Pressable onPress={submit} disabled={!logged && !canLog} style={[s.cta, { opacity: logged || canLog ? 1 : 0.4 }]}>
          <Text style={s.ctaTxt}>
            {logged ? 'Done' : busy ? 'Adding…' : `Add to ${labelOf(meal)}`}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, height: 48 },
    hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    hTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, letterSpacing: LetterSpacing.snug, color: C.foreground },

    lede: { fontSize: FontSize.sm, color: C.textMuted, lineHeight: 19, paddingHorizontal: Spacing.xl, marginTop: Spacing.xs },

    eyebrow: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase', color: C.textDim, paddingHorizontal: Spacing.xl, marginTop: Spacing.xl, marginBottom: Spacing.sm },
    eyebrowSoft: { fontWeight: FontWeight.regular, textTransform: 'none', letterSpacing: 0 },

    nameInput: { marginHorizontal: Spacing.xl, borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: Spacing.md, height: 46, fontSize: FontSize.base, fontWeight: FontWeight.medium },

    kcalWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.xl, borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: Spacing.md, height: 60 },
    kcalInput: { flex: 1, fontSize: 30, fontWeight: FontWeight.black, letterSpacing: LetterSpacing.tight, color: C.foreground, padding: 0, fontVariant: ['tabular-nums'] },
    kcalUnit: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: C.textMuted },

    macroRow: { flexDirection: 'row', gap: Spacing.md, paddingHorizontal: Spacing.xl },
    macroField: { flex: 1, gap: 6 },
    macroLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
    macroInputWrap: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: Spacing.md, height: 46 },
    macroInput: { flex: 1, fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: C.foreground, padding: 0, fontVariant: ['tabular-nums'] },
    macroUnit: { fontSize: FontSize.sm, color: C.textMuted },
    macroSumRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.xl, marginTop: Spacing.sm },
    macroSum: { flex: 1, fontSize: FontSize.sm, color: C.textMuted, lineHeight: 18 },
    macroSumUse: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: C.accentText },

    mealChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: Spacing.xl },
    mealChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: Radius.full, borderWidth: 1 },
    mealChipTxt: { fontSize: 12, fontWeight: FontWeight.semibold },

    toggleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginHorizontal: Spacing.xl, marginTop: Spacing.xl, paddingHorizontal: Spacing.md, paddingVertical: Spacing.md, borderWidth: 1, borderRadius: Radius.lg },
    rowIcon: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: C.foreground },
    rowSub: { fontSize: FontSize.sm, color: C.textSecondary, marginTop: 2, lineHeight: 17 },

    error: { fontSize: FontSize.sm, paddingHorizontal: Spacing.xl, marginTop: Spacing.md, lineHeight: 18 },

    cta: { height: 52, borderRadius: Radius.xl, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', marginHorizontal: Spacing.xl, marginTop: Spacing.xl },
    ctaTxt: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  });
}
