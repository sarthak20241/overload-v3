/**
 * CoachBlocks: the UI Drona can put in a reply. Tables, line and bar charts,
 * and stat tiles, drawn natively from the blocks lib/coachBlocks.ts parses.
 *
 * Calm by design: hairline borders, one accent (the line, or the highlighted
 * bar), numbers in tabular figures. Everything takes its colors from the
 * theme so it reads in both light and dark.
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import type { ChartBlock, ChartPoint, CoachBlock, ProgressItem, StatItem } from '@/lib/coachBlocks';
import { PulsingStatus } from './OrbStage';
import { monotonePath } from '@/components/ui/MiniAreaChart';

type Inline = (text: string) => React.ReactNode;

const fmt = (v: number) => {
  const r = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return r.toLocaleString('en-US');
};

// ─── Table ───────────────────────────────────────────────────────────────────

export function TableView({
  header, rows, align, inline,
}: { header: string[]; rows: string[][]; align: ('left' | 'right')[]; inline: Inline }) {
  const { C } = useTheme();
  // Wide tables scroll sideways inside their frame; narrow ones fill it.
  const [frameW, setFrameW] = useState(0);
  const minCol = 76;
  const contentW = Math.max(frameW, header.length * minCol);
  const colW = frameW > 0 ? contentW / header.length : undefined;
  const cell = (text: string, ci: number, head: boolean) => (
    <View key={ci} style={[s.cell, { width: colW }]}>
      <Text
        style={[
          head ? s.headText : s.cellText,
          { color: head ? C.textMuted : C.foreground, textAlign: align[ci] },
          ci === 0 && !head && { fontWeight: FontWeight.semibold },
        ]}
      >
        {head ? text : inline(text)}
      </Text>
    </View>
  );
  return (
    <View
      style={[s.frame, { borderColor: C.borderSubtle }]}
      onLayout={(e: LayoutChangeEvent) => setFrameW(e.nativeEvent.layout.width - 2)}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} scrollEnabled={contentW > frameW + 1}>
        <View style={{ width: frameW > 0 ? contentW : undefined }}>
          <View style={[s.row, { backgroundColor: C.muted }]}>{header.map((h, ci) => cell(h, ci, true))}</View>
          {rows.map((r, ri) => (
            <View
              key={ri}
              style={[s.row, ri > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.borderSubtle }]}
            >
              {r.map((c, ci) => cell(c, ci, false))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Chart ───────────────────────────────────────────────────────────────────

const CHART_H = 132;
// Room above the tallest bar for its value label.
const PAD_T = 20;
const PAD_B = 6;

// Smooth curves through every point, with no overshoot: the line never
// bends above or below a value that is not in the data.
const linePath = monotonePath;

export function ChartView({ chart }: { chart: ChartBlock }) {
  if (chart.kind === 'donut') return <DonutView chart={chart} />;
  return <XYChart chart={chart} />;
}

function XYChart({ chart }: { chart: ChartBlock }) {
  const { C } = useTheme();
  const [w, setW] = useState(0);
  const { points, unit, goal, compare } = chart;
  const values = points.map((p) => p.value);
  // The scale covers both lines, so the comparison is honest.
  const all = compare ? [...values, ...compare.points.map((p) => p.value)] : values;
  const withGoal = goal != null ? [...all, goal] : all;
  let lo = Math.min(...withGoal);
  let hi = Math.max(...withGoal);
  if (chart.kind === 'bar') lo = Math.min(0, lo);
  else {
    // Breathing room so the line never sits on the frame.
    const span = hi - lo || Math.abs(hi) || 1;
    // A bit more headroom than tight bounds: day-to-day wobble reads as
    // wobble, not as cliffs.
    lo -= span * 0.3;
    hi += span * 0.3;
  }
  if (hi === lo) hi = lo + 1;
  const innerH = CHART_H - PAD_T - PAD_B;
  const yOf = (v: number) => PAD_T + innerH * (1 - (v - lo) / (hi - lo));
  const last = points[points.length - 1];
  const first = points[0];
  const delta = points.length > 1 ? last.value - first.value : 0;
  const accent = C.accentText;

  // Bars: every bar gets its value on top and its name below, when they fit.
  const isBar = chart.kind === 'bar';
  const gap = points.length > 12 ? 3 : 8;
  const barW = w > 0 ? Math.max(4, (w - gap * (points.length - 1)) / points.length) : 0;
  const labelEachBar = isBar && points.length <= 8;
  // X labels: first, middle and last, so they never collide.
  const labelIdx = points.length <= 4
    ? points.map((_, i) => i)
    : [0, Math.floor((points.length - 1) / 2), points.length - 1];

  let plot: React.ReactNode = null;
  if (w > 0 && chart.kind === 'line') {
    const step = points.length > 1 ? (w - 12) / (points.length - 1) : 0;
    const pts = points.map((p, i) => ({ x: 6 + i * step, y: yOf(p.value) }));
    const d = linePath(pts);
    const area = `${d} L ${pts[pts.length - 1].x},${CHART_H - PAD_B} L ${pts[0].x},${CHART_H - PAD_B} Z`;
    // The comparison sits under the main line: dashed, neutral, same x steps.
    // Each line spans the full width, so two series of different lengths
    // (this month so far vs all of last month) still start and end together.
    const cmp = compare
      ? linePath(compare.points.map((p, i) => ({
        x: 6 + i * ((w - 12) / (compare.points.length - 1)),
        y: yOf(p.value),
      })))
      : null;
    plot = (
      <>
        {cmp && (
          <Path d={cmp} stroke={C.foreground} strokeOpacity={0.45} strokeWidth={1.75} strokeDasharray="5 4" fill="none" strokeLinejoin="round" />
        )}
        <Defs>
          <LinearGradient id="coachChartFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={accent} stopOpacity={0.22} />
            <Stop offset="1" stopColor={accent} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Path d={area} fill="url(#coachChartFill)" />
        <Path d={d} stroke={accent} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        {pts.length <= 16 && pts.slice(0, -1).map((p, i) => (
          <Circle key={i} cx={p.x} cy={p.y} r={2.5} fill={C.background} stroke={accent} strokeWidth={1.5} />
        ))}
        <Circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r={4} fill={accent} />
      </>
    );
  } else if (w > 0) {
    const top = Math.max(...values);
    plot = points.map((p, i) => {
      const y0 = yOf(Math.max(0, lo));
      const y1 = yOf(p.value);
      const isTop = p.value === top;
      return (
        <Rect
          key={i}
          x={i * (barW + gap)}
          y={Math.min(y0, y1)}
          width={barW}
          height={Math.max(2, Math.abs(y0 - y1))}
          rx={Math.min(4, barW / 2)}
          fill={isTop ? accent : C.foreground}
          fillOpacity={isTop ? 1 : 0.22}
        />
      );
    });
  }

  return (
    <View style={[s.frame, s.chartFrame, { borderColor: C.borderSubtle, backgroundColor: C.card }]}>
      <View style={s.chartHead}>
        <Text style={[s.chartTitle, { color: C.textSecondary }]} numberOfLines={1}>
          {chart.title ?? ''}
        </Text>
        {/* A line's headline is where it ended. Bars carry their own values. */}
        {!isBar && (
          <Text style={[s.chartValue, { color: C.foreground }]}>
            {fmt(last.value)}
            {unit ? <Text style={[s.chartUnit, { color: C.textMuted }]}> {unit}</Text> : null}
          </Text>
        )}
        {isBar && !!unit && <Text style={[s.chartUnit, { color: C.textMuted }]}>{unit}</Text>}
      </View>
      {compare && (
        <View style={s.legend}>
          <View style={s.legendItem}>
            <View style={[s.legendSwatch, { backgroundColor: accent }]} />
            <Text style={[s.legendText, { color: C.textSecondary }]} numberOfLines={1}>{chart.name ?? 'Now'}</Text>
          </View>
          <View style={s.legendItem}>
            <View style={[s.legendSwatch, s.legendDash, { borderColor: C.foreground }]} />
            <Text style={[s.legendText, { color: C.textSecondary }]} numberOfLines={1}>{compare.name || 'Before'}</Text>
          </View>
        </View>
      )}
      {chart.kind === 'line' && !compare && points.length > 1 && delta !== 0 && (
        <Text style={[s.chartDelta, { color: C.textMuted }]}>
          {delta > 0 ? '+' : '−'}{fmt(Math.abs(delta))}{unit ? ` ${unit}` : ''} since {first.label}
        </Text>
      )}
      <View style={{ height: CHART_H, marginTop: Spacing.sm }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        {w > 0 && (
          <Svg width={w} height={CHART_H}>
            {goal != null && (
              <Line
                x1={0}
                x2={w}
                y1={yOf(goal)}
                y2={yOf(goal)}
                stroke={C.textMuted}
                strokeWidth={1}
                strokeDasharray="4 4"
                strokeOpacity={0.7}
              />
            )}
            {plot}
          </Svg>
        )}
        {labelEachBar && w > 0 && points.map((p, i) => (
          <Text
            key={i}
            style={[
              s.barValue,
              { left: i * (barW + gap), width: barW, top: Math.min(yOf(p.value), yOf(Math.max(0, lo))) - 16, color: C.textSecondary },
            ]}
            numberOfLines={1}
          >
            {fmt(p.value)}
          </Text>
        ))}
        {goal != null && w > 0 && (
          <Text style={[s.goalLabel, { top: yOf(goal) - 16, color: C.textMuted }]}>
            {chart.goalLabel ?? 'Goal'} {fmt(goal)}
          </Text>
        )}
      </View>
      {labelEachBar ? (
        <View style={[s.xRow, { gap }]}>
          {points.map((p, i) => (
            <Text key={i} style={[s.xLabel, { color: C.textMuted, textAlign: 'center' }]} numberOfLines={1}>
              {p.label}
            </Text>
          ))}
        </View>
      ) : (
      <View style={s.xRow}>
        {labelIdx.map((i, n) => (
          <Text
            key={i}
            style={[
              s.xLabel,
              { color: C.textMuted, textAlign: n === 0 ? 'left' : n === labelIdx.length - 1 ? 'right' : 'center' },
            ]}
            numberOfLines={1}
          >
            {points[i].label}
          </Text>
        ))}
      </View>
      )}
    </View>
  );
}

