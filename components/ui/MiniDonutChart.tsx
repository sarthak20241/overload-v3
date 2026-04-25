/**
 * Interactive donut chart using react-native-svg.
 * Tap any segment to highlight it and show its % in the center.
 * Uses a native Pressable overlay with angle-based hit testing.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { FontWeight } from '@/constants/theme';
import type { GestureResponderEvent } from 'react-native';

export interface DonutSegment {
  name: string;
  value: number;
  color: string;
}

interface MiniDonutChartProps {
  data: DonutSegment[];
  size: number;
  thickness?: number;
  gap?: number;
  subColor?: string;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(
  cx: number, cy: number,
  outerR: number, innerR: number,
  startAngle: number, endAngle: number,
) {
  const sweep = endAngle - startAngle;
  const largeArc = sweep > 180 ? 1 : 0;
  const oS = polarToCartesian(cx, cy, outerR, startAngle);
  const oE = polarToCartesian(cx, cy, outerR, endAngle);
  const iS = polarToCartesian(cx, cy, innerR, endAngle);
  const iE = polarToCartesian(cx, cy, innerR, startAngle);
  return [
    `M ${oS.x} ${oS.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${oE.x} ${oE.y}`,
    `L ${iS.x} ${iS.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${iE.x} ${iE.y}`,
    'Z',
  ].join(' ');
}

export function MiniDonutChart({
  data,
  size,
  thickness = 20,
  gap = 2,
  subColor = '#888',
}: MiniDonutChartProps) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const [activeIdx, setActiveIdx] = useState<number>(0);

  if (total === 0 || data.length === 0) return null;

  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2;
  const innerR = outerR - thickness;

  const gapAngle = gap;
  const available = 360 - gapAngle * data.length;

  // Build segments with start/end angles
  let currentAngle = 0;
  const segments = data.map((seg, i) => {
    const segAngle = (seg.value / total) * available;
    const start = currentAngle;
    const end = currentAngle + segAngle;
    currentAngle = end + gapAngle;
    return {
      ...seg,
      index: i,
      startAngle: start,
      endAngle: end,
      d: arcPath(cx, cy, outerR, innerR, start, end),
    };
  });

  const displayed = data[activeIdx] || data[0];
  const displayedPct = Math.round((displayed.value / total) * 100);

  // Handle touch — calculate angle from center and find which segment
  const handlePress = useCallback((e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    const dx = locationX - cx;
    const dy = locationY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Only respond to touches in the ring area
    if (dist < innerR * 0.6 || dist > outerR + 4) return;

    // Calculate angle (0 = top, clockwise)
    let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
    if (angle < 0) angle += 360;

    // Find which segment this angle falls in
    for (const seg of segments) {
      if (angle >= seg.startAngle && angle <= seg.endAngle) {
        setActiveIdx(seg.index);
        return;
      }
    }
  }, [segments, cx, cy, innerR, outerR]);

  return (
    <Pressable onPress={handlePress} style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        {segments.map((seg) => (
          <Path
            key={seg.index}
            d={seg.d}
            fill={seg.color}
            opacity={activeIdx === seg.index ? 1 : 0.35}
          />
        ))}
      </Svg>
      {/* Center label */}
      <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
        <Text style={[styles.label, { color: displayed.color }]}>
          {displayedPct}%
        </Text>
        <Text style={[styles.sub, { color: subColor }]}>
          {displayed.name}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 18,
    fontWeight: FontWeight.black,
    lineHeight: 22,
    letterSpacing: -0.5,
  },
  sub: {
    fontSize: 8,
    fontWeight: FontWeight.semibold,
    marginTop: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
