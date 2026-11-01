/**
 * The moving pictures inside the getting-started lessons
 * (lib/startLessons.ts). Each is a small, looping sketch of the real screen
 * drawn in code, not a video: it follows light and dark mode, stays sharp on
 * every phone and costs no download.
 *
 * Rules every demo follows:
 * - It only moves while its card is the one on screen (`active`).
 * - Reduced Motion shows the finished frame, still.
 * - Transform and opacity only; one accent (lime) moment at most.
 * - It is decoration: hidden from screen readers, the card's text says it all.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';
import { Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import { Feather } from '@expo/vector-icons';
import { Colors, FontFamily, FontSize, FontWeight, LetterSpacing, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { DronaMark } from '@/components/coach/DronaMark';
import { PARSE_SPEED_COPY, type ParseSpeed } from '@/lib/parseSpeed';
import { HOME_LOG_HINT_FIRST } from '@/lib/homeLogHint';
import type { LessonDemo as DemoId } from '@/lib/startLessons';

export const DEMO_HEIGHT = 184;

const SPRING = { damping: 18, stiffness: 180, mass: 0.8 };

/**
 * Steps through `durations` (ms per phase) in a loop while active. Inactive
 * holds phase 0; Reduced Motion holds the last phase (the finished frame).
 */
function usePhase(durations: readonly number[], active: boolean): number {
  const reduced = useReducedMotion();
  const last = durations.length - 1;
  const [phase, setPhase] = useState(reduced ? last : 0);
  useEffect(() => {
    if (reduced) { setPhase(last); return; }
    if (!active) { setPhase(0); return; }
    let alive = true;
    let p = 0;
    let t: ReturnType<typeof setTimeout>;
    const step = () => {
      t = setTimeout(() => {
        if (!alive) return;
        p = (p + 1) % durations.length;
        setPhase(p);
        step();
      }, durations[p]);
    };
    setPhase(0);
    step();
    return () => { alive = false; clearTimeout(t); };
    // durations is a module constant per demo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reduced, last]);
  return phase;
}

function Frame({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  const { C } = useTheme();
  return (
    <View
      style={[f.frame, { backgroundColor: C.background, borderColor: C.borderSubtle }, padded && f.padded]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {children}
    </View>
  );
}

// ── Food: type it ────────────────────────────────────────────────────────

const FOOD_TEXT = '2 eggs and toast';

function FoodType({ active }: { active: boolean }) {
  const { C } = useTheme();
  const reduced = useReducedMotion();
  const [n, setN] = useState(reduced ? FOOD_TEXT.length : 0);
  useEffect(() => {
    if (reduced) { setN(FOOD_TEXT.length); return; }
    if (!active) { setN(0); return; }
    let alive = true;
    let i = 0;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!alive) return;
      if (i < FOOD_TEXT.length) { i += 1; setN(i); t = setTimeout(tick, 70); }
      else t = setTimeout(() => { i = 0; setN(0); t = setTimeout(tick, 700); }, 1800);
    };
    t = setTimeout(tick, 500);
    return () => { alive = false; clearTimeout(t); };
  }, [active, reduced]);

  const caret = useSharedValue(1);
  useEffect(() => {
    caret.value = reduced ? 1 : withRepeat(withSequence(withTiming(0, { duration: 450 }), withTiming(1, { duration: 450 })), -1);
  }, [reduced, caret]);
  const caretStyle = useAnimatedStyle(() => ({ opacity: caret.value }));
  const typed = FOOD_TEXT.slice(0, n);
  const full = n === FOOD_TEXT.length;

  return (
    <Frame>
      <View style={f.center}>
        <Text style={[f.eyebrow, { color: C.textDim }]}>FOOD BOX</Text>
        <View style={[f.box, { backgroundColor: C.card, borderColor: C.border }]}>
          <View style={f.boxText}>
            {n === 0 ? (
              <Text style={[f.boxPlaceholder, { color: C.textDim }]}>What did you eat?</Text>
            ) : (
              <Text style={[f.boxTyped, { color: C.foreground }]}>{typed}</Text>
            )}
            <Animated.View style={[f.caret, { backgroundColor: C.foreground }, caretStyle]} />
          </View>
          <View style={[f.send, { backgroundColor: full ? Colors.primary : C.muted }]}>
            <Feather name="arrow-up" size={14} color={full ? Colors.primaryFg : C.textDim} />
          </View>
        </View>
      </View>
    </Frame>
  );
}

// ── Food: the numbers ────────────────────────────────────────────────────

const RESULT_PHASES = [500, 450, 450, 1100, 1700] as const;

function FoodResult({ active }: { active: boolean }) {
  const { C } = useTheme();
  const phase = usePhase(RESULT_PHASES, active);
  const eggs = phase >= 4 ? 3 : 2;
  const kcal = eggs * 70 + 80;
  const protein = eggs * 6 + 3;

  const row = (key: string, name: string, amount: ReactNode, value: string, delay: number) => (
    <Animated.View key={key} entering={FadeInDown.duration(260).delay(delay)} style={[f.foodRow, { borderColor: C.borderSubtle }]}>
      <Text style={[f.foodName, { color: C.foreground }]} numberOfLines={1}>{name}</Text>
      {amount}
      <Text style={[f.foodKcal, { color: C.mutedFg }]}>{value}</Text>
    </Animated.View>
  );

  return (
    <Frame>
      <View style={{ gap: 8 }}>
        {phase >= 1 && row(
          'eggs',
          'Eggs',
          <View style={f.stepper}>
            <View style={[f.stepBtn, { backgroundColor: C.muted }]}><Feather name="minus" size={10} color={C.mutedFg} /></View>
            <Animated.Text key={eggs} entering={FadeIn.duration(200)} style={[f.stepVal, { color: C.foreground }]}>{eggs}</Animated.Text>
            <View style={[f.stepBtn, { backgroundColor: phase === 4 ? C.foreground : C.muted }]}>
              <Feather name="plus" size={10} color={phase === 4 ? C.background : C.mutedFg} />
            </View>
          </View>,
          `${eggs * 70} kcal`,
          0,
        )}
        {phase >= 2 && row('toast', 'Toast', <Text style={[f.stepVal, { color: C.foreground }]}>1</Text>, '80 kcal', 0)}
        {phase >= 3 && (
          <Animated.View entering={FadeIn.duration(260)} style={f.totalRow}>
            <Animated.Text key={kcal} entering={FadeIn.duration(200)} style={[f.totalNum, { color: C.foreground }]}>
              {kcal}
            </Animated.Text>
            <Text style={[f.totalUnit, { color: C.mutedFg }]}>kcal</Text>
            <View style={{ flex: 1 }} />
            <Text style={[f.totalUnit, { color: C.mutedFg }]}>{protein} g protein</Text>
          </Animated.View>
        )}
      </View>
    </Frame>
  );
}

// ── Food: where it lives ─────────────────────────────────────────────────

function FoodWhere({ active }: { active: boolean }) {
  const { C } = useTheme();
  const reduced = useReducedMotion();
  const ring = useSharedValue(0);
  useEffect(() => {
    ring.value = 0;
    if (!active || reduced) return;
    ring.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.out(Easing.cubic) }), -1);
  }, [active, reduced, ring]);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: 0.45 * (1 - ring.value),
    transform: [{ scale: 1 + ring.value * 0.8 }],
  }));

  return (
    <Frame>
      <View style={{ gap: 8, flex: 1 }}>
        <View style={[f.skel, { width: '46%', height: 12, backgroundColor: C.muted }]} />
        <View style={[f.skel, { height: 54, backgroundColor: C.card }]} />
        <View style={[f.skel, { height: 38, width: '40%', backgroundColor: C.card }]} />
      </View>
      <View style={f.fabWrap}>
        <View style={[f.hintPill, { backgroundColor: C.card, borderColor: C.border }]}>
          <Text style={[f.hintText, { color: C.foreground }]}>{HOME_LOG_HINT_FIRST}</Text>
        </View>
        <View>
          <Animated.View style={[f.fab, f.fabRing, { borderColor: Colors.primary }, ringStyle]} />
          <View style={[f.fab, { backgroundColor: Colors.primary }]}>
            <Feather name="plus" size={18} color={Colors.primaryFg} />
          </View>
        </View>
      </View>
    </Frame>
  );
}