// ─── Donut ───────────────────────────────────────────────────────────────────

const DONUT = 128;
const RING = 16;

// Macro slices wear the app's macro colors, so a split reads the same here
// as on the Nutrition screen. Anything else gets the accent, then neutrals.
function sliceColors(points: ChartPoint[], C: ReturnType<typeof useTheme>['C']): { color: string; opacity: number }[] {
  const macro = (label: string) => {
    const l = label.toLowerCase();
    if (l.startsWith('protein')) return C.macro.protein;
    if (l.startsWith('carb')) return C.macro.carbs;
    if (l.startsWith('fat')) return C.macro.fat;
    return null;
  };
  const allMacro = points.every((p) => macro(p.label));
  const neutral = [1, 0.55, 0.38, 0.26, 0.18];
  let n = 0;
  return points.map((p, i) => {
    if (allMacro) return { color: macro(p.label)!, opacity: 1 };
    if (i === 0) return { color: C.accentText, opacity: 1 };
    return { color: C.foreground, opacity: neutral[Math.min(++n, neutral.length - 1)] };
  });
}

function DonutView({ chart }: { chart: ChartBlock }) {
  const { C } = useTheme();
  const { points, unit } = chart;
  const total = points.reduce((a, p) => a + p.value, 0);
  const colors = sliceColors(points, C);
  const r = (DONUT - RING) / 2;
  const circ = 2 * Math.PI * r;
  const GAP = points.length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <View style={[s.frame, s.chartFrame, { borderColor: C.borderSubtle, backgroundColor: C.card }]}>
      {!!chart.title && (
        <Text style={[s.chartTitle, { color: C.textSecondary, marginBottom: Spacing.sm }]} numberOfLines={1}>
          {chart.title}
        </Text>
      )}
      <View style={s.donutRow}>
        <View style={{ width: DONUT, height: DONUT }}>
          <Svg width={DONUT} height={DONUT} style={{ transform: [{ rotate: '-90deg' }] }}>
            {points.map((p, i) => {
              const len = Math.max(0, (p.value / total) * circ - GAP);
              const el = (
                <Circle
                  key={i}
                  cx={DONUT / 2}
                  cy={DONUT / 2}
                  r={r}
                  stroke={colors[i].color}
                  strokeOpacity={colors[i].opacity}
                  strokeWidth={RING}
                  strokeDasharray={`${len} ${circ - len}`}
                  strokeDashoffset={-offset}
                  fill="none"
                />
              );
              offset += (p.value / total) * circ;
              return el;
            })}
          </Svg>
          <View style={[StyleSheet.absoluteFill, s.donutCenter]}>
            <Text style={[s.chartValue, { color: C.foreground }]}>{fmt(total)}</Text>
            {!!unit && <Text style={[s.chartUnit, { color: C.textMuted }]}>{unit}</Text>}
          </View>
        </View>
        <View style={s.donutLegend}>
          {points.map((p, i) => (
            <View key={i} style={s.donutLegendRow}>
              <View style={[s.donutDot, { backgroundColor: colors[i].color, opacity: colors[i].opacity }]} />
              <Text style={[s.legendText, { color: C.foreground, flex: 1 }]} numberOfLines={1}>{p.label}</Text>
              <Text style={[s.donutPct, { color: C.textSecondary }]}>
                {fmt(p.value)}{unit ? ` ${unit}` : ''}
                <Text style={{ color: C.textMuted }}>  {Math.round((p.value / total) * 100)}%</Text>
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

// ─── Progress ────────────────────────────────────────────────────────────────

export function ProgressView({ items }: { items: ProgressItem[] }) {
  const { C } = useTheme();
  return (
    <View style={[s.frame, s.chartFrame, { borderColor: C.borderSubtle, backgroundColor: C.card, gap: 14 }]}>
      {items.map((it, i) => {
        const pct = Math.max(0, Math.min(1, it.value / it.target));
        const over = it.value > it.target;
        const left = it.target - it.value;
        const u = it.unit ? ` ${it.unit}` : '';
        return (
          <View key={i}>
            <View style={s.progressHead}>
              <Text style={[s.progressLabel, { color: C.foreground }]} numberOfLines={1}>{it.label}</Text>
              <Text style={[s.progressNums, { color: C.foreground }]}>
                {fmt(it.value)}
                <Text style={{ color: C.textMuted }}> / {fmt(it.target)}{u}</Text>
              </Text>
            </View>
            <View style={[s.progressTrack, { backgroundColor: C.muted }]}>
              <View style={[s.progressFill, { width: `${pct * 100}%`, backgroundColor: C.accentText }]} />
            </View>
            <Text style={[s.progressNote, { color: C.textMuted }]}>
              {over ? `${fmt(-left)}${u} over` : left === 0 ? 'Hit' : `${fmt(left)}${u} to go`}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export function StatsView({ items }: { items: StatItem[] }) {
  const { C } = useTheme();
  // Two or three side by side; four become a 2 x 2.
  const perRow = items.length === 4 ? 2 : items.length;
  return (
    <View style={s.statsWrap}>
      {items.map((it, i) => (
        <View
          key={i}
          style={[
            s.statTile,
            { borderColor: C.borderSubtle, backgroundColor: C.card, flexBasis: `${100 / perRow - 3}%` },
          ]}
        >
          <Text style={[s.statValue, { color: C.foreground }]} numberOfLines={1} adjustsFontSizeToFit>
            {it.value}
          </Text>
          <Text style={[s.statLabel, { color: C.textMuted }]} numberOfLines={2}>{it.label}</Text>
          {!!it.note && <Text style={[s.statNote, { color: C.accentText }]} numberOfLines={2}>{it.note}</Text>}
        </View>
      ))}
    </View>
  );
}

// ─── Placeholder while a block streams in ────────────────────────────────────

const PENDING_LABEL = {
  chart: 'Drawing a chart',
  stats: 'Pulling the numbers',
  table: 'Building a table',
  progress: 'Checking your progress',
};

export function PendingBlock({ what }: { what: keyof typeof PENDING_LABEL }) {
  const { C } = useTheme();
  return (
    <View style={[s.frame, s.pending, { borderColor: C.borderSubtle, backgroundColor: C.card }]}>
      <PulsingStatus label={PENDING_LABEL[what]} color={C.textMuted} style={s.pendingText} />
    </View>
  );
}

/** One rich block. Text blocks stay with the caller (they need its inline renderer). */
export function RichBlock({ block, inline }: { block: CoachBlock; inline: Inline }) {
  switch (block.type) {
    case 'table':
      return <TableView header={block.header} rows={block.rows} align={block.align} inline={inline} />;
    case 'chart':
      return <ChartView chart={block} />;
    case 'stats':
      return <StatsView items={block.items} />;
    case 'progress':
      return <ProgressView items={block.items} />;
    case 'pending':
      return <PendingBlock what={block.what} />;
    default:
      return null;
  }
}

const s = StyleSheet.create({
  frame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    marginVertical: 4,
  },
  row: { flexDirection: 'row' },
  cell: { paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'center' },
  headText: { fontSize: 11, fontWeight: FontWeight.semibold, letterSpacing: 0.4 },
  cellText: { fontSize: FontSize.sm, lineHeight: 17, fontVariant: ['tabular-nums'] },

  chartFrame: { padding: Spacing.md },
  chartHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  chartTitle: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  chartValue: { fontSize: 20, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  chartUnit: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  chartDelta: { fontSize: 12, marginTop: 2, textAlign: 'right', fontVariant: ['tabular-nums'] },
  goalLabel: { position: 'absolute', right: 0, fontSize: 10, fontVariant: ['tabular-nums'] },
  xRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  xLabel: { flex: 1, fontSize: 11 },
  legend: { flexDirection: 'row', gap: 14, marginTop: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  legendSwatch: { width: 14, height: 3, borderRadius: 2 },
  legendDash: { height: 0, borderTopWidth: 2, borderStyle: 'dashed', opacity: 0.6 },
  legendText: { fontSize: 12 },
  donutRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg },
  donutCenter: { alignItems: 'center', justifyContent: 'center' },
  donutLegend: { flex: 1, gap: 10 },
  donutLegendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  donutDot: { width: 8, height: 8, borderRadius: 4 },
  donutPct: { fontSize: 12, fontVariant: ['tabular-nums'] },
  progressHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  progressLabel: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  progressNums: { fontSize: FontSize.base, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 6 },
  progressFill: { height: 8, borderRadius: 4 },
  progressNote: { fontSize: 11, marginTop: 4, fontVariant: ['tabular-nums'] },
  barValue: { position: 'absolute', fontSize: 11, textAlign: 'center', fontVariant: ['tabular-nums'] },

  statsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 4 },
  statTile: {
    flexGrow: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  statValue: { fontSize: 20, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 12, marginTop: 2 },
  statNote: { fontSize: 12, marginTop: 4, fontWeight: FontWeight.medium },

  pending: { height: 88, alignItems: 'center', justifyContent: 'center' },
  pendingText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
});
