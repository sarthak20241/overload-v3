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
 * A caller may pass `maxAgeMs`: a value stored less than that long ago
 * answers at once with no read, so screens that open one after another (the
 * dashboard cards, then Goal & Plan) share one read instead of paying one
 * each. Writes still clear it at once; the window only bounds how late a
 * change made somewhere else (another device, a server job) shows up.
 *
 * Keys (one user each):
 *   program:<clerkId>
 *   pillar:week:<clerkId>:<monday>     pillar:nights:<clerkId>:<today>
 *   pillar:vitals:<clerkId>:<today>    pillar:routines:<clerkId>:<routine ids>
 *   workouts:<clerkId>                 workouts:<clerkId>:older
 *   readiness:<clerkId>:<today>
 *
 * Memory only: it lives as long as the JS runtime, and a cold start reads
 * fresh. Pure (no imports), so `deno test lib/screenCache.test.ts` covers it.
 */

const values = new Map<string, unknown>();
/** When each value was stored, for maxAgeMs. */
const storedAt = new Map<string, number>();
let now = () => Date.now();
const inflight = new Map<string, { gen: number; p: Promise<unknown> }>();
/** Bumped by every invalidate, so a read can tell a write happened while it ran. */
let generation = 0;

/** The cached value, or undefined when there is none (null is a stored "nothing"). */
export function peek<T>(key: string): T | undefined {
  return values.has(key) ? (values.get(key) as T) : undefined;
}

/**
 * Read through the cache: answers from a value younger than `maxAgeMs` when
 * one is asked for, else joins a read of the same key already in flight
 * (unless a write came since it started), stores the answer, and leaves the
 * last good value in place when the read fails.
 */
export function fetchShared<T>(key: string, fn: () => Promise<T>, opts?: { maxAgeMs?: number }): Promise<T> {
  const maxAge = opts?.maxAgeMs;
  if (maxAge != null && values.has(key) && now() - (storedAt.get(key) ?? -Infinity) < maxAge) {
    return Promise.resolve(values.get(key) as T);
  }
  const running = inflight.get(key);
  if (running && running.gen === generation) return running.p as Promise<T>;
  const gen = generation;
  const p = fn().then(
    (v) => {
      if (gen === generation) { values.set(key, v); storedAt.set(key, now()); }
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
  for (const k of [...values.keys()]) {
    if (k === prefix || k.startsWith(`${prefix}:`)) { values.delete(k); storedAt.delete(k); }
  }
}

/**
 * Store a value a write just computed (it is fresh). A read already in
 * flight is not stored over it, as with invalidate.
 */
export function put<T>(key: string, value: T): void {
  generation += 1;
  values.set(key, value);
  storedAt.set(key, now());
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
  storedAt.clear();
}

/** Tests only: start from empty. */
export function resetForTest(): void {
  values.clear();
  storedAt.clear();
  inflight.clear();
  generation = 0;
  now = () => Date.now();
}

/** Tests only: a fake clock for maxAgeMs. */
export function setClockForTest(clock: () => number): void {
  now = clock;
}
