/**
 * The hero metric's chart on the Goal screen (.planning/phase-metrics/SPEC.md,
 * src/goal9.py line_chart and src/goal8.py bars_chart), in react-native-svg,
 * which has shipped since the first build, so this needs no new native code.
 *
 *   MetricLineChart  a number over the program: the readings as a lime line
 *                    with a dot on the latest, a dotted path on to the phase
 *                    target (ringed dot, "69.6 by wk 7") and the goal (flag,
 *                    "68 kg"). x is program weeks, 0 at the start.
 *   MetricBarsChart  a habit: one bar per program week against a dotted
 *                    target line, past weeks solid, this week lighter, weeks
 *                    to come as stubs.
 */
import { View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { monotonePath } from '@/components/ui/MiniAreaChart';

export const CHART_HEIGHT = 88;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;
const X0 = 4;
const X1_INSET = 16;
const LABEL_FONT = 10.5;
/** Half a label's width: a label centred nearer an edge than this is pulled in. */
const LABEL_HALF = 26;
const clampLabelX = (x: number, width: number) => Math.max(LABEL_HALF, Math.min(width - LABEL_HALF, x));

export interface LinePoint {
  /** Program weeks from the start (fractional). */
  x: number;
  y: number;
}

interface LineProps {
  width: number;
  /** Readings so far, oldest first. */
  points: LinePoint[];
  /** The whole program, in weeks: the x axis. */
  weeks: number;
  /** Where this phase ends (program week) and what it asks for. */
  phaseEndWeek: number;
  phaseTarget: number;
  phaseTargetLabel: string;
  /** The program's own destination, when it has one: the flag at the end. */
  goalTarget?: number | null;
  goalLabel?: string;
}

export function MetricLineChart({ width, points, weeks, phaseEndWeek, phaseTarget, phaseTargetLabel, goalTarget, goalLabel }: LineProps) {
  const { C } = useTheme();
  const H = CHART_HEIGHT;
  const x1 = width - X1_INSET;
  const W = Math.max(1, weeks);
  const ys = [...points.map((p) => p.y), phaseTarget, ...(goalTarget != null ? [goalTarget] : [])];
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const padY = (hi - lo) * 0.12;
  lo -= padY; hi += padY;
  const X = (w: number) => X0 + (x1 - X0) * Math.max(0, Math.min(W, w)) / W;
  const Y = (v: number) => PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) * (hi - v) / (hi - lo);

  const pts = points.map((p) => ({ x: X(p.x), y: Y(p.y) }));
  const last = pts[pts.length - 1] ?? null;
  const px = X(phaseEndWeek);
  const py = Y(phaseTarget);
  const tx = X(W);
  const ty = goalTarget != null ? Y(goalTarget) : null;
  const dotted = last
    ? `M${last.x.toFixed(1)},${last.y.toFixed(1)} L${px.toFixed(1)},${py.toFixed(1)}${ty != null ? ` L${tx.toFixed(1)},${ty.toFixed(1)}` : ''}`
    : null;
  // Labels sit under their marks; when the two land on top of each other the
  // goal label moves up above the flag.
  const goalLabelAbove = ty != null && Math.abs(ty - py) < 14 && Math.abs(tx - px) < 60;

  return (
    <View style={{ width, height: H }}>
      <Svg width={width} height={H} viewBox={`0 0 ${width} ${H}`}>
        {dotted && (
          <Path d={dotted} stroke={C.textMuted} strokeWidth={2} strokeDasharray="1 6" strokeLinecap="round" fill="none" />
        )}
        {pts.length >= 2 && (
          <Path d={monotonePath(pts)} stroke={Colors.primary} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {last && (
          <>
            <Circle cx={last.x} cy={last.y} r={5.5} fill={Colors.primary} />
            <Circle cx={last.x} cy={last.y} r={2.2} fill={Colors.primaryFg} />
          </>
        )}
        <Circle cx={px} cy={py} r={4} fill={C.card} stroke={Colors.primary} strokeWidth={2} />
        <SvgText x={clampLabelX(px, width)} y={py + 20} textAnchor="middle" fontSize={LABEL_FONT} fontWeight="600" fill={C.accentText}>
          {phaseTargetLabel}
        </SvgText>
        {ty != null && (
          <G transform={`translate(${tx.toFixed(1)},${ty.toFixed(1)})`}>
            <Circle r={9} fill={C.card} stroke={C.mutedFg} strokeWidth={1.4} />
            <Path d="M-2.8,4.2 L-2.8,-4.6 M-2.8,-4.6 L3.8,-2.5 L-2.8,-0.4" stroke={C.foreground} strokeWidth={1.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </G>
        )}
        {ty != null && goalLabel && (
          <SvgText x={clampLabelX(tx, width)} y={goalLabelAbove ? ty - 14 : ty + 22} textAnchor="middle" fontSize={LABEL_FONT} fontWeight="600" fill={C.mutedFg}>
            {goalLabel}
          </SvgText>
        )}
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
  const H = CHART_HEIGHT;
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
