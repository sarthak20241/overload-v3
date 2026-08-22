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
import { AppState } from 'react-native';
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
  // Metered free tier (migration 0088). Replaces the retired
  // 'trial_ended' / 'eligible_for_trial' states; those remain in the union
  // only so a stale persisted access blob from an old app version still
  // type-checks while it renders one last time before the refresh RPC lands.
  | 'free'
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
  parsesToday?: number;
  parseDailyLimit?: number;
  parsesLeft?: number;
  hadTrial?: boolean;
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

// Mounted hooks that want to be told when the cache is invalidated.
//
// Clearing `cachedAccess` alone is NOT enough, and assuming it was is what let
// a paid user keep seeing "Free plan · 3 messages left" until they force-quit:
// AICoachModal renders with `visible={false}` rather than unmounting, so its
// hook instance holds the pre-purchase value in React state and has no reason
// to look at the module cache ever again. Emptying a variable it already read
// cannot reach it. Subscribers close that gap.
type Listener = () => void;
const listeners = new Set<Listener>();

// Entitlement can change while the app is backgrounded: a renewal lands, a
// subscription lapses, or the user cancels from iOS Settings. Re-read on the way
// back in so the UI isn't arguing with the App Store.
//
// One subscription for the whole app, attached while anything is listening,
// rather than one per mounted hook — otherwise N consumers would each fire an
// invalidation on every foreground.
let appStateSub: { remove: () => void } | null = null;

function subscribeToCoachAccess(fn: Listener): () => void {
  listeners.add(fn);
  if (!appStateSub) {
    appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') invalidateCoachAccess();
    });
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      appStateSub?.remove();
      appStateSub = null;
    }
  };
}

/** Tell every mounted hook to refetch. Listeners never notify, so no loop. */
function notifyCoachAccessListeners(): void {
  for (const fn of Array.from(listeners)) fn();
}

/**
 * Drop the cached access AND make every mounted `useCoachAccess` refetch.
 *
 * Call after anything that can change entitlement out from under the UI: a
 * completed purchase, a restore, a trial start, returning to the foreground.
 */
export function invalidateCoachAccess(): void {
  cachedAccess = null;
  notifyCoachAccessListeners();
}

/**
 * @deprecated Use {@link invalidateCoachAccess}. This only empties the cache
 * for the NEXT mount; already-mounted screens keep rendering the stale value.
 */
export function resetCoachAccessCache(): void {
  invalidateCoachAccess();
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
    parsesToday: typeof row.parses_today === 'number' ? row.parses_today : undefined,
    parseDailyLimit: typeof row.parse_daily_limit === 'number' ? row.parse_daily_limit : undefined,
    parsesLeft: typeof row.parses_left === 'number' ? row.parses_left : undefined,
    hadTrial: typeof row.had_trial === 'boolean' ? row.had_trial : undefined,
    endReason: row.end_reason ?? undefined,
    endedAt: row.ended_at ?? undefined,
  };
}

// One RPC in flight at a time, shared by every mounted hook. Without this,
// invalidating with both AICoachModal and MilestoneUpsellCard mounted fires the
// same query twice for the same answer.
let inFlight: Promise<CoachAccess | null> | null = null;

/**
 * Fetch, cache and persist the access for `userId`. Resolves null when the RPC
 * failed, so callers can keep whatever they were already showing rather than
 * downgrading a paying user on a network blip.
 */
function fetchCoachAccess(
  supabase: ReturnType<typeof useSupabaseClient>,
  userId: string | null,
): Promise<CoachAccess | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { data, error } = await supabase.rpc('get_coach_access_status');
      if (error) return null;
      const next = normalize(data);
      cachedAccess = { userId, access: next };
      if (userId) {
        AsyncStorage.setItem(coachAccessKey(userId), JSON.stringify(next)).catch(() => {});
      }
      return next;
    } catch {
      return null;
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
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
      const next = await fetchCoachAccess(supabaseRef.current, userId);
      if (cancelled) return;
      // On failure fall back to the last-known access (or UNKNOWN) — never
      // claim a signed-in user is unauthenticated. The edge function re-checks
      // on every request, so this is UI-only.
      setAccess(next ?? lastKnown ?? UNKNOWN);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]); // Refire when the authenticated user changes.

  // Re-read whenever anything calls invalidateCoachAccess(). This is what makes
  // a purchase visible on a screen that is already mounted — the effect above
  // only reruns on an auth change, and AICoachModal never unmounts.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeToCoachAccess(() => {
      void (async () => {
        const next = await fetchCoachAccess(supabaseRef.current, userId);
        if (!cancelled && next) setAccess(next);
      })();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId]);

  const refresh = useCallback(async (): Promise<void> => {
    // Manual invalidation. Used after starting a trial, after a purchase
    // completes, or on pull-to-refresh. Doesn't flip `loading` to true —
    // existing data is fine as a placeholder while the new value lands.
    //
    // Notifies rather than only updating this instance, so a purchase made on
    // /upgrade also refreshes the Coach sheet mounted behind it. Listeners only
    // fetch (they never notify), so there is no feedback loop, and the in-flight
    // dedupe means the extra awaits below share one RPC.
    cachedAccess = null;
    notifyCoachAccessListeners();
    const next = await fetchCoachAccess(supabaseRef.current, userId);
    if (next) setAccess(next);
  }, [userId]);

  return { access, loading, refresh };
}
