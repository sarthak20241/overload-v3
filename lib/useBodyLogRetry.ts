/**
 * Retries body log uploads (weight, body fat, measurements) with backoff.
 *
 * A save uploads at once. When that fails (no signal at the gym), the entry
 * waits on the phone, and this retries after 15 s, 30 s, 60 s ... capped at
 * 15 minutes, only while something is still waiting. A new save or a return
 * to the app starts the gaps over; the app going to the background stops them.
 * The rules live in lib/bodyLog.ts (createRetryScheduler, tested there).
 * Mounted once from the (app) layout, next to useForegroundHealthSync, which
 * already uploads on app open and foreground.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useSupabaseClient } from './supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { createRetryScheduler, onBodyLogEvent } from './bodyLog';
import { flushBodyLogsOnOpen } from './bodyLogSync';

export function useBodyLogRetry(): void {
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    const scheduler = createRetryScheduler({
      run: () => { flushBodyLogsOnOpen(supabase, userId).catch(() => {}); },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });
    const off = onBodyLogEvent((e) => {
      if (e.userId !== userId) return;
      if (e.type === 'edit') scheduler.reset();
      else scheduler.flushed(e.name, e.remaining);
    });
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') scheduler.resume();
      else scheduler.pause();
    });
    return () => {
      off();
      sub.remove();
      scheduler.pause();
    };
  }, [userId, supabase]);
}
