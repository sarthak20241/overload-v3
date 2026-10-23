/**
 * The Overload Pro funnel (.planning/paywall-plan.md, design review artifact
 * "open-reveal"). One route, three internal screens, modeled beat-for-beat on
 * the Cal AI funnel with our adaptations (soft wall, 7-day trial, transparent
 * price headline):
 *
 *   warmup    "Try everything free for 7 days." Gift frame, Drona's voice,
 *             no price anywhere. First "No payment today".
 *   reminder  "I'll remind you before you pay." One screen for the one
 *             objection that kills trials. Continue triggers the OS
 *             notification permission prompt (needed for the day-5 reminder
 *             this screen promises, plus rest cues later).
 *   paywall   The single reusable paywall: transparent price headline,
 *             a path to the goal, annual (preselected, save badge) vs monthly
 *             vs founding lifetime, trust row, refund promise, CTA, delayed
 *             soft-wall skip link. Every trial claim on it (badge, "No
 *             payment today", "Start my N days free") is derived from the
 *             store product's introductory offer via freeTrialDays(), so a
 *             plan only advertises a trial App Store Connect actually gives.
 *   success   Shown once the tier has flipped. "You're in." plus the three
 *             things that just unlocked, then one Continue straight to the
 *             dashboard, where the phase 1 split prompt takes over. A toast
 *             is too small for a payment, and it left the user hunting the
 *             app for proof.
 *             While it's on screen the dashboard cache is warmed so the
 *             landing has real data instead of an empty first frame.
 *
 * Entry modes:
 *   /upgrade?flow=onboarding[&dest=routines]  full 3-screen funnel, shown
 *       once after sign-up when the guest funnel's plan has been saved.
 *       Finishing (purchase or skip) lands on the dashboard (or routines).
 *   /upgrade[?context=cap_chat|cap_parse|milestone]  paywall screen only,
 *       opened from the cap-hit sheet / locked features / milestone card.
 *       Finishing pops back to wherever the user was.
 *
 * Android sells the same three products through Google Play (same RC
 * offerings; Play IDs overload_monthly:monthly, overload_annual:annual,
 * overload_founding_lifetime). Store words come from STORE_NAME/STORE_ACCOUNT.
 *
 * Purchase plumbing mirrors components/ai/Paywall.tsx: RC purchase, then poll
 * get_coach_access_status until the webhook flips the tier. On a successful
 * annual (trial) purchase we schedule the local day-5 reminder notification,
 * which the reminder screen and the timeline explicitly promised.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import {
  Colors,
  FontFamily,
  FontSize,
  FontWeight,
  IconSize,
  LetterSpacing,
  Radius,
  Shadow,
  Spacing,
} from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { track, setUserProps } from '@/lib/analytics';
import { useToast } from '@/components/ui/Toast';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useSupabaseClient } from '@/lib/supabase';
import { PressableScale } from '@/components/ui/PressableScale';
import { DronaMark } from '@/components/coach/DronaMark';
import { invalidateCoachAccess } from '@/hooks/useCoachAccess';
import { prefetchDashboard } from '@/lib/dashboardData';
import {
  requestNotificationPermission,
  scheduleTrialReminder,
} from '@/lib/notifications';
import {
  ensureIdentity,
  getCoachOfferings,
  isPurchasesAvailable,
  purchaseCoachPackage,
  restorePurchases,
  freeTrialDays,
  PurchaseCancelledError,
  PurchasesUnavailableError,
  STORE_ACCOUNT,
  STORE_NAME,
  type PlanKey,
  type RevenueCatPackage,
} from '@/lib/revenuecat';

type FunnelStep = 'warmup' | 'reminder' | 'paywall' | 'success';

/** What the success screen needs to know about the purchase it celebrates. */
interface PurchaseOutcome {
  plan: PlanKey;
  /** The entitlement carries an intro/trial period (annual, first time). */
  onTrial: boolean;
}

// What the paywall says Pro gives. Readiness dropped from Pro (2026-07-29):
// the app never gated it client-side, so advertising it was a bug.
//
// 2026-10-22: the Free/Pro table (FREE + PRO columns, a "See the full
// comparison" expander and SOON rows) read as a wall of text on a real
// Android phone and pushed the headline off screen. Pro is now four short
// lines; each one is something Pro does today.
//
// 2026-10-23: four feature lines still sold features, not the product. Free
// is a sample (3 chats, 3 AI food logs a day); Pro is the coaching that walks
// someone to their goal, so the paywall draws that walk: three steps joined by
// a line, ending at the goal. Every step is something only Pro can run today
// (the server gates program/plan/workout building and refining as Pro).
const PRO_PATH = [
  'A program built for your goal',
  'Drona checks in. Your plan adapts to your routine.',
  'Training and food, coached daily',
];

interface FoundingStatus {
  tier: string;
  cap: number;
  claimed: number;
  closed_at: string | null;
}

/**
 * "₹999.00" → "₹". Currency symbol straight from the store-localized price
 * string, so the derived per-month figure always matches the store currency.
 */
function currencySymbol(priceString: string): string {
  const sym = priceString.replace(/[\d.,\s]/g, '');
  return sym || '';
}