// ── Food modes ───────────────────────────────────────────────────────────

const MODES: ParseSpeed[] = ['quick', 'precise'];
const MODE_PHASES = [1800, 1800] as const;

function ModesPick({ active }: { active: boolean }) {
  const { C } = useTheme();
  const phase = usePhase(MODE_PHASES, active);
  const reduced = useReducedMotion();
  // Reduced Motion's "finished frame" is the default mode, not the last one.
  const idx = reduced ? 0 : phase;
  const [w, setW] = useState(0);
  const x = useSharedValue(0);
  useEffect(() => {
    const seg = w / MODES.length;
    x.value = reduced ? seg * idx : withSpring(seg * idx, SPRING);
  }, [idx, w, reduced, x]);
  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const mode = MODES[idx];

  return (
    <Frame>
      <View style={f.center}>
        <View
          style={[f.track, { backgroundColor: C.muted }]}
          onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width - 8)}
        >
          {w > 0 && (
            <Animated.View style={[f.trackPill, { width: w / MODES.length, backgroundColor: C.card }, pill]} />
          )}
          {MODES.map((m, i) => (
            <View key={m} style={f.trackCell}>
              <Text style={[f.trackText, { color: i === idx ? C.foreground : C.mutedFg }]}>{PARSE_SPEED_COPY[m].title}</Text>
            </View>
          ))}
        </View>
        <Animated.Text
          key={mode}
          entering={FadeIn.duration(260)}
          exiting={FadeOut.duration(160)}
          style={[f.modeSub, { color: C.mutedFg }]}
        >
          {PARSE_SPEED_COPY[mode].sub}
        </Animated.Text>
      </View>
    </Frame>
  );
}

