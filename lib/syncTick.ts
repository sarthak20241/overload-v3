/**
 * How components/SyncProvider moves syncedTick: screens re-read the server
 * only when it moves, and merge a local save onto what they show otherwise.
 * Pure, so `deno test lib/syncTick.test.ts` covers it.
 */

export interface SyncCounts {
  /** Items (workouts, routines, workout edits) still waiting to sync. */
  pendingCount: number;
  /** Bumped each time the server changed under the screens. */
  syncedTick: number;
}

/**
 * The counts after a new pending count `n`, `landed` items having just
 * reached the server. The tick moves when anything landed, even if a save
 * made during the flush kept the count level, and on any drop. `synced` says
 * whether it moved (the caller then clears the shared reads it changes).
 */
export function nextSyncCounts(prev: SyncCounts, n: number, landed: number): { counts: SyncCounts; synced: boolean } {
  const synced = landed > 0 || n < prev.pendingCount;
  if (synced) return { counts: { pendingCount: n, syncedTick: prev.syncedTick + 1 }, synced };
  if (n === prev.pendingCount) return { counts: prev, synced };
  return { counts: { ...prev, pendingCount: n }, synced };
}
