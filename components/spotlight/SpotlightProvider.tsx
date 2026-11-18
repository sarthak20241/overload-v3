/**
 * Spotlight tours: the dashboard intro and the first-visit hints (rules and
 * words in lib/spotlight.ts, the drawing in ./SpotlightOverlay.tsx).
 *
 * A screen marks a control with `useSpotlightTarget('food_box')` (a ref for a
 * plain View) and asks for its tour with `useSpotlightTour('food_box', ready)`.
 * The provider keeps which tours this account has seen (AsyncStorage, per
 * user), runs one tour at a time, and measures each control on screen before
 * it lights it. A control that is not laid out or sits off screen is skipped,
 * and a hint whose control is not there yet is tried again on the next visit
 * (it is only marked seen once it showed).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUser } from '@clerk/clerk-expo';
import { useFocusEffect } from 'expo-router';
import { Portal } from '@/components/ui/Portal';
import { track } from '@/lib/analytics';
import {
  accountAgeDays,
  canStart,
  countsAsSeen,
  holeFor,
  nextStep,
  onScreen,
  parseSeen,
  seenKey,
  TOURS,
  type Hole,
  type Rect,
  type SpotlightEnd,
  type SpotlightTargetId,
  type SpotlightTourId,
} from '@/lib/spotlight';
import { SpotlightOverlay } from './SpotlightOverlay';

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

interface Ctx {
  register: (target: SpotlightTargetId, ref: React.RefObject<View | null>) => () => void;
  start: (id: SpotlightTourId) => Promise<boolean>;
  end: (id: SpotlightTourId, how: SpotlightEnd) => void;
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
  const { user } = useUser();
  const userId = user?.id ?? null;
  const createdAtMs = user?.createdAt ? new Date(user.createdAt).getTime() : null;

  const targets = useRef(new Map<SpotlightTargetId, React.RefObject<View | null>>());
  const [seen, setSeen] = useState<Set<SpotlightTourId> | null>(null);
  const seenRef = useRef<Set<SpotlightTourId> | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const activeRef = useRef<Active | null>(null);
  activeRef.current = active;
  seenRef.current = seen;
  const [screen, setScreen] = useState<{ w: number; h: number } | null>(null);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // Load this account's seen list. A sign-out or account switch reloads.
  useEffect(() => {
    setSeen(null);
    setActive(null);
    if (!userId) return;
    if (DEMO) { setSeen(new Set()); return; }
    let live = true;
    AsyncStorage.getItem(seenKey(userId))
      .then((raw) => { if (live) setSeen(parseSeen(raw)); })
      .catch(() => { if (live) setSeen(new Set()); });
    return () => { live = false; };
  }, [userId]);

  const register = useCallback((target: SpotlightTargetId, ref: React.RefObject<View | null>) => {
    targets.current.set(target, ref);
    return () => {
      if (targets.current.get(target) === ref) targets.current.delete(target);
    };
  }, []);

  const markSeen = useCallback((id: SpotlightTourId) => {
    const next = new Set(seenRef.current ?? []);
    next.add(id);
    seenRef.current = next;
    setSeen(next);
    if (userId && !DEMO) AsyncStorage.setItem(seenKey(userId), JSON.stringify([...next])).catch(() => {});
  }, [userId]);

  /** The lit hole for step `from` or the first later step whose control is on screen. */
  const findStep = useCallback(async (id: SpotlightTourId, from: number): Promise<{ index: number; hole: Hole } | null> => {
    const steps = TOURS[id].steps;
    const sc = screenRef.current;
    if (!sc) return null;
    for (let i = from; i < steps.length; i++) {
      const rect = await measure(targets.current.get(steps[i].target));
      if (onScreen(rect, sc.w, sc.h)) return { index: i, hole: holeFor(rect!, steps[i].shape) };
    }
    return null;
  }, []);

  const start = useCallback(async (id: SpotlightTourId) => {
    const s = seenRef.current;
    if (!s) return false;
    const age = DEMO ? 0 : accountAgeDays(createdAtMs, Date.now());
    if (!canStart(id, { seen: s, active: activeRef.current?.id ?? null, accountAgeDays: age })) return false;
    const first = await findStep(id, 0);
    // Another tour may have started while we measured.
    if (!first || activeRef.current) return false;
    const a = { id, ...first };
    activeRef.current = a;
    setActive(a);
    track('spotlight_shown', { tour: id, step: TOURS[id].steps[first.index].target });
    return true;
  }, [createdAtMs, findStep, markSeen]);

  const end = useCallback((id: SpotlightTourId, how: SpotlightEnd) => {
    const a = activeRef.current;
    if (!a || a.id !== id) return;
    activeRef.current = null;
    setActive(null);
    // Seen only once it really ended, so a tour a popup cut short comes back.
    if (countsAsSeen(TOURS[id].kind, how)) markSeen(id);
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

  const value = useMemo<Ctx>(() => ({ register, start, end }), [register, start, end]);

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
          onEnd={(how) => { if (activeRef.current) end(activeRef.current.id, how); }}
        />
      </Portal>
    </SpotlightContext.Provider>
  );
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

  // Only the screen's own focus may end its tour, never a context change.
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => {
      setFocused(false);
      ctxRef.current?.end(id, 'left');
    };
  }, [id]));

  useEffect(() => {
    if (!ctx || !focused) return;
    // Something else took the screen (a popup, a sheet): step aside for now.
    if (!ready) { ctx.end(id, 'interrupted'); return; }
    const t = setTimeout(() => { ctx.start(id); }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [ctx, focused, ready, id]);

  return useCallback(() => ctxRef.current?.end(id, 'used'), [id]);
}