// ── Workout: today ───────────────────────────────────────────────────────

const TODAY_PHASES = [400, 1300, 260, 1400] as const;

function WorkoutToday({ active }: { active: boolean }) {
  const { C } = useTheme();
  const phase = usePhase(TODAY_PHASES, active);
  const press = useSharedValue(1);
  useEffect(() => {
    press.value = withSpring(phase === 2 ? 0.94 : 1, SPRING);
  }, [phase, press]);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));

  return (
    <Frame>
      <View style={f.center}>
        {phase >= 1 && (
          <Animated.View entering={FadeInDown.duration(320)} style={[f.todayCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
            <Text style={[f.eyebrow, { color: C.textDim }]}>TODAY</Text>
            <Text style={[f.todayTitle, { color: C.foreground }]}>Upper body</Text>
            <Text style={[f.todayMeta, { color: C.mutedFg }]}>Phase 1  ·  5 exercises  ·  45 min</Text>
            <Animated.View style={[f.startBtn, { backgroundColor: Colors.primary }, pressStyle]}>
              <Feather name="play" size={11} color={Colors.primaryFg} />
              <Text style={f.startText}>Start</Text>
            </Animated.View>
          </Animated.View>
        )}
      </View>
    </Frame>
  );
}

// ── Workout: sets ────────────────────────────────────────────────────────

const SETS_PHASES = [500, 600, 600, 1600] as const;

function WorkoutSets({ active }: { active: boolean }) {
  const { C } = useTheme();
  const phase = usePhase(SETS_PHASES, active);
  return (
    <Frame>
      <Text style={[f.exName, { color: C.foreground }]}>Bench press</Text>
      <View style={{ gap: 6, marginTop: 8 }}>
        {[0, 1, 2].map((i) => {
          const done = phase > i;
          return (
            <View key={i} style={[f.setRow, { backgroundColor: done ? C.primaryMuted : C.card }]}>
              <Text style={[f.setLabel, { color: C.textDim }]}>Set {i + 1}</Text>
              <Text style={[f.setVal, { color: C.foreground }]}>60 kg  ×  8</Text>
              <View style={{ flex: 1 }} />
              <View style={[f.setCheck, done ? { backgroundColor: C.accentText, borderColor: 'transparent' } : { borderColor: C.border }]}>
                {done && (
                  <Animated.View entering={ZoomIn.springify().damping(14)}>
                    <Feather name="check" size={10} color={C.background} />
                  </Animated.View>
                )}
              </View>
            </View>
          );
        })}
      </View>
    </Frame>
  );
}

// ── Workout: Drona adjusts ───────────────────────────────────────────────

const ADJUST_PHASES = [500, 1100, 2000] as const;

function WorkoutAdjust({ active }: { active: boolean }) {
  const { C } = useTheme();
  const phase = usePhase(ADJUST_PHASES, active);
  const kg = phase >= 2 ? '62.5' : '60';
  return (
    <Frame>
      <View style={f.center}>
        {phase >= 1 && (
          <Animated.View entering={FadeInDown.duration(300)} style={[f.bubble, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
            <View style={[f.bubbleMark, { backgroundColor: C.muted }]}><DronaMark size={10} state="static" /></View>
            <Text style={[f.bubbleText, { color: C.foreground }]}>
              8 reps came easy last time. Try 62.5 kg today.
            </Text>
          </Animated.View>
        )}
        <View style={[f.setRow, { backgroundColor: C.card, alignSelf: 'stretch', marginTop: 10 }]}>
          <Text style={[f.setLabel, { color: C.textDim }]}>Set 1</Text>
          <Animated.Text key={kg} entering={FadeIn.duration(260)} style={[f.setVal, { color: C.foreground }]}>
            {kg} kg  ×  8
          </Animated.Text>
          <View style={{ flex: 1 }} />
          {phase >= 2 && (
            <Animated.View entering={FadeIn.duration(260)} style={[f.upChip, { backgroundColor: C.primaryMuted }]}>
              <Feather name="trending-up" size={10} color={C.accentText} />
              <Text style={[f.upText, { color: C.accentText }]}>+2.5 kg</Text>
            </Animated.View>
          )}
        </View>
      </View>
    </Frame>
  );
}

// ── Phases: the road ─────────────────────────────────────────────────────

const ROAD = [
  { label: 'Phase 1', sub: 'Build the base', meta: '4 weeks' },
  { label: 'Phase 2', sub: 'Get stronger', meta: '6 weeks' },
  { label: 'Goal', sub: 'Your target', meta: '' },
];
const ROAD_PHASES = [500, 800, 800, 1800] as const;
const NODE_GAP = 46;

function PhasesRoad({ active }: { active: boolean }) {
  const { C } = useTheme();
  const phase = usePhase(ROAD_PHASES, active);
  const reached = Math.min(phase, ROAD.length - 1);
  const fill = useSharedValue(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    const target = reached / (ROAD.length - 1);
    fill.value = reduced || phase === 0 ? target : withTiming(target, { duration: 700, easing: Easing.inOut(Easing.cubic) });
  }, [reached, phase, reduced, fill]);
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: fill.value }] }));
  const lineH = NODE_GAP * (ROAD.length - 1);

  return (
    <Frame>
      <View style={{ paddingLeft: 4 }}>
        <View style={[f.roadLine, { height: lineH, backgroundColor: C.muted }]}>
          <Animated.View style={[f.roadFill, { height: lineH, backgroundColor: C.foreground }, fillStyle]} />
        </View>
        {ROAD.map((r, i) => {
          const on = i <= reached;
          const goal = i === ROAD.length - 1;
          return (
            <View key={r.label} style={[f.roadNode, { top: i * NODE_GAP }]}>
              <View
                style={[
                  f.roadDot,
                  on ? { backgroundColor: goal ? Colors.primary : C.foreground, borderColor: 'transparent' } : { backgroundColor: C.background, borderColor: C.border },
                ]}
              />
              <Text style={[f.roadLabel, { color: on ? C.foreground : C.mutedFg }]}>{r.label}</Text>
              <Text style={[f.roadSub, { color: C.mutedFg }]}>{r.sub}</Text>
              <View style={{ flex: 1 }} />
              {!!r.meta && <Text style={[f.roadMeta, { color: C.textDim }]}>{r.meta}</Text>}
            </View>
          );
        })}
      </View>
    </Frame>
  );
}

