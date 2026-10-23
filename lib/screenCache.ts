/**
 * A small in-memory cache for the Goal & Plan screens (stale-while-revalidate).
 *
 * Each screen paints at once from `peek(key)` when a value is there, and
 * refreshes in the background through `fetchShared(key, fn)`. Two screens
 * asking for the same key at the same time share one read. A write calls
 * `invalidate(prefix)`: the cached value goes, and a read that was already
 * in flight when the write happened still answers its caller but is not
 * stored, so a pre-write answer never overwrites a post-write one.
 *
 * Keys (one user each):
 *   program:<clerkId>
 *   pillar:week:<clerkId>:<monday>     pillar:nights:<clerkId>:<today>
 *   pillar:vitals:<clerkId>:<today>    pillar:routines:<clerkId>:<routine ids>
 *
 * Memory only: it lives as long as the JS runtime, and a cold start reads
 * fresh. Pure (no imports), so `deno test lib/screenCache.test.ts` covers it.
 */

const values = new Map<string, unknown>();
const inflight = new Map<string, { gen: number; p: Promise<unknown> }>();
/** Bumped by every invalidate, so a read can tell a write happened while it ran. */
let generation = 0;

/** The cached value, or undefined when there is none (null is a stored "nothing"). */
export function peek<T>(key: string): T | undefined {
  return values.has(key) ? (values.get(key) as T) : undefined;
}

/**
 * Read through the cache: joins a read of the same key already in flight
 * (unless a write came since it started), stores the answer, and leaves the
 * last good value in place when the read fails.
 */
export function fetchShared<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running && running.gen === generation) return running.p as Promise<T>;
  const gen = generation;
  const p = fn().then(
    (v) => {
      if (gen === generation) values.set(key, v);
      return v;
    },
  ).finally(() => {
    if (inflight.get(key)?.p === p) inflight.delete(key);
  });
  inflight.set(key, { gen, p });
  return p;
}

/**
 * Drop the cached value at `prefix` and every key below it, by whole
 * segments: 'program:user_1' clears 'program:user_1' and
 * 'program:user_1:…', never 'program:user_10'. Reads in flight are not stored.
 */
export function invalidate(prefix: string): void {
  generation += 1;
  for (const k of [...values.keys()]) if (k === prefix || k.startsWith(`${prefix}:`)) values.delete(k);
}

/** A user's program changed (or the routines of one of its phases): drop the program and its routine summaries. */
export function invalidateUserProgram(clerkId: string): void {
  invalidate(`program:${clerkId}`);
  invalidate(`pillar:routines:${clerkId}`);
}

/** Sign-out: forget every user's values; reads in flight are not stored. */
export function clearCache(): void {
  generation += 1;
  values.clear();
}

/** Tests only: start from empty. */
export function resetForTest(): void {
  values.clear();
  inflight.clear();
  generation = 0;
}
