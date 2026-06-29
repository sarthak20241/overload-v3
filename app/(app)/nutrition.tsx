/**
 * Nutrition day view — the diet "diary" + journal in one screen.
 *
 * Structure = MyFitnessPal meal sections (Breakfast / Lunch / Dinner / Snacks),
 * each with its entries + subtotal, under a co-equal calories + protein summary
 * (MacroRing). Logging = the inline "Tell Drona what you ate" input at the bottom
 * (Journable model): you type/speak plain words, the entry resolves in place, and
 * tapping an entry shows Drona's read. Calm/mature system: Inter (system fallback
 * for now), tabular figures, Colors.macro register, lime reserved for the action.
 *
 * v1 renders with sample data so the layout is verifiable on-device; the Supabase
 * day-load + the NL parse (Drona edge fn) wire in next.
 */
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import {
  Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow,
} from '@/constants/theme';
import { MacroRing } from '@/components/ui/MacroRing';
import { MacroBar } from '@/components/diet/MacroBar';
import { useTodayNutrition, setLogMeal } from '@/lib/dietData';
import type { MealType } from '@/lib/foods';

const fmtK = (n: number) => Math.round(n).toLocaleString();
const calCaption = (eaten: number, goal: number) =>
  eaten > goal
    ? `${fmtK(eaten)} / ${fmtK(goal)} · +${fmtK(eaten - goal)} kcal`
    : `${fmtK(eaten)} / ${fmtK(goal)} kcal`;

/** Open the full-screen food search targeting a meal (MFP model, not a drawer).
 *  The target meal goes through setLogMeal (a module store the screens read on
 *  focus) because food-search is a retained Tabs screen and router params went
 *  stale across re-opens — which made every log land in breakfast. */
function openSearch(meal: MealType) {
  setLogMeal(meal);
  router.push({ pathname: '/food-search', params: { meal } });
}

interface MealDef { type: MealType; label: string; icon: keyof typeof Feather.glyphMap }

const MEALS: MealDef[] = [
  { type: 'breakfast', label: 'Breakfast', icon: 'sunrise' },
  { type: 'lunch', label: 'Lunch', icon: 'sun' },
  { type: 'dinner', label: 'Dinner', icon: 'sunset' },
  { type: 'snack', label: 'Snacks', icon: 'coffee' },
];

// Daily targets — hardcoded for now; reads from user_profiles next.
const TARGETS = { kcal: 2000, protein: 125, carb: 250, fat: 56 };

const round = (n: number) => Math.round(n);

