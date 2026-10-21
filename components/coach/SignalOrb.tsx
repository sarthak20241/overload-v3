/**
 * SignalOrb: Ship Notes' Signal Orb (a WebGL particle orb) running in a small
 * transparent WebView. It is Drona's face in the coach chat.
 *
 * Four shapes, morphing smoothly into each other:
 *  - listening: a breathing sphere; `level` (0-1) sets how much it ripples
 *  - thinking:  a braided ring knot
 *  - searching: three orbit bands with bright heads
 *  - done:      a ring with a tick
 *
 * The page is built from a vendored string (signalOrbSource.ts), so nothing
 * loads over the network. State changes go in by injected JavaScript, so the
 * page never reloads while the chat runs.
 *
 * Native module: react-native-webview. A binary without it cannot run this,
 * so this ships with a new app version, never as an OTA to an older build.
 */
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { WebView } from 'react-native-webview';
import { SIGNAL_ORB_JS } from './signalOrbSource';

export type SignalOrbState = 'listening' | 'thinking' | 'searching' | 'done';

interface Props {
  /** The WebView box. The sphere itself is about 53% of it; the rest is halo. */
  size: number;
  state: SignalOrbState;
  /** 0-1, how much the listening sphere ripples. */
  level?: number;
  /** Dot count, live. More dots read denser and finer; fewer read bolder,
   *  which a small orb needs to stay visible. */
  particles: number;
  /** Brightness multiplier, live. Lifts a small orb off the background. */
  brightness?: number;
  /** One RGB for every state: the orb wears the app's accent, not a rainbow. */
  color: [number, number, number];
  /** Stop the animation loop while the orb is hidden. */
  paused?: boolean;
  /** Shown centered until the page is ready (a WebView takes ~1s to start),
   *  so a short wait never shows an empty spot. */
  placeholder?: ReactNode;
}

function buildPage(color: [number, number, number], particles: number, state: SignalOrbState, level: number) {
  const colors = JSON.stringify([color, color, color, color]);
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}signal-orb{width:100vw}</style>
</head><body>
<script>window.SIGNAL_ORB_COLORS=${colors};</script>
<signal-orb state="${state}" level="${level}" particles="${particles}"></signal-orb>
<script>${SIGNAL_ORB_JS.replace(/<\/script/gi, '<\\/script')}</script>
<script>window.orb=document.querySelector('signal-orb');window.ReactNativeWebView&&window.ReactNativeWebView.postMessage('ready');</script>
</body></html>`;
}

export function SignalOrb({ size, state, level = 0.5, particles, brightness = 1, color, paused = false, placeholder }: Props) {
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  // The page is built once per color. State, level, dots, brightness and
  // pause go in live, so a turn never reloads (and blanks) the orb.
  const colorKey = color.join(',');
  const html = useMemo(
    () => buildPage(color, particles, state, level),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colorKey],
  );

  // A new page (theme change) starts hidden until it says it is ready.
  useEffect(() => { setReady(false); }, [html]);
  // The orb fades in over its placeholder rather than popping in.
  const shown = useSharedValue(0);
  useEffect(() => { shown.value = withTiming(ready ? 1 : 0, { duration: ready ? 450 : 0 }); }, [ready, shown]);
  const orbStyle = useAnimatedStyle(() => ({ opacity: shown.value }));
  const placeholderStyle = useAnimatedStyle(() => ({ opacity: 1 - shown.value }));

  useEffect(() => {
    if (!ready) return;
    ref.current?.injectJavaScript(
      `window.orb&&(window.orb.setAttribute('state',${JSON.stringify(state)}),window.orb.setAttribute('level','${level.toFixed(2)}'),window.orb.setAttribute('particles','${Math.round(particles)}'));`
      + `document.documentElement.style.filter=${JSON.stringify(brightness === 1 ? '' : `brightness(${brightness.toFixed(2)})`)};true;`,
    );
  }, [ready, state, level, particles, brightness]);

  useEffect(() => {
    if (!ready) return;
    ref.current?.injectJavaScript(
      paused
        ? 'window.orb&&(cancelAnimationFrame(window.orb.frame),window.orb.frame=0);true;'
        // Resume unless reduced motion is on: the orb then shows a still
        // shape on purpose and must not start its loop.
        : 'window.orb&&!window.orb.frame&&!(window.orb.media&&window.orb.media.matches)&&(window.orb.last=0,window.orb.frame=requestAnimationFrame(window.orb.tick));true;',
    );
  }, [ready, paused]);

  return (
    <View pointerEvents="none" style={{ width: size, height: size }}>
      {placeholder != null && (
        <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }, placeholderStyle]}>
          {placeholder}
        </Animated.View>
      )}
      <Animated.View style={[{ width: size, height: size }, orbStyle]}>
      <WebView
        ref={ref}
        originWhitelist={['*']}
        source={{ html }}
        onMessage={(e) => { if (e.nativeEvent.data === 'ready') setReady(true); }}
        style={{ width: size, height: size, backgroundColor: 'transparent' }}
        containerStyle={{ backgroundColor: 'transparent' }}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        androidLayerType="hardware"
        setSupportMultipleWindows={false}
        javaScriptEnabled
      />
      </Animated.View>
    </View>
  );
}

/** The orb's color per app theme: lime on dark, a deeper lime on cream. */
export function signalOrbColor(mode: 'dark' | 'light'): [number, number, number] {
  return mode === 'light' ? [91, 143, 0] : [200, 255, 0];
}

/** The sphere's diameter as a share of the box (radius 192 of a 360 half-box). */
export const SIGNAL_ORB_SPHERE = 384 / 720;
