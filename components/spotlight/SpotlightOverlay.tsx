/**
 * The spotlight itself (state and rules in ./SpotlightProvider.tsx and
 * lib/spotlight.ts).
 *
 * The look:
 *  - Skia draws one dark sheet with a hole cut out of it (even-odd fill). The
 *    hole is five shared values (x, y, width, height, corner), so it springs
 *    from one control to the next and changes shape on the way.
 *  - On open the hole starts as wide as the screen and closes in on the
 *    control (an iris), while the dark fades in.
 *  - A thin lime ring with a soft glow sits on the hole's edge, and a second
 *    ring keeps breathing out of it, so the eye goes there first.
 *  - The tip card springs in from the hole's side with a small caret that
 *    points at the control, and a light haptic on every step.
 *
 * Touches: the intro takes every tap (anywhere moves on). A hint blocks only
 * the dark area (a tap there closes it), so the lit control stays live and
 * the user does the real thing. A keyboard opening also closes a hint, since
 * the user is now typing in the lit box.
 *
 * Reduced Motion: no iris, no springs, no breathing ring; plain fades.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeInUp,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { BlurMask, Canvas, FillType, Path, RoundedRect, Skia } from '@shopify/react-native-skia';
import { Colors, FontFamily, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';
import { tipSide, type Hole, type SpotlightEnd, type SpotlightTour } from '@/lib/spotlight';

const SPRING = { damping: 19, stiffness: 170, mass: 0.9 } as const;
const GUTTER = Spacing.lg;
const TIP_GAP = 14;
const CARET = 12;

interface Props {
  tour: SpotlightTour | null;
  index: number;
  hole: Hole | null;
  onScreenSize: (s: OverlayFrame) => void;
  onNext: () => void;
  onEnd: (how: SpotlightEnd) => void;
}

interface Shown { tour: SpotlightTour; index: number; hole: Hole }

/** The overlay's size, and its top-left corner in window coordinates. */
export interface OverlayFrame { w: number; h: number; ox: number; oy: number }

