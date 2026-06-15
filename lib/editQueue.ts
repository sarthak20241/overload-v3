/**
 * Offline write queue for EDITS to already-synced workouts, mirroring
 * lib/syncQueue.ts and lib/routineQueue.ts.
 *
 * Editing a completed workout that already lives on the server is local-first
 * too: the edit is enqueued here and SyncProvider reconciles it to Supabase in
 * the background (replace workout_sets, update the workout row, adjust XP by the
 * delta). Read screens overlay the edit on top of fresh server data
 * (applyEditsTo*) so a wholesale revalidate never clobbers a not-yet-synced
 * edit — the same approach mergePendingRoutines uses for routines.
 *
 * Guest and not-yet-synced (pending) workouts never use this queue: a guest
 * workout is edited directly in the guest store, and a pending workout is
 * mutated in place in lib/syncQueue before it ever uploads.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveExerciseRow } from '@/lib/exerciseResolve';
import { getXpForWorkout } from '@/lib/xp';

const KEY = (userId: string) => `pending_edits_v1::${userId}`;
const SCHEMA = 1 as const;

export interface PendingEditSet {
  weight_kg: number;
  reps: number;
  order: number;
}

export interface PendingEditExercise {
  /** Library def, kept so a temp (unresolved) exercise can resolve at flush. */
  def: { name: string; muscle_group: string; category: string };
  /** Real exercises.id if known; null when it must resolve by name at flush. */
  resolvedExerciseId: string | null;
  sets: PendingEditSet[];
}

export interface PendingWorkoutEdit {
  schema: typeof SCHEMA;
  /** Server workouts.id being edited; also the supersede / idempotency key. */
  workoutId: string;
  ownerId: string;
  name: string;
  notes: string | null;
  exercises: PendingEditExercise[];
  totalVolumeKg: number;
  /**
   * The workout's ORIGINAL server set count + volume, captured the first time
   * it was edited. The XP delta is always measured against this baseline (not a
   * previous not-yet-flushed edit), so repeated offline edits never drift.
   */
  baseSetCount: number;
  baseVolumeKg: number;
  // --- flush progress / idempotency ---
  phase: 'queued' | 'sets_replaced' | 'done';
  attempts: number;
  /** epoch ms; entries are skipped until now() passes this (backoff). */
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
}

// --- per-user store (AsyncStorage-backed, in-memory cache) ---
const _byUser: Record<string, PendingWorkoutEdit[]> = {};
const _hydrated: Record<string, boolean> = {};

async function persist(userId: string) {
  try {
    await AsyncStorage.setItem(KEY(userId), JSON.stringify(_byUser[userId] ?? []));
  } catch {
    // Persistence failures shouldn't break the in-memory flow.
  }
}

/** Load a user's edit queue from disk. Idempotent; call when the user is known. */
export async function hydrateEditQueue(userId: string): Promise<void> {
  if (!userId || _hydrated[userId]) return;
  try {
    const raw = await AsyncStorage.getItem(KEY(userId));
    const parsed = raw ? (JSON.parse(raw) as PendingWorkoutEdit[]) : [];
    const existing = _byUser[userId] ?? [];
    const ids = new Set(existing.map((e) => e.workoutId));
    _byUser[userId] = [
      ...existing,
      ...parsed.filter((p) => p?.schema === SCHEMA && !ids.has(p.workoutId)),
    ];
    if (existing.length > 0) void persist(userId);
  } catch {
    _byUser[userId] = _byUser[userId] ?? [];
  } finally {
    _hydrated[userId] = true;
  }
}

export function getPendingEdits(userId: string): PendingWorkoutEdit[] {
  return _byUser[userId] ?? [];
}

/** The pending edit for a specific workout, if one is queued. */
export function getPendingEdit(userId: string, workoutId: string): PendingWorkoutEdit | null {
  return _byUser[userId]?.find((e) => e.workoutId === workoutId) ?? null;
}

export function getPendingEditCount(userId: string): number {
  return (_byUser[userId] ?? []).length;
}

/**
 * Enqueue (or supersede, by workoutId) a pending edit. A superseding edit keeps
 * the original server baseline (baseSetCount/baseVolumeKg) and original
 * createdAt, so the XP delta stays measured against the synced state even after
 * several offline re-edits, and re-flushes from a clean phase.
 */
