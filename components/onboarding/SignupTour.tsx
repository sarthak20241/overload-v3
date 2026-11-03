/**
 * The sign-up tour: five full-screen film scenes right after a new account is
 * made. It sits on the Goal screen (?tour=1) while phase 1 builds underneath,
 * so the wait for the plan becomes the tour. Words and tap rules live in
 * lib/signupTour.ts.
 *
 * The look follows the owner's reference (Nike Run Club's opener): the film
 * fills the screen with only a soft scrim, a small wordmark top left, story
 * bars on top, and a big two-tone headline at the lower left (white line,
 * grey line, same size) over round pill buttons.
 *
 * Drawn through the root Portal on a high layer, so the build sheet that opens
 * underneath after it mounts stays hidden until the tour ends.
 *
 * The films are decoration: expo-video is resolved defensively (a binary
 * without it shows each scene's still), and Reduced Motion shows stills too.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, FontFamily, FontSize, FontWeight, LetterSpacing, Spacing } from '@/constants/theme';
import { Portal } from '@/components/ui/Portal';
import { PressableScale } from '@/components/ui/PressableScale';
import { haptics } from '@/lib/haptics';
import { track } from '@/lib/analytics';
import { nextScene, tapStep, TOUR_SCENE_MS, tourScenes, type TourSceneId } from '@/lib/signupTour';

const FILMS: Record<TourSceneId, number> = {
  welcome: require('@/assets/tour/welcome.mp4'),
  train: require('@/assets/tour/train.mp4'),
  eat: require('@/assets/tour/eat.mp4'),
  adapt: require('@/assets/tour/adapt.mp4'),
  plan: require('@/assets/tour/plan.mp4'),
};
const STILLS: Record<TourSceneId, number> = {
  welcome: require('@/assets/tour/welcome.jpg'),
  train: require('@/assets/tour/train.jpg'),
  eat: require('@/assets/tour/eat.jpg'),
  adapt: require('@/assets/tour/adapt.jpg'),
  plan: require('@/assets/tour/plan.jpg'),
};

/** Above every sheet, so the build opening underneath stays out of sight. */
const TOUR_LAYER = 100;

type VideoModule = typeof import('expo-video');
const Video: VideoModule | null = (() => {
  try {
    const m = require('expo-video') as VideoModule | undefined;
    return typeof m?.useVideoPlayer === 'function' && m?.VideoView != null ? m : null;
  } catch {
    return null;
  }
})();

/** One player for the whole tour; each scene swaps its film in. The last
 *  scene plays once and holds its final frame (the silhouette). */
function Film({ id }: { id: TourSceneId }) {
  // Starts on the current scene, so a remount mid-tour does not jump back.
  // The source must stay fixed after mount: the hook builds a new player
  // whenever its source changes, which would undo the one-player swap below.
  const initial = useRef(FILMS[id]).current;
  const player = Video!.useVideoPlayer(initial, (p) => {
    p.muted = true;
    p.loop = true;
    p.play();
  });
  const first = useRef(true);
  // A swap that fails leaves the last film playing over the new scene's
  // still; stop it and let the still show instead.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    player.loop = id !== 'plan';
    if (first.current) { first.current = false; return; }
    let live = true;
    player.replaceAsync(FILMS[id])
      .then(() => { if (!live) return; setFailed(false); player.play(); })
      .catch(() => { if (!live) return; player.pause(); setFailed(true); });
    return () => { live = false; };
  }, [id, player]);
  const VideoView = Video!.VideoView;
  if (failed) return null;
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      nativeControls={false}
      pointerEvents="none"
    />
  );
}

/** A story bar: full when passed, filling while current, empty ahead. */
function Bar({ state, progress }: { state: 'done' | 'now' | 'ahead'; progress: ReturnType<typeof useSharedValue<number>> }) {
  const fill = useAnimatedStyle(() => ({
    transform: [{ scaleX: state === 'done' ? 1 : state === 'now' ? progress.value : 0 }],
  }), [state]);
  return (
    <View style={s.bar}>
      <Animated.View style={[s.barFill, fill]} />
    </View>
  );
}

interface Props {
  firstName: string | null;
  /** "Build the base. 4 weeks." for the last scene, when the phase is known. */
  phaseLine: string | null;
  /** Finished (the last button) or skipped. The owner unmounts it. */
  onDone: (how: 'finished' | 'skipped') => void;
}

