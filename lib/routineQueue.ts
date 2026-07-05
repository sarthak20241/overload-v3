/**
 * Offline write queue for routine create/edit, mirroring lib/syncQueue.ts.
 *
 * Saving a routine (new or edited) used to go straight to Supabase and was lost
 * offline — worse, an edit deleted the old routine_exercises before re-inserting,
 * so a mid-flight failure could wipe a routine's exercises. This makes routine
 * writes local-first: the save optimistically updates the 'routines' cache and
 * enqueues here; SyncProvider flushes idempotently in the background.
 *
 * Idempotency without a new column: a newly-created routine gets a
 * CLIENT-GENERATED uuid as its `id`, used both as the queue key and as the
 * routine's primary key on insert (upsert on conflict id). An edit reuses the
 * existing server id. So retries converge with no `client_id` column needed, and
 * a workout's routine_id can link to a still-pending routine by that same id.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveExerciseRow } from '@/lib/exerciseResolve';
import { readCache, writeCache } from '@/lib/localCache';

const KEY = (userId: string) => `pending_routines_v1::${userId}`;
const SCHEMA = 1 as const;

export interface PendingRoutineExercise {
  def: { name: string; muscle_group: string; category: string };
  resolvedExerciseId: string | null;
  order: number;
  sets: number;
  reps_min: number;
  reps_max: number;
  rest_seconds: number;
  note: string | null;
  /** Superset grouping ordinal (migration 0060); null = solo. */
  superset_group: number | null;
}

export interface PendingRoutine {
  schema: typeof SCHEMA;
  /** The routine's primary key: a client uuid for a create, the server id for an edit. */
  routineId: string;
  ownerId: string;
  name: string;
  description: string | null;
  color: string | null;
  createdAtIso: string;
  exercises: PendingRoutineExercise[];
  phase: 'queued' | 'routine_upserted' | 'done';
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
}

// --- per-user store ---
const _byUser: Record<string, PendingRoutine[]> = {};
const _hydrated: Record<string, boolean> = {};

async function persist(userId: string) {
  try {
    await AsyncStorage.setItem(KEY(userId), JSON.stringify(_byUser[userId] ?? []));
  } catch {
    /* swallow */
  }
}

export async function hydrateRoutineQueue(userId: string): Promise<void> {
  if (!userId || _hydrated[userId]) return;
  try {
    const raw = await AsyncStorage.getItem(KEY(userId));
    const parsed = raw ? (JSON.parse(raw) as PendingRoutine[]) : [];
    const existing = _byUser[userId] ?? [];
    const ids = new Set(existing.map((e) => e.routineId));
    _byUser[userId] = [
      ...existing,
      ...parsed.filter((p) => p?.schema === SCHEMA && !ids.has(p.routineId)),
    ];
    if (existing.length > 0) void persist(userId);
  } catch {
    _byUser[userId] = _byUser[userId] ?? [];
  } finally {
    _hydrated[userId] = true;
  }
}

export function getPendingRoutines(userId: string): PendingRoutine[] {
  return _byUser[userId] ?? [];
}

export function getPendingRoutineCount(userId: string): number {
  return (_byUser[userId] ?? []).length;
}

/** Enqueue (or replace, by routineId) a pending routine write. */
export async function enqueueRoutine(userId: string, entry: PendingRoutine): Promise<void> {
  const list = (_byUser[userId] ??= []);
  const idx = list.findIndex((e) => e.routineId === entry.routineId);
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);
  await persist(userId);
}

function patchRoutine(userId: string, routineId: string, patch: Partial<PendingRoutine>) {
  const e = _byUser[userId]?.find((x) => x.routineId === routineId);
  if (!e) return;
  Object.assign(e, patch);
  void persist(userId);
}

export function removePendingRoutine(userId: string, routineId: string): void {
  const list = _byUser[userId];
  if (!list) return;
  _byUser[userId] = list.filter((x) => x.routineId !== routineId);
  void persist(userId);
}

export async function clearUserRoutineQueue(userId: string): Promise<void> {
  delete _byUser[userId];
  _hydrated[userId] = false;
  try {
    await AsyncStorage.removeItem(KEY(userId));
  } catch {
    /* swallow */
  }
}

// --- read-side helpers (optimistic display) ---

/** Shape a pending routine into a 'routines' cache row (matches the server select). */
export function pendingRoutineToCacheRow(p: PendingRoutine): any {
  return {
    id: p.routineId,
    user_id: p.ownerId,
    name: p.name,
    description: p.description,
    color: p.color ?? undefined,
    created_at: p.createdAtIso,
    _pendingSync: true,
    routine_exercises: p.exercises.map((ex, i) => {
      // Unresolved exercises get a temp- id so that starting this routine and
      // finishing a workout treats them as "resolve by name" at the workout's
      // own flush (the workout screen keys on a 'temp-' prefix).
      const exId = ex.resolvedExerciseId ?? `temp-routine-${p.routineId}-${i}`;
      return {
        id: `${p.routineId}-re-${i}`,
        routine_id: p.routineId,
        exercise_id: exId,
        order: ex.order,
        sets: ex.sets,
        reps_min: ex.reps_min,
        reps_max: ex.reps_max,
        rest_seconds: ex.rest_seconds,
        note: ex.note,
        superset_group: ex.superset_group,
        exercises: {
          id: exId,
          name: ex.def.name,
          muscle_group: ex.def.muscle_group,
          category: ex.def.category,
        },
      };
    }),
  };
}

