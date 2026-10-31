/**
 * "Drona finished" notices for work the user stopped watching.
 *
 * Any flow that keeps running after the user leaves (a kept coach sheet, a
 * background phase build, a meal parse on a tab they left) calls
 * announceReady(). One handler, set by CoachSheetHost at the app root,
 * decides how it lands:
 * - app open: a banner with a View button,
 * - app in the background: a phone notification. Its tap opens the same place.
 *
 * Either way it also waits behind the dashboard bell (lib/readyInbox) until
 * it is opened, under `inbox` (its id there; false keeps it out).
 *
 * Plain module, no React, so lib code (lib/phaseBuild.ts) can announce too.
 */

export type ReadyTarget =
  /** A kept coach sheet. `route` is where to go when it is gone (app restarted). */
  | { coachSession: number; route?: string }
  | { route: string };

export interface ReadyNotice {
  /** The banner line, and the notification's title. */
  title: string;
  /** The notification's body. */
  body: string;
  failed?: boolean;
  target: ReadyTarget;
  /** Its id behind the bell. Default: `coach:<session>` for a sheet. False: not filed. */
  inbox?: string | false;
}

/** Where a notice waits behind the bell, or null when it does not. */
export function inboxIdFor(n: ReadyNotice): string | null {
  if (n.inbox === false) return null;
  if (n.inbox) return n.inbox;
  return 'coachSession' in n.target ? `coach:${n.target.coachSession}` : null;
}

type Handler = (n: ReadyNotice) => void;
let handler: Handler | null = null;
// Notices from before the host mounted (a build that ended during start-up).
let early: ReadyNotice[] = [];

export function setReadyNoticeHandler(h: Handler | null): void {
  handler = h;
  if (h && early.length) {
    const queued = early;
    early = [];
    queued.forEach((n) => h(n));
  }
}

export function announceReady(n: ReadyNotice): void {
  if (handler) handler(n);
  else early = [...early.slice(-2), n];
}

/** A notification's data, back to a target. Null when it is not ours. */
export function readyTargetFromData(data: Record<string, unknown>): ReadyTarget | null {
  const route = typeof data.route === 'string' && data.route.startsWith('/') ? data.route : undefined;
  if (typeof data.coachSession === 'number') return { coachSession: data.coachSession, route };
  if (route) return { route };
  return null;
}
