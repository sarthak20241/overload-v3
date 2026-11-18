/**
 * Spotlight tours: the dashboard intro and first-visit hints for new accounts,
 * and "what's new" tours for an OTA (rules, words and the how-to for adding a
 * release tour in lib/spotlight.ts; the drawing in ./SpotlightOverlay.tsx).
 *
 * A screen marks a control with `useSpotlightTarget('food_box')` (a ref for a
 * plain View) and asks for its tour with `useSpotlightTour('food_box', ready)`.
 * Hints wait until the dashboard intro has ended, so the intro always comes first
 * (an account that never sees the intro on the dashboard gets no hints).
 * A hint whose lit control opens another screen must call the returned `done()`
 * first (goal-plan's phase card does), or leaving reads as 'left' and the hint
 * shows again.
 * The provider keeps which tours this account has seen (AsyncStorage, per
 * user), runs one tour at a time, and measures each control on screen before
 * it lights it. A control that is not laid out or sits off screen is skipped,
 * and a hint whose control is not there yet is tried again on the next visit
 * (it is only marked seen once it showed).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, type View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
// The safe accessor: ClerkProvider is not mounted when the key is missing,
// and this provider wraps the whole Stack, including that guard screen.
import { useClerkUser } from '@/hooks/useClerkUser';
import { useFocusEffect } from 'expo-router';
import { Portal } from '@/components/ui/Portal';
import { track, trackError } from '@/lib/analytics';
import {
  canStart,
  countsAsSeen,
  dataLoaded,
  holeFor,
  mergeSeen,
  nextStep,
  onScreen,
  parseSeen,
  seenKey,
  toOverlay,
  TOURS,
  type Hole,
  type Rect,
  type SpotlightEnd,
  type SpotlightTargetId,
  type SpotlightTourId,
} from '@/lib/spotlight';
import { SpotlightOverlay, type OverlayFrame } from './SpotlightOverlay';

/** Under the sign-up film (100), over every sheet. */
const SPOTLIGHT_LAYER = 90;
/** Wait for the screen's own entrance animations before measuring. */
const SETTLE_MS = 750;
/**
 * Dev builds only: EXPO_PUBLIC_SPOTLIGHT_DEMO=1 shows every tour on any
 * account, once per app launch, and stores nothing. For working on the tours.
 */
const DEMO = __DEV__ && process.env.EXPO_PUBLIC_SPOTLIGHT_DEMO === '1';

export type { SpotlightEnd } from '@/lib/spotlight';

interface Active {
  id: SpotlightTourId;
  index: number;
  hole: Hole;
}

/** shown; blocked (seen, too old, another tour, screen gone); missed (no control on screen). */
type StartResult = 'shown' | 'blocked' | 'missed';

interface Ctx {
  register: (target: SpotlightTargetId, ref: React.RefObject<View | null>) => () => void;
  /** `stillWanted` is checked after measuring: the screen may have gone. */
  start: (id: SpotlightTourId, stillWanted?: () => boolean) => Promise<StartResult>;
  end: (id: SpotlightTourId, how: SpotlightEnd) => void;
  /** The seen list and the account date are in: screens may try their tour. */
  loaded: boolean;
}

const SpotlightContext = createContext<Ctx | null>(null);

function measure(ref: React.RefObject<View | null> | undefined): Promise<Rect | null> {
  return new Promise((resolve) => {
    const node = ref?.current;
    if (!node) return resolve(null);
    try {
      node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
    } catch {
      resolve(null);
    }
  });
}

