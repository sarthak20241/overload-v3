/**
 * The counting behind lib/backgroundTime, with no native imports so Deno can
 * test it (backgroundHolds.test.ts).
 *
 * - Every hold asks the native side to begin. It keeps one task and ignores a
 *   begin while one runs, so after iOS has expired a task (its time ran out)
 *   the next hold starts a fresh one instead of trusting a stale count.
 * - The task ends when the last hold is released.
 * - A hold that is never released (work that hangs) lets go by itself after
 *   MAX_HOLD_MS. iOS grants about 30 s, so nothing real runs that long, and a
 *   stuck count can never cost the rest of the session its background time.
 * - When iOS expires the task itself (its ~30 s ran out), the native side
 *   ends it but JS is not told, so the count can stay above 0 for a while.
 *   Harmless: a later hold calls begin() again (iOS may refuse a second grant
 *   in the same background stint, which only means no extra time), and the
 *   MAX_HOLD_MS cap brings the count back to 0.
 */
export const MAX_HOLD_MS = 60_000;

export type NativeTask = { begin(): void; end(): void };
type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export function createHolds(native: NativeTask | null, timers: Timers) {
  let holds = 0;
  return {
    count: () => holds,
    hold(): () => void {
      if (!native) return () => {};
      holds += 1;
      try { native.begin(); } catch { /* no time is the old behaviour */ }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        timers.clear(cap);
        holds -= 1;
        if (holds === 0) {
          try { native.end(); } catch { /* nothing held */ }
        }
      };
      const cap = timers.set(release, MAX_HOLD_MS);
      return release;
    },
  };
}

/**
 * Work that should keep going if the user leaves the app.
 *
 * A hold taken when work starts can lapse (MAX_HOLD_MS) before the user ever
 * leaves, and work that started 2 minutes ago would then get no time at all.
 * So the moment the app goes to the background with work still running, a
 * fresh hold is taken; coming back to the app, or the last work ending,
 * lets it go.
 */
export function createWorkTracker(holds: { hold(): () => void }) {
  let working = 0;
  let away: (() => void) | null = null;
  const dropAway = () => { away?.(); away = null; };
  return {
    working: () => working,
    start(): () => void {
      working += 1;
      const release = holds.hold();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        release();
        working -= 1;
        if (working === 0) dropAway();
      };
    },
    appState(state: string) {
      // iOS says 'inactive' first on the way out, and the native begin hops
      // to the main queue, so the hold is taken there: by 'background' there
      // is little time left. A peek at the notification shade is 'inactive'
      // too; coming back to 'active' lets it go.
      if ((state === 'inactive' || state === 'background') && working > 0) {
        if (!away) away = holds.hold();
      } else if (state === 'active') {
        dropAway();
      }
    },
  };
}
