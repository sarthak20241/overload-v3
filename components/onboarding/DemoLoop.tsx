/**
 * The welcome hero's proof: a muted, looping capture of the real app inside
 * a device frame. No narration, no chrome; the product demos itself while
 * the copy above makes the promise.
 *
 * The loop is DECORATIVE, so it must never be load-bearing. expo-video is a
 * native module, and a binary without it (an OTA update landing on an older
 * build, or a build made before the dependency was linked) throws
 * "Cannot find native module 'ExpoVideo'" at import time. Imported at module
 * scope that takes the whole onboarding screen down with it. So we resolve
 * expo-video defensively and fall back to a still frame of the same capture:
 * the hero still shows the product, just without motion.
 */
import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

// Captured from the iOS simulator (scripted walk: log a set, strength curve,
// type-to-log food), edited to a seamless loop. Re-capture via the workflow
// in .planning/onboarding-redesign-plan.md when the UI changes materially.
const DEMO = require('@/assets/onboarding/welcome-demo.mp4');
const POSTER = require('@/assets/onboarding/welcome-demo-poster.jpg');

// Capture is 604x1246 (status bar cropped off): keep that aspect.
const ASPECT = 1246 / 604;

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
function VideoLoop({ width, height }: { width: number; height: number }) {
  const player = Video!.useVideoPlayer(DEMO, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  const View_ = Video!.VideoView;
  return (
    <View_
      player={player}
      style={{ width, height }}
      contentFit="cover"
      nativeControls={false}
      pointerEvents="none"
    />
  );
}

export function DemoLoop({ width = 200 }: { width?: number }) {
  const { C } = useTheme();
  const height = Math.round(width * ASPECT);

  return (
    <View
      style={[
        d.frame,
        { width, height, borderColor: C.border, backgroundColor: C.card },
      ]}
    >
      {Video ? (
        <VideoLoop width={width} height={height} />
      ) : (
        <Image source={POSTER} style={{ width, height }} resizeMode="cover" />
      )}
    </View>
  );
}

const d = StyleSheet.create({
  frame: {
    borderRadius: 28,
    borderWidth: 1,
    overflow: 'hidden',
    alignSelf: 'center',
  },
});
