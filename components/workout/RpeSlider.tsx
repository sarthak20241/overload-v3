/**
 * Pure-JS RPE/RIR slider (Phase B). No native slider dependency (so it works in
 * the current dev client) — a gesture-handler Pan over a measured track, snapped
 * to 0.5 RPE steps. Always operates in raw RPE space (1-10); the sheet handles
 * the RIR display. Left = easy, right = max effort.
 */
import { useRef, useState } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { Colors, Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';

const MIN = 1;
const MAX = 10;
const STEP = 0.5;
const THUMB = 28;

export function RpeSlider({ value, onChange }: { value: number | null; onChange: (rpe: number) => void }) {
  const { C } = useTheme();
  const [w, setW] = useState(0);
  const wRef = useRef(0);
  const lastRef = useRef<number | null>(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  lastRef.current = value;

  const apply = (x: number) => {
    const width = wRef.current;
    if (width <= 0) return;
    const frac = Math.min(1, Math.max(0, x / width));
    let v = MIN + frac * (MAX - MIN);
    v = Math.min(MAX, Math.max(MIN, Math.round(v / STEP) * STEP));
    if (v !== lastRef.current) {
      lastRef.current = v;
      haptics.tick();
      onChangeRef.current(v);
    }
  };

  const pan = Gesture.Pan()
    .onBegin((e) => { runOnJS(apply)(e.x); })
    .onUpdate((e) => { runOnJS(apply)(e.x); });

  const frac = value == null ? 0 : (value - MIN) / (MAX - MIN);

  return (
    <GestureDetector gesture={pan}>
      <View
        style={s.hit}
        onLayout={(e: LayoutChangeEvent) => { const width = e.nativeEvent.layout.width; wRef.current = width; setW(width); }}
      >
        <View style={[s.track, { backgroundColor: C.muted }]}>
          <View style={[s.fill, { width: `${frac * 100}%`, backgroundColor: value == null ? 'transparent' : Colors.primary }]} />
        </View>
        {value != null && (
          <View style={[s.thumb, { left: w ? frac * w - THUMB / 2 : -THUMB / 2, borderColor: Colors.primary, backgroundColor: C.elevated }]} />
        )}
      </View>
    </GestureDetector>
  );
}

const s = StyleSheet.create({
  hit: { height: 44, justifyContent: 'center' },
  track: { height: 6, borderRadius: Radius.full, overflow: 'hidden' },
  fill: { height: '100%' },
  thumb: { position: 'absolute', width: THUMB, height: THUMB, borderRadius: THUMB / 2, borderWidth: 3, top: (44 - THUMB) / 2 },
});
