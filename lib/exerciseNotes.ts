/**
 * Sticky per-exercise personal notes.
 *
 * One note per (user, exercise) — "seat at 4", "elbows tucked", "longer warmup
 * for the left shoulder" — shown under the exercise header in every session
 * and edited in place there. Distinct from workouts.notes (per-session
 * reflection shown in history) and routine_exercises.note (coach cue on a
 * routine slot).
 *
 * Local-first, same pattern as lib/guestStore.ts: module memory + AsyncStorage
 * per owner (a Clerk user id, or 'guest'), hydrated on demand. Every keystroke
 * lands in the local store immediately and independently of the workout's own
 * save/discard lifecycle — abandoning a session must not eat a note edit.
 * Signed-in owners flush dirty entries to `user_exercise_notes` in the
 * background (the workout screen debounces the flush); guests never touch
 * Supabase.
 *
 * Entries are keyed by normalized exercise NAME, not id, because an ad-hoc
 * exercise starts life with a temp id until reconcileExerciseRow resolves the
 * real row (and name is already how previousPerformance identifies exercises
 * across local caches). The DB id attaches to the entry when known; the flush
 * skips entries that don't have one yet.
 *
 * Name-as-key leans on the DB invariant that an exercise name resolves to ONE
 * row per user (unique index on the global catalog + per-user custom names,
 * migration exercise_name_unique + lib/exerciseResolve.ts). setExerciseNote
 * takes the caller's exerciseId over a previously attached one on purpose:
 * under the invariant they only differ when the row was deleted and recreated,
 * where the fresh id is the live one (a stale id would FK-fail on flush and
 * stay dirty forever). If the uniqueness invariant is ever relaxed, this
 * becomes last-editor-wins across same-named rows — revisit the keying then.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';

const KEY = (owner: string) => `exercise_notes_v1::${owner}`;

interface NoteEntry {
  note: string;
  /** exercises.id when known; null while the exercise still has a temp id. */
  exerciseId: string | null;
  updatedAt: number;
  /** True when the local edit hasn't reached Supabase yet (always false for guests). */
  dirty: boolean;
}

const _mem: Record<string, Record<string, NoteEntry>> = {};
const _hydrated: Record<string, boolean> = {};

/** Normalized map key for an exercise name (same convention as previousPerformance). */
export function exerciseNoteKey(name: string): string {
  return name.trim().toLowerCase();
}

function store(owner: string): Record<string, NoteEntry> {
  return (_mem[owner] ??= {});
}

function persist(owner: string) {
  AsyncStorage.setItem(KEY(owner), JSON.stringify(store(owner))).catch(() => {
    // Persistence failures shouldn't break the in-memory flow.
  });
}

/** Load an owner's notes from disk into memory. Idempotent per owner. */
export async function hydrateExerciseNotes(owner: string): Promise<void> {
  if (_hydrated[owner]) return;
  try {
    const raw = await AsyncStorage.getItem(KEY(owner));
    // Don't clobber a value written in memory before hydration finished.
    if (raw != null && !(owner in _mem)) _mem[owner] = JSON.parse(raw);
  } catch {
    // corrupt / missing → start empty
  } finally {
    _hydrated[owner] = true;
  }
}

/** All of an owner's notes as { nameKey: note }, empty notes omitted. */
export function getAllExerciseNotes(owner: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, e] of Object.entries(store(owner))) {
    if (e.note.trim()) out[k] = e.note;
  }
  return out;
}

/**
 * Record a note edit. Writes memory + disk synchronously with the keystroke;
 * the caller schedules the network flush (signed-in only).
 */
export function setExerciseNote(
  owner: string,
  name: string,
  exerciseId: string | null,
  note: string,
): void {
  const s = store(owner);
  const k = exerciseNoteKey(name);
  if (!k) return;
  const prev = s[k];
  s[k] = {
    note,
    exerciseId: exerciseId ?? prev?.exerciseId ?? null,
    updatedAt: Date.now(),
    dirty: owner !== 'guest',
  };
  persist(owner);
}

/**
 * Attach the real DB id to an entry once an ad-hoc add resolves its temp id.
 * No-op when there's no entry or it already has an id.
 */
export function attachExerciseNoteId(owner: string, name: string, exerciseId: string): void {
  const e = store(owner)[exerciseNoteKey(name)];
  if (!e || e.exerciseId) return;
  e.exerciseId = exerciseId;
  persist(owner);
}

/**
 * Push dirty entries to user_exercise_notes. An emptied note deletes the row.
 * Entries without a real id yet (ad-hoc temp ids) stay dirty and are retried
 * on the next call. Failures keep the entry dirty — the next workout screen
 * mount retries.
 */
export async function flushExerciseNotes(client: SupabaseClient, userId: string): Promise<void> {
  const s = store(userId);
  for (const [k, e] of Object.entries(s)) {
    if (!e.dirty || !e.exerciseId || e.exerciseId.startsWith('temp-')) continue;
    try {
      if (e.note.trim()) {
        const { error } = await client
          .from('user_exercise_notes')
          .upsert(
            {
              user_id: userId,
              exercise_id: e.exerciseId,
              note: e.note,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id,exercise_id' },
          );
        if (error) throw error;
        e.dirty = false;
      } else {
        const { error } = await client
          .from('user_exercise_notes')
          .delete()
          .match({ user_id: userId, exercise_id: e.exerciseId });
        if (error) throw error;
        delete s[k];
      }
    } catch {
      // Offline / RLS hiccup: stays dirty, retried next mount.
    }
  }
  persist(userId);
}

/**
 * Pull the user's notes from Supabase and merge into the local store. Server
 * is authoritative for clean entries (adds, updates, and deletions from other
 * devices); local dirty entries win until they flush. Returns the merged
 * { nameKey: note } map, or null when the fetch failed (keep local as-is).
 */
export async function refreshExerciseNotesFromServer(
  client: SupabaseClient,
  userId: string,
): Promise<Record<string, string> | null> {
  try {
    const { data, error } = await client
      .from('user_exercise_notes')
      .select('exercise_id, note, updated_at, exercises(name)')
      .eq('user_id', userId);
    if (error) throw error;
    const s = store(userId);
    const serverKeys = new Set<string>();
    for (const row of (data as any[]) ?? []) {
      const name = row?.exercises?.name;
      if (!name || typeof row.note !== 'string') continue;
      const k = exerciseNoteKey(name);
      serverKeys.add(k);
      if (s[k]?.dirty) continue; // unflushed local edit wins
      s[k] = {
        note: row.note,
        exerciseId: row.exercise_id,
        updatedAt: Date.parse(row.updated_at) || Date.now(),
        dirty: false,
      };
    }
    // Clean entries the server no longer has were deleted elsewhere.
    for (const [k, e] of Object.entries(s)) {
      if (!e.dirty && !serverKeys.has(k)) delete s[k];
    }
    persist(userId);
    return getAllExerciseNotes(userId);
  } catch {
    return null;
  }
}
