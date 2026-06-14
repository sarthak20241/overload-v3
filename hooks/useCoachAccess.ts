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
 *   The fix here: cache at module scope, tagged with the Clerk user id it was
 *   fetched for (NOT keyed by client). The hook reads supabase through a ref so
 *   the lazy `getToken` inside still sees the latest Clerk token at request
 *   time, and re-runs its RPC whenever the authenticated user id changes — so a
 *   sign-in/sign-out automatically invalidates a previous (or guest) user's
 *   value instead of silently reusing it. `resetCoachAccessCache()` still
 *   forces a fresh fetch on the next mount (e.g. from `refresh()`).
 *
 * Not a security boundary. The edge function (supabase/functions/ai-coach)
 * re-checks `get_coach_access_status` on every request and returns 402 if
 * the user isn't paid/trialing. This hook only chooses which UI to render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';

// Persist the last successful access per user so a returning paid/trialing user
// sees their real state offline instead of being told to sign in.
const coachAccessKey = (userId: string) => `coach_access_v1::${userId}`;

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

const UNKNOWN: CoachAccess = { state: 'unknown' };

// Module-scope cache, keyed to the auth session it was fetched for. Because
// AICoachModal keeps this hook mounted even while hidden, an un-keyed global
// would hand a previous (or guest) user's access state to the next signed-in
// user until something manually reset it. Tagging the cache with the Clerk
// user id lets us detect an auth change and refetch automatically.
let cachedAccess: { userId: string | null; access: CoachAccess } | null = null;

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

  // Identify the current auth session so the cache can't leak across users.
  const { user } = useClerkUser();
  const userId = user?.id ?? null;

  const cacheForUser = cachedAccess?.userId === userId ? cachedAccess.access : null;
  const [access, setAccess] = useState<CoachAccess>(cacheForUser ?? UNKNOWN);
  const [loading, setLoading] = useState<boolean>(cacheForUser === null);

  useEffect(() => {
    if (cachedAccess?.userId === userId) {
      // Cache populated for THIS user by a previous mount — short-circuit.
      setAccess(cachedAccess.access);
      setLoading(false);
      return;
    }
    // Auth changed (or first fetch): drop any stale value and refetch.
    cachedAccess = null;
    setLoading(true);
    let cancelled = false;
    (async () => {
      // Seed from the persisted last-known access so a returning paid/trialing
      // user isn't told to "sign in" while offline on a cold start.
      let lastKnown: CoachAccess | null = null;
      if (userId) {
        try {
          const raw = await AsyncStorage.getItem(coachAccessKey(userId));
          if (raw) lastKnown = JSON.parse(raw) as CoachAccess;
        } catch {}
      }
      if (!cancelled && lastKnown) {
        // Paint the last-known access immediately and drop the spinner; the RPC
        // below still refreshes it in the background.
        setAccess(lastKnown);
        setLoading(false);
      }
      try {
        const { data, error } = await supabaseRef.current.rpc(
          'get_coach_access_status',
        );
        if (cancelled) return;
        if (error) {
          // Network blip / RLS rejection. Fall back to the last-known access
          // (or UNKNOWN) — never claim a signed-in user is unauthenticated.
          // The edge function re-checks on every send, so this is UI-only.
          setAccess(lastKnown ?? UNKNOWN);
        } else {
          const next = normalize(data);
          cachedAccess = { userId, access: next };
          setAccess(next);
          if (userId) AsyncStorage.setItem(coachAccessKey(userId), JSON.stringify(next)).catch(() => {});
        }
      } catch {
        if (cancelled) return;
        setAccess(lastKnown ?? UNKNOWN);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]); // Refire when the authenticated user changes.

  const refresh = useCallback(async (): Promise<void> => {
    // Manual invalidation. Used after starting a trial, after a purchase
    // completes, or on pull-to-refresh. Doesn't flip `loading` to true —
    // existing data is fine as a placeholder while the new value lands.
    cachedAccess = null;
    try {
      const { data, error } = await supabaseRef.current.rpc(
        'get_coach_access_status',
      );
      if (error) return; // keep current state on a failed refresh (e.g. offline)
      const next = normalize(data);
      cachedAccess = { userId, access: next };
      setAccess(next);
      if (userId) AsyncStorage.setItem(coachAccessKey(userId), JSON.stringify(next)).catch(() => {});
    } catch {
      // Keep the current state on a failed refresh rather than downgrading.
    }
  }, [userId]);

  return { access, loading, refresh };
}