export function SpotlightProvider({ children }: { children: React.ReactNode }) {
  const { user } = useClerkUser();
  const userId = user?.id ?? null;
  const createdAtMs = user?.createdAt ? new Date(user.createdAt).getTime() : null;

  const targets = useRef(new Map<SpotlightTargetId, React.RefObject<View | null>>());
  const [seen, setSeen] = useState<Set<SpotlightTourId> | null>(null);
  const seenRef = useRef<Set<SpotlightTourId> | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const activeRef = useRef<Active | null>(null);
  activeRef.current = active;
  seenRef.current = seen;
  // The overlay's size and where it starts in the window (see toOverlay).
  const [screen, setScreen] = useState<OverlayFrame | null>(null);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // Load this account's seen list. A sign-out or account switch reloads.
  useEffect(() => {
    // Clear the refs too: start() reads them, and the next render is not here yet.
    seenRef.current = null;
    activeRef.current = null;
    setSeen(null);
    setActive(null);
    if (!userId) return;
    if (DEMO) { setSeen(new Set()); return; }
    let live = true;
    AsyncStorage.getItem(seenKey(userId))
      .then((raw) => { if (live) setSeen(parseSeen(raw)); })
      .catch((e) => {
        // Reads as nothing seen, so tours may repeat: leave a trace.
        trackError(e, { where: 'spotlight_seen_read' });
        if (live) setSeen(new Set());
      });
    return () => { live = false; };
  }, [userId]);

  const register = useCallback((target: SpotlightTargetId, ref: React.RefObject<View | null>) => {
    targets.current.set(target, ref);
    return () => {
      if (targets.current.get(target) === ref) targets.current.delete(target);
    };
  }, []);

  const writeChain = useRef<Promise<unknown>>(Promise.resolve());
  const markSeen = useCallback((id: SpotlightTourId) => {
    const next = new Set(seenRef.current ?? []);
    next.add(id);
    seenRef.current = next;
    setSeen(next);
    if (userId && !DEMO) {
      const key = seenKey(userId);
      // Merge with what is stored, so a failed read earlier never wipes it,
      // and queue the saves, so two tours ending together never race.
      // A failed read aborts the save (it would write only this session's
      // list over the stored one). `next` holds every id this session, so the
      // next save retries them all.
      writeChain.current = writeChain.current
        .then(() => AsyncStorage.getItem(key))
        .then((raw) => AsyncStorage.setItem(key, JSON.stringify(mergeSeen(raw, next))))
        // Not fatal (the tour shows once more next launch), but leave a trace.
        .catch((e) => trackError(e, { where: 'spotlight_seen_write', tour: id }));
    }
  }, [userId]);

  /** The lit hole for step `from` or the first later step whose control is on screen. */
  const findStep = useCallback(async (id: SpotlightTourId, from: number): Promise<{ index: number; hole: Hole } | null> => {
    const steps = TOURS[id].steps;
    const sc = screenRef.current;
    if (!sc) return null;
    for (let i = from; i < steps.length; i++) {
      const measured = await measure(targets.current.get(steps[i].target));
      const rect = measured ? toOverlay(measured, { x: sc.ox, y: sc.oy }) : null;
      if (onScreen(rect, sc.w, sc.h)) return { index: i, hole: holeFor(rect!, steps[i].shape) };
    }
    return null;
  }, []);

  const start = useCallback(async (id: SpotlightTourId, stillWanted?: () => boolean) => {
    const s = seenRef.current;
    if (!s) return 'blocked';
    if (!canStart(TOURS[id], { seen: s, active: activeRef.current?.id ?? null, createdAtMs, nowMs: Date.now(), demo: DEMO })) return 'blocked';
    const first = await findStep(id, 0);
    // Another tour may have started, or the screen gone, while we measured.
    if (activeRef.current) return 'blocked';
    if (stillWanted && !stillWanted()) return 'blocked';
    if (!first) return 'missed';
    const a = { id, ...first };
    activeRef.current = a;
    setActive(a);
    track('spotlight_shown', { tour: id, step: TOURS[id].steps[first.index].target });
    return 'shown';
  }, [createdAtMs, findStep]);

  const end = useCallback((id: SpotlightTourId, how: SpotlightEnd) => {
    const a = activeRef.current;
    if (!a || a.id !== id) return;
    activeRef.current = null;
    setActive(null);
    // Seen only once it really ended, so a tour a popup cut short comes back.
    if (countsAsSeen(how)) markSeen(id);
    track('spotlight_done', { tour: id, how, step: a.index + 1, of: TOURS[id].steps.length });
  }, [markSeen]);

  const next = useCallback(async () => {
    const a = activeRef.current;
    if (!a) return;
    const n = nextStep(a.index, TOURS[a.id].steps.length);
    const found = n === 'done' ? null : await findStep(a.id, n);
    if (activeRef.current !== a) return;
    if (!found) return end(a.id, 'finished');
    const b = { id: a.id, ...found };
    activeRef.current = b;
    setActive(b);
  }, [end, findStep]);

  // Stable, so the overlay's back-button and keyboard listeners subscribe once.
  const endActive = useCallback((how: SpotlightEnd) => {
    if (activeRef.current) end(activeRef.current.id, how);
  }, [end]);

  const loaded = dataLoaded({ seenLoaded: seen != null, createdAtMs, demo: DEMO });
  // The overlay's frame changed (Android keyboard resize, split view): the lit
  // hole is in old coordinates. Measure the step again, or step aside.
  useEffect(() => {
    const a = activeRef.current;
    if (!a || !screen) return;
    let live = true;
    findStep(a.id, a.index).then((found) => {
      if (!live || activeRef.current !== a) return;
      if (!found || found.index !== a.index) return end(a.id, 'interrupted');
      const b = { ...a, hole: found.hole };
      activeRef.current = b;
      setActive(b);
    });
    return () => { live = false; };
    // Only a frame change re-measures; the step itself drives start/next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  const value = useMemo<Ctx>(() => ({ register, start, end, loaded }), [register, start, end, loaded]);

  return (
    <SpotlightContext.Provider value={value}>
      {children}
      <Portal layer={SPOTLIGHT_LAYER}>
        <SpotlightOverlay
          tour={active ? TOURS[active.id] : null}
          index={active?.index ?? 0}
          hole={active?.hole ?? null}
          onScreenSize={setScreen}
          onNext={next}
          onEnd={endActive}
        />
      </Portal>
    </SpotlightContext.Provider>
  );
}

/** Whether the software keyboard is up (starts are held while it is). */
function useKeyboardUp(): boolean {
  const [up, setUp] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', () => setUp(true));
    const b = Keyboard.addListener('keyboardDidHide', () => setUp(false));
    return () => { a.remove(); b.remove(); };
  }, []);
  return up;
}

