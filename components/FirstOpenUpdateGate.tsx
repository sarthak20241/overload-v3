/**
 * On a fresh store install, runs the newest update before the user sees
 * anything (rules and why: lib/firstOpenUpdate.ts).
 *
 * Renders nothing while it checks, so the native splash stays up: the app
 * looks the way it always does while launching, just up to a few seconds
 * longer on a first open. It sits outside everything else, so a reload
 * happens before Clerk, sync or onboarding have started.
 *
 * It can never keep the app closed: the check settles by FIRST_OPEN_CAP_MS,
 * and a backstop opens the app shortly after that even if storage or a
 * reload hangs.
 */
import { useEffect, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import {
  FIRST_OPEN_CAP_MS,
  type FirstOpenState,
  nextState,
  parseState,
  runFirstOpenUpdate,
  shouldCheckOnOpen,
} from '@/lib/firstOpenUpdate';
import { track } from '@/lib/analytics';

const STATE_KEY = 'first_open_update_v1';
const BACKSTOP_MS = FIRST_OPEN_CAP_MS + 2000;

const env = {
  isEnabled: Updates.isEnabled,
  isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  isDev: __DEV__,
};

// Decided once at module load: a dev build or an update already running
// never renders the gate at all, not even for one frame.
const mayCheck = shouldCheckOnOpen(env, { done: false, tries: 0 });

async function saveState(state: FirstOpenState): Promise<void> {
  try {
    await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {}
}

export function FirstOpenUpdateGate({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(!mayCheck);

  useEffect(() => {
    if (open) return;
    let cancelled = false;
    const backstop = setTimeout(() => setOpen(true), BACKSTOP_MS);
    (async () => {
      let state: FirstOpenState;
      try {
        state = parseState(await AsyncStorage.getItem(STATE_KEY));
      } catch {
        state = parseState(null);
      }
      if (!shouldCheckOnOpen(env, state)) {
        if (!cancelled) setOpen(true);
        return;
      }
      const t0 = Date.now();
      const outcome = await runFirstOpenUpdate({
        check: () => Updates.checkForUpdateAsync(),
        fetch: () => Updates.fetchUpdateAsync(),
        beforeReload: () => saveState(nextState(state, 'reloading')),
        reload: () => Updates.reloadAsync(),
      });
      track('first_open_update', { outcome, ms: Date.now() - t0, try: state.tries + 1 });
      // Reloading: stay closed, the new code takes over in a moment. If the
      // reload fails instead, the backstop opens the built-in code.
      if (outcome === 'reloading') return;
      await saveState(nextState(state, outcome));
      if (!cancelled) setOpen(true);
    })().catch(() => {
      if (!cancelled) setOpen(true);
    });
    return () => {
      cancelled = true;
      clearTimeout(backstop);
    };
  }, [open]);

  return open ? <>{children}</> : null;
}
