/**
 * NutritionTrendsCard — the diet slice of the Analytics tab: daily calories as
 * bars, each against that day's own goal range (lib/calorieBars.ts), plus
 * per-day macro averages. The period is selectable (7, 14 or 30 days, 14 by
 * default) and steps back to earlier periods. Self-contained (loads its own
 * history, reloads on focus) and renders nothing until a loaded period has a
 * logged day, so it can drop into Analytics with a single insert.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { loadNutritionRange, useNutritionTargets, ymd, type DayNutrition } from '@/lib/dietData';
import { calorieBars, canStepBack, periodFor, PERIODS, RANGE_PCT, type PeriodDays } from '@/lib/calorieBars';
import { CalorieBarChart } from '@/components/diet/CalorieBarChart';

const DEFAULT_DAYS: PeriodDays = 14;
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const r0 = (n: number) => Math.round(n);
const dayLabel = (d: Date) => `${d.getDate()} ${MONTH[d.getMonth()]}`;

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
  const [days, setDays] = useState<PeriodDays>(DEFAULT_DAYS);
  // 0 ends today; 1 is the period just before it, and so on.
  const [offset, setOffset] = useState(0);
  // The loaded days and which period they are, so a period still loading is
  // drawn dimmed instead of under the new period's header.
  const [loaded, setLoaded] = useState<{ key: string; history: DayNutrition[] } | null>(null);
  // Once any period has shown food, the card stays, so stepping back to a
  // period with nothing logged never takes the controls away with it.
  const [everLogged, setEverLogged] = useState(false);
  // Bumped each time the screen comes into focus, so food logged elsewhere
  // shows on return. Starts at 0: the first focus does the first load.
  const [focusTick, setFocusTick] = useState(0);
  // The period whose load failed, so the card says so instead of leaving the
  // last period's bars dimmed under the new header for good.
  const [failed, setFailed] = useState<string | null>(null);
  useFocusEffect(useCallback(() => { setFocusTick((t) => t + 1); }, []));

  const key = `${days}:${offset}`;
  useEffect(() => {
    if (focusTick === 0) return;
    let on = true;
    setFailed(null);
    const { start } = periodFor(new Date(), days, offset);
    loadNutritionRange(supabase, start, days)
      .then((h) => {
        if (!on) return;
        setLoaded({ key: `${days}:${offset}`, history: h });
        if (h.some((d) => d.kcal > 0)) setEverLogged(true);
      })
      .catch(() => { if (on) setFailed(`${days}:${offset}`); });
    return () => { on = false; };
  }, [supabase, days, offset, focusTick]);

  if (!everLogged || !loaded) return null;
  const history = loaded.history;
  const stale = loaded.key !== key;

  const { start, end } = periodFor(new Date(), days, offset);
  const rangeText = offset === 0 ? `Last ${days} days` : `${dayLabel(start)} – ${dayLabel(end)}`;
  const backOk = canStepBack(days, offset);

  const logged = history.filter((d) => d.kcal > 0);
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
  const caption = !finished.length ? 'Today so far' : offset === 0 ? 'Daily averages, not counting today' : 'Daily averages';

  return (
    <View style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
      <View style={s.header}>
        <Feather name="pie-chart" size={12} color={C.macro.calories} />
        <Text style={[s.label, { color: C.macro.calories }]}>NUTRITION</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={() => backOk && setOffset((o) => o + 1)}
          disabled={!backOk}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Previous ${days} days`}
        >
          <Feather name="chevron-left" size={14} color={backOk ? C.textMuted : C.borderSubtle} />
        </TouchableOpacity>
        <Text style={[s.range, { color: C.textDim }]}>{rangeText}</Text>
        <TouchableOpacity
          onPress={() => offset > 0 && setOffset((o) => o - 1)}
          disabled={offset === 0}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Next ${days} days`}
        >
          <Feather name="chevron-right" size={14} color={offset > 0 ? C.textMuted : C.borderSubtle} />
        </TouchableOpacity>
      </View>

      <View style={[s.segWrap, { backgroundColor: C.muted }]}>
        {PERIODS.map((p) => (
          <TouchableOpacity
            key={p}
            onPress={() => { setDays(p); setOffset(0); }}
            style={[s.segPill, days === p && { backgroundColor: Colors.primary }]}
            accessibilityRole="button"
            accessibilityState={{ selected: days === p }}
            accessibilityLabel={`${p} days`}
          >
            <Text style={[s.segText, { color: days === p ? Colors.primaryFg : C.textSecondary }]}>{p}D</Text>
          </TouchableOpacity>
        ))}
      </View>

      {failed === key && (
        <TouchableOpacity onPress={() => setFocusTick((t) => t + 1)} accessibilityRole="button">
          <Text style={[s.failed, { color: C.textMuted }]}>Couldn't load these days. Tap to try again.</Text>
        </TouchableOpacity>
      )}
      <View style={stale && s.stale}>
      {logged.length === 0 ? (
        <View style={s.valueRow}>
          <Text style={[s.suffix, { color: C.textMuted }]}>Nothing logged in these days.</Text>
        </View>
      ) : (
        <>
          {summary.logged > 0 ? (
            <View style={s.valueRow}>
              <Text style={[s.value, { color: C.foreground }]}>{summary.inRange}</Text>
              <Text style={[s.suffix, { color: C.textMuted }]}>
                {` of ${summary.logged} ${summary.logged === 1 ? 'day' : 'days'} in your range`}
              </Text>
              <View style={{ flex: 1 }} />
              <Text style={[s.avg, { color: C.textMuted }]}>{r0(summary.avgKcal ?? 0).toLocaleString()} kcal avg</Text>
            </View>
          ) : summary.avgKcal !== null ? (
            // Finished days, none with a goal: no range to report, the average still stands.
            <View style={s.valueRow}>
              <Text style={[s.value, { color: C.foreground }]}>{r0(summary.avgKcal).toLocaleString()}</Text>
              <Text style={[s.suffix, { color: C.textMuted }]}> kcal / day avg</Text>
            </View>
          ) : (
            <View style={s.valueRow}>
              <Text style={[s.suffix, { color: C.textMuted }]}>
                Only today is logged in the last {days} days. Your range fills in as days finish.
              </Text>
            </View>
          )}

          <View style={{ marginTop: Spacing.sm }}>
            <CalorieBarChart
              bars={bars}
              rangeLabel={offset === 0 ? `the last ${days} days` : `${dayLabel(start)} to ${dayLabel(end)}`}
              width={chartWidth}
              height={128}
              colors={{
                inRange: C.macro.calories,
                over: C.warningText,
                under: C.textDim,
                band: tint(C.macro.calories, 0.22),
                label: C.textMuted,
                labelToday: C.foreground,
                tooltipBg: tint(C.macro.calories, 0.12),
                tooltipText: C.foreground,
              }}
            />
          </View>

          <View style={s.legend}>
            <Key color={C.macro.calories} label="In range" C={C} />
            <Key color={C.warningText} label="Over" C={C} />
            <Key color={C.textDim} label="Under" C={C} />
            {offset === 0 && <Key color={tint(C.macro.calories, 0.45)} label="Today" C={C} />}
            <Text style={[s.keyText, s.bandNote, { color: C.textDim }]}>Shaded: goal ±{pct}%</Text>
          </View>

          <Text style={[s.caption, { color: C.textDim, borderTopColor: C.borderSubtle }]}>{caption}</Text>
          <View style={s.macros}>
            <Macro label="Protein" value={`${r0(avg((d) => d.protein_g))}g`} color={C.macro.protein} C={C} />
            <Macro label="Carbs" value={`${r0(avg((d) => d.carb_g))}g`} color={C.macro.carbs} C={C} />
            <Macro label="Fat" value={`${r0(avg((d) => d.fat_g))}g`} color={C.macro.fat} C={C} />
          </View>
        </>
      )}
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
  stale: { opacity: 0.4 },
  failed: { fontSize: FontSize.sm, marginTop: Spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: LetterSpacing.eyebrow },
  range: { fontSize: 11, fontVariant: ['tabular-nums'] },
  // Same look as the Analytics screen's SegmentedToggle.
  segWrap: { flexDirection: 'row', alignSelf: 'flex-start', borderRadius: Radius.md, padding: 3, marginTop: Spacing.sm },
  segPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.sm },
  segText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: Spacing.sm },
  value: { fontSize: FontSize.xxl, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'] },
  suffix: { fontSize: FontSize.sm },
  avg: { fontSize: FontSize.sm, fontVariant: ['tabular-nums'] },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md, marginTop: Spacing.sm },
  key: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  keyText: { fontSize: FontSize.xs },
  bandNote: { marginLeft: 'auto' },
  caption: { fontSize: FontSize.xs, marginTop: Spacing.md, paddingTop: Spacing.sm, borderTopWidth: 1 },
  macros: { flexDirection: 'row', marginTop: Spacing.xs },
});
