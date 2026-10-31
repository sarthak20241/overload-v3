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
