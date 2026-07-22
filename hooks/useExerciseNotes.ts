/**
 * Read-only access to the user's sticky per-exercise notes.
 *
 * The workout screen owns the write side (edit, debounced flush, id attach) and
 * talks to lib/exerciseNotes directly. Every other surface only ever *shows* a
 * note - the routine detail sheet, the routine editor, the exercise picker -
 * and this hook exists so those three don't each re-derive the owner rules and
 * the local-first-then-server load.
 *
 * Returns a { normalizedExerciseName: note } map; look up with noteFor(name).
 * Empty until hydration finishes, which is the right default: a note that
 * appears a frame late is invisible, a wrong one is not.
 */
import { useCallback, useEffect, useState } from 'react';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  exerciseNoteKey,
  getAllExerciseNotes,
  hydrateExerciseNotes,
  refreshExerciseNotesFromServer,
} from '@/lib/exerciseNotes';

// One in-flight server refresh per owner, shared across every mounted caller.
// The routines screen mounts three of these at once (detail sheet, editor, and
// the editor's picker), and without this they'd each fire the same select and
// race each other's merge into the lib/exerciseNotes module store.
const _inFlight: Record<string, Promise<Record<string, string> | null>> = {};

function refreshOnce(owner: string): Promise<Record<string, string> | null> {
  return (_inFlight[owner] ??= refreshExerciseNotesFromServer(supabase, owner).finally(() => {
    delete _inFlight[owner];
  }));
}

/**
 * @param enabled pass a sheet's `visible` flag so a mounted-but-hidden surface
 *   doesn't fetch. Notes load on the first render where this is true.
 */
export function useExerciseNotes(enabled = true): {
  notes: Record<string, string>;
  noteFor: (name: string | null | undefined) => string | null;
} {
  const { user, isLoaded: clerkLoaded } = useClerkUser();
  const isGuestSession = useIsGuestSession();
  const [notes, setNotes] = useState<Record<string, string>>({});

  // Same owner gate as the workout screen: mid-hydration Clerk has no user, so
  // isGuestSession briefly reads true for a signed-in user. A null owner keeps
  // us from reading the (empty) guest bucket and painting "no notes" for
  // someone who has them.
  const owner = !clerkLoaded ? null : isGuestSession ? 'guest' : user?.id;

  useEffect(() => {
    if (!owner || !enabled) return;
    let cancelled = false;
    (async () => {
      await hydrateExerciseNotes(owner);
      if (cancelled) return;
      setNotes(getAllExerciseNotes(owner));
      if (owner === 'guest' || !isSupabaseConfigured) return;
      // Pull only. Flushing dirty edits is the workout screen's job; doing it
      // here too would race two writers over the same entries.
      const merged = await refreshOnce(owner);
      if (!cancelled && merged) setNotes(merged);
    })();
    return () => { cancelled = true; };
  }, [owner, enabled]);

  const noteFor = useCallback(
    (name: string | null | undefined) => {
      if (!name) return null;
      const note = notes[exerciseNoteKey(name)];
      return note && note.trim() ? note.trim() : null;
    },
    [notes],
  );

  return { notes, noteFor };
}
