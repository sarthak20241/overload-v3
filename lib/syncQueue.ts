/**
 * Offline write queue for finished workouts.
 *
 * Signed-in users used to save a workout with three sequential Supabase writes
 * at the moment they tapped Finish — which hangs or loses the session on bad
 * gym wifi. Instead, the finish now enqueues the workout here (local,
 * AsyncStorage, same pattern as lib/guestStore.ts) and the SyncProvider flushes
 * it to Supabase in the background, immediately when online or when
 * connectivity returns.
 *
 * Guests never use this queue — they already persist completed workouts
 * directly to the guest store and have no server to sync to.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getXpForWorkout } from '@/lib/xp';
import { resolveExerciseRow } from '@/lib/exerciseResolve';

const KEY = (userId: string) => `pending_workouts_v1::${userId}`;
const SCHEMA = 1 as const;

export interface PendingSet {
  weight_kg: number;
  reps: number;
  order: number;
}

export interface PendingExercise {
  /** Library def, kept so a temp (unresolved) exercise can resolve at flush. */
  def: { name: string; muscle_group: string; category: string };
  /** Real exercises.id if known at finish; null when it was still a `temp-` id. */
  resolvedExerciseId: string | null;
  /** Completed sets only. */
  sets: PendingSet[];
}

export type PendingPhase = 'queued' | 'workout_inserted' | 'sets_inserted' | 'done';

export interface PendingWorkout {
  schema: typeof SCHEMA;
  /** uuid — the idempotency key, also written to workouts.client_id. */
  clientId: string;
  ownerId: string;
  name: string;
  notes: string | null;
  startedAtIso: string;
  durationSeconds: number;
  totalVolumeKg: number;
  linkedRoutineId: string | null;
  exercises: PendingExercise[];
  // --- flush progress / idempotency ---
  phase: PendingPhase;
  serverWorkoutId: string | null;
  attempts: number;
  /** epoch ms; entries are skipped until now() passes this (backoff). */
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
}

/** RFC4122-ish v4 uuid (Math.random is fine here — we only need uniqueness). */
export function newClientId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// --- per-user store (AsyncStorage-backed, in-memory cache) ---
const _byUser: Record<string, PendingWorkout[]> = {};
const _hydrated: Record<string, boolean> = {};

async function persist(userId: string) {
  try {
    await AsyncStorage.setItem(KEY(userId), JSON.stringify(_byUser[userId] ?? []));
  } catch {
    // Persistence failures shouldn't break the in-memory flow.
  }
}

/** Load a user's queue from disk. Idempotent; call when the user is known. */
export async function hydrateSyncQueue(userId: string): Promise<void> {
  if (!userId || _hydrated[userId]) return;
  try {
    const raw = await AsyncStorage.getItem(KEY(userId));
    const parsed = raw ? (JSON.parse(raw) as PendingWorkout[]) : [];
    // Anything written in memory before hydration finished is newest; keep it
    // and append disk entries not already present (by clientId).
    const existing = _byUser[userId] ?? [];
    const ids = new Set(existing.map((e) => e.clientId));
    _byUser[userId] = [
      ...existing,
      ...parsed.filter((p) => p?.schema === SCHEMA && !ids.has(p.clientId)),
    ];
    if (existing.length > 0) void persist(userId);
  } catch {
    _byUser[userId] = _byUser[userId] ?? [];
  } finally {
    _hydrated[userId] = true;
  }
}

export function getPendingWorkouts(userId: string): PendingWorkout[] {
  return _byUser[userId] ?? [];
}

export function getPendingCount(userId: string): number {
  return (_byUser[userId] ?? []).length;
}

export async function enqueueWorkout(userId: string, entry: PendingWorkout): Promise<void> {
  (_byUser[userId] ??= []).push(entry);
  await persist(userId);
}

function patchEntry(userId: string, clientId: string, patch: Partial<PendingWorkout>) {
  const e = _byUser[userId]?.find((x) => x.clientId === clientId);
  if (!e) return;
  Object.assign(e, patch);
  void persist(userId);
}

/**
 * Edit a not-yet-uploaded workout in place (name / notes / exercises / volume),
 * before its background flush begins. Only entries still in the 'queued' phase
 * are editable: once the flush has started (workout row inserted / sets
 * uploaded), mutating the entry would desync the server — the flush's
 * exactly-once set guard skips re-uploading the edited sets while phase 3 still
 * writes the new volume + XP, leaving old sets with a new total. Returns false
 * in that case (and when the entry is gone) so the editor defers to the
 * synced-edit path. Sets are recomputed by the caller, so XP/volume flow through
 * the normal flush untouched.
 */
