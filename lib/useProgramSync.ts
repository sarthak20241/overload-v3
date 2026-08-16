/**
 * Foreground program-advance trigger (Drona Programs, Phase 2).
 *
 * On app-open and each return to the foreground, advance the active program's
 * machine-read nutrition targets to whatever phase today falls in, IF a phase
 * boundary was crossed since the last apply (reconcileActiveProgram is
 * boundary-only + today-forward + idempotent, so firing on every 'active' is
 * safe and never clobbers an in-phase manual target edit). No-op for guests /
 * signed-out sessions and for users with no active program. An effect-scoped
 * flag guards against overlapping runs. Mounted once from the (app) layout,
 * alongside useForegroundHealthSync.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { reconcileActiveProgram } from '@/lib/programData';

export function useForegroundProgramSync(): void {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId || !supabase) return;
    let cancelled = false;
    // Scoped to this effect run, not the component. A component-level ref would
    // stay true across a sign-in while the PREVIOUS identity's reconcile was
    // still in flight, so the new user's first run would be skipped and they
    // would get no reconcile until the next foreground transition.
    let running = false;
    const run = () => {
      if (running || cancelled) return;
      running = true;
      reconcileActiveProgram(supabase, userId)
        .catch((e) => console.warn('[programs] reconcile failed', e))
        .finally(() => {
          running = false;
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