function perMonthLabel(pkg: RevenueCatPackage): string | null {
  const price = pkg.product?.price;
  if (typeof price !== 'number' || price <= 0) return null;
  const sym = currencySymbol(pkg.product.priceString ?? '');
  const v = price / 12;
  return `${sym}${v >= 20 ? String(Math.round(v)) : v.toFixed(2)}`;
}

export default function UpgradeScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const toast = useToast();
  const { user } = useClerkUser();
  const supabase = useSupabaseClient();
  const params = useLocalSearchParams<{ flow?: string; context?: string; dest?: string }>();
  const isFunnel = params.flow === 'onboarding';
  const context = typeof params.context === 'string' ? params.context : null;

  const [step, setStep] = useState<FunnelStep>(isFunnel ? 'warmup' : 'paywall');

  // ── Offerings + founding status (loaded once, shown on the paywall) ──────
  const [loading, setLoading] = useState(true);
  const [packages, setPackages] = useState<Partial<Record<PlanKey, RevenueCatPackage>>>({});
  const [founding, setFounding] = useState<FoundingStatus | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanKey>('annual');
  const [purchasing, setPurchasing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [outcome, setOutcome] = useState<PurchaseOutcome | null>(null);
  // Founding Lifetime is a distracting third option (and its ASC IAP isn't
  // provisioned yet), so it's collapsed behind a link by default. Once
  // expanded, the row inflates in place and the link disappears.
  const [showAllPlans, setShowAllPlans] = useState(false);
  const purchasesUsable = isPurchasesAvailable();

  // Paywall analytics. `context` is what sent them here (a usage cap, the
  // coach gate, the profile card), which is the difference between "the
  // paywall converts badly" and "one entry point converts badly".
  const paywallOpenedAt = useRef(Date.now());
  const paywallResolved = useRef(false);
  useEffect(() => {
    track('paywall_viewed', { source: isFunnel ? 'onboarding_funnel' : 'direct', context, purchases_available: purchasesUsable });
    return () => {
      if (paywallResolved.current) return;
      track('paywall_dismissed', {
        source: isFunnel ? 'onboarding_funnel' : 'direct',
        context,
        seconds_on_screen: Math.round((Date.now() - paywallOpenedAt.current) / 1000),
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one shot per mount
  }, []);

  // Gentle CTA pulse (RC conversion boosters: animated elements typically
  // lift conversion 12-18%). Calm brand = a slow 1.00 → 1.015 breath, not a
  // throb. Runs only while the paywall is idle: paused during purchase /
  // verify (a pulsing disabled button reads as broken) and disabled entirely
  // when the OS reduce-motion setting is on.
  const reduceMotion = useReducedMotion();
  const ctaPulse = useSharedValue(1);
  const pulseActive = step === 'paywall' && !purchasing && !verifying && !loading;
  useEffect(() => {
    if (!pulseActive || reduceMotion) {
      cancelAnimation(ctaPulse);
      ctaPulse.value = withTiming(1, { duration: 150 });
      return;
    }
    ctaPulse.value = withRepeat(
      withSequence(
        withTiming(1.015, { duration: 1100, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
    );
    return () => cancelAnimation(ctaPulse);
  }, [pulseActive, reduceMotion, ctaPulse]);
  const ctaPulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ctaPulse.value }],
  }));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [offerings, foundingResp] = await Promise.all([
          getCoachOfferings(),
          supabase.rpc('get_founding_status'),
        ]);
        if (cancelled) return;
        setPackages(offerings?.byPlan ?? {});
        const rows = (foundingResp.data as FoundingStatus[] | null) ?? [];
        setFounding(rows.find((r) => r.tier === 'founding_lifetime') ?? null);
      } catch (e) {
        if (!cancelled) console.warn('[upgrade] load failed:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // Where "done" goes. The funnel replaces into the app; a direct open pops
  // back to whatever surfaced the paywall.
  const finish = useCallback(() => {
    if (isFunnel) {
      router.replace(params.dest === 'routines' ? '/(app)/routines' : '/(app)');
    } else if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(app)');
    }
  }, [isFunnel, params.dest, router]);

  const waitForTierFlip = useCallback(async (): Promise<boolean> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const { data } = await supabase.rpc('get_coach_access_status');
        if ((data as { state?: string } | null)?.state === 'paid') return true;
      } catch {
        /* network blip, keep polling */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }, [supabase]);

  const handlePurchase = useCallback(async () => {
    const pkg = packages[selectedPlan];
    if (!pkg) {
      toast.error('Plan unavailable. Try again.');
      return;
    }
    if (purchasing || verifying) return;
    setPurchasing(true);
    track('purchase_started', { plan: selectedPlan, context, source: isFunnel ? 'onboarding_funnel' : 'direct' });
    try {
      if (user?.id) await ensureIdentity(user.id);
      const customerInfo = await purchaseCoachPackage(pkg);
      setPurchasing(false);
      setVerifying(true);
      const flipped = await waitForTierFlip();
      invalidateCoachAccess();
      if (flipped) {
        // Honor the reminder screen's promise ONLY when the purchase
        // actually carries a trial. Selecting Annual is not enough — an
        // existing subscriber who upgrades has no intro trial, and
        // scheduling would fire a false "your trial converts in 2 days"
        // notification 5 days later. Check the active entitlement's
        // periodType (INTRO | TRIAL) rather than trusting selectedPlan.
        const active = Object.values(customerInfo?.entitlements?.active ?? {});
        const onTrial = active.some((e) => {
          const t = e?.periodType;
          return t === 'TRIAL' || t === 'INTRO' || t === 'trial' || t === 'intro';
        });
        if (onTrial) {
          void scheduleTrialReminder().then((scheduled) => {
            track('trial_reminder_scheduled', { scheduled, plan: selectedPlan });
          });
        }
        // Warm the dashboard cache while the success screen is up, so the
        // landing paints real data instead of "Level 1 · no workouts".
        void prefetchDashboard(supabase, user?.id);
        paywallResolved.current = true;
        // The bridge only reads user_profiles on sign-in, so stamp the new tier
        // now or every event until the next cold start still says 'free'.
        setUserProps({ tier: selectedPlan, on_trial: onTrial });
        track('purchase_completed', {
          plan: selectedPlan,
          on_trial: onTrial,
          context,
          source: isFunnel ? 'onboarding_funnel' : 'direct',
          seconds_to_purchase: Math.round((Date.now() - paywallOpenedAt.current) / 1000),
        });
        setOutcome({ plan: selectedPlan, onTrial });
        setStep('success');
      } else {
        paywallResolved.current = true;
        track('purchase_completed', { plan: selectedPlan, on_trial: false, context, tier_flip: 'pending' });
        toast.info(
          "Purchase received. We're finalizing. Pull to refresh or relaunch in a minute.",
          { durationMs: 8000 },
        );
        finish();
      }
    } catch (e) {
      if (e instanceof PurchaseCancelledError) {
        /* backed out of the payment sheet, stay put */
        track('purchase_failed', { plan: selectedPlan, reason: 'cancelled', context });
      } else if (e instanceof PurchasesUnavailableError) {
        track('purchase_failed', { plan: selectedPlan, reason: 'unavailable', context });
        toast.error(e.message, { durationMs: 6000 });
      } else {
        console.warn('[upgrade] purchase failed:', e);
        track('purchase_failed', { plan: selectedPlan, reason: 'error', context });
        toast.error('Purchase failed. Try again or contact support.');
      }
    } finally {
      setPurchasing(false);
      setVerifying(false);
    }
  }, [packages, selectedPlan, purchasing, verifying, user?.id, waitForTierFlip, toast, finish, supabase]);

  const handleRestore = useCallback(async () => {
    if (restoring) return;
    setRestoring(true);
    track('purchase_restore_started', { context });
    try {
      const info = await restorePurchases();
      if (!info) {
        track('purchase_restore_failed', { reason: 'unavailable', context });
        toast.info('Purchases unavailable in this build.');
        return;
      }
      const hasActive = Object.values(info.entitlements?.active ?? {}).some((e) => e.isActive);
      if (hasActive) {
        const flipped = await waitForTierFlip();
        invalidateCoachAccess();
        if (flipped) {
          paywallResolved.current = true;
          // The exact tier is not known here (a restore carries no plan), but
          // 'free' is now wrong. The bridge's next profile read sets the name.
          setUserProps({ tier: 'restored', has_active_entitlement: true });
          track('purchase_restored', { context });
          toast.success('Restored. Welcome back.');
          finish();
        } else {
          track('purchase_restore_failed', { reason: 'flip_pending', context });
          toast.info("Restored. We're finalizing. Try again in a minute.");
        }
      } else {
        track('purchase_restore_failed', { reason: 'no_active', context });
        toast.info(`No previous purchases on this ${STORE_ACCOUNT}.`);
      }
    } catch (e) {
      track('purchase_restore_failed', { reason: 'error', context });
      console.warn('[upgrade] restore failed:', e);
      toast.error('Restore failed. Try again later.');
    } finally {
      setRestoring(false);
    }
  }, [restoring, waitForTierFlip, toast, finish]);

  // Success screen. Opened from a cap-hit sheet the user was mid-task
  // (chatting, logging food), so the only sensible next step is back to it.
  // Everywhere else it lands on the dashboard, never finish(): the onboarding
  // funnel's next beat is the phase 1 split prompt, which only the dashboard
  // shows. A coach chat opened on top of it ("plan my week") buried that
  // prompt and asked for a week the split popup builds anyway.
  const fromCap = context === 'cap_chat' || context === 'cap_parse';
  const goToDashboard = useCallback(() => {
    router.replace('/(app)');
  }, [router]);

  const advanceFromReminder = useCallback(async () => {
    // The promise needs the permission. Denial is fine: the screen never
    // claimed the OS can't say no, and Apple emails trial reminders anyway.
    const granted = await requestNotificationPermission();
    track('paywall_step_advanced', { from: 'reminder', to: 'paywall', notifications_granted: granted, context });
    setStep('paywall');
  }, [context]);

  const annual = packages.annual ?? null;
  const monthly = packages.monthly ?? null;
  const lifetime = packages.founding_lifetime ?? null;
  // Trial length per plan, straight from the store (0 = no trial). Lifetime
  // is a non-consumable and can't carry one.
  const trialDays: Record<PlanKey, number> = {
    annual: freeTrialDays(annual),
    monthly: freeTrialDays(monthly),
    founding_lifetime: 0,
  };
  const selectedTrial = trialDays[selectedPlan];
  const trialBadge = (days: number) => (days > 0 ? `${days} DAYS FREE` : undefined);
  const ctaLabel =
    selectedTrial > 0
      ? `Start my ${selectedTrial} days free`
      : selectedPlan === 'annual'
        ? 'Subscribe yearly'
        : selectedPlan === 'monthly'
          ? 'Subscribe monthly'
          : 'Claim founding lifetime';
  const perMonth = annual ? perMonthLabel(annual) : null;
  const savePct =
    annual?.product?.price && monthly?.product?.price
      ? Math.round((1 - annual.product.price / (monthly.product.price * 12)) * 100)
      : null;
  const foundingSoldOut =
    founding !== null && (founding.closed_at !== null || founding.claimed >= founding.cap);
  const foundingLeft = founding ? Math.max(0, founding.cap - founding.claimed) : null;

  // Headline: the core of the app, not a feature (RevenueCat 7-uses
  // framework: "Educate and Frame Value"). Overload is a coach that walks you
  // to your goal, so the default headline says exactly that. Sarthak's
  // phrase: "always by your side". History: v5 was "Never write a training
  // plan again." (a mechanic; the paywall must say what the app IS).
  const paywallTitle =
    context === 'milestone'
      ? 'Your next four weeks, programmed.'
      : context === 'pro_feature'
        ? 'That one is Overload Pro.'
        : context === 'cap_chat' || context === 'cap_parse'
          ? 'A coach who never runs out.'
          : 'Always by your side. All the way to your goal.';
  return (
    <SafeAreaView style={[u.safeArea, { backgroundColor: C.background }]}>
      {step === 'warmup' && (
        <Animated.View key="warmup" entering={FadeIn.duration(250)} style={u.stepFill}>
          <View style={u.centerFill}>
            <Animated.Text
              entering={FadeInDown.duration(400)}
              style={[u.displayTitle, { color: C.foreground, textAlign: 'center' }]}
            >
              Try everything free for 7 days.
            </Animated.Text>
            <Animated.View entering={FadeInDown.delay(150).duration(400)} style={u.quoteWrap}>
              <DronaMark size={56} state="idle" />
              <View style={[u.quoteBubble, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
                <Text style={[u.quoteText, { color: C.foreground }]}>
                  I don't do generic plans. Give me a week of your training and
                  judge me on the results.
                </Text>
              </View>
            </Animated.View>
          </View>
          <Animated.View entering={FadeInDown.delay(300).duration(400)} style={u.footer}>
            <NoPaymentRow color={C.foreground} />
            <PressableScale
              onPress={() => { track('paywall_step_advanced', { from: 'warmup', to: 'reminder', context }); setStep('reminder'); }}
              style={[u.cta, Shadow.playBtn]}
              accessibilityRole="button"
              accessibilityLabel="Try it free"
            >
              <Text style={u.ctaText}>Try it free</Text>
            </PressableScale>
            <Text style={[u.ctaNote, { color: C.textMuted }]}>
              Billing starts only after your 7-day trial, unless you cancel.
            </Text>
          </Animated.View>
        </Animated.View>
      )}

      {step === 'reminder' && (
        <Animated.View key="reminder" entering={FadeIn.duration(250)} style={u.stepFill}>
          <View style={u.topBar}>
            <TouchableOpacity
              onPress={() => setStep('warmup')}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="chevron-left" size={IconSize.lg} color={C.textMuted} />
            </TouchableOpacity>
            <View style={{ width: IconSize.lg }} />
          </View>
          <View style={u.centerFill}>
            <Animated.Text
              entering={FadeInDown.duration(400)}
              style={[u.displayTitle, { color: C.foreground, textAlign: 'center' }]}
            >
              I'll remind you before you pay.
            </Animated.Text>
            <Animated.Text
              entering={FadeInDown.delay(120).duration(400)}
              style={[u.subText, { color: C.textSecondary, textAlign: 'center' }]}
            >
              A notification on day 5, two days before your trial ends. Keep
              notifications on and you'll never be surprised.
            </Animated.Text>
            <Animated.View entering={FadeInDown.delay(240).duration(400)} style={u.bellWrap}>
              <View style={[u.bellCircle, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
                <Feather name="bell" size={40} color={C.textMuted} />
              </View>
              <View style={u.bellBadge}>
                <Text style={u.bellBadgeText}>1</Text>
              </View>
            </Animated.View>
          </View>
          <Animated.View entering={FadeInDown.delay(320).duration(400)} style={u.footer}>
            <NoPaymentRow color={C.foreground} />
            <PressableScale
              onPress={advanceFromReminder}
              style={[u.cta, Shadow.playBtn]}
              accessibilityRole="button"
              accessibilityLabel="Continue for free"
            >
              <Text style={u.ctaText}>Continue for free</Text>
            </PressableScale>
          </Animated.View>
        </Animated.View>
      )}

      {step === 'paywall' && (
        <Animated.View key="paywall" entering={FadeIn.duration(250)} style={u.stepFill}>
          {/*
            Compact single-viewport paywall (redesign 2026-07-28, sim review):
            the original layout ran to ~1100 pt of content (headline + full
            benefit rows + timeline card + three plan cards + footer) so the
            CTA sat below the fold. Scroll on a paywall = "still deciding" =
            drop-out; a converting paywall shows the entire decision in one
            viewport. Restructure below:
              - hero: eyebrow + one-line headline + one-line sub
              - horizontal 3-dot timeline (killed the vertical card)
              - benefits collapsed to two tight lines (was 4 rows of 24pt tiles)
              - only annual + monthly rendered inline; founding hidden behind a
                small "See all plans" toggle to declutter (the Founding
                non-consumable now exists in both App Store Connect and Play)
              - sticky footer with the CTA + trust check + delayed skip link
          */}
          {/* One way out: a quiet close in the corner (2026-10-23, replaces the
              back chevron AND the "Not now, I'll train on the free plan" link,
              which cluttered the footer). It always leaves for the free plan,
              funnel included, so it is the skip. Restore lives under the CTA. */}
          <View style={[u.topBar, { justifyContent: 'flex-end' }]}>
            <TouchableOpacity
              onPress={() => {
                track('paywall_skipped', { via: 'close', context, seconds_on_screen: Math.round((Date.now() - paywallOpenedAt.current) / 1000) });
                finish();
              }}
              accessibilityRole="button"
              accessibilityLabel="Close, continue on the free plan"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              // Leaving mid-purchase would drop the "Activating Pro" wait.
              disabled={purchasing || verifying}
              style={[u.closeBtn, { backgroundColor: C.card }, (purchasing || verifying) && { opacity: 0.4 }]}
            >
              <Feather name="x" size={IconSize.md} color={C.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Sized to fit one viewport on modern phones (verified iPhone 17);
              the ScrollView is a safety net for SE-class heights where the
              plans would otherwise clip unreachably. bounces=false keeps it
              feeling like a fixed screen when nothing overflows. */}
          <ScrollView
            style={u.paywallBody}
            contentContainerStyle={u.paywallBodyContent}
            showsVerticalScrollIndicator={false}
            bounces={false}
            alwaysBounceVertical={false}
          >
            <Text style={[u.eyebrow, { color: C.accentText }]}>OVERLOAD PRO</Text>
            <Text style={[u.hero, { color: C.foreground }]}>{paywallTitle}</Text>
            <Text style={[u.heroSub, { color: C.textSecondary }]}>
              Free is a taste of Drona. Pro is the coaching.
            </Text>

            {/* What Pro gives, as a path: three steps, then the goal. Free
                users already know the free side (they hit its caps). */}
            <View style={u.points}>
              {PRO_PATH.map((step) => (
                <View key={step} style={u.pathRow}>
                  <View style={u.pathRail}>
                    <View style={[u.pathDot, { borderColor: C.accentText }]} />
                    <View style={[u.pathLine, { backgroundColor: C.borderSubtle }]} />
                  </View>
                  <Text style={[u.pointText, { color: C.foreground }]}>{step}</Text>
                </View>
              ))}
              <View style={u.pathRow}>
                <View style={u.pathRail}>
                  <Feather name="flag" size={IconSize.sm} color={C.accentText} />
                </View>
                <Text style={[u.pathGoal, { color: C.accentText }]}>Your goal</Text>
              </View>
            </View>
            <Text style={[u.pathPlus, { color: C.textMuted }]}>
              Plus unlimited coach chat and AI food logs.
            </Text>

            {loading ? (
              <View style={u.spinnerWrap}>
                <ActivityIndicator color={C.foreground} />
              </View>
            ) : (
              <View style={u.plans}>
                {annual && (
                  <Animated.View entering={FadeInDown.delay(80).duration(350)}>
                    <PlanRow
                      selected={selectedPlan === 'annual'}
                      highlight
                      badge={trialBadge(trialDays.annual)}
                      name="Annual"
                      saveTag={savePct && savePct > 0 ? `SAVE ${savePct}%` : undefined}
                      price={annual.product.priceString}
                      priceUnit="/yr"
                      note={perMonth ? `${perMonth}/mo, billed yearly` : 'Billed yearly'}
                      onPress={() => { track('paywall_plan_selected', { plan: 'annual', previous_plan: selectedPlan }); setSelectedPlan('annual'); }}
                    />
                  </Animated.View>
                )}
                {monthly && (
                  <Animated.View entering={FadeInDown.delay(180).duration(350)}>
                    <PlanRow
                      selected={selectedPlan === 'monthly'}
                      name="Monthly"
                      badge={trialBadge(trialDays.monthly)}
                      price={monthly.product.priceString}
                      priceUnit="/mo"
                      note={trialDays.monthly > 0 ? 'Then billed monthly' : 'Billed monthly · no trial'}
                      onPress={() => { track('paywall_plan_selected', { plan: 'monthly', previous_plan: selectedPlan }); setSelectedPlan('monthly'); }}
                    />
                  </Animated.View>
                )}
                {showAllPlans && lifetime && lifetime.product?.priceString && !foundingSoldOut && (
                  <PlanRow
                    selected={selectedPlan === 'founding_lifetime'}
                    name="Founding Lifetime"
                    price={lifetime.product.priceString}
                    priceUnit=" once"
                    note={
                      foundingLeft !== null && founding
                        ? `${foundingLeft} of ${founding.cap} spots left · never comes back`
                        : 'One-time · Drona forever'
                    }
                    onPress={() => { track('paywall_plan_selected', { plan: 'founding_lifetime', previous_plan: selectedPlan }); setSelectedPlan('founding_lifetime'); }}
                  />
                )}
                {lifetime && lifetime.product?.priceString && !foundingSoldOut && !showAllPlans && (
                  <TouchableOpacity
                    onPress={() => { track('paywall_plans_expanded'); setShowAllPlans(true); }}
                    accessibilityRole="button"
                    accessibilityLabel="See all plans"
                  >
                    <Text style={[u.morePlans, { color: C.textMuted }]}>
                      See Founding Lifetime
                      {foundingLeft !== null && founding ? ` · ${foundingLeft}/${founding.cap} left` : ''}
                    </Text>
                  </TouchableOpacity>
                )}
                {!purchasesUsable && (
                  <Text style={[u.expoGoText, { color: C.mutedFg }]}>
                    In-app purchases need the {STORE_NAME} version of Overload.
                  </Text>
                )}
              </View>
            )}
          </ScrollView>

          <View style={u.paywallFooter}>
            <Animated.View style={ctaPulseStyle}>
              <PressableScale
                onPress={handlePurchase}
                disabled={purchasing || verifying || loading}
                style={[u.cta, Shadow.playBtn, loading && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityLabel={ctaLabel}
              >
                {/* Two waits, two honest labels. Apple's sheet + its own
                    "You're all set" alert can take ~8s to resolve, then the
                    webhook needs a couple more to flip the tier. A silent
                    spinner for 10s read as broken; a re-enabled button with
                    a caption underneath read as "tap again". */}
                {purchasing ? (
                  <>
                    <ActivityIndicator size="small" color={Colors.primaryFg} />
                    <Text style={u.ctaText}>Confirming with {STORE_NAME}…</Text>
                  </>
                ) : verifying ? (
                  <>
                    <ActivityIndicator size="small" color={Colors.primaryFg} />
                    <Text style={u.ctaText}>Activating Pro…</Text>
                  </>
                ) : (
                  <Text style={u.ctaText}>{ctaLabel}</Text>
                )}
              </PressableScale>
            </Animated.View>
            {/* One quiet trust line under the CTA (RC "Build Trust" + Bloom's
                refund transparency). Three facts, no icons: the billing
                truth, the exit path, the refund promise. It MUST track the
                selected plan AND the store: "No payment today" only when the
                selected product carries a free trial, otherwise it is a lie
                (and an App Review rejection waiting to happen). The refund is
                a promise Sarthak makes, not Apple: money moves through
                Apple's refund flow, we just never argue. History: v6 had two
                chip rows + a refund row above the CTA and read cluttered. */}
            {/* 2026-10-23: the goal promise replaces "Cancel anytime · 14-day
                refund". Overload exists to get people to their goal, so the
                refund is tied to it. The rule (ask within 30 days after the
                program ends) is in the Terms; the line stays short. The first
                fact still tracks plan + trial so it is never a lie. */}
            <Text style={[u.trustLine, { color: C.textMuted }]}>
              {selectedTrial > 0
                ? 'No payment today'
                : selectedPlan === 'founding_lifetime'
                  ? 'One payment, no renewals'
                  : 'First charge today'}
              {'   ·   '}
              <Text style={{ color: C.foreground }}>Didn't reach your goal? Full refund.</Text>
            </Text>
            {/* Restore, Terms, Privacy as one quiet row under the CTA, the way
                most store paywalls do it. The renewal terms live on the plan
                cards ("billed yearly", "Then billed monthly") and the store's
                own sheet, so no separate auto-renew sentence. */}
            <View style={u.footLinks}>
              <TouchableOpacity
                onPress={handleRestore}
                disabled={restoring}
                accessibilityRole="button"
                accessibilityLabel="Restore purchases"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                {restoring ? (
                  <ActivityIndicator size="small" color={C.textMuted} />
                ) : (
                  <Text style={[u.footLink, { color: C.textMuted }]}>Restore</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => Linking.openURL('https://tryoverload.app/terms.html')}
                accessibilityRole="link"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[u.footLink, { color: C.textMuted }]}>Terms</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => Linking.openURL('https://tryoverload.app/privacy.html')}
                accessibilityRole="link"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[u.footLink, { color: C.textMuted }]}>Privacy</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      )}

      {step === 'success' && (
        <Animated.View key="success" entering={FadeIn.duration(250)} style={u.stepFill}>
          <View style={u.centerFill}>
            <Animated.View entering={FadeInDown.duration(400)} style={u.successMark}>
              <DronaMark size={56} state="idle" />
            </Animated.View>
            <Animated.Text
              entering={FadeInDown.delay(100).duration(400)}
              style={[u.displayTitle, { color: C.foreground, textAlign: 'center' }]}
            >
              You're in.
            </Animated.Text>
            <Animated.Text
              entering={FadeInDown.delay(200).duration(400)}
              style={[u.subText, { color: C.textSecondary, textAlign: 'center' }]}
            >
              {outcome?.plan === 'founding_lifetime'
                ? "Founding member. Overload Pro is yours for good, and I'm yours to keep."
                : outcome?.onTrial
                  ? "Your 7 days start now. I'll remind you on day 5, before anything is charged."
                  : "Overload Pro is active. Give me a week of your training and judge me on the results."}
            </Animated.Text>
            <Animated.View
              entering={FadeInDown.delay(320).duration(400)}
              style={[u.unlockCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
            >
              {[
                'Unlimited coach chat',
                'Unlimited AI food logs',
                'A plan built for you, rewritten every week',
              ].map((line, i) => (
                <View
                  key={line}
                  style={[u.unlockRow, i > 0 && { borderTopWidth: 1, borderTopColor: C.borderSubtle }]}
                >
                  <View style={[u.unlockIcon, { backgroundColor: C.primaryMuted }]}>
                    <Feather name="check" size={11} color={C.accentText} />
                  </View>
                  <Text style={[u.unlockText, { color: C.foreground }]}>{line}</Text>
                </View>
              ))}
            </Animated.View>
          </View>
          <Animated.View entering={FadeInDown.delay(440).duration(400)} style={u.footer}>
            <PressableScale
              onPress={() => { track('paywall_success_cta', { destination: fromCap ? 'back' : 'dashboard' }); (fromCap ? finish : goToDashboard)(); }}
              style={[u.cta, Shadow.playBtn]}
              accessibilityRole="button"
              accessibilityLabel="Continue"
            >
              <Text style={u.ctaText}>Continue</Text>
            </PressableScale>
          </Animated.View>
        </Animated.View>
      )}
    </SafeAreaView>
  );
}

function NoPaymentRow({ color }: { color: string }) {
  return (
    <View style={u.noPayRow}>
      <Feather name="check" size={IconSize.sm} color={color} />
      <Text style={[u.noPayText, { color }]}>No payment today</Text>
    </View>
  );
}

/**
 * Compact plan row. The highlighted (annual) variant has more visual weight
 * (bg tint + border + badge), the rest read as light options — visual
 * hierarchy matches the intended default choice. Radios on the left for a
 * fast scan, price on the right in tabular figures.
 */
function PlanRow({
  selected,
  highlight = false,
  badge,
  name,
  saveTag,
  price,
  priceUnit,
  note,
  onPress,
}: {
  selected: boolean;
  highlight?: boolean;
  badge?: string;
  name: string;
  saveTag?: string;
  price: string;
  priceUnit: string;
  note?: string;
  onPress: () => void;
}) {
  const { C } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      style={[
        u.planRow,
        {
          backgroundColor: highlight ? C.primarySubtle : C.card,
          borderColor: selected ? C.accentText : C.borderSubtle,
          borderWidth: selected ? 2 : 1,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ selected }}
    >
      {badge && (
        <View style={u.planBadge}>
          <Text style={u.planBadgeText}>{badge}</Text>
        </View>
      )}
      <View
        style={[
          u.planRadio,
          selected
            ? { backgroundColor: C.accentText, borderColor: C.accentText }
            : { borderColor: C.border },
        ]}
      >
        {selected && <View style={[u.planRadioDot, { backgroundColor: C.background }]} />}
      </View>
      <View style={u.planText}>
        <View style={u.planNameRow}>
          <Text style={[u.planName, { color: C.foreground }]}>{name}</Text>
          {saveTag && (
            <View style={[u.saveTag, { backgroundColor: Colors.primaryFg }]}>
              <Text style={[u.saveTagText, { color: Colors.primary }]}>{saveTag}</Text>
            </View>
          )}
        </View>
        {note && <Text style={[u.planNote, { color: C.textMuted }]}>{note}</Text>}
      </View>
      <View style={u.planPriceCol}>
        <Text style={[u.planPrice, { color: C.foreground }]}>{price}</Text>
        <Text style={[u.planPriceUnit, { color: C.textMuted }]}>{priceUnit}</Text>
      </View>
    </PressableScale>
  );
}

const u = StyleSheet.create({
  safeArea: { flex: 1 },
  stepFill: { flex: 1 },
  centerFill: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.xxl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xxl,
  },

  displayTitle: {
    fontFamily: FontFamily.display,
    fontSize: 32,
    letterSpacing: LetterSpacing.tight,
    lineHeight: 38,
  },
  subText: {
    fontSize: FontSize.base,
    lineHeight: 21,
    marginTop: Spacing.md,
  },
  eyebrow: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    marginBottom: Spacing.sm,
  },

  quoteWrap: { alignItems: 'center', marginTop: Spacing.xxxl, gap: Spacing.lg },
  quoteBubble: {
    borderWidth: 1,
    borderRadius: Radius.xl,
    borderBottomLeftRadius: Radius.sm,
    padding: Spacing.lg,
    maxWidth: 300,
  },
  quoteText: { fontSize: FontSize.base, lineHeight: 21 },

  bellWrap: { alignSelf: 'center', marginTop: Spacing.xxxl },
  bellCircle: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadge: {
    position: 'absolute',
    top: -2,
    right: -6,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadgeText: { color: '#fff', fontSize: FontSize.lg, fontWeight: FontWeight.bold },

  benefits: { marginTop: Spacing.xl, gap: Spacing.md },
  benefitRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  benefitIcon: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  benefitText: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.medium, lineHeight: 19 },

  timeline: {
    borderWidth: 1,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    marginTop: Spacing.xl,
  },
  tlRow: { flexDirection: 'row', gap: Spacing.md, paddingBottom: Spacing.lg },
  tlRail: { alignItems: 'center', width: 12 },
  tlDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, marginTop: 3 },
  tlLine: { flex: 1, width: 2, marginTop: 2 },
  tlTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
  tlSub: { fontSize: FontSize.sm, lineHeight: 18, marginTop: 1 },

  spinnerWrap: { paddingVertical: Spacing.xl, alignItems: 'center' },
  // Compact horizontal plan row — much shorter than the old block card so
  // two of them + the "See Founding Lifetime" link fit above the CTA.
  plans: { marginTop: Spacing.md, gap: Spacing.sm },
  planRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: 16,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    position: 'relative',
    minHeight: 64,
  },
  planRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  planRadioDot: { width: 8, height: 8, borderRadius: 4 },
  planText: { flex: 1, minWidth: 0 },
  planPriceCol: { alignItems: 'flex-end' },
  planBadge: {
    position: 'absolute',
    top: -8,
    right: Spacing.md,
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.full,
  },
  planBadgeText: {
    color: Colors.primaryFg,
    fontSize: 9,
    fontWeight: FontWeight.black,
    letterSpacing: 1,
  },
  planNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  planName: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  // "SAVE 69%" tag — bumped up per RC boosters #3 (Prominent Discounts):
  // discount% at high contrast, positioned adjacent to the plan name so the
  // eye reads "Annual · save 69%" in one saccade. Loss aversion > gain.
  saveTag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: Radius.sm },
  saveTagText: { fontSize: 11, fontWeight: FontWeight.black, letterSpacing: 0.5 },
  planPrice: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  planPriceUnit: { fontSize: FontSize.xs, fontWeight: FontWeight.regular, marginTop: 1 },
  planNote: { fontSize: FontSize.xs, marginTop: 2 },
  morePlans: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    textAlign: 'center',
    textDecorationLine: 'underline',
    marginTop: Spacing.xs,
    paddingVertical: Spacing.xs,
  },

  // Redesigned paywall (2026-07-28): body is a scroll-only-if-needed
  // ScrollView (SE-class safety net), footer is fixed at the bottom.
  paywallBody: { flex: 1 },
  paywallBodyContent: {
    paddingHorizontal: Spacing.xxl,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  hero: {
    fontFamily: FontFamily.display,
    fontSize: 28,
    letterSpacing: LetterSpacing.tight,
    lineHeight: 33,
  },
  heroSub: {
    fontSize: FontSize.md,
    lineHeight: 20,
    marginTop: 6,
  },
  // The path to the goal: lime ring per step on a thin rail, flag at the end.
  // Rows carry no gap so each rail segment runs into the next ring.
  points: { marginTop: Spacing.lg },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    minHeight: 34,
  },
  pathRail: { width: 14, alignItems: 'center', alignSelf: 'stretch' },
  pathDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, marginTop: 4 },
  pathLine: { width: 2, flex: 1, marginTop: 3, marginBottom: -1 },
  pointText: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.medium, lineHeight: 20 },
  pathGoal: { fontSize: FontSize.md, fontWeight: FontWeight.bold, lineHeight: 20 },
  pathPlus: { fontSize: FontSize.sm, marginTop: Spacing.xs },
  // Success screen: mark, headline, one-line sub, then a three-row "what
  // just unlocked" card.
  successMark: { alignItems: 'center', marginBottom: Spacing.lg },
  unlockCard: {
    alignSelf: 'stretch',
    marginTop: Spacing.xl,
    borderRadius: Radius.lg,
    borderWidth: 1,
    paddingHorizontal: Spacing.lg,
  },
  unlockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
  },
  unlockIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unlockText: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.semibold },

  noPayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginBottom: Spacing.md,
  },
  noPayText: { fontSize: FontSize.md, fontWeight: FontWeight.bold },

  // Single trust line under the CTA: billing truth · exit path · refund.
  trustLine: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
    textAlign: 'center',
    marginTop: Spacing.md,
  },

  footer: {
    paddingHorizontal: Spacing.xxl,
    paddingBottom: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  paywallFooter: {
    paddingHorizontal: Spacing.xxl,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    height: 56,
    borderRadius: Radius.full,
  },
  ctaText: { fontSize: 17, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  ctaNote: {
    fontSize: FontSize.sm,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: Spacing.md,
  },
  footLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.xxl,
    marginTop: Spacing.lg,
  },
  footLink: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  expoGoNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.lg,
  },
  expoGoText: { flex: 1, fontSize: FontSize.xs, lineHeight: 18 },
});