export function SpotlightOverlay({ tour, index, hole, onScreenSize, onNext, onEnd }: Props) {
  const reduce = useReducedMotion();
  const { mode, C } = useTheme();
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const rootRef = useRef<View>(null);
  // What is drawn: it outlives `tour` by the fade out.
  const [shown, setShown] = useState<Shown | null>(null);
  const [closing, setClosing] = useState(false);
  // Read by the open/close effect, which runs on the props alone: refs keep it
  // off stale state (a tour that opens during the last one's fade).
  const shownRef = useRef<Shown | null>(null);
  const closingRef = useRef(false);
  const show = (v: Shown | null) => { shownRef.current = v; setShown(v); };
  const setClosingBoth = (v: boolean) => { closingRef.current = v; setClosing(v); };
  // The fade's end clears the drawing only if nothing opened meanwhile.
  const clearIfClosed = () => { if (closingRef.current) { show(null); setClosingBoth(false); } };

  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const w = useSharedValue(0);
  const h = useSharedValue(0);
  const r = useSharedValue(0);
  const dim = useSharedValue(0);
  const pulse = useSharedValue(0);

  // Open, move, close.
  useEffect(() => {
    if (tour && hole) {
      // Still drawn (even mid-fade): move the hole from where it is, no iris.
      const wasOpen = shownRef.current != null;
      show({ tour, index, hole });
      setClosingBoth(false);
      const to = (v: typeof x, n: number) => { v.value = reduce ? n : withSpring(n, SPRING); };
      if (!wasOpen && !reduce && size) {
        // Iris: start from a hole bigger than the screen, centred on the control.
        const big = Math.hypot(size.w, size.h) * 2;
        const cx = hole.x + hole.width / 2;
        const cy = hole.y + hole.height / 2;
        x.value = cx - big / 2; y.value = cy - big / 2; w.value = big; h.value = big; r.value = big / 2;
        x.value = withTiming(hole.x, { duration: 620, easing: Easing.out(Easing.cubic) });
        y.value = withTiming(hole.y, { duration: 620, easing: Easing.out(Easing.cubic) });
        w.value = withTiming(hole.width, { duration: 620, easing: Easing.out(Easing.cubic) });
        h.value = withTiming(hole.height, { duration: 620, easing: Easing.out(Easing.cubic) });
        r.value = withTiming(hole.r, { duration: 620, easing: Easing.out(Easing.cubic) });
      } else {
        to(x, hole.x); to(y, hole.y); to(w, hole.width); to(h, hole.height); to(r, hole.r);
      }
      dim.value = withTiming(1, { duration: reduce ? 160 : 320 });
      haptics.selection();
      return;
    }
    if (shownRef.current && !closingRef.current) {
      setClosingBoth(true);
      dim.value = withTiming(0, { duration: 240 }, (ok) => {
        if (ok) runOnJS(clearIfClosed)();
      });
    }
    // Only the props drive this; the shared values and helpers are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour, index, hole, reduce]);

  // The breathing ring, only while something is lit.
  const lit = shown != null && !closing;
  useEffect(() => {
    if (!lit || reduce) {
      cancelAnimation(pulse);
      pulse.value = 0;
      return;
    }
    pulse.value = 0;
    pulse.value = withDelay(500, withRepeat(withTiming(1, { duration: 1700, easing: Easing.out(Easing.quad) }), -1, false));
    return () => cancelAnimation(pulse);
  }, [lit, reduce, pulse]);

  // Android back closes it.
  useEffect(() => {
    if (!lit) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onEnd('skipped'); return true; });
    return () => sub.remove();
  }, [lit, onEnd]);

  // A hint ends once the user types in the lit box.
  const isHint = shown?.tour.kind === 'hint';
  useEffect(() => {
    if (!lit || !isHint) return;
    const sub = Keyboard.addListener('keyboardDidShow', () => onEnd('used'));
    return () => sub.remove();
  }, [lit, isHint, onEnd]);

  const W = size?.w ?? 0;
  const H = size?.h ?? 0;

  const sheet = useDerivedValue(() => {
    const p = Skia.Path.Make();
    p.addRect(Skia.XYWHRect(0, 0, W, H));
    p.addRRect(Skia.RRectXY(Skia.XYWHRect(x.value, y.value, w.value, h.value), r.value, r.value));
    p.setFillType(FillType.EvenOdd);
    return p;
  }, [W, H]);

  // The breathing ring grows out of the hole and fades as it goes.
  const grow = useDerivedValue(() => pulse.value * 16);
  const ringX = useDerivedValue(() => x.value - grow.value);
  const ringY = useDerivedValue(() => y.value - grow.value);
  const ringW = useDerivedValue(() => w.value + grow.value * 2);
  const ringH = useDerivedValue(() => h.value + grow.value * 2);
  const ringR = useDerivedValue(() => r.value + grow.value);
  const ringOpacity = useDerivedValue(() => (1 - pulse.value) * 0.7 * dim.value);
  const edgeOpacity = useDerivedValue(() => dim.value);
  const sheetOpacity = useDerivedValue(() => dim.value);

  const tipFade = useAnimatedStyle(() => ({ opacity: dim.value }));

  const shade = mode === 'dark' ? 'rgba(0,0,0,0.74)' : 'rgba(12,12,10,0.62)';

  const tip = useMemo(() => {
    if (!shown || !size) return null;
    const { tour: t, index: i, hole: hl } = shown;
    const step = t.steps[i];
    const side = tipSide(hl, size.h);
    const centerX = hl.x + hl.width / 2;
    const caretLeft = Math.max(22, Math.min(size.w - GUTTER * 2 - 22 - CARET, centerX - GUTTER - CARET / 2));
    const pos = side === 'below'
      ? { top: hl.y + hl.height + TIP_GAP }
      : { bottom: size.h - hl.y + TIP_GAP };
    const last = i === t.steps.length - 1;
    const enter = reduce
      ? FadeIn.duration(180)
      : (side === 'below' ? FadeInDown : FadeInUp).springify().damping(17).stiffness(190).delay(i === 0 ? 300 : 90);
    return { t, i, step, side, caretLeft, pos, last, enter };
  }, [shown, size, reduce]);

  const press = (fn: () => void) => () => { haptics.tap(); fn(); };
  const finish = () => {
    if (!tip) return;
    if (tip.last) { haptics.success(); onEnd('finished'); } else onNext();
  };

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={lit ? 'box-none' : 'none'}
      ref={rootRef}
      onLayout={(e) => {
        const s = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
        setSize(s);
        // Where the overlay starts in the window, so measured controls line up.
        const node = rootRef.current;
        if (!node) return onScreenSize({ ...s, ox: 0, oy: 0 });
        node.measureInWindow((ox, oy) => onScreenSize({ ...s, ox: ox || 0, oy: oy || 0 }));
      }}
    >
      {shown && size ? (
        <>
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            <Path path={sheet} color={shade} opacity={sheetOpacity} />
            {/* Soft lime glow on the edge, then the crisp edge on top. */}
            <RoundedRect x={x} y={y} width={w} height={h} r={r} color={Colors.primary} style="stroke" strokeWidth={6} opacity={edgeOpacity}>
              <BlurMask blur={10} style="outer" />
            </RoundedRect>
            <RoundedRect x={x} y={y} width={w} height={h} r={r} color={Colors.primary} style="stroke" strokeWidth={1.5} opacity={edgeOpacity} />
            <RoundedRect x={ringX} y={ringY} width={ringW} height={ringH} r={ringR} color={Colors.primary} style="stroke" strokeWidth={1.5} opacity={ringOpacity} />
          </Canvas>

          {/* Touch layer. */}
          {!closing && shown.tour.kind === 'intro' ? (
            <Pressable style={StyleSheet.absoluteFill} onPress={finish} accessibilityLabel="Next tip" />
          ) : null}
          {!closing && shown.tour.kind === 'hint' ? (
            <OutsideBlockers hole={shown.hole} w={size.w} h={size.h} onPress={() => onEnd('outside')} />
          ) : null}

          {tip ? (
            <Animated.View style={[styles.tipWrap, tip.pos, tipFade]} pointerEvents={closing ? 'none' : 'box-none'}>
              <Animated.View
                key={`${tip.t.id}-${tip.i}`}
                entering={tip.enter}
                style={[styles.tip, { backgroundColor: C.card, borderColor: C.border }]}
                accessibilityLiveRegion="polite"
              >
                <View
                  style={[
                    styles.caret,
                    { left: tip.caretLeft, backgroundColor: C.card, borderColor: C.border },
                    tip.side === 'below' ? styles.caretTop : styles.caretBottom,
                  ]}
                />
                <View style={styles.tipHead}>
                  <View style={styles.dot} />
                  <Text style={[styles.title, { color: C.foreground }]}>{tip.step.title}</Text>
                </View>
                <Text style={[styles.body, { color: C.mutedFg }]}>{tip.step.body}</Text>
                <View style={styles.row}>
                  {tip.t.steps.length > 1 ? (
                    <View style={styles.dots}>
                      {tip.t.steps.map((_, k) => (
                        <View
                          key={k}
                          style={[styles.stepDot, { backgroundColor: k === tip.i ? Colors.primary : C.border, width: k === tip.i ? 16 : 6 }]}
                        />
                      ))}
                    </View>
                  ) : <View />}
                  <View style={styles.actions}>
                    {tip.t.kind === 'intro' && !tip.last ? (
                      <Pressable onPress={press(() => onEnd('skipped'))} hitSlop={10} accessibilityRole="button" accessibilityLabel="Skip the tour">
                        <Text style={[styles.skip, { color: C.mutedFg }]}>Skip</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      onPress={press(tip.t.kind === 'hint' ? () => onEnd('finished') : finish)}
                      style={({ pressed }) => [styles.cta, { opacity: pressed ? 0.85 : 1 }]}
                      accessibilityRole="button"
                    >
                      <Text style={styles.ctaText}>{tip.last ? 'Got it' : 'Next'}</Text>
                    </Pressable>
                  </View>
                </View>
              </Animated.View>
            </Animated.View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** Four dark panels around the hole: a tap on any of them closes the hint. */
function OutsideBlockers({ hole, w, h, onPress }: { hole: Hole; w: number; h: number; onPress: () => void }) {
  const top = Math.max(0, hole.y);
  const bottom = Math.min(h, hole.y + hole.height);
  const left = Math.max(0, hole.x);
  const right = Math.min(w, hole.x + hole.width);
  const panels = [
    { left: 0, top: 0, width: w, height: top },
    { left: 0, top: bottom, width: w, height: h - bottom },
    { left: 0, top, width: left, height: bottom - top },
    { left: right, top, width: w - right, height: bottom - top },
  ];
  return (
    <>
      {panels.map((p, i) => (
        <Pressable key={i} style={[styles.blocker, p]} onPress={onPress} accessibilityRole="button" accessibilityLabel="Close tip" />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  tipWrap: { position: 'absolute', left: GUTTER, right: GUTTER },
  tip: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 14,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  caret: {
    position: 'absolute',
    width: CARET,
    height: CARET,
    transform: [{ rotate: '45deg' }],
  },
  caretTop: { top: -CARET / 2, borderLeftWidth: StyleSheet.hairlineWidth, borderTopWidth: StyleSheet.hairlineWidth },
  caretBottom: { bottom: -CARET / 2, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  tipHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.primary },
  title: { fontFamily: FontFamily.onboardingHeading, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: FontFamily.onboardingBody, fontSize: 15, lineHeight: 21, marginTop: 4, marginLeft: 15 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 15 },
  stepDot: { height: 6, borderRadius: 3 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  skip: { fontFamily: FontFamily.onboardingHeading, fontSize: 15 },
  cta: { backgroundColor: Colors.primary, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 9 },
  ctaText: { fontFamily: FontFamily.onboardingHeading, fontSize: 15, color: Colors.primaryFg },
  blocker: { position: 'absolute' },
});