export async function enqueueEdit(
  userId: string,
  input: {
    workoutId: string;
    ownerId: string;
    name: string;
    notes: string | null;
    exercises: PendingEditExercise[];
    totalVolumeKg: number;
    baseSetCount: number;
    baseVolumeKg: number;
  },
): Promise<void> {
  const list = (_byUser[userId] ??= []);
  const idx = list.findIndex((e) => e.workoutId === input.workoutId);
  const base =
    idx >= 0
      ? {
          baseSetCount: list[idx].baseSetCount,
          baseVolumeKg: list[idx].baseVolumeKg,
          createdAt: list[idx].createdAt,
        }
      : { baseSetCount: input.baseSetCount, baseVolumeKg: input.baseVolumeKg, createdAt: Date.now() };
  const entry: PendingWorkoutEdit = {
    schema: SCHEMA,
    workoutId: input.workoutId,
    ownerId: input.ownerId,
    name: input.name,
    notes: input.notes,
    exercises: input.exercises,
    totalVolumeKg: input.totalVolumeKg,
    baseSetCount: base.baseSetCount,
    baseVolumeKg: base.baseVolumeKg,
    phase: 'queued',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: base.createdAt,
  };
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);
  await persist(userId);
}

function patchEntry(userId: string, workoutId: string, patch: Partial<PendingWorkoutEdit>) {
  const e = _byUser[userId]?.find((x) => x.workoutId === workoutId);
  if (!e) return;
  Object.assign(e, patch);
  void persist(userId);
}

export function removePendingEdit(userId: string, workoutId: string): void {
  const list = _byUser[userId];
  if (!list) return;
  _byUser[userId] = list.filter((x) => x.workoutId !== workoutId);
  void persist(userId);
}

/** Drop a user's edit queue from memory + disk (e.g. on sign-out). */
export async function clearUserEditQueue(userId: string): Promise<void> {
  delete _byUser[userId];
  _hydrated[userId] = false;
  try {
    await AsyncStorage.removeItem(KEY(userId));
  } catch {
    // ignore
  }
}

// --- read-side overlay (optimistic display) ---

/**
 * History-shape overlay: patch any row whose id matches a pending edit, swapping
 * in the edited name/notes/volume and rebuilding exercises[]/workout_sets to
 * match pendingToHistoryRow. Untouched rows pass through.
 */
export function applyEditsToHistoryRows(userId: string | null | undefined, rows: any[]): any[] {
  if (!userId) return rows;
  const edits = getPendingEdits(userId);
  if (edits.length === 0) return rows;
  const byId = new Map(edits.map((e) => [e.workoutId, e]));
  return rows.map((w) => {
    const e = w?.id ? byId.get(w.id) : undefined;
    if (!e) return w;
    let setId = 0;
    return {
      ...w,
      name: e.name,
      notes: e.notes ?? undefined,
      total_volume_kg: e.totalVolumeKg,
      workout_sets: e.exercises.flatMap((ex) =>
        ex.sets.map(() => ({ id: `${e.workoutId}-edit-s-${setId++}` })),
      ),
      exercises: e.exercises.map((ex) => ({
        name: ex.def.name,
        sets: ex.sets.map((s) => ({ weight_kg: s.weight_kg, reps: s.reps, completed: true })),
      })),
      _pendingSync: true,
    };
  });
}

/**
 * Dashboard / analytics-shape overlay: patch any row whose id matches a pending
 * edit, rebuilding workout_sets/sets to match pendingToDashboardWorkout.
 */
export function applyEditsToDashboardRows(userId: string | null | undefined, rows: any[]): any[] {
  if (!userId) return rows;
  const edits = getPendingEdits(userId);
  if (edits.length === 0) return rows;
  const byId = new Map(edits.map((e) => [e.workoutId, e]));
  return rows.map((w) => {
    const e = w?.id ? byId.get(w.id) : undefined;
    if (!e) return w;
    let order = 0;
    const sets = e.exercises.flatMap((ex, ei) => {
      const meta = {
        id: ex.resolvedExerciseId ?? `${e.workoutId}-edit-ex-${ei}`,
        name: ex.def.name,
        muscle_group: ex.def.muscle_group || 'Other',
        category: ex.def.category || 'Other',
      };
      return ex.sets.map((s, si) => ({
        id: `${e.workoutId}-edit-set-${ei}-${si}`,
        exercise_id: meta.id,
        exercises: meta,
        weight_kg: s.weight_kg,
        reps: s.reps,
        completed: true,
        order: order++,
      }));
    });
    return {
      ...w,
      name: e.name,
      notes: e.notes ?? undefined,
      total_volume_kg: e.totalVolumeKg,
      workout_sets: sets,
      sets,
      _pendingSync: true,
    };
  });
}

