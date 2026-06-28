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
  /** Opt-in: scale the y-axis to the data's own range (not forced through 0), so
   *  small real variation reads clearly. Implied when `baseline` is set. */
  autoScale?: boolean;
  /** A faint "your normal" band drawn behind the line, in data units. */
  baseline?: { lo: number; hi: number };
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
  autoScale = false,
  baseline,
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

  // Smooth cubic bezier curve
  const linePath = points
    .map((p, i) => {
      if (i === 0) return `M ${p.x},${p.y}`;
      const prev = points[i - 1];
      const cpx = (prev.x + p.x) / 2;
      return `C ${cpx},${prev.y} ${cpx},${p.y} ${p.x},${p.y}`;
    })
    .join(' ');

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
    <Pressable onPress={handlePress} style={{ width, height }}>
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
            opacity={0.08}
          />
        )}

        <Path d={areaPath} fill="url(#areaGrad)" />
        <Path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

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
            {activePoint.value >= 1000
              ? `${(activePoint.value / 1000).toFixed(1)}k`
              : activePoint.value}
            {valueSuffix}
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
