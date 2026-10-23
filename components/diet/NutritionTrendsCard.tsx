/**
 * NutritionTrendsCard — the diet slice of the Analytics tab: daily calories
 * over the last 14 days as bars, each against that day's own goal range
 * (lib/calorieBars.ts), plus per-day macro averages. Self-contained (loads its
 * own history, reloads on focus) and renders nothing until there's at least
 * one logged day, so it can drop into Analytics with a single insert.
 */
import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { loadNutritionHistory, useNutritionTargets, ymd, type DayNutrition } from '@/lib/dietData';
import { calorieBars, RANGE_PCT } from '@/lib/calorieBars';
import { CalorieBarChart } from '@/components/diet/CalorieBarChart';

const DAYS = 14;
const r0 = (n: number) => Math.round(n);

/** A theme colour at `alpha`. Theme tokens are hex today; anything else
 *  falls back to transparent, so a faint band can never turn solid and hide
 *  the bars drawn over it. */
function tint(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return 'transparent';
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

export function NutritionTrendsCard() {
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const { width } = useWindowDimensions();
  const { targetsOn } = useNutritionTargets();
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

  const todayIso = ymd(new Date());
  // Macro averages over the same days as the calorie average: finished logged
  // days, so half of today does not pull them down. Only today logged: today.
  const finished = logged.filter((d) => d.dayIso !== todayIso);
  const base = finished.length ? finished : logged;
  const avg = (sel: (d: DayNutrition) => number) => base.reduce((a, d) => a + sel(d), 0) / base.length;
  // Each day against the goal it had: fuel days, one-day goals, past changes.
  const goalFor = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return targetsOn(new Date(y, m - 1, d)).kcal;
  };
  const { bars, summary } = calorieBars(history, goalFor, todayIso);
  const chartWidth = width - Spacing.xl * 2 - Spacing.lg * 2;
  const pct = Math.round(RANGE_PCT * 100);

  return (
    <View style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
      <View style={s.header}>
        <Feather name="pie-chart" size={12} color={C.macro.calories} />
        <Text style={[s.label, { color: C.macro.calories }]}>NUTRITION</Text>
        <View style={{ flex: 1 }} />
        <Text style={[s.range, { color: C.textDim }]}>Last {DAYS} days</Text>
      </View>

      {summary.logged > 0 ? (
        <View style={s.valueRow}>
          <Text style={[s.value, { color: C.foreground }]}>{summary.inRange}</Text>
          <Text style={[s.suffix, { color: C.textMuted }]}>
            {` of ${summary.logged} ${summary.logged === 1 ? 'day' : 'days'} in your range`}
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={[s.avg, { color: C.textMuted }]}>{r0(summary.avgKcal ?? 0).toLocaleString()} kcal avg</Text>
        </View>
      ) : (
        <View style={s.valueRow}>
          <Text style={[s.suffix, { color: C.textMuted }]}>Only today is logged in the last 14 days. Your range fills in as days finish.</Text>
        </View>
      )}

      <View style={{ marginTop: Spacing.sm }}>
        <CalorieBarChart
          bars={bars}
          width={chartWidth}
          height={128}
          colors={{
            inRange: C.macro.calories,
            over: C.warningText,
            under: C.textDim,
            band: tint(C.macro.calories, 0.13),
            label: C.textMuted,
            labelToday: C.foreground,
            tooltipBg: tint(C.macro.calories, 0.12),
            tooltipText: C.foreground,
          }}
        />
      </View>

      <View style={s.legend}>
        <Key color={tint(C.macro.calories, 0.2)} label={`Goal ±${pct}%`} C={C} />
        <Key color={C.macro.calories} label="In range" C={C} />
        <Key color={C.warningText} label="Over" C={C} />
        <Key color={C.textDim} label="Under" C={C} />
      </View>

      <View style={[s.macros, { borderTopColor: C.borderSubtle }]}>
        <Macro label="Protein" value={`${r0(avg((d) => d.protein_g))}g`} color={C.macro.protein} C={C} />
        <Macro label="Carbs" value={`${r0(avg((d) => d.carb_g))}g`} color={C.macro.carbs} C={C} />
        <Macro label="Fat" value={`${r0(avg((d) => d.fat_g))}g`} color={C.macro.fat} C={C} />
      </View>
    </View>
  );
}

function Key({ color, label, C }: { color: string; label: string; C: ReturnType<typeof useTheme>['C'] }) {
  return (
    <View style={s.key}>
      <View style={[s.swatch, { backgroundColor: color }]} />
      <Text style={[s.keyText, { color: C.textMuted }]}>{label}</Text>
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
  avg: { fontSize: 12, fontVariant: ['tabular-nums'] },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md, marginTop: Spacing.sm },
  key: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  keyText: { fontSize: 10 },
  macros: { flexDirection: 'row', marginTop: Spacing.md, paddingTop: Spacing.md, borderTopWidth: 1 },
});