export function SignupTour({ firstName, phaseLine, onDone }: Props) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();
  // With a screen reader on, scenes wait for Next: a 4.5s timer moves on
  // before the words are read out.
  const [readerOn, setReaderOn] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isScreenReaderEnabled().then((on) => { if (live) setReaderOn(on); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setReaderOn);
    return () => { live = false; sub.remove(); };
  }, []);
  const scenes = tourScenes(firstName, phaseLine);
  const last = scenes.length - 1;
  const [index, setIndex] = useState(0);
  // Bumped to restart the current scene's timer (back on the first scene).
  const [round, setRound] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const progress = useSharedValue(0);
  const ended = useRef(false);
  // The scene index for callbacks that fire late (the auto-advance from the
  // UI thread, analytics on finish), so they never read a stale one.
  const indexRef = useRef(index);
  indexRef.current = index;
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The owner's onDone is usually an inline arrow; a ref keeps finish (and so
  // go) stable, so the scene timer below never restarts on an owner render.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => () => { if (doneTimer.current) clearTimeout(doneTimer.current); }, []);
  const scene = scenes[index];

  useEffect(() => { track('signup_tour_shown', {}); }, []);

  const finish = useCallback((how: 'finished' | 'skipped') => {
    if (ended.current) return;
    ended.current = true;
    track('signup_tour_done', { how, scene: indexRef.current });
    setLeaving(true);
    // The fade-out plays, then the owner unmounts the tour. The owner must
    // keep the tour mounted until onDone: unmounting it first clears this
    // timer, onDone never fires, and anything waiting on it (the Goal
    // screen's paywall hand-off) would wait for good.
    doneTimer.current = setTimeout(() => onDoneRef.current(how), 280);
  }, []);

  const go = useCallback((step: -1 | 1) => {
    if (ended.current) return;
    const from = indexRef.current;
    const to = nextScene(from, step, scenes.length);
    if (to === 'done') { finish('finished'); return; }
    // Back on the first scene: replay its timer. Zeroing the value alone
    // would cancel the running timing and stall the tour there.
    if (to === from) { setRound((r) => r + 1); return; }
    haptics.selection();
    setIndex(to);
  }, [scenes.length, finish]);

  // Each scene fills its bar, then moves on. The last one waits for the button,
  // and so does every scene while a screen reader is on.
  useEffect(() => {
    if (round === 0 || index !== 0) track('signup_tour_scene', { scene: index, id: scene.id });
    cancelAnimation(progress);
    progress.value = 0;
    const isLast = index === last;
    if (readerOn) return;
    progress.value = withTiming(1, { duration: TOUR_SCENE_MS, easing: Easing.linear }, (done) => {
      if (done && !isLast) runOnJS(go)(1);
    });
    return () => cancelAnimation(progress);
    // Per scene only: go, progress and last are stable for the tour's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, round, readerOn]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { finish('skipped'); return true; });
    return () => sub.remove();
  }, [finish]);

  const onTap = (e: GestureResponderEvent) => go(tapStep(e.nativeEvent.locationX, width));
  const isLast = index === last;

  return (
    <Portal layer={TOUR_LAYER}>
      {!leaving && (
        <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(260)} style={s.root}>
          <StatusBar style="light" />
          <Image source={STILLS[scene.id]} style={StyleSheet.absoluteFill} resizeMode="cover" />
          {Video && !reduced ? <Film id={scene.id} /> : null}

          {/* A light wash over the whole frame, then a deeper fade where the
              words sit, so white type reads on any frame of the film. */}
          <View style={[StyleSheet.absoluteFill, s.wash]} pointerEvents="none" />
          <LinearGradient
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.65)']}
            style={s.scrim}
            pointerEvents="none"
          />

          {/* Tap anywhere to move on, left third to go back. Hidden from
              screen readers, which use the Next and Skip buttons instead. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onTap}
            accessible={false}
            importantForAccessibility="no"
          />

          <View style={[s.top, { paddingTop: insets.top + Spacing.sm }]} pointerEvents="none">
            <View style={s.bars}>
              {scenes.map((sc, i) => (
                <Bar key={sc.id} state={i < index ? 'done' : i === index ? 'now' : 'ahead'} progress={progress} />
              ))}
            </View>
            <Text style={s.mark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              OVER<Text style={{ color: Colors.primary }}>LOAD</Text>
            </Text>
          </View>

          <View style={[s.bottom, { paddingBottom: insets.bottom + Spacing.xl }]} pointerEvents="box-none">
            <Animated.View key={scene.id} entering={reduced ? undefined : FadeInDown.duration(520)} pointerEvents="none">
              <Text style={s.title} accessibilityRole="header">
                {scene.title}
                {'\n'}
                <Text style={s.sub}>{scene.sub}</Text>
              </Text>
            </Animated.View>

            <View style={s.buttons}>
              {isLast ? (
                <PressableScale
                  onPress={() => finish('finished')}
                  style={[s.pill, s.pillSolid, { flex: 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel="See my plan"
                >
                  <Text style={s.pillSolidText}>See my plan</Text>
                </PressableScale>
              ) : (
                <>
                  <PressableScale
                    onPress={() => go(1)}
                    haptic={false}
                    style={[s.pill, s.pillSolid]}
                    accessibilityRole="button"
                    accessibilityLabel="Next"
                  >
                    <Text style={s.pillSolidText}>Next</Text>
                  </PressableScale>
                  <PressableScale
                    onPress={() => finish('skipped')}
                    haptic="tick"
                    style={[s.pill, s.pillLine]}
                    accessibilityRole="button"
                    accessibilityLabel="Skip the tour"
                  >
                    <Text style={s.pillLineText}>Skip</Text>
                  </PressableScale>
                </>
              )}
            </View>
          </View>
        </Animated.View>
      )}
    </Portal>
  );
}

const s = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0b0b0b' },
  wash: { backgroundColor: 'rgba(0,0,0,0.18)' },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%' },
  top: { position: 'absolute', left: Spacing.xl, right: Spacing.xl, top: 0 },
  bars: { flexDirection: 'row', gap: 4 },
  bar: { flex: 1, height: 2.5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  barFill: { flex: 1, backgroundColor: '#ffffff', transformOrigin: 'left' },
  mark: {
    marginTop: Spacing.lg,
    color: '#ffffff',
    fontSize: FontSize.md,
    fontWeight: FontWeight.black,
    letterSpacing: LetterSpacing.eyebrow,
  },
  bottom: { position: 'absolute', left: Spacing.xl, right: Spacing.xl, bottom: 0 },
  title: {
    color: '#ffffff',
    fontFamily: FontFamily.displayMedium,
    fontSize: 34,
    lineHeight: 39,
    letterSpacing: LetterSpacing.tight,
  },
  sub: { color: 'rgba(255,255,255,0.55)' },
  buttons: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.xxl },
  pill: { flex: 1, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  pillSolid: { backgroundColor: '#ffffff' },
  pillSolidText: { color: '#0a0a0a', fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  pillLine: { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)' },
  pillLineText: { color: '#ffffff', fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
});
