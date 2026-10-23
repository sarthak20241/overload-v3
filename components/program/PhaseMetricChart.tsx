/**
 * The hero metric's chart on the Goal screen, drawn to the approved
 * reference (.planning/phase-metrics/shots/goal-screen-v2-reference.webp),
 * in react-native-svg, which has shipped since the first build, so this
 * needs no new native code.
 *
 *   MetricLineChart  a number over the program: one smooth lime line from
 *                    the first reading, a faint lime fill under it, a solid
 *                    dot at now, and a dashed line on to a hollow ring at the
 *                    target at the program's end. Nothing else: the GOAL
 *                    figure sits above the chart and the phase card says the
 *                    phase target. x runs from the first reading inside the
 *                    program to the program's end, so the line always starts
 *                    at the left edge. The readings get the left part of the
 *                    width (HISTORY_SHARE) even when they cover a few days of
 *                    a long program, so the line reads as a line, not a stub;
 *                    the dashed stretch to the goal takes the rest.
 *   MetricBarsChart  a habit: one bar per program week against a dotted
 *                    target line, past weeks solid, this week lighter, weeks
 *                    to come as stubs.
 */
import { View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { monotonePath } from '@/components/ui/MiniAreaChart';

export const CHART_HEIGHT = 76;
const BARS_HEIGHT = 88;
const PAD_TOP = 6;
const PAD_BOTTOM = 12;
const X0 = 4;
const X1_INSET = 10;
const LABEL_FONT = 10.5;
/** The share of the width the readings so far get, at least. */
const HISTORY_SHARE = 0.58;

export interface LinePoint {
  /** Program weeks from the start (fractional). */
  x: number;
  y: number;
}

interface LineProps {
  width: number;
  /** Readings so far, oldest first. */
  points: LinePoint[];
  /** The whole program, in weeks: where the line's path ends. */
  weeks: number;
  /** The value the hollow ring at the end marks: the program goal, else the phase target. */
  endTarget: number;
}

export function MetricLineChart({ width, points, weeks, endTarget }: LineProps) {
  const { C } = useTheme();
  const H = CHART_HEIGHT;
  const x1 = width - X1_INSET;
  // From the first reading inside the program to the program's end.
  const inside = points.filter((p) => p.x >= 0);
  const xStart = inside.length > 0 ? inside[0].x : 0;
  const xEnd = Math.max(xStart + 1, weeks);
  const ys = [...inside.map((p) => p.y), endTarget];
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const padY = (hi - lo) * 0.1;
  lo -= padY; hi += padY;
  // Two pieces: first reading to now across at least HISTORY_SHARE of the
  // width, now to the program's end across the rest.
  const xNow = inside.length > 0 ? inside[inside.length - 1].x : xStart;
  const linearShare = (xNow - xStart) / (xEnd - xStart);
  const share = inside.length >= 2 ? Math.max(HISTORY_SHARE, linearShare) : linearShare;
  const xMid = X0 + (x1 - X0) * share;
  const X = (w: number) => {
    const c = Math.max(xStart, Math.min(xEnd, w));
    if (xNow <= xStart || c <= xNow) return xNow <= xStart ? X0 : X0 + (xMid - X0) * (c - xStart) / (xNow - xStart);
    return xMid + (x1 - xMid) * (c - xNow) / Math.max(1e-9, xEnd - xNow);
  };
  const Y = (v: number) => PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) * (hi - v) / (hi - lo);

  const pts = inside.map((p) => ({ x: X(p.x), y: Y(p.y) }));
  const last = pts[pts.length - 1] ?? null;
  const tx = X(xEnd);
  const ty = Y(endTarget);
  const line = pts.length >= 2 ? monotonePath(pts) : null;
  // The fill closes the line down to the chart's floor.
  const area = line && last ? `${line} L ${last.x},${H} L ${pts[0].x},${H} Z` : null;

  return (
    <View style={{ width, height: H }}>
      <Svg width={width} height={H} viewBox={`0 0 ${width} ${H}`}>
        <Defs>
          <LinearGradient id="metricFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={Colors.primary} stopOpacity={0.07} />
            <Stop offset="1" stopColor={Colors.primary} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        {area && <Path d={area} fill="url(#metricFill)" />}
        {last && (
          <Path
            d={`M ${last.x},${last.y} L ${tx},${ty}`}
            stroke={C.textMuted}
            strokeWidth={1.5}
            strokeDasharray="4 5"
            strokeLinecap="round"
            fill="none"
          />
        )}
        {line && <Path d={line} stroke={Colors.primary} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
        {last && <Circle cx={last.x} cy={last.y} r={5.5} fill={Colors.primary} />}
        <Circle cx={tx} cy={ty} r={5.5} fill={C.background} stroke={C.mutedFg} strokeWidth={1.6} />
      </Svg>
    </View>
  );
}

interface BarsProps {
  width: number;
  /** One value per program week so far (null = nothing that week), oldest first. */
  values: (number | null)[];
  /** The whole program, in weeks. */
  weeks: number;
  /** The running week, 1-based. */
  curWeek: number;
  target: number;
  targetLabel: string;
}

export function MetricBarsChart({ width, values, weeks, curWeek, target, targetLabel }: BarsProps) {
  const { C } = useTheme();
  const H = BARS_HEIGHT;
  const x1 = width - X1_INSET;
  const W = Math.max(1, weeks);
  const top = 14;
  const bot = H - 18;
  const mx = Math.max(target, ...values.map((v) => v ?? 0)) * 1.1 || 1;
  const slot = (x1 - X0) / W;
  const bw = slot * 0.62;
  const ty = bot - (bot - top) * target / mx;
  const bars = [];
  for (let w = 0; w < W; w++) {
    const x = X0 + w * slot + (slot - bw) / 2;
    const v = w < values.length ? values[w] : undefined;
    if (v != null && v > 0) {
      const h = Math.max(2, (bot - top) * v / mx);
      const fill = w < curWeek - 1 ? Colors.primary : C.primaryBorder;
      bars.push(<Rect key={`b${w}`} x={x} y={bot - h} width={bw} height={h} rx={4} fill={w < curWeek - 1 ? fill : Colors.primary} opacity={w < curWeek - 1 ? 1 : 0.45} />);
    } else {
      bars.push(<Rect key={`b${w}`} x={x} y={bot - 6} width={bw} height={6} rx={3} fill={C.muted} />);
    }
    if (W <= 16 || w % 2 === 0) {
      bars.push(
        <SvgText key={`t${w}`} x={x + bw / 2} y={bot + 13} textAnchor="middle" fontSize={10} fontWeight="600" fill={C.textDim}>
          {w + 1}
        </SvgText>,
      );
    }
  }
  return (
    <View style={{ width, height: H }}>
      <Svg width={width} height={H} viewBox={`0 0 ${width} ${H}`}>
        {bars}
        <Line x1={X0} x2={x1} y1={ty} y2={ty} stroke={C.textMuted} strokeWidth={1.5} strokeDasharray="2 5" strokeLinecap="round" />
        <SvgText x={x1} y={ty - 6} textAnchor="end" fontSize={LABEL_FONT} fontWeight="600" fill={C.mutedFg}>
          {targetLabel}
        </SvgText>
      </Svg>
    </View>
  );
}