export function updatePendingWorkout(
  userId: string,
  clientId: string,
  patch: { name: string; notes: string | null; exercises: PendingExercise[]; totalVolumeKg: number },
): boolean {
  const e = _byUser[userId]?.find((x) => x.clientId === clientId);
  // Gone (already synced) or mid-flush (phase past 'queued') — not safe to edit
  // in place; the caller routes those through the synced-edit queue instead.
  if (!e || e.phase !== 'queued') return false;
  e.name = patch.name;
  e.notes = patch.notes;
  e.exercises = patch.exercises;
  e.totalVolumeKg = patch.totalVolumeKg;
  void persist(userId);
  return true;
}

export function removePendingWorkout(userId: string, clientId: string): void {
  const list = _byUser[userId];
  if (!list) return;
  _byUser[userId] = list.filter((x) => x.clientId !== clientId);
  void persist(userId);
}

/** Drop a user's queue from memory + disk (e.g. on sign-out). */
export async function clearUserQueue(userId: string): Promise<void> {
  delete _byUser[userId];
  _hydrated[userId] = false;
  try {
    await AsyncStorage.removeItem(KEY(userId));
  } catch {
    // ignore
  }
}

// --- flush engine ---

// Postgres errors carry a 5-char SQLSTATE code; connectivity failures don't.
// We treat coded errors as data problems (park, move on) and everything else as
// a transport failure (back off, retry the whole queue later).
function isDataError(err: any): boolean {
  const code = err?.code;
  return typeof code === 'string' && /^[0-9A-Za-z]{5}$/.test(code);
}

function backoffMs(attempts: number): number {
  return Math.min(60000, 2 ** Math.max(0, attempts) * 2000) + Math.floor(Math.random() * 1000);
}

async function insertWorkoutOrRecover(
  supabase: SupabaseClient,
  entry: PendingWorkout,
): Promise<string> {
  const { data, error } = await supabase
    .from('workouts')
    .insert({
      // user_id omitted — default auth.jwt()->>'sub' fills it server-side.
      client_id: entry.clientId,
      routine_id: entry.linkedRoutineId,
      name: entry.name,
      notes: entry.notes,
      started_at: entry.startedAtIso,
      // finished_at stays null until phase 3.
    })
    .select('id')
    .single();
  if (!error && data) return (data as any).id as string;
  // 23505: this workout already landed on a prior attempt — recover its id by
  // client_id rather than inserting a duplicate.
  if (error?.code === '23505') {
    const { data: existing } = await supabase
      .from('workouts')
      .select('id')
      .eq('client_id', entry.clientId)
      .maybeSingle();
    if (existing && (existing as any).id) return (existing as any).id as string;
  }
  throw error ?? new Error('workout insert returned no row');
}

async function upsertXp(supabase: SupabaseClient, earned: number): Promise<void> {
  // Atomic increment via the award_xp RPC (migration 0039) — scoped to the
  // caller's profile by the JWT sub — so concurrent/retried flushes can't
  // clobber each other the way the old select-then-upsert did.
  await supabase.rpc('award_xp', { p_earned: earned });
}

/**
 * Push one pending workout to Supabase. Idempotent across retries:
 *   - phase 1 recovers the workout row by client_id on conflict,
 *   - phase 2 only inserts sets when none exist yet (guards the per-user stats
 *     trigger from double-counting),
 *   - the phase markers are persisted as each step lands, so a crash mid-flush
 *     resumes from where it stopped.
 * Throws on failure; the caller classifies network vs data error.
 */
