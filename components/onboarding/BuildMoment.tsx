/**
 * The build moment (Phase 4): Drona visibly assembling the plan. The mark
 * runs its thinking trace while checklist lines tick in sequence, a Space
 * Grotesk percent counts up, and the mark releases (answer state) when the
 * plan is ready.
 *
 * v1 staging: the deterministic engine is instant, so the ticks are paced by
 * timers over REAL artifacts (the lines describe what was actually built).
 * Phase 3b binds this same screen to the ai-coach edge function's server
 * status events and streamed days; the screen is ELASTIC by design - it waits
 * for `ready` rather than a fixed duration, so slower generation just holds
 * the thinking state longer (locked decision: no timeout bail for slowness).
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { FontFamily, FontSize, IconSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';
import { DronaMark } from '@/components/coach/DronaMark';

// Once the plan is ready, remaining lines tick through briskly.
const READY_STEP_MS = 700;
// While generation is still running, ticks stretch so the latency is spread
// across the WHOLE checklist instead of sprinting to the last line and
// stalling: ~0.9s, 1.6s, 2.6s, 3.8s between ticks (per tick index).
const waitingStepMs = (tickIndex: number) => 900 + tickIndex * tickIndex * 320;
// Displayed percent per completed tick: uneven, organic milestones. Between
// ticks the number creeps a few points toward the next one so the screen
// always looks alive during a long generation.
const PCT_TARGETS = [0, 26, 44, 63, 82, 100];

export function BuildMoment({
  lines,
  /** True once the plan artifacts exist; the last tick waits for it. */
  ready,
  onDone,
}: {
  lines: string[];
  ready: boolean;
  onDone: () => void;
}) {
  const { C } = useTheme();
  const [ticked, setTicked] = useState(0);
  const [creep, setCreep] = useState(0);
  const doneFired = useRef(false);

  // Advance one line per beat. The FINAL line refuses to tick until `ready`
  // (elastic hold); earlier ticks slow progressively while generation runs.
  useEffect(() => {
    if (ticked >= lines.length) return;
    const isLast = ticked === lines.length - 1;
    if (isLast && !ready) return; // hold the thinking state; effect re-runs on `ready`
    const t = setTimeout(() => {
      haptics.tick();
      setTicked((n) => n + 1);
    }, ready ? READY_STEP_MS : waitingStepMs(ticked));
    return () => clearTimeout(t);
  }, [ticked, lines.length, ready]);

  const finished = ticked >= lines.length;

  // Percent creep between ticks: drift up to 6 points toward the next
  // milestone (never reaching it) so a long hold still shows motion.
  useEffect(() => {
    setCreep(0);
    if (finished) return;
    const iv = setInterval(() => setCreep((c) => Math.min(c + 1, 6)), 900);
    return () => clearInterval(iv);
  }, [ticked, finished]);

  useEffect(() => {
    if (!finished || doneFired.current) return;
    doneFired.current = true;
    const t = setTimeout(onDone, 1100);
    return () => clearTimeout(t);
  }, [finished, onDone]);

  const base = PCT_TARGETS[Math.min(ticked, PCT_TARGETS.length - 1)];
  const next = PCT_TARGETS[Math.min(ticked + 1, PCT_TARGETS.length - 1)];
  const pct = Math.min(base + creep, Math.max(base, next - 3));

  return (
    <View style={b.wrap}>
      <DronaMark size={64} state={finished ? 'answer' : 'thinking'} />
      <Text style={[b.pct, { color: C.foreground }]}>{pct}%</Text>
      <Text style={[b.title, { color: C.textSecondary }]}>
        {finished ? 'Your plan is ready.' : 'Building your plan'}
      </Text>

      <View style={b.list}>
        {lines.map((line, idx) => {
          const done = idx < ticked;
          const current = idx === ticked;
          if (!done && !current) return null;
          return (
            <Animated.View key={line} entering={FadeInDown.duration(300)} style={b.row}>
              {done ? (
                <Feather name="check" size={IconSize.sm} color={C.accentText} />
              ) : (
                <View style={[b.pending, { borderColor: C.border }]} />
              )}
              <Text
                style={[
                  b.rowText,
                  { color: done ? C.foreground : C.textMuted },
                ]}
              >
                {line}
              </Text>
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

const b = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.md,
  },
  pct: {
    fontFamily: FontFamily.display,
    fontSize: 56,
    letterSpacing: -1,
    marginTop: Spacing.md,
  },
  title: { fontSize: FontSize.lg },
  list: {
    alignSelf: 'stretch',
    marginTop: Spacing.xxl,
    gap: Spacing.lg,
    minHeight: 200,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  rowText: { fontSize: FontSize.md, flex: 1 },
  pending: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
  },
});
