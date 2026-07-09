/**
 * Shared food-composition UI — the macro ring + calorie-share split, and the full
 * Nutrition Facts panel (fiber / sugar / sat fat / sodium). Used by BOTH the
 * food-detail "Add Food" screen and the meal/recipe builder's portion picker so a
 * food looks and reads identically wherever you're about to add it. Pass resolved
 * (already scaled to the chosen serving × quantity) nutrients.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Spacing, Radius, FontSize, FontWeight, Shadow } from '@/constants/theme';
import { MacroDonut } from '@/components/diet/MacroDonut';
import type { useTheme } from '@/hooks/useTheme';
import type { ResolvedNutrients } from '@/lib/foods';

type C = ReturnType<typeof useTheme>['C'];
const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Donut + carbs/fat/protein split, each with its calorie-share % and gram weight. */
export function FoodCompositionCard({ n, C }: { n: ResolvedNutrients; C: C }) {
  const kcalC = Math.max(n.carb_g, 0) * 4;
  const kcalF = Math.max(n.fat_g, 0) * 9;
  const kcalP = Math.max(n.protein_g, 0) * 4;
  const tot = kcalC + kcalF + kcalP || 1;
  const pct = (x: number) => `${Math.round((x / tot) * 100)}%`;
  return (
    <View style={[s.compCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
      <MacroDonut kcal={n.kcal} protein_g={n.protein_g} carb_g={n.carb_g} fat_g={n.fat_g} size={116} thickness={12} />
      <View style={s.macroCols}>
        <MacroCol pctTxt={pct(kcalC)} grams={`${r0(n.carb_g)}g`} label="Carbs" color={C.macro.carbs} C={C} />
        <MacroCol pctTxt={pct(kcalF)} grams={`${r0(n.fat_g)}g`} label="Fat" color={C.macro.fat} C={C} />
        <MacroCol pctTxt={pct(kcalP)} grams={`${r0(n.protein_g)}g`} label="Protein" color={C.macro.protein} C={C} />
      </View>
    </View>
  );
}

/** The Nutrition Facts card: calories + the extended nutrient tail (micros). */
export function NutritionFactsPanel({ n, C }: { n: ResolvedNutrients; C: C }) {
  return (
    <View style={[s.facts, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
      <FactRow label="Calories" value={r0(n.kcal).toLocaleString()} bold C={C} />
      <FactRow label="Total Fat" value={`${r1(n.fat_g)} g`} C={C} />
      <FactRow label="Saturated Fat" value={`${r1(n.sat_fat_g)} g`} indent C={C} />
      <FactRow label="Total Carbohydrate" value={`${r1(n.carb_g)} g`} C={C} />
      <FactRow label="Dietary Fiber" value={`${r1(n.fiber_g)} g`} indent C={C} />
      <FactRow label="Sugars" value={`${r1(n.sugar_g)} g`} indent C={C} />
      <FactRow label="Protein" value={`${r1(n.protein_g)} g`} bold C={C} />
      <FactRow label="Sodium" value={`${r0(n.sodium_mg)} mg`} last C={C} />
    </View>
  );
}

function MacroCol({ pctTxt, grams, label, color, C }: { pctTxt: string; grams: string; label: string; color: string; C: C }) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={{ fontSize: FontSize.sm, fontWeight: FontWeight.bold, color, fontVariant: ['tabular-nums'] }}>{pctTxt}</Text>
      <Text style={{ fontSize: FontSize.lg, fontWeight: FontWeight.black, color: C.foreground, fontVariant: ['tabular-nums'], marginTop: 2 }}>{grams}</Text>
      <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{label}</Text>
    </View>
  );
}

function FactRow({ label, value, indent, bold, last, C }: { label: string; value: string; indent?: boolean; bold?: boolean; last?: boolean; C: C }) {
  return (
    <View style={[{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 11, paddingHorizontal: Spacing.lg }, !last && { borderBottomWidth: 1, borderBottomColor: C.borderSubtle }]}>
      <Text style={{ fontSize: FontSize.base, color: bold ? C.foreground : C.textSecondary, fontWeight: bold ? FontWeight.bold : FontWeight.regular, paddingLeft: indent ? Spacing.lg : 0 }}>{label}</Text>
      <Text style={{ fontSize: FontSize.base, color: C.foreground, fontWeight: bold ? FontWeight.bold : FontWeight.medium, fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  compCard: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg, marginHorizontal: Spacing.xl, marginTop: Spacing.lg, padding: Spacing.lg, borderRadius: Radius.lg, borderWidth: 1, ...Shadow.card },
  macroCols: { flex: 1, flexDirection: 'row' },
  facts: { marginHorizontal: Spacing.xl, borderRadius: Radius.lg, borderWidth: 1, ...Shadow.card },
});
