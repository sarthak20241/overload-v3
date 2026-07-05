/**
 * Interactive mini area chart using react-native-svg.
 * Tap anywhere on the chart to select the nearest data point.
 * Uses a native Pressable overlay for reliable touch handling.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Svg, {
  Path, Defs, LinearGradient, Stop, Circle, Line, Rect,
} from 'react-native-svg';
import { FontWeight } from '@/constants/theme';
import type { GestureResponderEvent } from 'react-native';

interface MiniAreaChartProps {
  data: number[];
  labels?: string[];
  width: number;
  height: number;
  color: string;
  strokeWidth?: number;
  tooltipTextColor?: string;
  tooltipBgColor?: string;
  valueSuffix?: string;
  /** Scale the y-axis to the data's OWN range (default true), so small real
   *  variation in narrow-band metrics (weight, resting HR, body fat) stays
   *  visible. Pass false to anchor at zero for magnitude-from-zero metrics. */
  autoScale?: boolean;
  /** A faint "your normal" band drawn behind the line, in data units. */
  baseline?: { lo: number; hi: number };
  /** Faint dashed horizontal reference lines, in data units (e.g. band thresholds). */
  refLines?: number[];
  /** Format the tooltip value (pass the metric's own formatter). */
  formatValue?: (v: number) => string;
  /** Always-on dot on the latest point, coloured (e.g. today's band colour). */
  lastPointColor?: string;
  accessibilityLabel?: string;
}

// Monotone cubic interpolation (Fritsch-Carlson): a smooth curve through every
// point with no overshoot, so it never invents values between sparse samples.
function monotonePath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n < 2) return n === 1 ? `M ${pts[0].x},${pts[0].y}` : '';
  if (n === 2) return `M ${pts[0].x},${pts[0].y} L ${pts[1].x},${pts[1].y}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slope[i] = (pts[i + 1].y - pts[i].y) / (dx[i] || 1);
  }
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  // Constrain tangents so each segment stays monotone (kills overshoot).
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = pts[i].x + dx[i] / 3;
    const c1y = pts[i].y + (m[i] * dx[i]) / 3;
    const c2x = pts[i + 1].x - dx[i] / 3;
    const c2y = pts[i + 1].y - (m[i + 1] * dx[i]) / 3;
    d += ` C ${c1x},${c1y} ${c2x},${c2y} ${pts[i + 1].x},${pts[i + 1].y}`;
  }
  return d;
}

export function MiniAreaChart({
  data,
  labels,
  width,
  height,
  color,
  strokeWidth = 2,
  tooltipTextColor = '#fff',
  tooltipBgColor = 'rgba(0,0,0,0.75)',
  valueSuffix = '',
  autoScale = true,
  baseline,
  refLines,
  formatValue,
  lastPointColor,
  accessibilityLabel,
}: MiniAreaChartProps) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  if (data.length < 2) return null;

  let max: number;
  let min: number;
  if (autoScale || baseline) {
    const vals = baseline ? [...data, baseline.lo, baseline.hi] : [...data];
    max = Math.max(...vals);
    min = Math.min(...vals);
    const pad = (max - min) * 0.15 || Math.abs(max) * 0.1 || 1;
    max += pad;
    min -= pad;
  } else {
    max = Math.max(...data, 1);
    min = Math.min(...data, 0);
  }
  const range = max - min || 1;

  const padTop = 20;
  const padBottom = 4;
  const chartH = height - padTop - padBottom;
  const yFor = (v: number) => padTop + chartH - ((v - min) / range) * chartH;

  const points = data.map((v, i) => ({
    x: (i / (data.length - 1)) * width,
    y: padTop + chartH - ((v - min) / range) * chartH,
    value: v,
  }));

  // Smooth but honest: a monotone cubic passes through every real point and never
  // overshoots into values the user did not record (unlike a plain midpoint bezier).
  const linePath = monotonePath(points);

  const areaPath = `${linePath} L ${points[points.length - 1].x},${height} L ${points[0].x},${height} Z`;

  const activePoint = activeIdx !== null ? points[activeIdx] : null;

  // Find nearest data point to touch X
  const handlePress = useCallback((e: GestureResponderEvent) => {
    const touchX = e.nativeEvent.locationX;
    let closest = 0;
    let minDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - touchX);
      if (dist < minDist) {
        minDist = dist;
        closest = i;
      }
    });
    setActiveIdx(activeIdx === closest ? null : closest);
  }, [points, activeIdx]);

  return (
    <Pressable onPress={handlePress} style={{ width, height }} accessible={!!accessibilityLabel} accessibilityLabel={accessibilityLabel}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <Stop offset="60%" stopColor={color} stopOpacity={0.12} />
            <Stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </LinearGradient>
        </Defs>

        {/* "Your normal" band, drawn behind the line. */}
        {baseline && (
          <Rect
            x={0}
            y={yFor(baseline.hi)}
            width={width}
            height={Math.max(1, yFor(baseline.lo) - yFor(baseline.hi))}
            fill={color}
            opacity={0.13}
          />
        )}

        {/* Threshold reference lines (e.g. readiness band cutoffs). */}
        {refLines?.map((v, i) => (
          <Line key={`ref-${i}`} x1={0} y1={yFor(v)} x2={width} y2={yFor(v)} stroke={color} strokeWidth={1} strokeDasharray="2,4" opacity={0.18} />
        ))}

        <Path d={areaPath} fill="url(#areaGrad)" />
        <Path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Always-on "today" dot, coloured by band when provided. */}
        {lastPointColor && (
          <Circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={3.5} fill={lastPointColor} />
        )}

        {/* Dashed indicator line */}
        {activePoint && (
          <Line
            x1={activePoint.x}
            y1={padTop}
            x2={activePoint.x}
            y2={height}
            stroke={color}
            strokeWidth={1}
            strokeDasharray="3,3"
            opacity={0.4}
          />
        )}

        {/* Active dot with halo */}
        {activePoint && (
          <>
            <Circle cx={activePoint.x} cy={activePoint.y} r={6} fill={color} opacity={0.15} />
            <Circle cx={activePoint.x} cy={activePoint.y} r={3} fill={color} />
          </>
        )}
      </Svg>

      {/* Tooltip */}
      {activePoint && activeIdx !== null && (
        <View
          style={[
            chartStyles.tooltip,
            {
              backgroundColor: tooltipBgColor,
              left: Math.max(0, Math.min(activePoint.x - 32, width - 64)),
              top: 0,
            },
          ]}
        >
          {labels?.[activeIdx] && (
            <Text style={[chartStyles.tooltipLabel, { color: tooltipTextColor, opacity: 0.6 }]}>
              {labels[activeIdx]}:
            </Text>
          )}
          <Text style={[chartStyles.tooltipValue, { color: tooltipTextColor }]}>
            {formatValue
              ? formatValue(activePoint.value)
              : `${activePoint.value >= 1000 ? `${(activePoint.value / 1000).toFixed(1)}k` : activePoint.value}${valueSuffix}`}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const chartStyles = StyleSheet.create({
  tooltip: {
    position: 'absolute',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  tooltipLabel: {
    fontSize: 9,
    fontWeight: FontWeight.semibold,
  },
  tooltipValue: {
    fontSize: 9,
    fontWeight: FontWeight.bold,
  },
});