export async function flushPendingWorkout(
  supabase: SupabaseClient,
  userId: string,
  entry: PendingWorkout,
): Promise<void> {
  let phase = entry.phase;
  let serverWorkoutId = entry.serverWorkoutId;

  if (phase === 'queued') {
    serverWorkoutId = await insertWorkoutOrRecover(supabase, entry);
    phase = 'workout_inserted';
    patchEntry(userId, entry.clientId, { serverWorkoutId, phase });
  }
  if (!serverWorkoutId) throw new Error('missing server workout id');

  // Resolve any exercise that was still on a temp id when finished (offline).
  let resolvedChanged = false;
  for (const ex of entry.exercises) {
    if (!ex.resolvedExerciseId) {
      const resolved = await resolveExerciseRow(supabase, ex.def);
      if (resolved) {
        ex.resolvedExerciseId = resolved.id;
        resolvedChanged = true;
      }
    }
  }
  if (resolvedChanged) patchEntry(userId, entry.clientId, { exercises: entry.exercises });

  // If an exercise still couldn't resolve but has completed sets, do NOT
  // silently drop them and mark the workout synced. Throw a parkable
  // (data-coded) error so flushQueue keeps the entry queued with a surfaced
  // lastError and retries it — online a custom resolves on the next attempt;
  // only a genuine, persistent server error leaves it visibly parked.
  if (entry.exercises.some((ex) => !ex.resolvedExerciseId && ex.sets.length > 0)) {
    throw Object.assign(new Error('Some exercises could not be linked yet'), { code: 'EXRES' });
  }

  if (phase === 'workout_inserted') {
    // Exactly-once: skip if sets already landed on a prior attempt.
    const { count, error: countError } = await supabase
      .from('workout_sets')
      .select('id', { count: 'exact', head: true })
      .eq('workout_id', serverWorkoutId);
    // Don't treat a FAILED count as "0 sets" — that would re-insert the sets (and
    // the per-user stats trigger would double-count). Throw so flushQueue parks
    // and retries instead of blindly inserting.
    if (countError) throw countError;
    if (!count) {
      const rows = entry.exercises.flatMap((ex) =>
        ex.resolvedExerciseId
          ? ex.sets.map((s, idx) => ({
              workout_id: serverWorkoutId,
              exercise_id: ex.resolvedExerciseId,
              weight_kg: s.weight_kg,
              reps: s.reps,
              completed: true,
              order: s.order ?? idx,
            }))
          : [],
      );
      if (rows.length > 0) {
        const { error } = await supabase.from('workout_sets').insert(rows);
        if (error) throw error;
      }
    }
    phase = 'sets_inserted';
    patchEntry(userId, entry.clientId, { phase });
  }

  if (phase === 'sets_inserted') {
    // Record the REAL workout end time (start + duration), not the flush-time
    // clock — an offline workout can sync hours later, and this keeps the server
    // row consistent with the optimistic local row (lib/pendingAdapters).
    const finishedAtIso = new Date(
      Date.parse(entry.startedAtIso) + entry.durationSeconds * 1000,
    ).toISOString();
    const { error } = await supabase
      .from('workouts')
      .update({
        finished_at: finishedAtIso,
        duration_seconds: entry.durationSeconds,
        total_volume_kg: entry.totalVolumeKg,
      })
      .eq('id', serverWorkoutId);
    if (error) throw error;
    // XP is best-effort, matching the original inline save.
    try {
      const setCount = entry.exercises.reduce((n, e) => n + e.sets.length, 0);
      await upsertXp(supabase, getXpForWorkout(setCount, entry.totalVolumeKg));
    } catch {
      // non-fatal
    }
    phase = 'done';
    patchEntry(userId, entry.clientId, { phase });
  }

  removePendingWorkout(userId, entry.clientId);
}

export interface FlushResult {
  pendingCount: number;
  lastError: string | null;
}

/**
 * Flush all queued workouts for a user, oldest first. Stops on the first
 * transport failure (no point hammering an unreachable server) but skips past a
 * data error so one poisoned entry doesn't block the rest.
 */
export async function flushQueue(
  supabase: SupabaseClient,
  userId: string,
): Promise<FlushResult> {
  const queue = [...getPendingWorkouts(userId)].sort((a, b) => a.createdAt - b.createdAt);
  let lastError: string | null = null;
  for (const entry of queue) {
    if (entry.nextAttemptAt > Date.now()) continue;
    try {
      await flushPendingWorkout(supabase, userId, entry);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      patchEntry(userId, entry.clientId, {
        attempts: entry.attempts + 1,
        lastError: msg,
        nextAttemptAt: Date.now() + backoffMs(entry.attempts + 1),
      });
      lastError = msg;
      if (!isDataError(err)) break; // transport failure: stop, retry the lot later
      // data error: park this one, keep going
    }
  }
  return { pendingCount: getPendingCount(userId), lastError };
}
