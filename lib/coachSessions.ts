/**
 * The coach sheets that are open, or still working out of sight.
 *
 * The coach sheet used to live inside whichever screen opened it, so closing
 * it, tapping back, or leaving that screen unmounted it and aborted whatever
 * Drona was writing. A workout, a split or a program the user waited 15 s for
 * was thrown away by one tap. Now one host at the app root
 * (components/ai/CoachSheetHost.tsx) renders every sheet from this store, and a
 * sheet that is still working when it is closed is kept, hidden, until it ends.
 *
 * The rules:
 * - One sheet shows at a time.
 * - Closing a busy sheet keeps it ("kept"). Closing an idle one drops it, as
 *   before, unless its result has not been seen yet.
 * - A kept sheet that ends ("finished") waits as unseen until the user opens
 *   it: from the ready banner, the phone notification, or by opening the same
 *   kind of sheet again (same screen, and for a phase build the same phase).
 * - The in-workout chat is never kept. Its context is the live session, which
 *   the workout screen snapshots per open, so a kept one would answer about a
 *   workout that has moved on.
 *
 * Plain TypeScript with no React, so the rules are tested in Deno
 * (lib/coachSessions.test.ts). The props type is generic for the same reason.
 */

export type CoachSheetScreen = 'menu' | 'chat' | 'plan' | 'workout' | 'program';

/** The props the store reads. The sheet's real props carry much more. */
export interface CoachSessionProps {
  initialScreen?: CoachSheetScreen;
  linkRoutinesToPhaseId?: string;
  workoutContext?: unknown;
}

export interface CoachSession<P extends CoachSessionProps> {
  id: number;
  props: P;
  /** The opener's close callback: tells it the sheet is gone. */
  onClose: (() => void) | null;
  visible: boolean;
  /** The sub-screen the sheet is on now, not the one it opened on. */
  screen: CoachSheetScreen;
  busy: boolean;
  failed: boolean;
  /** The screen holds a built workout, split or program (not just a reply). */
  result: boolean;
  /** Ended while hidden, and not opened since. */
  unseen: boolean;
  /** False for the in-workout chat: closing always drops it. */
  keepAlive: boolean;
  touchedAt: number;
}

export type CoachSessionEvent<P extends CoachSessionProps> =
  | { type: 'kept'; session: CoachSession<P> }
  | { type: 'finished'; session: CoachSession<P>; failed: boolean; hidden: boolean };

/** Kept sheets past this many lose their oldest idle one. */
export const MAX_KEPT = 4;