// --- flush engine (mirrors lib/routineQueue.ts) ---

function isDataError(err: any): boolean {
  const code = err?.code;
  return typeof code === 'string' && /^[0-9A-Za-z]{5}$/.test(code);
}

function backoffMs(attempts: number): number {
  return Math.min(60000, 2 ** Math.max(0, attempts) * 2000) + Math.floor(Math.random() * 1000);
}

/**
 * Reconcile one pending edit to Supabase. Idempotent across retries:
 *   - exercises resolve to real ids (find-or-insert by name),
 *   - workout_sets are replaced wholesale (delete+insert; a re-run wipes any
 *     partial insert and re-inserts the full set, and the entry always holds the
 *     full desired state),
 *   - the workout row + XP delta land last, gated by the phase marker.
 */
async function flushPendingEdit(
  supabase: SupabaseClient,
  userId: string,
  entry: PendingWorkoutEdit,
): Promise<void> {
  let phase = entry.phase;

  // Resolve any exercise still without a real id (e.g. one added during the
  // edit). Find-or-insert by name; safe to re-run every attempt.
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
  if (changed) patchEntry(userId, entry.workoutId, { exercises: entry.exercises });
  if (entry.exercises.some((ex) => !ex.resolvedExerciseId && ex.sets.length > 0)) {
    // Couldn't link a set-bearing exercise yet — park (retries; resolves online).
    throw Object.assign(new Error('Some exercises could not be linked yet'), { code: 'EXRES' });
  }

  if (phase === 'queued') {
    const { error: delErr } = await supabase
      .from('workout_sets')
      .delete()
      .eq('workout_id', entry.workoutId);
    if (delErr) throw delErr;
    const rows = entry.exercises.flatMap((ex) =>
      ex.resolvedExerciseId
        ? ex.sets.map((s, idx) => ({
            workout_id: entry.workoutId,
            exercise_id: ex.resolvedExerciseId,
            weight_kg: s.weight_kg,
            reps: s.reps,
            completed: true,
            order: s.order ?? idx,
          }))
        : [],
    );
    if (rows.length > 0) {
      const { error: insErr } = await supabase.from('workout_sets').insert(rows);
      if (insErr) throw insErr;
    }
    phase = 'sets_replaced';
    patchEntry(userId, entry.workoutId, { phase });
  }

  if (phase === 'sets_replaced') {
    const { error } = await supabase
      .from('workouts')
      .update({
        name: entry.name,
        notes: entry.notes,
        total_volume_kg: entry.totalVolumeKg,
      })
      .eq('id', entry.workoutId);
    if (error) throw error;
    // XP delta vs the original server baseline, best-effort (matches the
    // delete-refund / finish-award posture). The stats tables recompute
    // themselves from the changed sets via their own trigger.
    try {
      const newCount = entry.exercises.reduce((n, e) => n + e.sets.length, 0);
      const delta =
        getXpForWorkout(newCount, entry.totalVolumeKg) -
        getXpForWorkout(entry.baseSetCount, entry.baseVolumeKg);
      if (delta !== 0) await supabase.rpc('award_xp', { p_earned: delta });
    } catch {
      // non-fatal
    }
    phase = 'done';
    patchEntry(userId, entry.workoutId, { phase });
  }

  removePendingEdit(userId, entry.workoutId);
}

export interface EditFlushResult {
  pendingCount: number;
  lastError: string | null;
}

export async function flushEditQueue(
  supabase: SupabaseClient,
  userId: string,
): Promise<EditFlushResult> {
  const queue = [...getPendingEdits(userId)].sort((a, b) => a.createdAt - b.createdAt);
  let lastError: string | null = null;
  for (const entry of queue) {
    if (entry.nextAttemptAt > Date.now()) continue;
    try {
      await flushPendingEdit(supabase, userId, entry);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      patchEntry(userId, entry.workoutId, {
        attempts: entry.attempts + 1,
        lastError: msg,
        nextAttemptAt: Date.now() + backoffMs(entry.attempts + 1),
      });
      lastError = msg;
      if (!isDataError(err)) break; // transport failure: stop, retry the lot later
      // data error: park this one, keep going
    }
  }
  return { pendingCount: getPendingEditCount(userId), lastError };
}