/** Mark a control as a spotlight target. Pass the screen's own ref if it has one. */
export function useSpotlightTarget(target: SpotlightTargetId, own?: React.RefObject<View | null>) {
  const ctx = useContext(SpotlightContext);
  const mine = useRef<View>(null);
  const ref = own ?? mine;
  useEffect(() => ctx?.register(target, ref), [ctx, target, ref]);
  return ref;
}

/**
 * Ask for a tour while this screen is in front and `ready` (its controls are
 * drawn and nothing else owns the screen). Returns `done`, for the screen to
 * call when the user uses the lit control. Leaving the screen ends it.
 */
export function useSpotlightTour(id: SpotlightTourId, ready: boolean) {
  const ctx = useContext(SpotlightContext);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [focused, setFocused] = useState(false);
  // Read after the async measure in start(): the screen may have gone by then.
  const wantedRef = useRef(false);
  wantedRef.current = focused && ready;

  // Only the screen's own focus may end its tour, never a context change.
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => {
      setFocused(false);
      wantedRef.current = false;
      ctxRef.current?.end(id, 'left');
    };
  }, [id]));

  // ctx is read through the ref, so a new context value (Clerk settling)
  // never restarts the settle timer; only `loaded` turning true does.
  const loaded = ctx?.loaded ?? false;
  const keyboardUp = useKeyboardUp();
  useEffect(() => {
    const c = ctxRef.current;
    if (!c || !focused) return;
    // Something else took the screen (a popup, a sheet): step aside for now.
    if (!ready) { c.end(id, 'interrupted'); return; }
    // Never start over an open keyboard (it would cover what the user types);
    // try again once it closes. A tour already up ends itself as 'used'.
    if (keyboardUp) return;
    // Re-runs when `loaded` turns true, so a slow cold start still gets its try.
    // It does NOT re-run when a tour ends (seen is not a dep), on purpose: a
    // follow-up (set_types, food_modes) waits for the next visit or `ready`
    // flip, so the user gets one lesson at a time.
    if (!loaded) return;
    // One retry: the control may not be laid out yet (a slow list, the
    // overlay's size not in). Hints wait on the intro, so a lost intro
    // would cost them too.
    let retry: ReturnType<typeof setTimeout> | undefined;
    const tryStart = () => ctxRef.current?.start(id, () => wantedRef.current) ?? Promise.resolve<StartResult>('blocked');
    const t = setTimeout(() => {
      tryStart().then((first) => {
        if (first === 'missed' && wantedRef.current) {
          retry = setTimeout(() => {
            tryStart().then((again) => {
              // Twice no control on screen: worth seeing how often in PostHog.
              if (again === 'missed') track('spotlight_missed', { tour: id });
            });
          }, SETTLE_MS * 2);
        }
      });
    }, SETTLE_MS);
    return () => { clearTimeout(t); if (retry) clearTimeout(retry); };
  }, [focused, ready, loaded, keyboardUp, id]);

  return useCallback(() => ctxRef.current?.end(id, 'used'), [id]);
}
