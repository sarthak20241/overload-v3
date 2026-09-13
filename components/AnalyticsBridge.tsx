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
import { useEffect, useRef } from 'react';
import { usePathname, useSegments } from 'expo-router';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useSupabaseClient } from '@/lib/supabase';
import { screen, identifyUser, resetAnalytics, setUserProps, analyticsEnabled } from '@/lib/analytics';

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

  const lastScreen = useRef<string | null>(null);
  const identified = useRef<string | null>(null);

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
  }, [isLoaded, isSignedIn, user?.id]);

  // ── Person properties from the profile row ───────────────────────────────
  // Tier, level and goal are what every question gets sliced by ("do paying
  // users log more?"), so they belong on the person, not on each event.
  useEffect(() => {
    if (!analyticsEnabled || !supabase || !isSignedIn || !user?.id) return;
    let cancelled = false;
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
  }, [supabase, isSignedIn, user?.id]);

  return null;
}
