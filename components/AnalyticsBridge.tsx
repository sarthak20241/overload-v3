/**
 * Feeds PostHog the two things it can't work out on its own: which screen the
 * user is on, and who the user is.
 *
 * Renders nothing. Mount once inside the navigator (so expo-router's hooks are
 * available) and inside ClerkProvider.
 *
 * Screen views are manual on purpose: expo-router does not hand PostHog a
 * NavigationContainer, so `autocapture.captureScreens` can't see route
 * changes. We report the route PATTERN (`workout/[id]`), not the resolved path
 * (`workout/7f3c…`), so one screen is one row in the dashboard instead of one
 * row per workout.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { usePathname, useSegments } from 'expo-router';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useSupabaseClient } from '@/lib/supabase';
import { useIsGuestSession } from '@/lib/guestMode';
import { screen, identifyUser, resetAnalytics, setUserProps, registerSuperProps, analyticsEnabled } from '@/lib/analytics';

/** Person props re-read from user_profiles at most this often on foreground. */
const PROFILE_REFRESH_MS = 10 * 60 * 1000;

/** `['(app)', 'index']` -> `app/index`. Groups stay, ids stay as `[id]`. */
function routeName(segments: string[], pathname: string): string {
  if (!segments.length) return pathname || 'unknown';
  return segments.map((s) => s.replace(/^\((.*)\)$/, '$1')).join('/');
}

export function AnalyticsBridge() {
  const segments = useSegments();
  const pathname = usePathname();
  const { user, isSignedIn, isLoaded } = useClerkUser();
  const supabase = useSupabaseClient();

  const isGuestSession = useIsGuestSession();

  const lastScreen = useRef<string | null>(null);
  const identified = useRef<string | null>(null);

  // ── Super property: guest or not ─────────────────────────────────────────
  // Rides on every event, so any insight can split guests from accounts
  // without each call site remembering to send is_guest.
  useEffect(() => {
    if (!analyticsEnabled) return;
    registerSuperProps({ is_guest: isGuestSession });
  }, [isGuestSession]);

  // Bumped on foreground (throttled) so tier, level and streak on the person
  // do not freeze at whatever they were on sign-in.
  const [profileTick, setProfileTick] = useState(0);
  const lastProfileFetch = useRef(0);
  useEffect(() => {
    if (!analyticsEnabled) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      if (Date.now() - lastProfileFetch.current < PROFILE_REFRESH_MS) return;
      setProfileTick((t) => t + 1);
    });
    return () => sub.remove();
  }, []);

  // ── Screen views ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!analyticsEnabled) return;
    const name = routeName(segments as string[], pathname);
    // expo-router re-renders the layout on param changes too; only report a
    // real screen change or the funnel fills with duplicates.
    if (name === lastScreen.current) return;
    lastScreen.current = name;
    screen(name, { path: pathname });
  }, [segments, pathname]);

  // ── Who is this ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!analyticsEnabled || !isLoaded) return;

    if (!isSignedIn || !user?.id) {
      if (identified.current) {
        resetAnalytics();
        identified.current = null;
        // reset() wipes super properties too, and the guest effect above will
        // not re-run unless the flag flips, so put it back here.
        registerSuperProps({ is_guest: isGuestSession });
      }
      return;
    }
    if (identified.current === user.id) return;
    identified.current = user.id;

    identifyUser(user.id, {
      email: user.primaryEmailAddress?.emailAddress ?? undefined,
      name: user.fullName ?? undefined,
      signed_up_at: user.createdAt ? new Date(user.createdAt).toISOString() : undefined,
    });
  }, [isLoaded, isSignedIn, user?.id, isGuestSession]);

  // ── Person properties from the profile row ───────────────────────────────
  // Tier, level and goal are what every question gets sliced by ("do paying
  // users log more?"), so they belong on the person, not on each event.
  useEffect(() => {
    if (!analyticsEnabled || !supabase || !isSignedIn || !user?.id) return;
    let cancelled = false;
    lastProfileFetch.current = Date.now();
    (async () => {
      try {
        const { data } = await supabase
          .from('user_profiles')
          .select('tier, level, xp, streak, goal, experience_level, weekly_target_sessions, gender, daily_calorie_target')
          .eq('clerk_user_id', user.id)
          .maybeSingle();
        if (cancelled || !data) return;
        setUserProps({
          tier: data.tier ?? 'free',
          level: data.level ?? 1,
          xp: data.xp ?? 0,
          streak: data.streak ?? 0,
          goal: data.goal ?? undefined,
          experience_level: data.experience_level ?? undefined,
          weekly_target_sessions: data.weekly_target_sessions ?? undefined,
          gender: data.gender ?? undefined,
          has_nutrition_targets: !!data.daily_calorie_target,
        });
      } catch {
        // A missing profile row is normal mid-onboarding. Never block the app.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, isSignedIn, user?.id, profileTick]);

  return null;
}
