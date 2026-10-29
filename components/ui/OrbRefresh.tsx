/**
 * Pull to refresh with the orb in place of the native spinner.
 *
 * The native RefreshControl still owns the gesture, the threshold and the
 * held-open gap; only its spinner is hidden. The orb goes in the scroll
 * content as its first child:
 *
 *   <ScrollView refreshControl={<OrbRefreshControl refreshing={r} onRefresh={f} />}>
 *     <RefreshOrb refreshing={r} />
 *     ...
 *
 * iOS: the orb sits just above the content, so the pull uncovers it and the
 * held gap frames it. It stays frozen until the refresh starts, so a resting
 * screen pays nothing for it.
 * Android: the content does not move on a pull, so the orb opens its own gap
 * at the top while the refresh runs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, RefreshControl, StyleSheet, View, type RefreshControlProps } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { OrbLoader } from './OrbLoader';

const ORB = 28;
/** The gap UIRefreshControl holds open while refreshing. */
const IOS_GAP = 60;
const ANDROID_GAP = 52;

/** Holds the orb for at least this long, so a fast reload still reads as an
 *  answer to the pull rather than a flicker. */
const MIN_MS = 800;
/** A reload that hangs (offline) has its orb taken down after this. The
 *  reload itself is not cancelled: if it lands later, its data still shows. */
const MAX_MS = 10_000;

/**
 * Refreshing state for a pull. `run` may return a promise; the orb stays
 * until it settles. A fire-and-forget reload (a tick bump) gets MIN_MS.
 */
export function usePullRefresh(run: () => unknown) {
  const [refreshing, setRefreshing] = useState(false);
  // Each pull gets a number; only the latest one may end the orb, so an old
  // pull's timer cannot cut a newer one short.
  const pull = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => {
    pull.current = -1;
    timers.current.forEach(clearTimeout);
  }, []);

  const onRefresh = useCallback(() => {
    const id = ++pull.current;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRefreshing(true);
    const started = Date.now();
    const cap = new Promise((resolve) => { timers.current.push(setTimeout(() => resolve(null), MAX_MS)); });
    Promise.race([Promise.resolve().then(run), cap])
      .catch(() => {})
      .finally(() => {
        if (id !== pull.current) return;
        timers.current.forEach(clearTimeout);
        timers.current = [setTimeout(() => {
          if (id === pull.current) setRefreshing(false);
        }, Math.max(0, MIN_MS - (Date.now() - started)))];
      });
  }, [run]);
  return { refreshing, onRefresh };
}

export function OrbRefreshControl(props: RefreshControlProps) {
  return (
    <RefreshControl
      {...props}
      // iOS: a clear tint hides the spinner but keeps the pull and the gap.
      tintColor="transparent"
      title={undefined}
      // Android: the spinner disc is parked far above the screen. The pull
      // distance that fires the refresh does not depend on where it sits.
      colors={['transparent']}
      progressBackgroundColor="transparent"
      progressViewOffset={-400}
    />
  );
}

export function RefreshOrb({ refreshing }: { refreshing: boolean }) {
  return Platform.OS === 'ios' ? <IosOrb refreshing={refreshing} /> : <AndroidOrb refreshing={refreshing} />;
}

function IosOrb({ refreshing }: { refreshing: boolean }) {
  return (
    <View pointerEvents="none" style={s.ios}>
      <OrbLoader size={ORB} state="searching" paused={!refreshing} accessibilityLabel="Refreshing" />
    </View>
  );
}

function AndroidOrb({ refreshing }: { refreshing: boolean }) {
  // Kept mounted through the close, so the orb shrinks away instead of
  // vanishing, then unmounted so an idle screen draws nothing.
  const [shown, setShown] = useState(refreshing);
  const open = useSharedValue(refreshing ? 1 : 0);

  useEffect(() => {
    if (refreshing) setShown(true);
    open.value = withTiming(refreshing ? 1 : 0, { duration: 220, easing: Easing.out(Easing.cubic) }, (done) => {
      if (done && !refreshing) runOnJS(setShown)(false);
    });
  }, [refreshing, open]);

  const style = useAnimatedStyle(() => ({ height: open.value * ANDROID_GAP, opacity: open.value }));

  return (
    <Animated.View pointerEvents="none" style={[s.android, style]}>
      {shown ? <OrbLoader size={ORB} state="searching" accessibilityLabel="Refreshing" /> : null}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  ios: {
    position: 'absolute',
    top: -(IOS_GAP + ORB) / 2,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  android: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
});
