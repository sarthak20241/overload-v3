/**
 * DronaAura: the soft lime light that rises from the bottom of the coach chat
 * while Drona works (the dock lift). Static drawing; the caller fades and
 * breathes it with an opacity.
 */
import React from 'react';
import { Canvas, LinearGradient, RadialGradient, Rect, vec } from '@shopify/react-native-skia';

export function DronaAura({
  width,
  height,
  mode,
  fadeTo,
}: {
  width: number;
  height: number;
  mode: 'dark' | 'light';
  /** The surface color under the aura. The light fades into it at the bottom
   *  edge, so the glow never ends on a hard line above the home indicator. */
  fadeTo: string;
}) {
  const colors = mode === 'light'
    ? ['rgba(150,210,0,0.20)', 'rgba(150,210,0,0.06)', 'rgba(150,210,0,0)']
    : ['rgba(200,255,0,0.13)', 'rgba(200,255,0,0.04)', 'rgba(200,255,0,0)'];
  // Brightest just above the input, not at the very bottom edge.
  const cy = height - 110;
  const r = Math.max(width * 0.7, height * 0.8);
  const fade = 120;
  return (
    <Canvas style={{ width, height }}>
      <Rect x={0} y={0} width={width} height={height}>
        <RadialGradient c={vec(width / 2, cy)} r={r} colors={colors} positions={[0, 0.55, 1]} />
      </Rect>
      <Rect x={0} y={height - fade} width={width} height={fade}>
        <LinearGradient
          start={vec(0, height - fade)}
          end={vec(0, height)}
          colors={[`${fadeTo}00`, fadeTo]}
        />
      </Rect>
    </Canvas>
  );
}
