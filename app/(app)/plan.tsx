/**
 * Plan screen — what your subscription is, and what it has actually done for
 * you. Reached from the Profile plan card.
 *
 * Deliberately NOT a jump out to the App Store. Someone who just paid wants to
 * know what they got; cancelling is the last question they have, not the first,
 * so the store link is the quietest thing on the page. It was a bottom sheet
 * first, and a full page won because the content is a read, not a decision:
 * there is nothing to confirm or dismiss.
 *
 * A guest or a free user has no plan to describe, so both are bounced to
 * /upgrade — the paywall already is the detail view for them.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { useSupabaseClient } from '@/lib/supabase';
import { useCoachAccess } from '@/hooks/useCoachAccess';
import { isLifetimeTier, isStorePurchase, PLAN_BENEFITS, tierLabel } from '@/lib/tiers';

export default function PlanScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const { user, isLoaded: clerkLoaded } = useClerkUser();
  const isGuestSession = useIsGuestSession();
  const supabase = useSupabaseClient();
  const { access, loading: accessLoading, refresh: refreshAccess } = useCoachAccess();

  const [tierStartedAt, setTierStartedAt] = useState<string | null>(null);
  const [proWorkouts, setProWorkouts] = useState<number | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);

  const isPro = access.state === 'paid';
  const isTrialing = access.state === 'trialing';
  const hasSubscription = isPro || isTrialing;
  const isLifetime = isLifetimeTier(access.tier);
  // 'unknown' is "we could not find out", NOT "you have no plan". useCoachAccess
  // clears its loading flag even when the RPC failed and there was no cached
  // value to fall back on, so treating unknown as a non-subscriber would send a
  // paying user to the paywall on any network hiccup — the exact bug this
  // screen claims to guard against.
  const accessResolved = access.state !== 'unknown';

  // Only redirect a CONFIRMED non-subscriber, and only once Clerk and the
  // access RPC have both settled.
  useEffect(() => {
    if (!clerkLoaded || accessLoading || !accessResolved) return;
    if (isGuestSession || !hasSubscription) router.replace('/upgrade' as any);
  }, [clerkLoaded, accessLoading, accessResolved, isGuestSession, hasSubscription, router]);

  // Two numbers the access RPC does not carry: when this tier began, and how
  // much training has happened since. One round trip, on mount.
  useEffect(() => {
    const clerkId = user?.id;
    // Skip for anyone about to be bounced to /upgrade — they never see the page.
    if (!clerkId || isGuestSession || (accessResolved && !hasSubscription)) {
      setLoadingStats(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('tier_started_at')
          .eq('clerk_user_id', clerkId)
          .maybeSingle();
        const startedAt = (profile?.tier_started_at as string | null) ?? null;
        if (cancelled) return;
        setTierStartedAt(startedAt);

        if (startedAt) {
          const { count, error } = await supabase
            .from('workouts')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', clerkId)
            .gte('started_at', startedAt);
          if (!cancelled && !error) setProWorkouts(count ?? 0);
        }
      } catch {
        // Offline. Rows we have no number for are simply not rendered, rather
        // than showing a zero that reads as "you have done nothing".
      } finally {
        if (!cancelled) setLoadingStats(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, isGuestSession, accessResolved, hasSubscription, supabase]);

  // The access RPC only carries `tier` on the 'paid' state, never on
  // 'trialing' (see hooks/useCoachAccess.ts), so tierLabel(undefined) would put
  // the placeholder "Active" in the hero of a trialing user.
  const planLabel = isTrialing ? 'Free trial' : tierLabel(access.tier);
  // days_left is extract(epoch ...) / 86400 in the RPC, so a float: 6.83 would
  // otherwise render verbatim.
  const trialDaysLeft = access.daysLeft != null ? Math.max(0, Math.ceil(access.daysLeft)) : null;
  // A trial is NOT a store subscription, despite the obvious guess. Migration
  // 0088 is explicit: state 'trialing' is only ever a LEGACY no-card server
  // trial (coach_trials, via the deprecated start_coach_trial RPC),
  // grandfathered until it expires and then dropping to 'free'. A card-upfront
  // App Store intro trial sets user_profiles.tier on INITIAL_PURCHASE and
  // arrives here as 'paid'. So a trialing user has no card on file, will not be
  // charged, and a store link would open a page with nothing of theirs on it.
  const canManageInStore = isStorePurchase(access.tier);
  const renewsOn = access.expiresAt
    ? new Date(access.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const proDays = tierStartedAt
    ? Math.max(1, Math.floor((Date.now() - new Date(tierStartedAt).getTime()) / 86_400_000))
    : null;
  const startedOn = tierStartedAt
    ? new Date(tierStartedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  // This screen is a hidden sibling TAB of profile and index, so router.back()
  // pops tab history and lands wherever you were before Profile — the
  // dashboard, in practice. Both exits are therefore explicit: the chevron
  // returns to Profile, which is the only way in, and the primary button sends
  // you back to the dashboard to train.
  const backToProfile = useCallback(() => {
    router.replace('/(app)/profile');
  }, [router]);
  const backToTraining = useCallback(() => {
    router.replace('/(app)');
  }, [router]);

  // Only ever the store's SUBSCRIPTION management page, which is the one
  // documented universal link. Founding Lifetime is a non-consumable: it never
  // appears there and has nothing to renew or cancel, so it gets a statement
  // instead of a link.
  const openManageSubscription = useCallback(() => {
    Linking.openURL(
      Platform.OS === 'android'
        ? 'https://play.google.com/store/account/subscriptions'
        : 'https://apps.apple.com/account/subscriptions',
    ).catch(() => {});
  }, []);

  // Hold the frame while we decide whether this user belongs here, so the page
  // never flashes plan copy at someone about to be sent to the paywall.
  if (!clerkLoaded || accessLoading || (accessResolved && !hasSubscription)) {
    return (
      <SafeAreaView style={[s.safe, { backgroundColor: C.background }]} edges={['top']}>
        <View style={s.centerFill}>
          <ActivityIndicator color={C.foreground} />
        </View>
      </SafeAreaView>
    );
  }

  // The lookup failed and there was nothing cached. Say so and offer a way out,
  // rather than spinning forever or guessing that they have no plan.
  if (!accessResolved) {
    return (
      <SafeAreaView style={[s.safe, { backgroundColor: C.background }]} edges={['top']}>
        <View style={s.centerFill}>
          <Feather name="cloud-off" size={28} color={C.textMuted} />
          <Text style={[s.errorTitle, { color: C.foreground }]}>Couldn't load your plan</Text>
          <Text style={[s.errorBody, { color: C.textMuted }]}>
            Your subscription is unaffected. Check your connection and try again.
          </Text>
          <TouchableOpacity
            onPress={() => { void refreshAccess(); }}
            activeOpacity={0.85}
            style={[s.primaryBtn, { alignSelf: 'stretch', marginTop: Spacing.xl }]}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={s.primaryBtnText}>Try again</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={backToProfile}
            activeOpacity={0.7}
            style={s.storeLink}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Text style={[s.storeText, { color: C.textMuted }]}>Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: C.background }]} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity
          onPress={backToProfile}
          style={[s.backBtn, { backgroundColor: C.muted, borderColor: C.border }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={18} color={C.foreground} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: C.foreground }]}>Your plan</Text>
          <Text style={[s.subtitle, { color: C.mutedFg }]}>
            {isTrialing ? 'Overload Pro trial' : 'Overload Pro'}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {/* Hero: the billing truth, stated plainly and first. */}
        <Animated.View
          entering={FadeInDown.duration(350)}
          style={[s.hero, { backgroundColor: C.card, borderColor: C.primaryBorder }]}
        >
          <View style={s.heroTop}>
            <Text style={[s.heroPlan, { color: C.foreground }]}>{planLabel}</Text>
            {isPro && (
              <View style={s.proChip}>
                <Text style={s.proChipText}>PRO</Text>
              </View>
            )}
          </View>
          <Text style={[s.heroBilling, { color: C.textMuted }]}>
            {isLifetime
              ? 'Yours forever. One payment, no renewals.'
              : isTrialing
                ? trialDaysLeft != null
                  ? `${trialDaysLeft} ${trialDaysLeft === 1 ? 'day' : 'days'} left, then the free plan`
                  : 'Ends soon, then the free plan'
                : renewsOn
                  ? `Renews ${renewsOn}`
                  : 'Active'}
          </Text>
          {startedOn && (
            <Text style={[s.heroSince, { color: C.textDim }]}>
              {isLifetime ? 'Founding member since' : 'Started'} {startedOn}
            </Text>
          )}
        </Animated.View>

        {/* What the plan has actually done. Rows with no real number are left
            out rather than rendering a zero. */}
        <Label C={C}>YOUR PLAN SO FAR</Label>
        <Animated.View
          entering={FadeInDown.delay(80).duration(350)}
          style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
        >
          {loadingStats && proDays === null ? (
            <View style={s.statLoading}>
              <ActivityIndicator size="small" color={C.textMuted} />
            </View>
          ) : (
            <>
              {proDays !== null && (
                <Row C={C} label={isLifetime ? 'Founding member for' : 'On this plan for'}>
                  {proDays} {proDays === 1 ? 'day' : 'days'}
                </Row>
              )}
              {proWorkouts !== null && (
                <Row C={C} label="Workouts logged since">{String(proWorkouts)}</Row>
              )}
              <Row C={C} label="Coach messages today">
                {`${access.messagesToday ?? 0} of unlimited`}
              </Row>
              <Row C={C} label="AI food logs today" last>
                {`${access.parsesToday ?? 0} of unlimited`}
              </Row>
            </>
          )}
        </Animated.View>

        <Label C={C}>WHAT YOU GET</Label>
        <Animated.View
          entering={FadeInDown.delay(160).duration(350)}
          style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
        >
          {PLAN_BENEFITS.map((line, i) => (
            <View
              key={line}
              style={[s.benefitRow, i > 0 && { borderTopWidth: 1, borderTopColor: C.borderSubtle }]}
            >
              <View style={[s.benefitIcon, { backgroundColor: C.primaryMuted }]}>
                <Feather name="check" size={11} color={C.accentText} />
              </View>
              <Text style={[s.benefitText, { color: C.foreground }]}>{line}</Text>
            </View>
          ))}
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(240).duration(350)}>
          <TouchableOpacity
            onPress={backToTraining}
            activeOpacity={0.85}
            style={s.primaryBtn}
            accessibilityRole="button"
            accessibilityLabel="Back to training"
          >
            <Text style={s.primaryBtnText}>Back to training</Text>
          </TouchableOpacity>

          {/* Only offer the store when the store can actually manage the plan.
              See isStorePurchase: lifetime tiers have nothing to renew, AppSumo
              was redeemed with a code, and a legacy trial has no card at all. */}
          {!canManageInStore ? (
            <Text style={[s.storeText, { color: C.textMuted, textAlign: 'center', paddingTop: 14 }]}>
              {isLifetime
                ? 'One-time purchase. Nothing to renew or cancel.'
                : isTrialing
                  ? 'No card on file. Nothing will be charged.'
                  : 'Nothing to manage here.'}
            </Text>
          ) : (
            <TouchableOpacity
              onPress={openManageSubscription}
              activeOpacity={0.7}
              style={s.storeLink}
              accessibilityRole="button"
              accessibilityLabel="Manage subscription in the store"
            >
              <Text style={[s.storeText, { color: C.textMuted }]}>
                {Platform.OS === 'android' ? 'Manage or cancel in Play' : 'Manage or cancel in the App Store'}
              </Text>
              <Feather name="external-link" size={11} color={C.textMuted} />
            </TouchableOpacity>
          )}
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────────────
function Label({ C, children }: { C: any; children: React.ReactNode }) {
  return <Text style={[s.label, { color: C.textDim }]}>{children}</Text>;
}

