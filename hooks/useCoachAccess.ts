/**
 * useCoachAccess — single source of truth for "can this user chat with Drona,
 * and what's their current state?". Wraps the `get_coach_access_status`
 * Postgres RPC (see migration 0031).
 *
 * The RPC returns a tagged-union jsonb keyed by `state`:
 *   { state: 'unauthenticated' }
 *   { state: 'paid',               tier, expires_at, messages_today, daily_limit, messages_left }
 *   { state: 'trialing',           expires_at, days_left, messages_today, daily_limit, messages_left }
 *   { state: 'trial_ended',        end_reason, ended_at }
 *   { state: 'eligible_for_trial' }
 *
 * We normalize that into a flat camelCase shape so callers don't have to
 * narrow on `state` just to read a field.
 *
 * Cache strategy (revised, was buggy):
 *   The first version keyed the cache off the supabase client identity via a
 *   WeakMap, expecting client identity to be a clean proxy for "auth changed."
 *   In practice Clerk's `useAuth()` can yield a fresh `getToken` reference
 *   every render, which means useSupabaseClient's `useMemo([getToken])`
 *   re-creates the client on every render too. Each new client missed the
 *   cache → re-fetched → useEffect re-fired with the new client → repeat
 *   forever. The UI never left the loading state.
 *
 *   The fix here: cache at module scope, NOT keyed by client. The hook fires
 *   its RPC exactly once per mount (`useEffect(..., [])`) and reads supabase
 *   through a ref so the lazy `getToken` inside still sees the latest Clerk
 *   token at request time. Auth changes are handled explicitly by
 *   `resetCoachAccessCache()` — called on sign-out (or by `refresh()`) — so
 *   the next mount starts fresh.
 *
 * Not a security boundary. The edge function (supabase/functions/ai-coach)
 * re-checks `get_coach_access_status` on every request and returns 402 if
 * the user isn't paid/trialing. This hook only chooses which UI to render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSupabaseClient } from '@/lib/supabase';

export type CoachAccessState =
  | 'unauthenticated'
  | 'paid'
  | 'trialing'
  | 'trial_ended'
  | 'eligible_for_trial'
  | 'unknown';

export interface CoachAccess {
  state: CoachAccessState;
  tier?: string;
  expiresAt?: string | null;
  daysLeft?: number;
  messagesToday?: number;
  dailyLimit?: number;
  messagesLeft?: number;
  endReason?: string;
  endedAt?: string;
}

export interface UseCoachAccessReturn {
  access: CoachAccess;
  loading: boolean;
  refresh: () => Promise<void>;
}

const UNAUTH: CoachAccess = { state: 'unauthenticated' };
const UNKNOWN: CoachAccess = { state: 'unknown' };

// Module-scope cache. Single value shared across all mounts of the hook.
// Cleared by resetCoachAccessCache() — call this from the Clerk sign-out
// path (or anywhere auth changes) so the next mount re-fetches.
let cachedAccess: CoachAccess | null = null;

export function resetCoachAccessCache(): void {
  cachedAccess = null;
}

function normalize(row: any): CoachAccess {
  if (!row || typeof row !== 'object') return UNKNOWN;
  const state = (row.state ?? 'unknown') as CoachAccessState;
  return {
    state,
    tier: row.tier ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    daysLeft: typeof row.days_left === 'number' ? row.days_left : undefined,
    messagesToday: typeof row.messages_today === 'number' ? row.messages_today : undefined,
    dailyLimit: typeof row.daily_limit === 'number' ? row.daily_limit : undefined,
    messagesLeft: typeof row.messages_left === 'number' ? row.messages_left : undefined,
    endReason: row.end_reason ?? undefined,
    endedAt: row.ended_at ?? undefined,
  };
}

export function useCoachAccess(): UseCoachAccessReturn {
  // Read the supabase client through a ref so we don't depend on its
  // identity in any effect. supabase-js's fetch wrapper calls getToken()
  // lazily at request time, so a stale client object still attaches the
  // current Clerk JWT — what we care about is just having ANY usable
  // client when we fire the RPC.
  const supabase = useSupabaseClient();
  const supabaseRef = useRef(supabase);
  supabaseRef.current = supabase;

  const [access, setAccess] = useState<CoachAccess>(cachedAccess ?? UNKNOWN);
  const [loading, setLoading] = useState<boolean>(cachedAccess === null);

  useEffect(() => {
    if (cachedAccess !== null) {
      // Cache populated by a previous mount in this session — short-circuit.
      setAccess(cachedAccess);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabaseRef.current.rpc(
          'get_coach_access_status',
        );
        if (cancelled) return;
        if (error) {
          // Network blip / RLS rejection. Fall back to unauthenticated
          // (safe default — gates the chat) but do NOT cache the error,
          // so refresh() or a remount can retry.
          setAccess(UNAUTH);
        } else {
          const next = normalize(data);
          cachedAccess = next;
          setAccess(next);
        }
      } catch {
        if (cancelled) return;
        setAccess(UNAUTH);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Fire once per mount; read supabase via ref.

  const refresh = useCallback(async (): Promise<void> => {
    // Manual invalidation. Used after starting a trial, after a purchase
    // completes, or on pull-to-refresh. Doesn't flip `loading` to true —
    // existing data is fine as a placeholder while the new value lands.
    cachedAccess = null;
    try {
      const { data, error } = await supabaseRef.current.rpc(
        'get_coach_access_status',
      );
      if (error) {
        setAccess(UNAUTH);
        return;
      }
      const next = normalize(data);
      cachedAccess = next;
      setAccess(next);
    } catch {
      setAccess(UNAUTH);
    }
  }, []);

  return { access, loading, refresh };
}
