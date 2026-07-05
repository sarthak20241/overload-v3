/**
 * Readiness progress ring. Shared by the dashboard ReadinessCard (size 96) and
 * the /health hero (size 140) so the two never visually drift. Pure SVG, no deps
 * beyond react-native-svg. Children render centred over the ring (the score).
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

interface ReadinessRingProps {
  /** 0-100. Values out of range are clamped. */
  score: number;
  /** Progress stroke colour (band colour). */
  color: string;
  /** Track (unfilled) colour. */
  track: string;
  size?: number;
  stroke?: number;
  children?: ReactNode;
}

export function ReadinessRing({ score, color, track, size = 96, stroke = 9, children }: ReadinessRingProps) {
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.max(0, Math.min(100, score)) / 100);
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle cx={cx} cy={cx} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <Circle
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          rotation={-90}
          origin={`${cx}, ${cx}`}
        />
      </Svg>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </View>
    </View>
  );
}
