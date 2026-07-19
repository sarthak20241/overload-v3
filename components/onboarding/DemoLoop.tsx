/**
 * The welcome hero's proof: a muted, looping capture of the real app inside
 * a device frame. No narration, no chrome; the product demos itself while
 * the copy above makes the promise. Falls back to nothing if the player
 * fails, so the welcome screen never blocks on the asset.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useTheme } from '@/hooks/useTheme';

// Captured from the iOS simulator (scripted walk: log a set, strength curve,
// type-to-log food), edited to a seamless loop. Re-capture via the workflow
// in .planning/onboarding-redesign-plan.md when the UI changes materially.
const DEMO = require('@/assets/onboarding/welcome-demo.mp4');

export function DemoLoop({ width = 200 }: { width?: number }) {
  const { C } = useTheme();
  // Capture is 604x1246 (status bar cropped off): keep that aspect.
  const height = Math.round(width * (1246 / 604));

  const player = useVideoPlayer(DEMO, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });

  return (
    <View
      style={[
        d.frame,
        { width, height, borderColor: C.border, backgroundColor: C.card },
      ]}
    >
      <VideoView
        player={player}
        style={{ width, height }}
        contentFit="cover"
        nativeControls={false}
        pointerEvents="none"
      />
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