// ── Weight: the trend ────────────────────────────────────────────────────

// Daily readings bounce; the trend line through them falls gently. Unitless
// on purpose: it is a shape, not anyone's numbers.
const READINGS = [0.52, 0.3, 0.46, 0.62, 0.4, 0.5, 0.66, 0.48, 0.58, 0.74, 0.56, 0.7];
const TREND = (i: number) => 0.36 + (i / (READINGS.length - 1)) * 0.32;

function WeightTrend({ active }: { active: boolean }) {
  const { C } = useTheme();
  const reduced = useReducedMotion();
  const [w, setW] = useState(0);
  const h = DEMO_HEIGHT - Spacing.lg * 2 - 22;
  const draw = useSharedValue(reduced ? 1 : 0);
  const dots = useSharedValue(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) { draw.value = 1; dots.value = 1; return; }
    draw.value = 0;
    dots.value = 0;
    if (!active) return;
    dots.value = withRepeat(
      withSequence(withTiming(1, { duration: 700 }), withDelay(2600, withTiming(0, { duration: 300 }))),
      -1,
    );
    draw.value = withRepeat(
      withSequence(
        withDelay(700, withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.cubic) })),
        withDelay(1400, withTiming(0, { duration: 300 })),
      ),
      -1,
    );
  }, [active, reduced, draw, dots]);

  const { trend, pts } = useMemo(() => {
    const p = Skia.Path.Make();
    const pad = 8;
    const xAt = (i: number) => pad + (i / (READINGS.length - 1)) * (w - pad * 2);
    // Higher reading = higher on screen, so a falling weight slopes down.
    const yAt = (v: number) => pad + v * (h - pad * 2);
    READINGS.forEach((_, i) => {
      const x = xAt(i), y = yAt(TREND(i));
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    });
    return { trend: p, pts: READINGS.map((v, i) => ({ x: xAt(i), y: yAt(v) })) };
  }, [w, h]);

  return (
    <Frame>
      <View style={{ flex: 1 }} onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
        {w > 0 && (
          <Canvas style={{ width: w, height: h }}>
            {pts.map((pt, i) => (
              <Circle key={i} cx={pt.x} cy={pt.y} r={3} color={C.textDim} opacity={dots} />
            ))}
            <Path path={trend} style="stroke" strokeWidth={2.5} strokeCap="round" color={C.foreground} start={0} end={draw} />
          </Canvas>
        )}
        <View style={f.legend}>
          <View style={[f.legendDot, { backgroundColor: C.textDim }]} />
          <Text style={[f.legendText, { color: C.mutedFg }]}>Daily weigh-ins</Text>
          <View style={[f.legendLine, { backgroundColor: C.foreground }]} />
          <Text style={[f.legendText, { color: C.mutedFg }]}>Trend</Text>
        </View>
      </View>
    </Frame>
  );
}

