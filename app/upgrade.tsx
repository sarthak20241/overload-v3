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
 *             4 benefits, trial timeline, annual (7-day intro trial,
 *             preselected, save badge) vs decoy monthly vs founding lifetime,
 *             third "No payment today", CTA, delayed soft-wall skip link.
 *
 * Entry modes:
 *   /upgrade?flow=onboarding[&dest=routines]  full 3-screen funnel, shown
 *       once after sign-up when the guest funnel's plan has been saved.
 *       Finishing (purchase or skip) lands on the dashboard (or routines).
 *   /upgrade[?context=cap_chat|cap_parse|milestone]  paywall screen only,
 *       opened from the cap-hit sheet / locked features / milestone card.
 *       Finishing pops back to wherever the user was.
 *
 * Android: Play billing is blocked (BillDesk merchant verification), so this
 * screen never sells there. Direct opens get a "Pro is coming to Android"
 * panel; the onboarding flow skips /upgrade entirely on Android.
 *
 * Purchase plumbing mirrors components/ai/Paywall.tsx: RC purchase, then poll
 * get_coach_access_status until the webhook flips the tier. On a successful
 * annual (trial) purchase we schedule the local day-5 reminder notification,
 * which the reminder screen and the timeline explicitly promised.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useToast } from '@/components/ui/Toast';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useSupabaseClient } from '@/lib/supabase';
import { PressableScale } from '@/components/ui/PressableScale';
import { DronaMark } from '@/components/coach/DronaMark';
import { resetCoachAccessCache } from '@/hooks/useCoachAccess';
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
  PurchaseCancelledError,
  PurchasesUnavailableError,
  type PlanKey,
  type RevenueCatPackage,
} from '@/lib/revenuecat';

type FunnelStep = 'warmup' | 'reminder' | 'paywall';

