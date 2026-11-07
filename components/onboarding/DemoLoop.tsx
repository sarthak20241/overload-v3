/**
 * The welcome screen's demo: a muted film that fills the whole screen and
 * loops behind the two buttons. No device box and no text around it; the
 * film carries its own words ("Meet Drona. Say where you want to be.", then
 * log a set, say what you ate, a plan built for you, each on a real app
 * screen).
 *
 * The film is DECORATIVE, so it must never be load-bearing. expo-video is a
 * native module, and a binary without it (an OTA update landing on an older
 * build, or a build made before the dependency was linked) throws
 * "Cannot find native module 'ExpoVideo'" at import time. Imported at module
 * scope that takes the whole onboarding screen down with it. So we resolve
 * expo-video defensively and fall back to a still of the film's first scene.
 * Reduced Motion shows that still too.
 */
import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Image, StyleSheet, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

// 14.2 s, 720 x 1560, 1.5 MB, made in Remotion from simulator recordings
// and encoded with ffmpeg. The Remotion project is not in this repo; it lives
// on the owner's Mac (comp WelcomeDemoMediumPhone in
// ~/Movies/overload-launch/a-quiet-power/film/src/signup.tsx). It starts and ends on the dark stage,
// so the loop has no visible seam. The bottom ~24% holds nothing the story
// needs: the welcome screen's buttons sit there. Re-record when the three
// screens change materially.
const DEMO = require('@/assets/onboarding/welcome-demo.mp4');
const POSTER = require('@/assets/onboarding/welcome-demo-poster.jpg');

/** What a screen reader hears in place of the film. Re-write it when the film is re-cut. */
export const WELCOME_DEMO_LABEL =
  'Meet Drona. Say where you want to be, I handle the rest. Log a set in one tap. Say what you ate. A plan built for you.';

type VideoModule = typeof import('expo-video');

// Resolved once, at module load. A throw here means the native module is
// absent in this binary; that is a degraded hero, not a broken screen.
const Video: VideoModule | null = (() => {
  try {
    const m = require('expo-video') as VideoModule | undefined;
    return typeof m?.useVideoPlayer === 'function' && m?.VideoView != null ? m : null;
  } catch {
    return null;
  }
})();

/** Only mounted when expo-video resolved, so its hooks are never conditional. */
function VideoLoop() {
  const player = Video!.useVideoPlayer(DEMO, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  const View_ = Video!.VideoView;
  return (
    <View_
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      nativeControls={false}
      // iOS can put a Live Text button on a paused frame.
      allowsVideoFrameAnalysis={false}
      pointerEvents="none"
    />
  );
}

/**
 * Reduce Motion, kept current: Reanimated's hook reads it once at start-up, so
 * turning it on with the app open would leave the film playing.
 */
function useReduceMotionLive(): boolean {
  const atStart = useReducedMotion();
  const [on, setOn] = useState(atStart);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setOn(v); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}

/** Fills its parent. The owner places it behind the welcome screen's content. */
export function DemoLoop() {
  const reduced = useReduceMotionLive();
  return (
    <View
      style={[StyleSheet.absoluteFill, d.stage]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={WELCOME_DEMO_LABEL}
    >
      <Image source={POSTER} style={StyleSheet.absoluteFill} resizeMode="cover" />
      {Video && !reduced ? <VideoLoop /> : null}
    </View>
  );
}

const d = StyleSheet.create({
  stage: { backgroundColor: '#0a0a0a' },
});
