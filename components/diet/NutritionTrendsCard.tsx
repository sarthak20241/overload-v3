/**
 * NutritionTrendsCard — the diet slice of the Analytics tab: daily calories over
 * the last 14 days + per-day macro averages. Self-contained (loads its own
 * history, reloads on focus) and renders nothing until there's at least one
 * logged day, so it can drop into Analytics with a single insert.
 */
import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { MiniAreaChart } from '@/components/ui/MiniAreaChart';
import { useSupabaseClient } from '@/lib/supabase';
import { loadNutritionHistory, type DayNutrition } from '@/lib/dietData';

const DAYS = 14;
const r0 = (n: number) => Math.round(n);

export function NutritionTrendsCard() {
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const { width } = useWindowDimensions();
  const [history, setHistory] = useState<DayNutrition[]>([]);

  useFocusEffect(
    useCallback(() => {
      let on = true;
      loadNutritionHistory(supabase, DAYS).then((h) => { if (on) setHistory(h); }).catch(() => {});
      return () => { on = false; };
    }, [supabase]),
  );

  const logged = history.filter((d) => d.kcal > 0);
  if (logged.length === 0) return null;

  const avg = (sel: (d: DayNutrition) => number) => logged.reduce((a, d) => a + sel(d), 0) / logged.length;
  const kcalSeries = history.map((d) => d.kcal);
  const labels = history.map((d) => { const [, m, day] = d.dayIso.split('-'); return `${Number(m)}/${Number(day)}`; });
  const chartWidth = width - Spacing.xl * 2 - Spacing.lg * 2;

  return (
    <View style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
      <View style={s.header}>
        <Feather name="pie-chart" size={12} color={C.macro.calories} />
        <Text style={[s.label, { color: C.macro.calories }]}>NUTRITION</Text>
        <View style={{ flex: 1 }} />
        <Text style={[s.range, { color: C.textDim }]}>Last {DAYS} days</Text>
      </View>

      <View style={s.valueRow}>
        <Text style={[s.value, { color: C.foreground }]}>{r0(avg((d) => d.kcal)).toLocaleString()}</Text>
        <Text style={[s.suffix, { color: C.textMuted }]}> kcal / day avg</Text>
      </View>

      <View style={{ marginTop: 4, marginHorizontal: -2 }}>
        <MiniAreaChart
          data={kcalSeries}
          labels={labels}
          width={chartWidth}
          height={96}
          color={C.macro.calories}
          valueSuffix="kcal"
          tooltipBgColor={C.elevated}
          tooltipTextColor={C.foreground}
        />
      </View>

      <View style={[s.macros, { borderTopColor: C.borderSubtle }]}>
        <Macro label="Protein" value={`${r0(avg((d) => d.protein_g))}g`} color={C.macro.protein} C={C} />
        <Macro label="Carbs" value={`${r0(avg((d) => d.carb_g))}g`} color={C.macro.carbs} C={C} />
        <Macro label="Fat" value={`${r0(avg((d) => d.fat_g))}g`} color={C.macro.fat} C={C} />
      </View>
    </View>
  );
}

function Macro({ label, value, color, C }: { label: string; value: string; color: string; C: ReturnType<typeof useTheme>['C'] }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={{ fontSize: FontSize.lg, fontWeight: FontWeight.bold, color, fontVariant: ['tabular-nums'] }}>{value}</Text>
      <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{label} avg</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: Radius.lg, borderWidth: 1, padding: Spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: LetterSpacing.eyebrow },
  range: { fontSize: 11, fontVariant: ['tabular-nums'] },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: Spacing.sm },
  value: { fontSize: FontSize.xxl, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'] },
  suffix: { fontSize: FontSize.sm },
  macros: { flexDirection: 'row', marginTop: Spacing.md, paddingTop: Spacing.md, borderTopWidth: 1 },
});
