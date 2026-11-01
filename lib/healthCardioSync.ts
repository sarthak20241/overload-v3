/**
 * Cardio import: hub workouts -> finished Overload workouts.
 *
 * Runs inside the foreground health sync (runHealthSyncAndReadiness), after
 * the daily metrics. The adapter reads the hub's workouts, lib/healthCardio
 * keeps the cardio sessions that are not already in the app, and each one is
 * saved by the import_health_cardio RPC (migration 20261101120000), which is
 * idempotent per hub id and skips anything overlapping a cardio workout the
 * server already has. Imported workouts earn no XP.
 *
 * Same cursor style as healthSync: a per-user local day, re-read with a
 * two-day overlap, left alone when the hub returns nothing (on iOS a read
 * denial looks exactly like "no workouts").
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getHealthAdapter } from './healthSync';
import { planCardioImports, queuedCardioWindows, type BusyWindow } from './healthCardio';
import { getPendingWorkouts } from './syncQueue';
import { getActiveWorkoutSnapshot } from './activeWorkoutPersistence';
import { track } from './analytics';

const CURSOR_KEY = (userId: string) => `health_cardio_cursor_v1::${userId}`;
const DEFAULT_BACKFILL_DAYS = 28;
const OVERLAP_DAYS = 2;
const DAY_MS = 86_400_000;

function localMidnightMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

async function getCursor(userId: string): Promise<number | null> {
  try {
    const v = await AsyncStorage.getItem(CURSOR_KEY(userId));
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function setCursor(userId: string, ms: number): Promise<void> {
  try {
    await AsyncStorage.setItem(CURSOR_KEY(userId), String(ms));
  } catch {
    // A lost cursor re-reads a wider window next time; the RPC is idempotent.
  }
}

/** The database has no import_health_cardio yet (app shipped before the migration). */
function missingRpc(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return !!e && (e.code === 'PGRST202' || e.code === '42883') && (e.message ?? '').includes('import_health_cardio');
}

/** A Postgres error (5-char SQLSTATE) is about this row; anything else is the network. */
function isDataError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/** In-app cardio the server cannot see yet: queued workouts and the live session. */
function localBusyWindows(userId: string, nowMs: number): BusyWindow[] {
  const busy = queuedCardioWindows(getPendingWorkouts(userId));
  const live = getActiveWorkoutSnapshot();
  if (live && live.ownerId === userId && Number.isFinite(live.startTimeEpochMs)) {
    busy.push({ startMs: live.startTimeEpochMs, endMs: nowMs });
  }
  return busy;
}

/**
 * Import the hub's recent cardio sessions. Returns how many landed, or null
 * when nothing ran (no hub, no workout access, or a database without the RPC).
 */
export async function syncHealthCardio(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ imported: number } | null> {
  if (!userId) return null;
  const adapter = getHealthAdapter();
  if (!adapter?.readWorkouts || !(await adapter.isAvailable())) return null;

  const now = new Date();
  const today = localMidnightMs(now);
  const cursor = await getCursor(userId);
  const sinceMs = cursor != null
    ? Math.min(cursor, today) - OVERLAP_DAYS * DAY_MS
    : today - DEFAULT_BACKFILL_DAYS * DAY_MS;

  const workouts = await adapter.readWorkouts(sinceMs);
  if (workouts.length === 0) return { imported: 0 };

  const plan = planCardioImports(workouts, localBusyWindows(userId, now.getTime()), now.getTime());
  let imported = 0;
  for (const p of plan) {
    const { data, error } = await supabase.rpc('import_health_cardio', {
      p_source: p.source,
      p_external_id: p.externalId,
      p_exercise: p.exercise,
      p_name: p.name,
      p_started_at: p.startedAtIso,
      p_duration_seconds: p.durationSeconds,
      p_distance_m: p.distanceM,
    });
    if (error) {
      if (missingRpc(error)) return null;
      // Offline mid-run: stop, keep the cursor, and the next sync retries.
      if (!isDataError(error)) {
        if (imported > 0) track('health_cardio_imported', { count: imported, hub: adapter.hub });
        return { imported };
      }
      // One bad row (a catalog name the database lacks) never blocks the rest.
      continue;
    }
    if (data) imported++;
  }

  await setCursor(userId, today);
  if (imported > 0) track('health_cardio_imported', { count: imported, hub: adapter.hub });
  return { imported };
}