// Free → Pro comparison rows. `free`/`pro` render as: string → text,
// 'yes' → check icon, 'soon' → outlined "SOON" chip, null → dash. CORE
// shows by default (highest-signal deltas); MORE expands behind "See the
// full comparison" (Linktree's expandable-detail pattern) and deliberately
// includes the both-included rows so what free KEEPS is visible — the
// soft-wall skipper reads that as transparency, not concealment.
//
// Readiness dropped from Pro (2026-07-29 pivot): the app never gated it
// client-side, so advertising it as Pro was a false-advertising bug.
// Weekly reports + Coach nudges added with "Soon" markers — both are real
// product commitments spawned as build tasks; the chip becomes stale if
// the features don't ship within a few weeks, so treat those as deadline
// obligations, not backlog wishes.
type CompareCell = string | 'yes' | 'soon' | null;
const COMPARE_CORE: { label: string; free: CompareCell; pro: CompareCell }[] = [
  { label: 'Coach chat', free: '3/day', pro: 'Unlimited' },
  { label: 'Fast, accurate AI food logs', free: '3/day', pro: 'Unlimited' },
  { label: 'Personalized plans + workouts', free: null, pro: 'yes' },
  { label: 'Weekly plan rewrites', free: null, pro: 'yes' },
];
const COMPARE_MORE: { label: string; free: CompareCell; pro: CompareCell }[] = [
  { label: 'Refine any plan in chat', free: null, pro: 'yes' },
  { label: 'Weekly progress reports', free: null, pro: 'soon' },
  { label: 'Proactive coach nudges', free: null, pro: 'soon' },
  { label: 'Workout + diet tracking', free: 'yes', pro: 'yes' },
  { label: 'Unlimited routines + history', free: 'yes', pro: 'yes' },
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
  // Founding Lifetime is a distracting third option (and its ASC IAP isn't
  // provisioned yet), so it's collapsed behind a link by default. Once
  // expanded, the row inflates in place and the link disappears.
  const [showAllPlans, setShowAllPlans] = useState(false);
  // Full comparison list, collapsed by default (core deltas only).
  const [showFullCompare, setShowFullCompare] = useState(false);
  // Soft-wall skip: fades in after a beat so the value case gets first read.
  const [skipVisible, setSkipVisible] = useState(false);
  const purchasesUsable = isPurchasesAvailable();

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

  useEffect(() => {
    if (step !== 'paywall') return;
    const t = setTimeout(() => setSkipVisible(true), 2000);
    return () => clearTimeout(t);
  }, [step]);

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
    try {
      if (user?.id) await ensureIdentity(user.id);
      const customerInfo = await purchaseCoachPackage(pkg);
      setPurchasing(false);
      setVerifying(true);
      const flipped = await waitForTierFlip();
      resetCoachAccessCache();
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
        if (onTrial) void scheduleTrialReminder();
        toast.success("You're in. Welcome to Overload Pro.");
        finish();
      } else {
        toast.info(
          "Purchase received. We're finalizing. Pull to refresh or relaunch in a minute.",
          { durationMs: 8000 },
        );
        finish();
      }
    } catch (e) {
      if (e instanceof PurchaseCancelledError) {
        /* backed out of the payment sheet, stay put */
      } else if (e instanceof PurchasesUnavailableError) {
        toast.error(e.message, { durationMs: 6000 });
      } else {
        console.warn('[upgrade] purchase failed:', e);
        toast.error('Purchase failed. Try again or contact support.');
      }
    } finally {
      setPurchasing(false);
      setVerifying(false);
    }
  }, [packages, selectedPlan, purchasing, verifying, user?.id, waitForTierFlip, toast, finish]);

  const handleRestore = useCallback(async () => {
    if (restoring) return;
    setRestoring(true);
    try {
      const info = await restorePurchases();
      if (!info) {
        toast.info('Purchases unavailable in this build.');
        return;
      }
      const hasActive = Object.values(info.entitlements?.active ?? {}).some((e) => e.isActive);
      if (hasActive) {
        const flipped = await waitForTierFlip();
        resetCoachAccessCache();
        if (flipped) {
          toast.success('Restored. Welcome back.');
          finish();
        } else {
          toast.info("Restored. We're finalizing. Try again in a minute.");
        }
      } else {
        toast.info('No previous purchases on this Apple ID.');
      }
    } catch (e) {
      console.warn('[upgrade] restore failed:', e);
      toast.error('Restore failed. Try again later.');
    } finally {
      setRestoring(false);
    }
  }, [restoring, waitForTierFlip, toast, finish]);

  const advanceFromReminder = useCallback(async () => {
    // The promise needs the permission. Denial is fine: the screen never
    // claimed the OS can't say no, and Apple emails trial reminders anyway.
    await requestNotificationPermission();
    setStep('paywall');
  }, []);

  // ── Android: nothing to sell until Play billing unblocks ─────────────────
  if (Platform.OS === 'android') {
    return (
      <SafeAreaView style={[u.safeArea, { backgroundColor: C.background }]}>
        <View style={u.centerFill}>
          <DronaMark size={56} state="idle" />
          <Text style={[u.displayTitle, { color: C.foreground, textAlign: 'center' }]}>
            Pro is coming to Android.
          </Text>
          <Text style={[u.subText, { color: C.textSecondary, textAlign: 'center' }]}>
            Until then you have the free plan: your full program, plus 3 coach
            messages and 3 AI food logs a day. I make those three count.
          </Text>
        </View>
        <View style={u.footer}>
          <PressableScale onPress={finish} style={[u.cta, Shadow.playBtn]} accessibilityRole="button" accessibilityLabel="Continue">
            <Text style={u.ctaText}>Continue</Text>
          </PressableScale>
        </View>
      </SafeAreaView>
    );
  }

  const annual = packages.annual ?? null;
  const monthly = packages.monthly ?? null;
  const lifetime = packages.founding_lifetime ?? null;
  const perMonth = annual ? perMonthLabel(annual) : null;
  const savePct =
    annual?.product?.price && monthly?.product?.price
      ? Math.round((1 - annual.product.price / (monthly.product.price * 12)) * 100)
      : null;
  const foundingSoldOut =
    founding !== null && (founding.closed_at !== null || founding.claimed >= founding.cap);
  const foundingLeft = founding ? Math.max(0, founding.cap - founding.claimed) : null;

  // Headline: outcome, not mechanic (RevenueCat 7-uses framework: "Educate
  // and Frame Value"). Ladder's paywall proved this — "Get results, without
  // planning workouts" beat every feature-led variant. Sub carries the trial
  // + price mechanics so the headline stays clean.
  const paywallTitle =
    context === 'milestone'
      ? 'Your next four weeks, programmed.'
      : context === 'pro_feature'
        ? 'That one is Overload Pro.'
        : context === 'cap_chat' || context === 'cap_parse'
          ? 'A coach who never runs out.'
          : 'Never write a training plan again.';
  // One sentence: the ecosystem story (Sarthak's framing). Everything else
  // (what's included, trial mechanics, price) lives in exactly one dedicated
  // element below: the Free → Pro comparison table with its expandable full
  // list. History: v4 had three overlapping explainers and read overloaded;
  // v5 collapsed them into the table.
  const paywallSub =
    'Drona watches your training, food and recovery, and steers you to your goal week by week.';

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
              onPress={() => setStep('reminder')}
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
                small "See all plans" toggle both to declutter and because the
                Founding non-consumable IAP isn't provisioned in App Store
                Connect yet (per .planning/paywall-plan.md ship-state) — a
                surfaced-but-broken option is worse than a hidden one
              - sticky footer with the CTA + trust check + delayed skip link
          */}
          <View style={u.topBar}>
            <TouchableOpacity
              onPress={() => (isFunnel ? setStep('reminder') : finish())}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="chevron-left" size={IconSize.lg} color={C.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleRestore}
              disabled={restoring}
              accessibilityRole="button"
              accessibilityLabel="Restore purchases"
            >
              {restoring ? (
                <ActivityIndicator size="small" color={C.textMuted} />
              ) : (
                <Text style={[u.restoreText, { color: C.textMuted }]}>Restore</Text>
              )}
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
            <Text style={[u.heroSub, { color: C.textSecondary }]}>{paywallSub}</Text>

            {/* Free → Pro comparison (RC "Educate & Frame Value", Vivid's
                compare-plans pattern). THE single explainer on this screen:
                our freemium model means free users already have a metered
                coach, so "what am I signing up for?" is genuinely the delta,
                not a feature list. Also quietly reassures the soft-wall
                skipper that free keeps working. */}
            <View style={[u.compare, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              <View style={u.cmpHeader}>
                <View style={{ flex: 1 }} />
                <View style={u.cmpCol}>
                  <Text style={[u.cmpHeadText, { color: C.textDim }]}>FREE</Text>
                </View>
                <View style={u.cmpCol}>
                  <Text style={[u.cmpHeadText, { color: C.accentText }]}>PRO</Text>
                </View>
              </View>
              {(showFullCompare ? [...COMPARE_CORE, ...COMPARE_MORE] : COMPARE_CORE).map((row) => (
                <View key={row.label} style={[u.cmpRow, { borderTopColor: C.borderSubtle }]}>
                  <Text style={[u.cmpLabel, { color: C.foreground }]}>{row.label}</Text>
                  <View style={u.cmpCol}>
                    {row.free === 'yes' ? (
                      <Feather name="check" size={IconSize.sm} color={C.textMuted} />
                    ) : row.free === 'soon' ? (
                      <View style={[u.soonChip, { borderColor: C.textMuted }]}>
                        <Text style={[u.soonText, { color: C.textMuted }]}>SOON</Text>
                      </View>
                    ) : row.free ? (
                      <Text style={[u.cmpFree, { color: C.textMuted }]}>{row.free}</Text>
                    ) : (
                      <Feather name="minus" size={IconSize.sm} color={C.textDim} />
                    )}
                  </View>
                  <View style={u.cmpCol}>
                    {row.pro === 'yes' ? (
                      <Feather name="check" size={IconSize.sm} color={C.accentText} />
                    ) : row.pro === 'soon' ? (
                      <View style={[u.soonChip, { borderColor: C.accentText }]}>
                        <Text style={[u.soonText, { color: C.accentText }]}>SOON</Text>
                      </View>
                    ) : (
                      <Text style={[u.cmpPro, { color: C.accentText }]}>{row.pro}</Text>
                    )}
                  </View>
                </View>
              ))}
              <TouchableOpacity
                onPress={() => setShowFullCompare((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel={showFullCompare ? 'Show less' : 'See the full comparison'}
                style={[u.cmpMoreBtn, { borderTopColor: C.borderSubtle }]}
              >
                <Text style={[u.cmpMoreText, { color: C.textMuted }]}>
                  {showFullCompare ? 'Show less' : 'See the full comparison'}
                </Text>
                <Feather
                  name={showFullCompare ? 'chevron-up' : 'chevron-down'}
                  size={IconSize.sm}
                  color={C.textMuted}
                />
              </TouchableOpacity>
            </View>

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
                      badge="7 DAYS FREE"
                      name="Annual"
                      saveTag={savePct && savePct > 0 ? `SAVE ${savePct}%` : undefined}
                      price={annual.product.priceString}
                      priceUnit="/yr"
                      note={perMonth ? `${perMonth}/mo, billed yearly` : 'Billed yearly'}
                      onPress={() => setSelectedPlan('annual')}
                    />
                  </Animated.View>
                )}
                {monthly && (
                  <Animated.View entering={FadeInDown.delay(180).duration(350)}>
                    <PlanRow
                      selected={selectedPlan === 'monthly'}
                      name="Monthly"
                      price={monthly.product.priceString}
                      priceUnit="/mo · no trial"
                      onPress={() => setSelectedPlan('monthly')}
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
                    onPress={() => setSelectedPlan('founding_lifetime')}
                  />
                )}
                {lifetime && lifetime.product?.priceString && !foundingSoldOut && !showAllPlans && (
                  <TouchableOpacity
                    onPress={() => setShowAllPlans(true)}
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
                    In-app purchases require a TestFlight build.
                  </Text>
                )}
              </View>
            )}
          </ScrollView>

          <View style={u.paywallFooter}>
            {verifying && (
              <View style={u.verifyingRow}>
                <ActivityIndicator color={C.foreground} />
                <Text style={[u.verifyingText, { color: C.foreground }]}>Verifying purchase…</Text>
              </View>
            )}
            {/* Trust motif above the CTA (RC 7-uses "Build Trust" + Bloom's
                refund transparency). Two anchors in one horizontal line: the
                billing truth and the exit path. MUST track the selected plan:
                only annual carries the trial, so "No payment today" on a
                monthly/lifetime selection would be a lie (and an App Review
                rejection waiting to happen). */}
            <View style={u.trustRow}>
              <View style={u.trustChip}>
                <Feather name="check" size={11} color={C.accentText} />
                <Text style={[u.trustText, { color: C.foreground }]}>
                  {selectedPlan === 'annual'
                    ? 'No payment today'
                    : selectedPlan === 'monthly'
                      ? 'First charge today'
                      : 'One payment, no renewals'}
                </Text>
              </View>
              <View style={[u.trustDot, { backgroundColor: C.textDim }]} />
              <View style={u.trustChip}>
                <Feather name="check" size={11} color={C.accentText} />
                <Text style={[u.trustText, { color: C.foreground }]}>
                  {selectedPlan === 'founding_lifetime'
                    ? 'Yours forever'
                    : 'Cancel in Settings, 2 taps'}
                </Text>
              </View>
            </View>
            <Animated.View style={ctaPulseStyle}>
              <PressableScale
                onPress={handlePurchase}
                disabled={purchasing || verifying || loading}
                style={[u.cta, Shadow.playBtn, (purchasing || verifying || loading) && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityLabel={
                  selectedPlan === 'annual'
                    ? 'Start my 7 days free'
                    : selectedPlan === 'monthly'
                      ? 'Subscribe monthly'
                      : 'Claim founding lifetime'
                }
              >
                {purchasing ? (
                  <ActivityIndicator size="small" color={Colors.primaryFg} />
                ) : (
                  <Text style={u.ctaText}>
                    {selectedPlan === 'annual'
                      ? 'Start my 7 days free'
                      : selectedPlan === 'monthly'
                        ? 'Subscribe monthly'
                        : 'Claim founding lifetime'}
                  </Text>
                )}
              </PressableScale>
            </Animated.View>
            {skipVisible && (
              <Animated.View entering={FadeIn.duration(400)}>
                <TouchableOpacity
                  onPress={finish}
                  accessibilityRole="button"
                  accessibilityLabel="Continue with the free plan"
                >
                  <Text style={[u.skipText, { color: C.textDim }]}>
                    Not now, I'll train on the free plan
                  </Text>
                </TouchableOpacity>
              </Animated.View>
            )}
            <Text style={[u.legal, { color: C.textDim }]}>
              Auto-renews until cancelled.{' '}
              <Text style={u.legalLink} onPress={() => Linking.openURL('https://tryoverload.app/terms.html')}>
                Terms
              </Text>
              {' · '}
              <Text style={u.legalLink} onPress={() => Linking.openURL('https://tryoverload.app/privacy.html')}>
                Privacy
              </Text>
            </Text>
          </View>
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
  restoreText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
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
    lineHeight: 19,
    marginTop: 6,
  },
  // Free → Pro comparison table
  compare: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginTop: Spacing.lg,
  },
  cmpHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.xs,
  },
  cmpHeadText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.label,
  },
  cmpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm + 1,
    borderTopWidth: 1,
  },
  cmpLabel: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.medium },
  cmpCol: { width: 82, alignItems: 'center' },
  cmpFree: { fontSize: FontSize.sm },
  cmpPro: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  // "SOON" chip: outlined pill that carries a Pro feature we've committed
  // to shipping but haven't shipped yet. Deliberately smaller and less
  // visually loud than a checkmark so the eye reads it as "yes, and it's
  // in flight" rather than "yes, definitely today". Color set inline from
  // the column's theme (accent for Pro, muted for Free — the latter is
  // never used today but keeps the render branch symmetric).
  soonChip: {
    borderWidth: 1,
    borderRadius: Radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  soonText: {
    fontSize: 9.5,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.5,
  },
  cmpMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingTop: Spacing.sm + 1,
    paddingBottom: 2,
    borderTopWidth: 1,
  },
  cmpMoreText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  verifyingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.lg,
  },
  verifyingText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  noPayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginBottom: Spacing.md,
  },
  noPayText: { fontSize: FontSize.md, fontWeight: FontWeight.bold },

  // Trust motif row above the CTA. Two chips separated by a dot, replacing
  // the previous single "No payment today" row so both trust anchors land
  // at the moment of maximum hesitation (RC "Build Trust" tactic).
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  trustChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  trustText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  // Color set inline from the theme (C.textDim): a hardcoded value here was
  // invisible against the dark background in the sim review.
  trustDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
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
  skipText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    textAlign: 'center',
    textDecorationLine: 'underline',
    marginTop: Spacing.md,
  },
  legal: {
    fontSize: FontSize.xs,
    lineHeight: 15,
    textAlign: 'center',
    marginTop: Spacing.sm,
  },
  legalLink: { textDecorationLine: 'underline' },

  expoGoNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.lg,
  },
  expoGoText: { flex: 1, fontSize: FontSize.xs, lineHeight: 18 },
});
