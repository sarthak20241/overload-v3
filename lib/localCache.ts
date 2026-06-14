/**
 * Stale-while-revalidate read cache for signed-in screens.
 *
 * Each main screen reads its last-known data from here synchronously (after a
 * one-time hydrate) so it renders instantly and keeps working with no signal,
 * then revalidates against Supabase in the background. On a network failure the
 * screen keeps the cached data instead of blanking or hanging.
 *
 * Server-authoritative: a successful revalidate overwrites the cached entity
 * wholesale (unlike the guest store, reads have no local writes to preserve).
 * Keyed per Clerk user so accounts never see each other's data on one device.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type CacheEntity =
  | 'routines'
  | 'exercises'
  | 'dashboardWorkouts'
  | 'historyWorkouts'
  | 'analyticsWorkouts'
  | 'profileXp'
  | 'profile'
  | 'prevPerf';

const ENTITIES: CacheEntity[] = [
  'routines',
  'exercises',
  'dashboardWorkouts',
  'historyWorkouts',
  'analyticsWorkouts',
  'profileXp',
  'profile',
  'prevPerf',
];
const KEY = (entity: CacheEntity, userId: string) => `cache_${entity}_v1::${userId}`;

const _mem: Record<string, unknown> = {};
const _hydrated: Record<string, boolean> = {};

/** Last-known cached value for an entity, or null if nothing is cached yet. */
export function readCache<T>(entity: CacheEntity, userId: string | null | undefined): T | null {
  if (!userId) return null;
  const k = KEY(entity, userId);
  return k in _mem ? (_mem[k] as T) : null;
}

/** Overwrite the cached value for an entity (fire-and-forget persist). */
export function writeCache<T>(entity: CacheEntity, userId: string | null | undefined, data: T): void {
  if (!userId) return;
  const k = KEY(entity, userId);
  _mem[k] = data;
  AsyncStorage.setItem(k, JSON.stringify(data)).catch(() => {});
}

/**
 * Load all of a user's cached entities from disk into memory. Call (and await)
 * before the first synchronous readCache so an offline cold start has data.
 * Idempotent; only the first call per user hits disk.
 */
export async function hydrateCache(userId: string | null | undefined): Promise<void> {
  if (!userId || _hydrated[userId]) return;
  await Promise.all(
    ENTITIES.map(async (entity) => {
      const k = KEY(entity, userId);
      try {
        const raw = await AsyncStorage.getItem(k);
        // Don't clobber a value written in memory before hydration finished.
        if (raw != null && !(k in _mem)) _mem[k] = JSON.parse(raw);
      } catch {
        // corrupt / missing → leave unset
      }
    }),
  );
  _hydrated[userId] = true;
}

/** Drop a user's cache from memory + disk (e.g. on sign-out / account switch). */
export async function clearUserCache(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  _hydrated[userId] = false;
  await Promise.all(
    ENTITIES.map(async (entity) => {
      const k = KEY(entity, userId);
      delete _mem[k];
      try {
        await AsyncStorage.removeItem(k);
      } catch {
        // ignore
      }
    }),
  );
}
