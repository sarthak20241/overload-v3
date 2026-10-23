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
import { invalidate } from '@/lib/screenCache';
import { nextSyncCounts, type SyncCounts } from '@/lib/syncTick';

/** Workouts + routines + workout edits still waiting to sync for this user. */
const totalPending = (userId: string) =>
  getPendingCount(userId) + getPendingRoutineCount(userId) + getPendingEditCount(userId);

interface SyncState {
  /** Workouts saved locally but not yet on the server. */
  pendingCount: number;
  /**
   * Bumped each time a flush lands something on the server (or the count
   * drops), so screens re-read it. A rise is a local save; screens show it
   * by merging the queue onto what they already hold, with no read.
   */
  syncedTick: number;
  flushing: boolean;
  /** Last flush error message while work is still pending, else null. */
  lastError: string | null;
  /** Attempt a flush now (also used as a manual retry). */
  flushNow: () => Promise<void>;
}

const SyncContext = createContext<SyncState>({
  pendingCount: 0,
  syncedTick: 0,
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
  // The count and syncedTick move in ONE state update, so a drop re-renders
  // the screens once with both, never with the count first and the tick after.
  const [{ pendingCount, syncedTick }, setCounts] = useState({ pendingCount: 0, syncedTick: 0 });
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const countsRef = useRef<SyncCounts>({ pendingCount: 0, syncedTick: 0 });
  // `landed`: items the flush just put on the server. Counted, not read off
  // the count: a save made during the flush can keep the count level.
  const setPendingCount = useCallback((n: number, landed = 0) => {
    const { counts, synced } = nextSyncCounts(countsRef.current, n, landed);
    if (counts === countsRef.current) return;
    countsRef.current = counts;
    // The server changed: the shared reads it touches are stale (the
    // workouts, and readiness, whose training load reads them).
    const uid = userIdRef.current;
    if (synced && uid) {
      invalidate(`workouts:${uid}`);
      invalidate(`readiness:${uid}`);
    }
    setCounts(counts);
  }, []);
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
    // A new identity starts from an empty queue, so the old account's count
    // never reads as this one's rise or drop.
    if (countsRef.current.pendingCount !== 0) {
      countsRef.current = { ...countsRef.current, pendingCount: 0 };
      setCounts(countsRef.current);
    }
    if (!userId) return;
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
  }, [userId, setPendingCount]);

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
      setPendingCount(total, rResult.flushed + wResult.flushed + eResult.flushed);
      setLastError(
        total > 0 ? (wResult.lastError ?? eResult.lastError ?? rResult.lastError) : null,
      );
    } finally {
      flushingRef.current = false;
      setFlushing(false);
    }
  }, [userId, setPendingCount]);

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
    () => ({ pendingCount, syncedTick, flushing, lastError, flushNow }),
    [pendingCount, syncedTick, flushing, lastError, flushNow],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncState {
  return useContext(SyncContext);
}
