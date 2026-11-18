/**
 * What the swap list ranks from: every exercise the person can pick (the
 * shared catalog and their own), with ids and swap tags, plus the names they
 * have logged before.
 *
 * Cache-first, then one read per app run: the list must open with no wait in
 * the gym, and it must work with no signal once it has loaded one time.
 * Guests have no session to read with, so they get an empty list and the
 * preview shows no swap button.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSupabaseClient, isSupabaseConfigured } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { hydrateCache, readCache, writeCache } from '@/lib/localCache';
import { getLocalPreviousPerformance } from '@/lib/previousPerformance';
import { EXERCISE_LIBRARY } from '@/lib/exercises';
import type { SwapExercise } from '@/lib/exerciseSwaps';

export type SwapCatalogRow = SwapExercise & { muscle_group: string; category: string };

const COLUMNS = 'id, name, muscle_group, category, metric_type, created_by, target_muscle, swap_pattern';

// One read per app run per account. The catalog changes rarely; a custom
// exercise made today shows up on the next app start (untagged rows still
// rank by their muscle group).
const readThisRun = new Set<string>();

/** Well-known names lead their tier (lib/exerciseSwaps commonNames). */
export const COMMON_EXERCISE_NAMES: ReadonlySet<string> = new Set(EXERCISE_LIBRARY.map((e) => e.name.toLowerCase()));

export function useSwapCatalog(enabled: boolean) {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const isGuest = useIsGuestSession();
  const userId = isGuest ? null : (user?.id ?? null);
  const [rows, setRows] = useState<SwapCatalogRow[]>(() => (userId ? readCache<SwapCatalogRow[]>('swapCatalog', userId) ?? [] : []));

  useEffect(() => {
    if (!enabled || !userId || !isSupabaseConfigured) return;
    let cancelled = false;
    // One page of the list. The API gateway sometimes answers a read with an
    // HTML error page instead of rows (seen while testing this hook); one
    // retry a moment later clears it.
    const readPage = async (from: number): Promise<SwapCatalogRow[]> => {
      for (let attempt = 0; ; attempt += 1) {
        const { data, error } = await supabase.from('exercises').select(COLUMNS).order('id').range(from, from + 999);
        if (!error) return (data ?? []) as SwapCatalogRow[];
        if (attempt >= 1 || cancelled) throw error;
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    (async () => {
      await hydrateCache(userId);
      const cached = readCache<SwapCatalogRow[]>('swapCatalog', userId);
      if (!cancelled && cached?.length) setRows(cached);
      if (readThisRun.has(userId) && cached?.length) return;
      try {
        // RLS returns the catalog and this account's own rows, nobody else's.
        const all: SwapCatalogRow[] = [];
        for (let from = 0; ; from += 1000) {
          const data = await readPage(from);
          all.push(...data);
          if (data.length < 1000) break;
        }
        if (cancelled || all.length === 0) return;
        readThisRun.add(userId);
        writeCache('swapCatalog', userId, all);
        setRows(all);
      } catch {
        // Offline: the cached list stands.
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, userId]);

  // Ids of rows whose name the person has logged before, from this device's
  // workouts (no network). Worked out only while the list is wanted.
  const doneIds = useMemo(() => {
    if (!enabled || !userId || rows.length === 0) return new Set<string>();
    const logged = getLocalPreviousPerformance(userId, rows.map((r) => r.name));
    const names = new Set(Object.keys(logged));
    return new Set(rows.filter((r) => names.has(r.name.trim().toLowerCase())).map((r) => r.id));
  }, [enabled, userId, rows]);

  return { exercises: rows, doneIds, available: !!userId && rows.length > 0 };
}
