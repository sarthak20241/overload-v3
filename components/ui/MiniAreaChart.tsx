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
  /** Faint dashed horizontal reference lines, in data units (e.g. band thresholds). */
  refLines?: number[];
  /** Format the tooltip value (pass the metric's own formatter). */
  formatValue?: (v: number) => string;
  /** Always-on dot on the latest point, coloured (e.g. today's band colour). */
  lastPointColor?: string;
  accessibilityLabel?: string;
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

  // Straight segments between real points. A bezier would overshoot between
  // sparse daily samples and fabricate values the user never recorded.
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ');

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