export default function NutritionScreen() {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { byMeal, totals } = useTodayNutrition();

  const eaten = { kcal: totals.kcal, protein: totals.protein_g, carb: totals.carb_g, fat: totals.fat_g };

  const s = makeStyles(C);

  return (
    <View style={[s.root, { backgroundColor: C.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + Spacing.sm, paddingBottom: 150 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={s.header}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={s.back}>
            <Feather name="chevron-left" size={22} color={C.foreground} />
          </Pressable>
          <Text style={s.title}>Today</Text>
          <View style={s.streak}>
            <Feather name="zap" size={12} color={Colors.macro.protein} />
            <Text style={s.streakTxt}>3</Text>
          </View>
        </View>

        {/* Summary — calorie hero ring (LEFT + eaten/goal caption below + same-hue
            overshoot) and three macro bars carrying target + signed over. */}
        <View style={s.summary}>
          <View style={{ alignItems: 'center' }}>
            <MacroRing
              value={eaten.kcal} target={TARGETS.kcal} color={C.macro.calories} valueColor={C.macro.calories}
              display="remaining" overshoot name="Calories" size={132} thickness={9} centerFontSize={32}
              belowCaption={calCaption(eaten.kcal, TARGETS.kcal)}
            />
          </View>
          <View style={s.macroRail}>
            <MacroBar verbose label="Protein" name="Protein" value={eaten.protein} target={TARGETS.protein} color={C.macro.protein} delayMs={0} />
            <MacroBar verbose label="Carbs" name="Carbs" value={eaten.carb} target={TARGETS.carb} color={C.macro.carbs} delayMs={70} />
            <MacroBar verbose label="Fat" name="Fat" value={eaten.fat} target={TARGETS.fat} color={C.macro.fat} delayMs={140} />
          </View>
        </View>

        {/* Drona line */}
        <View style={s.drona}>
          <View style={s.avatar}><Feather name="zap" size={11} color={C.accentText} /></View>
          <Text style={s.dronaTxt}>Good start. Get one more protein hit in at lunch and you're on pace.</Text>
        </View>

        {/* Meal sections */}
        {MEALS.map((m) => {
          const entries = byMeal[m.type];
          const sub = entries.reduce((a, e) => ({ kcal: a.kcal + e.kcal, protein: a.protein + e.protein_g }), { kcal: 0, protein: 0 });
          return (
            <View key={m.type} style={s.section}>
              <View style={s.sectionHead}>
                <Feather name={m.icon} size={13} color={C.textDim} />
                <Text style={s.sectionLabel}>{m.label}</Text>
                <View style={{ flex: 1 }} />
                {entries.length > 0 && (
                  <Text style={s.sectionSub}>{round(sub.protein)}g P · {round(sub.kcal)}</Text>
                )}
              </View>

              {entries.map((e) => (
                <View key={e.id} style={s.entry}>
                  <Text style={s.entryName}>
                    {e.food_name} <Text style={s.serving}>· {e.quantity !== 1 ? `${e.quantity} × ` : ''}{e.serving_unit}</Text>
                  </Text>
                  <View style={s.macros}>
                    <Text style={[s.macroNum, { color: C.foreground }]}>{round(e.kcal)}</Text>
                    <Text style={[s.macroNum, { color: C.macro.protein }]}>{round(e.protein_g)}g P</Text>
                    <Text style={[s.macroNum, { color: C.macro.carbs }]}>{round(e.carb_g)} C</Text>
                    <Text style={[s.macroNum, { color: C.macro.fat }]}>{round(e.fat_g)} F</Text>
                  </View>
                </View>
              ))}

              <Pressable style={s.add} hitSlop={8} onPress={() => openSearch(m.type)}>
                <Feather name="plus" size={14} color={C.accentText} />
                <Text style={s.addTxt}>Add to {m.label.toLowerCase()}</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      {/* Bottom logging bar — opens the full-screen search. Becomes the Drona NL
          input once the parse edge fn lands. */}
      <View style={[s.inputWrap, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable style={s.input} onPress={() => openSearch('snack')}>
          <Feather name="plus-circle" size={16} color={C.accentText} />
          <Text style={[s.inputText, { color: C.textDim }]}>Tell Drona what you ate</Text>
          <Feather name="camera" size={16} color={C.textSecondary} style={{ marginHorizontal: 4 }} />
          <Feather name="mic" size={16} color={C.textSecondary} />
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, height: 44 },
    back: { width: 32, height: 32, justifyContent: 'center', marginLeft: -8 },
    title: { fontSize: FontSize.xl, fontWeight: FontWeight.black, letterSpacing: LetterSpacing.tight, color: C.foreground },
    streak: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 'auto' },
    streakTxt: { fontSize: FontSize.sm, color: C.textSecondary, fontVariant: ['tabular-nums'], fontWeight: FontWeight.semibold },

    summary: { marginHorizontal: Spacing.xl, marginTop: Spacing.sm, backgroundColor: C.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: C.borderSubtle, padding: Spacing.lg, ...Shadow.card },
    macroRail: { marginTop: Spacing.lg, gap: 11 },

    drona: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: Spacing.xl, marginTop: Spacing.md },
    avatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.primarySubtle, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    dronaTxt: { flex: 1, fontSize: FontSize.sm, lineHeight: 18, color: C.textSecondary },

    section: { marginTop: Spacing.xl, paddingHorizontal: Spacing.xl },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.xs },
    sectionLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase', color: C.textDim },
    sectionSub: { fontSize: 11, color: C.textMuted, fontVariant: ['tabular-nums'] },

    entry: { backgroundColor: C.card, borderRadius: Radius.md, borderWidth: 1, borderColor: C.borderSubtle, padding: Spacing.md, marginTop: Spacing.sm, ...Shadow.card },
    raw: { fontSize: 10, color: C.textDim, marginBottom: 1 },
    entryName: { fontSize: FontSize.base, fontWeight: FontWeight.medium, color: C.foreground },
    serving: { fontSize: FontSize.sm, color: C.textMuted, fontWeight: FontWeight.regular },
    macros: { flexDirection: 'row', gap: Spacing.md, marginTop: 6 },
    macroNum: { fontSize: 11, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
    analysing: { flexDirection: 'row', alignItems: 'center' },
    analysingTxt: { fontSize: FontSize.sm, color: C.textSecondary },

    add: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: Spacing.sm, paddingLeft: 2 },
    addTxt: { fontSize: FontSize.sm, color: C.accentText, fontWeight: FontWeight.medium },

    inputWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, backgroundColor: C.background },
    input: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: Radius.lg, paddingHorizontal: Spacing.md, paddingVertical: 10, ...Shadow.card },
    inputText: { flex: 1, fontSize: FontSize.base, color: C.foreground, padding: 0 },
  });
}
