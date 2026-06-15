import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useSupabaseClient } from '@/lib/supabase';
import { flushQueue, getPendingCount, hydrateSyncQueue } from '@/lib/syncQueue';
import { flushRoutineQueue, getPendingRoutineCount, hydrateRoutineQueue } from '@/lib/routineQueue';
import { flushEditQueue, getPendingEditCount, hydrateEditQueue } from '@/lib/editQueue';
import { hydrateCache } from '@/lib/localCache';

/** Workouts + routines + workout edits still waiting to sync for this user. */
const totalPending = (userId: string) =>
  getPendingCount(userId) + getPendingRoutineCount(userId) + getPendingEditCount(userId);

interface SyncState {
  /** Workouts saved locally but not yet on the server. */
  pendingCount: number;
  flushing: boolean;
  /** Last flush error message while work is still pending, else null. */
  lastError: string | null;
  /** Attempt a flush now (also used as a manual retry). */
  flushNow: () => Promise<void>;
}

const SyncContext = createContext<SyncState>({
  pendingCount: 0,
  flushing: false,
  lastError: null,
  flushNow: async () => {},
});

const RETRY_INTERVAL_MS = 30000;

/**
 * Owns the background flush loop for the offline workout queue (lib/syncQueue).
 * Flushes on app foreground, once on mount, on a periodic retry timer while work
 * is pending, and on demand via flushNow(). Mounted in app/_layout.tsx so the
 * whole app (and the OfflineBanner) can read sync state.
 */
export function SyncProvider({ children }: { children: ReactNode }) {
  const { user } = useClerkUser();
  const supabase = useSupabaseClient();
  const userId = user?.id ?? null;
  const [pendingCount, setPendingCount] = useState(0);
  const [flushing, setFlushing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const flushingRef = useRef(false);
  // Hold the Supabase client in a ref so flushNow doesn't depend on its
  // identity. useSupabaseClient() can return a new client across renders; if
  // flushNow churned with it, the flush effect would re-run every render and
  // oscillate `flushing` state — an infinite render loop.
  const supabaseRef = useRef(supabase);
  supabaseRef.current = supabase;

  // Hydrate this user's queue when they sign in / change.
  useEffect(() => {
    if (!userId) {
      setPendingCount(0);
      return;
    }
    let cancelled = false;
    // Warm the read cache early so screens render last-known data instantly.
    void hydrateCache(userId);
    Promise.all([
      hydrateSyncQueue(userId),
      hydrateRoutineQueue(userId),
      hydrateEditQueue(userId),
    ]).then(() => {
      if (!cancelled) setPendingCount(totalPending(userId));
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const flushNow = useCallback(async () => {
    if (!userId) return;
    if (flushingRef.current) return; // single in-flight flush
    flushingRef.current = true;
    setFlushing(true);
    setPendingCount(totalPending(userId)); // reflect a just-enqueued item immediately
    try {
      await hydrateSyncQueue(userId); // no-op once hydrated
      await hydrateRoutineQueue(userId);
      await hydrateEditQueue(userId);
      // Routines first so a workout that links to a still-pending routine (by its
      // client-generated id) finds the routine row already inserted. Edits last:
      // they target already-synced workouts, independent of the other queues.
      const rResult = await flushRoutineQueue(supabaseRef.current, userId);
      const wResult = await flushQueue(supabaseRef.current, userId);
      const eResult = await flushEditQueue(supabaseRef.current, userId);
      const total = rResult.pendingCount + wResult.pendingCount + eResult.pendingCount;
      setPendingCount(total);
      setLastError(
        total > 0 ? (wResult.lastError ?? eResult.lastError ?? rResult.lastError) : null,
      );
    } finally {
      flushingRef.current = false;
      setFlushing(false);
    }
  }, [userId]);

  // Flush when the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void flushNow();
    });
    return () => sub.remove();
  }, [flushNow]);

  // Flush once when ready, then retry periodically while work is pending.
  useEffect(() => {
    void flushNow();
    const t = setInterval(() => {
      if (userId && totalPending(userId) > 0) void flushNow();
    }, RETRY_INTERVAL_MS);
    return () => clearInterval(t);
  }, [flushNow, userId]);

  const value = useMemo(
    () => ({ pendingCount, flushing, lastError, flushNow }),
    [pendingCount, flushing, lastError, flushNow],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncState {
  return useContext(SyncContext);
}