function Row({
  C, label, children, last = false,
}: { C: any; label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <View style={[s.row, !last && { borderBottomWidth: 1, borderBottomColor: C.borderSubtle }]}>
      <Text style={[s.rowLabel, { color: C.textMuted }]}>{label}</Text>
      <Text style={[s.rowValue, { color: C.foreground }]}>{children}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1 },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: Spacing.md,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  subtitle: { fontSize: FontSize.xs, marginTop: 1 },
  // 120, matching profile.tsx and exercises.tsx. BottomNav in (app)/_layout
  // is absolutely positioned at 64 + insets.bottom (~98pt with a home
  // indicator) and this route is not in hideWorkoutChrome, so a smaller pad
  // puts the primary button and the store link behind the nav bar.
  scroll: { paddingHorizontal: Spacing.xl, paddingBottom: 120 },

  hero: {
    borderRadius: Radius.lg, borderWidth: 1,
    paddingHorizontal: Spacing.lg, paddingVertical: 14,
    marginBottom: Spacing.xl,
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heroPlan: { flex: 1, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  proChip: {
    backgroundColor: Colors.primary, borderRadius: Radius.full,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  proChipText: {
    fontSize: 9, fontWeight: FontWeight.bold, letterSpacing: 0.8,
    color: Colors.primaryFg,
  },
  heroBilling: { fontSize: FontSize.md, fontWeight: FontWeight.semibold, marginTop: 4 },
  heroSince: { fontSize: FontSize.xs, marginTop: 3 },

  label: {
    fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1.5,
    marginBottom: 8,
  },
  card: {
    borderRadius: Radius.lg, borderWidth: 1, overflow: 'hidden',
    marginBottom: Spacing.xl,
  },
  statLoading: { paddingVertical: 26, alignItems: 'center' },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 11, gap: 10,
  },
  rowLabel: { flex: 1, fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  rowValue: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  benefitRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 11,
  },
  benefitIcon: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  benefitText: { flex: 1, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },

  primaryBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.full,
    height: 50, alignItems: 'center', justifyContent: 'center',
  },
  primaryBtnText: {
    fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primaryFg,
  },
  storeLink: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, paddingTop: 14,
  },
  storeText: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },

  errorTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold,
    marginTop: Spacing.lg, textAlign: 'center',
  },
  errorBody: {
    fontSize: FontSize.xs, lineHeight: 18,
    marginTop: 6, textAlign: 'center', paddingHorizontal: Spacing.xl,
  },
});