// ── Switch ───────────────────────────────────────────────────────────────

export function LessonDemoView({ demo, active }: { demo: DemoId; active: boolean }) {
  switch (demo) {
    case 'food_type': return <FoodType active={active} />;
    case 'food_result': return <FoodResult active={active} />;
    case 'food_where': return <FoodWhere active={active} />;
    case 'modes_pick': return <ModesPick active={active} />;
    case 'workout_today': return <WorkoutToday active={active} />;
    case 'workout_sets': return <WorkoutSets active={active} />;
    case 'workout_adjust': return <WorkoutAdjust active={active} />;
    case 'phases_road': return <PhasesRoad active={active} />;
    case 'weight_trend': return <WeightTrend active={active} />;
  }
}

const f = StyleSheet.create({
  frame: { height: DEMO_HEIGHT, borderRadius: Radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  padded: { padding: Spacing.lg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  eyebrow: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, marginBottom: 8, alignSelf: 'flex-start' },

  box: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingLeft: 14, paddingRight: 6, height: 48 },
  boxText: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  boxPlaceholder: { fontSize: FontSize.base },
  boxTyped: { fontSize: FontSize.base, fontWeight: FontWeight.medium },
  caret: { width: 1.5, height: 17, marginLeft: 1 },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },

  foodRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  foodName: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  foodKcal: { width: 58, textAlign: 'right', fontSize: FontSize.sm, fontVariant: ['tabular-nums'] },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepBtn: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  stepVal: { minWidth: 10, textAlign: 'center', fontSize: FontSize.base, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  totalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 4 },
  totalNum: { fontFamily: FontFamily.display, fontSize: FontSize.xxxl, letterSpacing: LetterSpacing.tight, fontVariant: ['tabular-nums'] },
  totalUnit: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },

  skel: { borderRadius: Radius.md },
  fabWrap: { position: 'absolute', right: Spacing.lg, bottom: Spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 },
  hintPill: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 6 },
  hintText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  fab: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  fabRing: { position: 'absolute', borderWidth: 2 },

  track: { alignSelf: 'stretch', flexDirection: 'row', borderRadius: 12, padding: 4, height: 44 },
  trackPill: { position: 'absolute', top: 4, left: 4, bottom: 4, borderRadius: 9 },
  trackCell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  trackText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  modeSub: { marginTop: 14, fontSize: FontSize.base, textAlign: 'center' },

  todayCard: { alignSelf: 'stretch', borderRadius: Radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: Spacing.lg },
  todayTitle: { fontFamily: FontFamily.display, fontSize: FontSize.xxl, letterSpacing: LetterSpacing.tight },
  todayMeta: { fontSize: FontSize.sm, marginTop: 4 },
  startBtn: { alignSelf: 'flex-start', marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  startText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.primaryFg },

  exName: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  setRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: Radius.md, paddingHorizontal: 12, height: 36 },
  setLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, width: 36 },
  setVal: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  setCheck: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },

  bubble: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: Radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: 12 },
  bubbleMark: { width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  bubbleText: { flex: 1, fontSize: FontSize.base, lineHeight: 19 },
  upChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  upText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  roadLine: { position: 'absolute', left: 6, top: 7, width: 2, borderRadius: 1, overflow: 'hidden' },
  roadFill: { width: 2, transformOrigin: 'top' },
  roadNode: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 10, height: 16 },
  roadDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5 },
  roadLabel: { fontSize: FontSize.base, fontWeight: FontWeight.bold, width: 58 },
  roadSub: { fontSize: FontSize.sm },
  roadMeta: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },

  legend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  legendDot: { width: 6, height: 6, borderRadius: 3 },
  legendLine: { width: 14, height: 2.5, borderRadius: 1, marginLeft: 10 },
  legendText: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
});
