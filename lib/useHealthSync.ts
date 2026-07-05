/**
 * Foreground health-sync trigger (holistic tracking, Phase 2).
 *
 * On app-open and each return to the foreground, pull the latest hub data and
 * recompute today's readiness for the signed-in user. No-op for guests /
 * signed-out sessions and on platforms with no hub adapter. Both underlying
 * steps are idempotent, so firing on every 'active' is safe. A ref guards
 * against overlapping runs. Mounted once from the (app) layout.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useSupabaseClient } from './supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { runHealthSyncAndReadiness } from './readinessSync';

export function useForegroundHealthSync(): void {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const userId = user?.id ?? null;
  const running = useRef(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const run = () => {
      if (running.current || cancelled) return;
      running.current = true;
      runHealthSyncAndReadiness(supabase, userId)
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
