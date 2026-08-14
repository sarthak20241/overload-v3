/**
 * Foreground program-advance trigger (Drona Programs, Phase 2).
 *
 * On app-open and each return to the foreground, advance the active program's
 * machine-read nutrition targets to whatever phase today falls in, IF a phase
 * boundary was crossed since the last apply (reconcileActiveProgram is
 * boundary-only + today-forward + idempotent, so firing on every 'active' is
 * safe and never clobbers an in-phase manual target edit). No-op for guests /
 * signed-out sessions and for users with no active program. A ref guards
 * against overlapping runs. Mounted once from the (app) layout, alongside
 * useForegroundHealthSync.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useSupabaseClient } from './supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { reconcileActiveProgram } from './programData';

export function useForegroundProgramSync(): void {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const userId = user?.id ?? null;
  const running = useRef(false);

  useEffect(() => {
    if (!userId || !supabase) return;
    let cancelled = false;
    const run = () => {
      if (running.current || cancelled) return;
      running.current = true;
      reconcileActiveProgram(supabase, userId)
        .catch(() => {})
        .finally(() => {
          running.current = false;
        });
    };
    run(); // on mount / when a user becomes available
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') run();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [userId, supabase]);
}