/**
 * Merge pending routine writes into a fresh server routine list: a pending edit
 * overrides the server row (same id), a pending create is prepended. So a
 * wholesale revalidate doesn't clobber a not-yet-synced routine.
 */
export function mergePendingRoutines(serverRoutines: any[], userId: string | null | undefined): any[] {
  if (!userId) return serverRoutines;
  const pending = getPendingRoutines(userId);
  if (pending.length === 0) return serverRoutines;
  const byId = new Map(pending.map((p) => [p.routineId, p]));
  const serverIds = new Set(serverRoutines.map((r) => r.id));
  const merged = serverRoutines.map((r) =>
    byId.has(r.id) ? pendingRoutineToCacheRow(byId.get(r.id)!) : r,
  );
  const creates = pending
    .filter((p) => !serverIds.has(p.routineId))
    .map(pendingRoutineToCacheRow);
  return [...creates, ...merged];
}

/**
 * Optimistically apply a pending routine to the 'routines' cache so it renders
 * immediately and survives a restart, before it syncs.
 */
export function applyRoutineToCache(userId: string, entry: PendingRoutine): void {
  const existing = readCache<any[]>('routines', userId) ?? [];
  const without = existing.filter((r) => r.id !== entry.routineId);
  writeCache('routines', userId, [pendingRoutineToCacheRow(entry), ...without]);
}

// --- flush engine ---

function isDataError(err: any): boolean {
  const code = err?.code;
  return typeof code === 'string' && /^[0-9A-Za-z]{5}$/.test(code);
}

function backoffMs(attempts: number): number {
  return Math.min(60000, 2 ** Math.max(0, attempts) * 2000) + Math.floor(Math.random() * 1000);
}

async function flushPendingRoutine(
  supabase: SupabaseClient,
  userId: string,
  entry: PendingRoutine,
): Promise<void> {
  let phase = entry.phase;

  if (phase === 'queued') {
    // Upsert the routine row by id (insert for a create, update for an edit).
    const { error } = await supabase.from('routines').upsert(
      {
        id: entry.routineId,
        user_id: userId,
        name: entry.name,
        description: entry.description,
        ...(entry.color ? { color: entry.color } : {}),
      },
      { onConflict: 'id' },
    );
    if (error) throw error;
    phase = 'routine_upserted';
    patchRoutine(userId, entry.routineId, { phase });
  }

  // Resolve exercises to real ids (find-or-insert by name).
  let changed = false;
  for (const ex of entry.exercises) {
    if (!ex.resolvedExerciseId || ex.resolvedExerciseId.startsWith('temp-')) {
      const resolved = await resolveExerciseRow(supabase, ex.def);
      if (resolved) {
        ex.resolvedExerciseId = resolved.id;
        changed = true;
      }
    }
  }
  if (changed) patchRoutine(userId, entry.routineId, { exercises: entry.exercises });
  if (entry.exercises.some((ex) => !ex.resolvedExerciseId)) {
    // Couldn't link an exercise yet — park (retries; resolves once online).
    throw Object.assign(new Error('Some exercises could not be linked yet'), { code: 'EXRES' });
  }

  if (phase === 'routine_upserted') {
    // Replace routine_exercises wholesale. delete+insert is idempotent on retry
    // (a re-run deletes any partial inserts and re-inserts the full set), and
    // the LOCAL cache always holds the full desired state, so the server
    // converges even if a previous attempt half-applied.
    const { error: delErr } = await supabase
      .from('routine_exercises')
      .delete()
      .eq('routine_id', entry.routineId);
    if (delErr) throw delErr;
    if (entry.exercises.length > 0) {
      const rows = entry.exercises.map((ex) => ({
        routine_id: entry.routineId,
        exercise_id: ex.resolvedExerciseId,
        order: ex.order,
        sets: ex.sets,
        reps_min: ex.reps_min,
        reps_max: ex.reps_max,
        rest_seconds: ex.rest_seconds,
        note: ex.note,
        superset_group: ex.superset_group,
      }));
      const { error: insErr } = await supabase.from('routine_exercises').insert(rows);
      if (insErr) throw insErr;
    }
    phase = 'done';
    patchRoutine(userId, entry.routineId, { phase });
  }

  removePendingRoutine(userId, entry.routineId);
}

export interface RoutineFlushResult {
  pendingCount: number;
  lastError: string | null;
}

export async function flushRoutineQueue(
  supabase: SupabaseClient,
  userId: string,
): Promise<RoutineFlushResult> {
  const queue = [...getPendingRoutines(userId)].sort((a, b) => a.createdAt - b.createdAt);
  let lastError: string | null = null;
  for (const entry of queue) {
    if (entry.nextAttemptAt > Date.now()) continue;
    try {
      await flushPendingRoutine(supabase, userId, entry);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      patchRoutine(userId, entry.routineId, {
        attempts: entry.attempts + 1,
        lastError: msg,
        nextAttemptAt: Date.now() + backoffMs(entry.attempts + 1),
      });
      lastError = msg;
      if (!isDataError(err)) break; // transport failure: stop, retry later
    }
  }
  return { pendingCount: getPendingRoutineCount(userId), lastError };
}