/** Same keys, same values (by identity). An opener's props are a fresh object every render. */
export function sameProps(a: object, b: object): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function createCoachSessionStore<P extends CoachSessionProps>(now: () => number = Date.now) {
  // Reassigned, never mutated, so a snapshot is stable between writes
  // (useSyncExternalStore needs that).
  let sessions: CoachSession<P>[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(e: CoachSessionEvent<P>) => void>();

  const emit = () => listeners.forEach((l) => l());
  const fire = (e: CoachSessionEvent<P>) => eventListeners.forEach((l) => {
    try { l(e); } catch { /* a listener's bug is not the store's */ }
  });
  const find = (id: number) => sessions.find((s) => s.id === id);
  const patch = (id: number, p: Partial<CoachSession<P>>) => {
    sessions = sessions.map((s) => (s.id === id ? { ...s, ...p, touchedAt: now() } : s));
  };
  const drop = (id: number) => {
    sessions = sessions.filter((s) => s.id !== id);
  };

  // Too many kept sheets: drop the oldest idle ones. A busy one is never
  // dropped, since that would abort the work this store exists to keep.
  const trim = () => {
    const kept = sessions.filter((s) => !s.visible);
    let extra = kept.length - MAX_KEPT;
    if (extra <= 0) return;
    const idle = kept.filter((s) => !s.busy).sort((a, b) => a.touchedAt - b.touchedAt);
    for (const s of idle) {
      if (extra <= 0) break;
      drop(s.id);
      extra -= 1;
    }
  };

  // Hide one sheet. Busy (or unseen) ones stay, the rest go.
  const hideSession = (id: number) => {
    const s = find(id);
    if (!s || !s.visible) return;
    if (s.keepAlive && (s.busy || s.unseen)) {
      patch(id, { visible: false });
      if (s.busy) fire({ type: 'kept', session: find(id)! });
      trim();
    } else {
      drop(id);
    }
  };

  // The sheet showing now, closed so another can show. Its opener is told.
  const closeVisible = (exceptId?: number) => {
    const v = sessions.find((s) => s.visible && s.id !== exceptId);
    if (!v) return;
    const onClose = v.onClose;
    hideSession(v.id);
    onClose?.();
  };

  /** A kept sheet the same opener would have opened: same screen, same phase. */
  const resumable = (props: P): CoachSession<P> | undefined => {
    const want = props.initialScreen ?? 'menu';
    if (want === 'menu' || props.workoutContext) return undefined;
    return sessions
      .filter((s) => !s.visible && s.keepAlive && s.screen === want
        && (want !== 'plan' || (s.props.linkRoutinesToPhaseId ?? null) === (props.linkRoutinesToPhaseId ?? null)))
      .sort((a, b) => b.touchedAt - a.touchedAt)[0];
  };

  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    getSnapshot: () => sessions,
    onEvent(l: (e: CoachSessionEvent<P>) => void) {
      eventListeners.add(l);
      return () => { eventListeners.delete(l); };
    },
    get: find,

    /**
     * An opener shows a sheet. A kept sheet of the same kind is brought back
     * (with the opener's new props); otherwise a fresh one is made.
     */
    open(props: P, onClose: () => void): number {
      const back = resumable(props);
      closeVisible(back?.id);
      if (back) {
        patch(back.id, { props, onClose, visible: true, unseen: false });
        emit();
        return back.id;
      }
      const id = nextId++;
      sessions = [...sessions, {
        id,
        props,
        onClose,
        visible: true,
        screen: props.initialScreen ?? 'menu',
        busy: false,
        failed: false,
        result: false,
        unseen: false,
        keepAlive: !props.workoutContext,
        touchedAt: now(),
      }];
      emit();
      return id;
    },

    /** The opener re-rendered while its sheet shows. Ignored once another opener owns it. */
    update(id: number, props: P, onClose: () => void) {
      const s = find(id);
      if (!s || !s.visible || s.onClose !== onClose) return;
      // Nothing new: no emit, so the host does not redraw every sheet.
      if (sameProps(s.props, props)) return;
      sessions = sessions.map((x) => (x.id === id ? { ...x, props } : x));
      emit();
    },

    /** The opener hid its sheet (or went away). Only the current opener can. */
    release(id: number, onClose: () => void) {
      const s = find(id);
      if (!s || s.onClose !== onClose) return;
      hideSession(id);
      emit();
    },

    /** The sheet closed itself (close button, back, save). Its opener is told. */
    close(id: number) {
      const s = find(id);
      if (!s) return;
      const onClose = s.visible ? s.onClose : null;
      hideSession(id);
      emit();
      onClose?.();
    },

    /** Bring a kept sheet back (the ready banner, a notification tap). */
    show(id: number): boolean {
      const s = find(id);
      if (!s) return false;
      if (s.visible) return true;
      closeVisible(id);
      patch(id, { visible: true, unseen: false });
      emit();
      return true;
    },

    /**
     * A menu pick in sheet `fromId`. When a kept sheet already sits on that
     * screen, it takes over (and takes the opener with it) instead of a second
     * one starting: two chats would write the same conversation.
     */
    pickScreen(fromId: number, screen: CoachSheetScreen): boolean {
      const from = find(fromId);
      if (!from || screen === 'menu') return false;
      const kept = sessions
        .filter((s) => !s.visible && s.keepAlive && s.id !== fromId && s.screen === screen)
        .sort((a, b) => b.touchedAt - a.touchedAt)[0];
      if (!kept) return false;
      drop(fromId);
      patch(kept.id, { visible: true, unseen: false, onClose: from.onClose });
      emit();
      return true;
    },

    /** What a sheet is doing. Busy turning idle is "finished". */
    report(id: number, report: { screen: CoachSheetScreen; busy: boolean; failed: boolean; result?: boolean }) {
      const s = find(id);
      if (!s) return;
      const r = { ...report, result: report.result ?? false };
      if (s.screen === r.screen && s.busy === r.busy && s.failed === r.failed && s.result === r.result) return;
      const ended = s.busy && !r.busy;
      if (ended && !s.visible) {
        patch(id, { ...r, unseen: true });
      } else {
        patch(id, r);
      }
      // An error ends a run too. It waits as unseen like a result does, so
      // the user learns it failed instead of finding nothing there.
      if (ended) fire({ type: 'finished', session: find(id)!, failed: r.failed, hidden: !s.visible });
      emit();
    },

    /** Sign-out: every sheet goes. The one showing tells its opener, which would otherwise stay "open". */
    clear() {
      if (sessions.length === 0) return;
      const onClose = sessions.find((s) => s.visible)?.onClose ?? null;
      sessions = [];
      emit();
      onClose?.();
    },
  };
}

export type CoachSessionStore<P extends CoachSessionProps> = ReturnType<typeof createCoachSessionStore<P>>;
