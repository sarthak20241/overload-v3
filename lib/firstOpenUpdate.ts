/**
 * First open from the store: get the newest update before the user sees
 * anything.
 *
 * A fresh install runs the JS built into the binary. expo-updates downloads
 * any newer update in the background and only runs it from the NEXT open, so
 * someone who signs up on their first open goes through whatever sign-up the
 * binary shipped with, however old. On 2026-11-02 a fresh Play install of
 * 1.0.3 signed up through the Oct 27 flow and never got phase 1 built.
 *
 * So while the app runs its built-in code, and only for its first few opens,
 * components/FirstOpenUpdateGate.tsx keeps the splash up, asks for an update,
 * and reloads into it. It waits at most FIRST_OPEN_CAP_MS. Past the cap it
 * opens the built-in code and never reloads under the user; whatever finished
 * downloading runs on the next open, as before. Offline, the check fails fast
 * and the app opens at once.
 *
 * Pure: no React Native imports, so the rules run under Deno
 * (lib/firstOpenUpdate.test.ts).
 */

/** Longest the splash waits for an update on a first open. */
export const FIRST_OPEN_CAP_MS = 5000;

/** Opens that may wait before we stop trying (offline or slow each time). */
export const FIRST_OPEN_MAX_TRIES = 3;

export type FirstOpenState = { done: boolean; tries: number };

export const FRESH_STATE: FirstOpenState = { done: false, tries: 0 };

export type FirstOpenOutcome =
  | 'reloading' // a newer update is downloaded and the app is reloading into it
  | 'up_to_date' // the server has nothing newer than the built-in code
  | 'timed_out' // no answer inside the cap: opened the built-in code
  | 'failed'; // the check, download or reload threw: opened the built-in code

export type UpdatesEnv = {
  /** Updates.isEnabled: false in Expo Go and dev clients without updates. */
  isEnabled: boolean;
  /** Updates.isEmbeddedLaunch: true while running the binary's own JS. */
  isEmbeddedLaunch: boolean;
  /** __DEV__: a Metro bundle, nothing to update. */
  isDev: boolean;
};

/** Wait for an update on this open? Only on the binary's own code, and only
 *  until one check has come back or the tries are used up. */
export function shouldCheckOnOpen(env: UpdatesEnv, state: FirstOpenState): boolean {
  if (env.isDev || !env.isEnabled || !env.isEmbeddedLaunch) return false;
  return !state.done && state.tries < FIRST_OPEN_MAX_TRIES;
}

/** What to store after this open. A real answer ends it for good; a timeout
 *  or failure spends a try, so the next open may wait again. */
export function nextState(state: FirstOpenState, outcome: FirstOpenOutcome): FirstOpenState {
  if (outcome === 'reloading' || outcome === 'up_to_date') return { done: true, tries: state.tries + 1 };
  return { done: false, tries: state.tries + 1 };
}

/** Stored state, read defensively: anything unreadable counts as fresh. */
export function parseState(raw: string | null): FirstOpenState {
  if (!raw) return FRESH_STATE;
  try {
    const v = JSON.parse(raw) as Partial<FirstOpenState>;
    return {
      done: v.done === true,
      tries: typeof v.tries === 'number' && Number.isFinite(v.tries) ? v.tries : 0,
    };
  } catch {
    return FRESH_STATE;
  }
}

export type FirstOpenSteps = {
  /** Updates.checkForUpdateAsync */
  check: () => Promise<{ isAvailable: boolean }>;
  /** Updates.fetchUpdateAsync */
  fetch: () => Promise<{ isNew: boolean }>;
  /** Saves the state before a reload, so the new code never waits again. */
  beforeReload: () => Promise<void>;
  /** Updates.reloadAsync */
  reload: () => Promise<void>;
  capMs?: number;
};

/**
 * Check, download, reload, all inside the cap. Resolves with the outcome as
 * soon as it is known, and by the cap at the latest. A download that lands
 * after the cap never reloads: the app is open by then.
 */
export function runFirstOpenUpdate(steps: FirstOpenSteps): Promise<FirstOpenOutcome> {
  const capMs = steps.capMs ?? FIRST_OPEN_CAP_MS;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: FirstOpenOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => settle('timed_out'), capMs);

    (async () => {
      const { isAvailable } = await steps.check();
      if (settled) return;
      if (!isAvailable) return settle('up_to_date');
      const { isNew } = await steps.fetch();
      if (settled) return;
      if (!isNew) return settle('up_to_date');
      await steps.beforeReload();
      if (settled) return;
      // Settle first: reloadAsync tears the JS down and may never resolve.
      settle('reloading');
      await steps.reload();
    })().catch(() => {
      // A reload that throws leaves us on the built-in code, already open or
      // about to be. Report it only if nothing has settled yet.
      settle('failed');
    });
  });
}
