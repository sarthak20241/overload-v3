/**
 * Draws every coach sheet, and says when Drona finished out of sight.
 *
 * Mounted once at the app root (app/_layout.tsx), inside the providers the
 * sheet needs. Screens still render <AICoachModal>, which only hands its props
 * to the session store (lib/coachSessions); this host reads the store and
 * mounts one <CoachSheet> per session. Because the sheet lives here, leaving
 * the screen that opened it no longer unmounts it, so a build still running
 * when the user closes the sheet or walks away keeps going.
 *
 * It also owns lib/readyNotice's handler for the whole app:
 * - app open: a banner with View (a kept sheet comes back, or a route opens),
 * - app in the background: a phone notification, plus the banner on return
 *   in case they come back without tapping it.
 */
import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState, Keyboard } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useToast } from '@/components/ui/Toast';
import { CoachSheet, coachSessions, type CoachSheetProps } from '@/components/ai/AICoachModal';
import type { CoachSession } from '@/lib/coachSessions';
import { useClerkUser } from '@/hooks/useClerkUser';
import {
  announceReady, inboxIdFor, openReadyTarget, readyTargetFromData, setCoachSessionOpener, setReadyNoticeHandler,
  type ReadyNotice, type ReadyTarget,
} from '@/lib/readyNotice';
import { isStaleCoachItem, readyInbox } from '@/lib/readyInbox';
import { onPhaseDraftChange, readPhaseDraft } from '@/lib/phaseDraft';
import { addNotificationTapListener, dismissNotification, presentNotificationNow, requestNotificationPermission } from '@/lib/notifications';
import { holdBackgroundTime, NOTICE_GRACE_MS } from '@/lib/backgroundTime';
import { track } from '@/lib/analytics';

type Session = CoachSession<CoachSheetProps>;

// A sheet closed while idle leaves the store at once, but is drawn a moment
// longer with visible=false, so its slide-out still plays (the sheet's
// content unmounts inside a still-mounted Portal, as it always did).
const EXIT_MS = 260;
// How long a return to the app waits for a notification tap before showing
// the "it's ready" banner instead.
const TAP_WINDOW_MS = 600;
type Drawn = { session: Session; leaving: boolean };
let drawn: Drawn[] = [];
const drawnListeners = new Set<() => void>();
const emitDrawn = () => drawnListeners.forEach((l) => l());
let lastSessions: Session[] = [];
coachSessions.subscribe(() => {
  const now = coachSessions.getSnapshot();
  const gone = lastSessions.filter((p) => p.visible && !now.some((s) => s.id === p.id));
  lastSessions = now;
  const stillLeaving = drawn.filter((d) => d.leaving);
  drawn = [
    ...now.map((session) => ({ session, leaving: false })),
    ...stillLeaving,
    ...gone.map((g) => ({ session: { ...g, visible: false }, leaving: true })),
  ].sort((a, b) => a.session.id - b.session.id);
  gone.forEach((g) => setTimeout(() => {
    drawn = drawn.filter((d) => !(d.leaving && d.session.id === g.id));
    emitDrawn();
  }, EXIT_MS));
  emitDrawn();
});
const subscribeDrawn = (l: () => void) => {
  drawnListeners.add(l);
  return () => { drawnListeners.delete(l); };
};
const getDrawn = () => drawn;

/** What the notice says for a sheet that ended out of sight. */
export function coachReadyNotice(s: Session, failed: boolean): ReadyNotice {
  const target: ReadyTarget = {
    coachSession: s.id,
    // A phase build also keeps its plan as a draft, which Goal & Plan opens
    // even after the app restarts and the kept sheet is gone.
    route: s.props.linkRoutinesToPhaseId ? '/goal-plan' : undefined,
  };
  if (failed) {
    return { title: "I couldn't finish that.", body: 'Tap to see what happened.', failed: true, target };
  }
  if (s.result && s.screen === 'workout') {
    return { title: 'Your workout is ready.', body: 'Tap to look it over and save it.', target };
  }
  if (s.result && s.screen === 'plan') {
    return { title: 'Your split is ready.', body: 'Tap to look it over and save it.', target };
  }
  if (s.result && s.screen === 'program') {
    return { title: 'Your plan is ready.', body: 'Tap to look it over and apply it.', target };
  }
  return { title: 'I answered you.', body: 'Tap to read it.', target };
}

