/**
 * Daily calorie bars, each against its own goal range (lib/calorieBars.ts).
 * The range is a faint column behind the bar, so a fuel day's higher goal
 * shows as a taller band. Tap a bar for its day and numbers. The y axis starts
 * at zero, so bar height is the real amount eaten.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, type GestureResponderEvent } from 'react-native';
import Svg, { G, Rect, Line } from 'react-native-svg';
import { FontWeight } from '@/constants/theme';
import { labelEvery, type CalorieBar } from '@/lib/calorieBars';

const LABEL_H = 14;
const LABEL_W = 24;
/** The day labels and the tooltip live in fixed rows (LABEL_H, TOP_PAD), so
 *  system text scaling may grow them only this far before they would clip. */
const MAX_FONT_SCALE = 1.3;
const TOP_PAD = 22;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface CalorieBarColors {
  inRange: string;
  over: string;
  under: string;
  band: string;
  label: string;
  labelToday: string;
  tooltipBg: string;
  tooltipText: string;
}

function dayParts(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return { date: new Date(y, m - 1, d), day: d, month: m - 1 };
}

const fmt = (n: number) => Math.round(n).toLocaleString();

export function CalorieBarChart({ bars, width, height, colors }: {
  bars: CalorieBar[];
  width: number;
  height: number;
  colors: CalorieBarColors;
}) {
  const [active, setActive] = useState<number | null>(null);
  // A different set of days (fewer of them, or the same count shifted at
  // midnight): an old selection would point at another day's bar.
  const span = `${bars[0]?.dayIso ?? ''}:${bars.length}`;
  useEffect(() => { setActive(null); }, [span]);
  if (bars.length === 0) return null;

  const plotH = height - LABEL_H - TOP_PAD;
  const top = Math.max(...bars.map((b) => Math.max(b.kcal, b.hi)), 1) * 1.08;
  const yFor = (v: number) => TOP_PAD + plotH - (v / top) * plotH;
  const colW = width / bars.length;
  const barW = Math.max(4, Math.min(18, colW * 0.56));

  // Today is still going: under its range is not "under" yet, so it stays the
  // in-range colour, drawn lighter. Already over is worth showing as over.
  const colorFor = (b: CalorieBar) =>
    b.status === 'over' ? colors.over : b.status === 'under' && !b.today ? colors.under : colors.inRange;

  // locationX is relative to the pressed view. The press layer has no
  // children and spans the whole chart, so it is the chart's own x.
  const onPress = (e: GestureResponderEvent) => {
    const i = Math.min(bars.length - 1, Math.max(0, Math.floor(e.nativeEvent.locationX / colW)));
    setActive(active === i ? null : i);
  };

  const sel = active !== null ? bars[active] : null;
  const selText = sel
    ? (() => {
      const { date, day, month } = dayParts(sel.dayIso);
      const when = `${WEEKDAY[date.getDay()]} ${day} ${MONTH[month]}`;
      if (sel.status === 'none') return `${when}: nothing logged`;
      const goal = sel.goal > 0 ? ` of ${fmt(sel.goal)}` : '';
      return `${when}: ${fmt(sel.kcal)}${goal} kcal${sel.today ? ' so far' : ''}`;
    })()
    : null;

  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height} pointerEvents="none">
        {bars.map((b, i) => {
          const cx = colW * i + colW / 2;
          const x = cx - barW / 2;
          const bandTop = b.hi > 0 ? yFor(b.hi) : null;
          return (
            <G key={b.dayIso}>
              {active === i && (
                <Rect x={colW * i + 1} y={TOP_PAD - 4} width={colW - 2} height={plotH + 4} rx={4} fill={colors.band} opacity={0.6} />
              )}
              {bandTop !== null && (
                <Rect x={x - 2} y={bandTop} width={barW + 4} height={Math.max(1, yFor(b.lo) - bandTop)} rx={2} fill={colors.band} />
              )}
              {b.status !== 'none' && (
                <Rect
                  x={x}
                  y={yFor(b.kcal)}
                  width={barW}
                  height={Math.max(2, TOP_PAD + plotH - yFor(b.kcal))}
                  rx={Math.min(4, barW / 2)}
                  fill={colorFor(b)}
                  opacity={b.today ? 0.45 : 1}
                />
              )}
              {b.goal > 0 && (
                <Line x1={x - 3} x2={x + barW + 3} y1={yFor(b.goal)} y2={yFor(b.goal)} stroke={colors.label} strokeWidth={1} opacity={0.5} />
              )}
            </G>
          );
        })}
      </Svg>
      <View style={[s.labels, { top: height - LABEL_H }]} pointerEvents="none">
        {/* About seven labels whatever the period, the newest always labelled.
            Each is centred on its bar in a box wider than the column: on 30
            days a column is ~10 pt and a two-digit date wrapped inside it. */}
        {bars.map((b, i) => (bars.length - 1 - i) % labelEvery(bars.length) === 0 && (
          <Text
            key={b.dayIso}
            numberOfLines={1}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={[
              s.label,
              {
                left: Math.max(0, Math.min(width - LABEL_W, colW * i + colW / 2 - LABEL_W / 2)),
                color: b.today ? colors.labelToday : colors.label,
              },
              b.today && { fontWeight: FontWeight.bold },
            ]}
          >
            {String(dayParts(b.dayIso).day)}
          </Text>
        ))}
      </View>
      {/* A clear layer ON TOP of the drawing takes the tap. Wrapped around
          the Svg instead, the native svg view swallowed every touch on iOS. */}
      <Pressable
        onPress={onPress}
        style={StyleSheet.absoluteFill}
        accessible
        accessibilityLabel={`Calories per day for the last ${bars.length} days, each against its goal range`}
        // The tapped day, read out: the tooltip itself takes no focus.
        accessibilityValue={selText ? { text: selText } : undefined}
      />
      {sel && selText && (
        <View pointerEvents="none" style={s.tipRow}>
          <Text
            style={[s.tipText, { color: colors.tooltipText, backgroundColor: colors.tooltipBg }]}
            numberOfLines={1}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
          >
            {selText}
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  labels: { position: 'absolute', left: 0, right: 0, height: LABEL_H },
  label: { position: 'absolute', top: 0, width: LABEL_W, fontSize: 9, textAlign: 'center', fontVariant: ['tabular-nums'] },
  tipRow: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center' },
  tipText: {
    fontSize: 11, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'],
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden',
  },
});
