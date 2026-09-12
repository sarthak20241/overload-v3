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

/**
 * What Pro gives you. Deliberately shorter and blunter than the paywall's
 * comparison table (app/upgrade.tsx COMPARE_CORE): that table sells by contrast
 * against a free column and needs four rows to do it, while this page is read
 * by someone who has already paid and only wants confirmation. Nothing enforces
 * parity between the two lists, so if the offer changes, both need editing.
 */
const PLAN_BENEFITS = [
  'Unlimited coach chat',
  'Unlimited AI food logs',
  'Personalized plans, rewritten every week',
];

export default function PlanScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const { user, isLoaded: clerkLoaded } = useClerkUser();
  const isGuestSession = useIsGuestSession();
  const supabase = useSupabaseClient();
  const { access, loading: accessLoading } = useCoachAccess();

  const [tierStartedAt, setTierStartedAt] = useState<string | null>(null);
  const [proWorkouts, setProWorkouts] = useState<number | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);

  const isPro = access.state === 'paid';
  const isTrialing = access.state === 'trialing';
  const hasSubscription = isPro || isTrialing;
  const isLifetime = access.tier === 'founding_lifetime';

  // Nobody without a plan should be standing here. Wait for both Clerk and the
  // access RPC to settle first, or a paying user on a cold start gets bounced
  // to the paywall they already converted on.
  useEffect(() => {
    if (!clerkLoaded || accessLoading) return;
    if (isGuestSession || !hasSubscription) router.replace('/upgrade' as any);
  }, [clerkLoaded, accessLoading, isGuestSession, hasSubscription, router]);

  // Two numbers the access RPC does not carry: when this tier began, and how
  // much training has happened since. One round trip, on mount.
  useEffect(() => {
    const clerkId = user?.id;
    if (!clerkId || isGuestSession) {
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
  }, [user?.id, isGuestSession, supabase]);

  const planLabel = (() => {
    switch (access.tier) {
      case 'monthly': return 'Monthly';
      case 'annual': return 'Annual';
      case 'founding_annual': return 'Founding Annual';
      case 'founding_lifetime': return 'Founding Lifetime';
      default: return 'Active';
    }
  })();
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
  if (!clerkLoaded || accessLoading || !hasSubscription) {
    return (
      <SafeAreaView style={[s.safe, { backgroundColor: C.background }]} edges={['top']}>
        <View style={s.centerFill}>
          <ActivityIndicator color={C.foreground} />
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
                ? `Free trial${access.daysLeft != null ? ` · ${access.daysLeft} days left` : ''}`
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

          {isLifetime ? (
            <Text style={[s.storeText, { color: C.textMuted, textAlign: 'center', paddingTop: 14 }]}>
              One-time purchase. Nothing to renew or cancel.
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
});