function targetData(t: ReadyTarget, inbox: string | null): Record<string, unknown> {
  const base = 'coachSession' in t
    ? { coachSession: t.coachSession, ...(t.route ? { route: t.route } : {}) }
    : { route: t.route };
  return inbox ? { ...base, inbox } : base;
}

function sameTarget(a: ReadyTarget, b: ReadyTarget): boolean {
  if ('coachSession' in a || 'coachSession' in b) {
    return 'coachSession' in a && 'coachSession' in b && a.coachSession === b.coachSession;
  }
  return a.route === b.route;
}

// A kept sheet comes back through lib/readyNotice's openReadyTarget.
setCoachSessionOpener((id) => coachSessions.show(id));

// A phase item goes once its draft does (saved, or dropped).
const dropPhaseItemIfNoDraft = (phaseId: string) => {
  void readPhaseDraft(phaseId).then((d) => { if (!d) readyInbox.remove(`phase:${phaseId}`); });
};

export function CoachSheetHost() {
  const items = useSyncExternalStore(subscribeDrawn, getDrawn);
  // useToast() is a fresh object whenever a toast shows or hides. Read
  // through a ref, so the listeners below are not torn down and re-added
  // each time (a notification tap could land in that gap).
  const toastNow = useToast();
  const toastRef = useRef(toastNow);
  toastRef.current = toastNow;
  const router = useRouter();
  const { user } = useClerkUser();

  // A new account sees none of the last one's sheets, and its own bell.
  // Only a real change clears: Clerk loading (nobody, then the user) is not
  // one, and a sheet opened in that window must stay.
  const userId = user?.id ?? null;
  const lastUserRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastUserRef.current !== null && lastUserRef.current !== userId) coachSessions.clear();
    lastUserRef.current = userId;
    void readyInbox.hydrate(userId).then(() => {
      readyInbox.getSnapshot()
        .filter((i) => i.id.startsWith('phase:'))
        .forEach((i) => dropPhaseItemIfNoDraft(i.id.slice('phase:'.length)));
    });
  }, [userId]);
  useEffect(() => onPhaseDraftChange(dropPhaseItemIfNoDraft), []);

  // A sheet's item goes once the sheet is opened (any way) or gone.
  useEffect(() => coachSessions.subscribe(() => {
    const sessions = coachSessions.getSnapshot();
    readyInbox.removeWhere((i) => isStaleCoachItem(i, sessions));
  }), []);

  const go = useCallback((t: ReadyTarget, inbox: string | null) => {
    if (inbox) readyInbox.remove(inbox);
    openReadyTarget(t, (route) => router.push(route as Href));
  }, [router]);

  const showBanner = useCallback((n: ReadyNotice) => {
    const show = n.failed ? toastRef.current.error : toastRef.current.success;
    show(n.title, { action: { label: 'View', onPress: () => go(n.target, inboxIdFor(n)) }, durationMs: 8000 });
  }, [go]);

  // Notices that landed while the app was in the background, newest last.
  // On return the newest shows as the banner (one toast slot; the rest wait
  // behind the bell), and every notification they posted is cleared.
  type Waiting = { notice: ReadyNotice; shown: Promise<string | null> };
  const waitingRef = useRef<Waiting[]>([]);
  // The user came back by tapping one: no banner over what it opened.
  const tappedRef = useRef(false);

  useEffect(() => {
    setReadyNoticeHandler((n) => {
      // Behind the bell until opened, whichever way it lands now.
      const inbox = inboxIdFor(n);
      if (inbox) readyInbox.add({ id: inbox, title: n.title, body: n.body, failed: n.failed, target: n.target });
      if (AppState.currentState === 'active') {
        if (!n.bannerless) showBanner(n);
        return;
      }
      const shown = presentNotificationNow(n.title, n.body, targetData(n.target, inbox));
      // One per thing: the same news twice keeps the newer words.
      waitingRef.current = [...waitingRef.current.filter((w) => !sameTarget(w.notice.target, n.target)), { notice: n, shown }];
      void shown.then((id) => {
        track('ready_notice_sent', { channel: id ? 'notification' : 'none', failed: !!n.failed });
      });
    });
    return () => setReadyNoticeHandler(null);
  }, [showBanner]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (waitingRef.current.length === 0) { tappedRef.current = false; return; }
      // A beat first: when the user came back by tapping a notification, its
      // tap can land just after 'active', and it opens the result itself. The
      // banner must not flash first.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const all = waitingRef.current;
        waitingRef.current = [];
        const tapped = tappedRef.current;
        tappedRef.current = false;
        // Tapped: the other notifications are still unread news; leave them.
        if (tapped) return;
        const latest = all[all.length - 1];
        // No banner for a sheet that is already on screen (left open when the
        // user switched apps): the result is right there.
        const t = latest.notice.target;
        if (!latest.notice.bannerless && !('coachSession' in t && coachSessions.get(t.coachSession)?.visible)) {
          showBanner(latest.notice);
        }
        // Back without tapping: the banner (and the bell) say it now, so the
        // notifications would only be stale copies in the list. (Often the
        // work ended in the moment of coming back.)
        all.forEach((w) => { void w.shown.then((id) => { if (id) void dismissNotification(id); }); });
      }, TAP_WINDOW_MS);
    });
    return () => { sub.remove(); if (timer) clearTimeout(timer); };
  }, [showBanner]);

  // While Drona works, ask iOS for time to finish if the user leaves the app
  // (lib/backgroundTime), kept a moment past the end for the ready notice.
  const anyBusy = useSyncExternalStore(coachSessions.subscribe, () => coachSessions.getSnapshot().some((s) => s.busy));
  useEffect(() => {
    if (!anyBusy) return;
    const release = holdBackgroundTime();
    return () => { setTimeout(release, NOTICE_GRACE_MS); };
  }, [anyBusy]);

  useEffect(() => addNotificationTapListener((data) => {
    const t = readyTargetFromData(data);
    if (!t) return;
    // The tapped news is handled; the "back in the app" banner stays away.
    waitingRef.current = waitingRef.current.filter((w) => !sameTarget(w.notice.target, t));
    // Only for the return this tap is part of: a tap with the app already
    // open (or one never followed by 'active') must not skip a later banner.
    tappedRef.current = true;
    setTimeout(() => { tappedRef.current = false; }, TAP_WINDOW_MS * 3);
    toastRef.current.hide();
    track('ready_notice_opened', { channel: 'notification' });
    go(t, typeof data.inbox === 'string' ? data.inbox : null);
  }), [go]);

  useEffect(() => coachSessions.onEvent((e) => {
    if (e.type === 'kept') {
      Keyboard.dismiss();
      toastRef.current.info("Still on it. I'll tell you when it's ready.", { durationMs: 3000 });
      track('coach_kept_working', { screen: e.session.screen });
      // The one moment a "may I notify you" ask explains itself.
      void requestNotificationPermission();
      return;
    }
    // Seen as it ended: nothing to announce, unless the app was away. Then
    // the notification goes, but nothing is filed behind the bell: the sheet
    // is open on the result for when they come back.
    if (!e.hidden && AppState.currentState === 'active') return;
    const notice = coachReadyNotice(e.session, e.failed);
    announceReady(e.hidden ? notice : { ...notice, inbox: false });
  }), []);

  return (
    <>
      {items.map(({ session, leaving }) => (
        <CoachSheet
          key={session.id}
          {...session.props}
          sessionId={session.id}
          visible={session.visible && !leaving}
          kept={!session.visible && !leaving}
          onClose={() => coachSessions.close(session.id)}
        />
      ))}
    </>
  );
}
