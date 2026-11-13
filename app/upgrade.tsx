/**
 * The paywall. Since 2026-11-12 it sells two plans on one screen (plan file
 * .planning/connect-plan-paywall.md): "Drona coach" = Overload Pro, and
 * "Your own AI" = Overload Connect (tracker + ChatGPT / Claude connector, no
 * Drona). Parts in components/paywall/PaywallParts.tsx, rules in
 * lib/paywallPlans.ts, layout A/B from the PostHog flag `paywall-layout`.
 *
 * The Overload Pro funnel (.planning/paywall-plan.md, design review artifact
 * "open-reveal"). One route, three internal screens, modeled beat-for-beat on
 * the Cal AI funnel with our adaptations (soft wall, the store's free trial, transparent
 * price headline):
 *
 *   warmup    "Your goal isn't yours alone anymore." Trust first, Drona's
 *             voice, no price anywhere. First "No payment today".
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
  Alert,
  BackHandler,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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
import { track, setUserProps, flushAnalytics, getFlagVariant } from '@/lib/analytics';
import {
  accessHasPlan,
  ctaLabel as paywallCta,
  initialSide,
  layoutFromFlag,
  PAYWALL_LAYOUT_FLAG,
  planFor,
  priceLine,
  SIDE_PERIODS,
  SIDE_SUB,
  SIDE_TITLE,
  type PaywallLayout,
  type PaywallPeriod,
  type PaywallSide,
} from '@/lib/paywallPlans';
import { ExampleCard, Features, PAYWALL_LIME, PlanSwitch, PriceBoxes } from '@/components/paywall/PaywallParts';
import { useToast } from '@/components/ui/Toast';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useSupabaseClient } from '@/lib/supabase';
import { PressableScale } from '@/components/ui/PressableScale';
import { DronaMark } from '@/components/coach/DronaMark';
import { DronaHeroOrb } from '@/components/coach/DronaHeroOrb';
import { invalidateCoachAccess, useCoachAccess } from '@/hooks/useCoachAccess';
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
  getCustomerInfo,
  freeTrialDays,
  isConnectPlan,
  PurchaseCancelledError,
  PurchasePendingError,
  describePurchaseError,
  PENDING_STILL_WAITING,
  PurchasesUnavailableError,
  STORE_ACCOUNT,
  STORE_NAME,
  type PlanKey,
  type RevenueCatPackage,
  type RevenueCatCustomerInfo,
} from '@/lib/revenuecat';
import { OrbLoader } from '@/components/ui/OrbLoader';
import { isHardPaywallAccount, markStoreDown } from '@/lib/hardPaywall';
import { signOutAndCleanUp } from '@/lib/signOutCleanup';

type FunnelStep = 'warmup' | 'reminder' | 'paywall' | 'success';

/** What the success screen needs to know about the purchase it celebrates. */
interface PurchaseOutcome {
  plan: PlanKey;
  /** The entitlement carries an intro/trial period (annual, first time). */
  onTrial: boolean;
  /** The store's free days for that plan (0 = unknown). */
  trialDays: number;
}

/**
 * Is this buyer actually on a trial right now? Read from the active
 * entitlement's periodType (INTRO | TRIAL), never from the selected plan or
 * the product's offer: an existing subscriber who upgrades has no intro
 * trial, and the day-5 reminder would promise one they are not on.
 */
function entitlementOnTrial(customerInfo: RevenueCatCustomerInfo | null | undefined): boolean {
  return Object.values(customerInfo?.entitlements?.active ?? {}).some((e) => {
    const t = e?.periodType;
    return t === 'TRIAL' || t === 'INTRO' || t === 'trial' || t === 'intro';
  });
}

export default function UpgradeScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const toast = useToast();
  const { user, signOut, isLoaded: userLoaded } = useClerkUser();
  const supabase = useSupabaseClient();
  const params = useLocalSearchParams<{ flow?: string; context?: string; dest?: string }>();
  const isFunnel = params.flow === 'onboarding';
  // Hard paywall (lib/hardPaywall.ts). 'locked' is the app gate sending a new
  // account with no Pro here; the sign-up funnel is locked for the same
  // accounts. Locked = no close button, no Android back, and a sign-out link
  // so someone on the wrong account is never stuck.
  // In the funnel, until Clerk's user has loaded we can't read the account's
  // date: count it as locked, so the close button never flashes for a new
  // account. An older account sees the close once the user loads.
  // The URL alone never locks an older account: 'locked' also needs a new
  // account once the user has loaded.
  const newOrLoading = !userLoaded || !user || isHardPaywallAccount(user.createdAt);
  // Pro or a trial already (a code, an earlier purchase): never locked.
  const { access: coachAccess } = useCoachAccess();
  // A Connect buyer has paid too: they come here to add Drona, never locked.
  const hasAccess = coachAccess.state === 'paid' || coachAccess.state === 'trialing' || coachAccess.connect === true;
  const isLocked =
    isPurchasesAvailable() && (params.flow === 'locked' || isFunnel) && newOrLoading && !hasAccess;
  const source = params.flow === 'locked' ? 'locked' : isFunnel ? 'onboarding_funnel' : 'direct';
  const context = typeof params.context === 'string' ? params.context : null;

  const [step, setStep] = useState<FunnelStep>(isFunnel ? 'warmup' : 'paywall');

  // ── Offerings + founding status (loaded once, shown on the paywall) ──────
  const [loading, setLoading] = useState(true);
  const [packages, setPackages] = useState<Partial<Record<PlanKey, RevenueCatPackage>>>({});
  // Two sides (Drona = Pro, Your own AI = Connect) and a period. The plan
  // sold is derived from both (lib/paywallPlans.ts). Yearly is preselected.
  const [side, setSide] = useState<PaywallSide>(() => initialSide(typeof params.context === 'string' ? params.context : null));
  const [period, setPeriod] = useState<PaywallPeriod>('annual');
  // The side on screen now, for view events fired from run-once effects.
  const sideRef = useRef(side);
  sideRef.current = side;
  // planFor is null only for a side/period pair the screen never offers
  // (Drona has no lifetime). Then nothing is sold: the button is off and
  // handlePurchase stops, never falling back to another plan.
  const plannedKey = planFor(side, period);
  const buyingConnect = plannedKey ? isConnectPlan(plannedKey) : false;
  // Price and trial per period of the side on screen, straight from the store
  // (0 trial days = none). A period whose product did not load is hidden.
  const sidePrices: Partial<Record<PaywallPeriod, string>> = {};
  const sideTrials: Partial<Record<PaywallPeriod, number>> = {};
  for (const p of SIDE_PERIODS[side]) {
    const key = planFor(side, p);
    const pkg = key ? packages[key] : undefined;
    if (pkg?.product?.priceString) {
      sidePrices[p] = pkg.product.priceString;
      sideTrials[p] = p === 'lifetime' ? 0 : freeTrialDays(pkg);
    }
  }
  const selectedTrial = sideTrials[period] ?? 0;
  // A/B test (PostHog flag paywall-layout): tiles (A, default) or icon list (B).
  const [layout, setLayout] = useState<PaywallLayout>('tiles');
  useEffect(() => {
    let live = true;
    // paywall_viewed waits for the layout (flag or 1.5 s timeout), so every
    // event of the funnel carries the layout this viewer really saw.
    void getFlagVariant(PAYWALL_LAYOUT_FLAG, 'tiles').then((v) => {
      if (!live) return;
      const resolved = layoutFromFlag(v);
      setLayout(resolved);
      viewTracked.current = true;
      track('paywall_viewed', { source, context, purchases_available: purchasesUsable, side: sideRef.current, paywall_layout: resolved, flag_status: 'resolved' });
    });
    return () => { live = false; };
  }, []);
  // Bumped by "Try again" when the store's plans did not load.
  const [storeTry, setStoreTry] = useState(0);
  const [purchasing, setPurchasing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // A payment the bank is still approving after the 2-minute wait. The buy
  // button stays off: a second tap could double-charge (Ask to Buy) or hit
  // Play's already-owned error while the first order is still pending.
  const [pendingOrder, setPendingOrder] = useState(false);
  // Locked buyer whose payment went through but the server has not confirmed
  // yet: the buy button stays off so they Restore instead of paying twice.
  const [activationPending, setActivationPending] = useState(false);
  const [outcome, setOutcome] = useState<PurchaseOutcome | null>(null);
  // The pending wait outlives a tap by up to 2 minutes; nothing may update a
  // screen the buyer already left.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const purchasesUsable = isPurchasesAvailable();

  // Paywall analytics. `context` is what sent them here (a usage cap, the
  // coach gate, the profile card), which is the difference between "the
  // paywall converts badly" and "one entry point converts badly".
  const paywallOpenedAt = useRef(Date.now());
  const paywallResolved = useRef(false);
  const viewTracked = useRef(false);
  useEffect(() => {
    return () => {
      // Left before the layout flag resolved: still count the view, so fast
      // bounces stay in the funnel (layout unknown).
      if (!viewTracked.current) {
        viewTracked.current = true;
        track('paywall_viewed', { source, context, purchases_available: purchasesUsable, side: sideRef.current, paywall_layout: 'tiles', flag_status: 'pending' });
      }
      if (paywallResolved.current) return;
      track('paywall_dismissed', {
        source,
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
  const pulseActive = step === 'paywall' && !purchasing && !verifying && !loading && !activationPending;
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
        const offerings = await getCoachOfferings();
        if (cancelled) return;
        setPackages(offerings?.byPlan ?? {});
      } catch (e) {
        if (!cancelled) console.warn('[upgrade] load failed:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, storeTry]);

  // The store's plans did not load (store down, no network): nothing can be
  // bought, so a locked paywall must not trap anyone. It offers a retry and
  // opens like every other failure in the gate (fail open).
  // Any purchasable plan counts: Connect alone loading is not an outage.
  const storeDown = !loading && Object.keys(packages).length === 0;
  // Once the store has failed, the way out stays while "try again" reloads.
  const [storeFailed, setStoreFailed] = useState(false);
  useEffect(() => {
    if (storeDown) setStoreFailed(true);
    else if (!loading) setStoreFailed(false);
  }, [storeDown, loading]);
  const lockedNow = isLocked && !storeDown && !storeFailed;
  useEffect(() => {
    if (!(storeDown && isLocked)) return;
    markStoreDown();
    // Tracked so a real store outage can be told apart from a bad offering
    // config or someone blocking the request.
    track('paywall_store_down', { source, context, platform: STORE_NAME });
  }, [storeDown, isLocked]);

  // Where "done" goes. The funnel replaces into the app; a direct open pops
  // back to whatever surfaced the paywall.
  const finish = useCallback(() => {
    if (params.flow === 'locked') {
      router.replace('/(app)');
    } else if (isFunnel) {
      router.replace(params.dest === 'routines' ? '/(app)/routines' : '/(app)');
    } else if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(app)');
    }
  }, [isFunnel, params.flow, params.dest, router]);

  // Android back must not slip past a locked paywall.
  useEffect(() => {
    if (!lockedNow) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [lockedNow]);

  // Apple 5.1.1(v): an account can be deleted inside the app. A locked new
  // account can't reach Profile, so the paywall offers it too. Same server
  // wipe as Profile (delete-account), then Clerk's own delete.
  const [deleting, setDeleting] = useState(false);
  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      'Delete your account?',
      'This deletes your account and everything in it. It cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              const { error } = await supabase.functions.invoke('delete-account');
              if (error) throw error;
              if (user && (user as any).delete) {
                try { await (user as any).delete(); } catch { /* already deleted by the function */ }
              }
              track('account_deleted', { from: 'paywall' });
              await flushAnalytics();
              paywallResolved.current = true;
              // Always end the session and drop local data, even when Clerk's
              // own delete already ran: a live session would bounce back here.
              await signOutAndCleanUp({ userId: user?.id, supabase, clerkSignOut: signOut });
              router.replace('/(auth)');
            } catch (e: any) {
              setDeleting(false);
              toast.error(e?.message ? `Couldn't delete the account. ${e.message}` : "Couldn't delete the account. Try again.");
            }
          },
        },
      ],
    );
  }, [supabase, user, signOut, router, toast]);

  const handleSignOut = useCallback(async () => {
    try {
      await signOutAndCleanUp({ userId: user?.id, supabase, clerkSignOut: signOut, throwIfSignOutFails: true });
    } catch (e) {
      console.warn('[upgrade] sign out failed:', e);
      toast.error("Couldn't sign out. Check your connection and try again.");
      return;
    }
    track('paywall_signed_out', { source, context });
    paywallResolved.current = true;
    router.replace('/(auth)');
  }, [signOut, router, source, context, toast, user?.id, supabase]);

  // Longer `timeoutMs` for a pending payment: the store is waiting on a bank
  // mandate, which routinely lands well after the 30s a webhook flip needs.
  // What a purchase must turn on. A Connect purchase never makes the state
  // 'paid' (no Drona): it lands as `connect: true`. A Pro buyer who already
  // has Connect (or the reverse) must wait for the plan they just bought, so
  // 'either' is for Restore only.
  const waitForTierFlip = useCallback(async (timeoutMs = 30_000, want: 'pro' | 'connect' | 'either' = 'pro'): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const { data } = await supabase.rpc('get_coach_access_status');
        // 'trialing' counts too: it is Pro everywhere, and the hard-paywall
        // gate lets it in, so a buyer must never wait on it.
        if (accessHasPlan(data as { state?: string; connect?: boolean } | null, want)) return true;
      } catch {
        /* network blip, keep polling */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }, [supabase]);

  const handlePurchase = useCallback(async () => {
    const plan = plannedKey;
    const pkg = plan ? packages[plan] : undefined;
    if (!plan || !pkg) {
      toast.error('Plan unavailable. Try again.');
      return;
    }
    if (purchasing || verifying || pendingOrder || activationPending) return;
    setPurchasing(true);
    track('purchase_started', { plan, context, source, side, period, paywall_layout: layout });
    try {
      if (user?.id) await ensureIdentity(user.id);
      const customerInfo = await purchaseCoachPackage(pkg);
      setPurchasing(false);
      setVerifying(true);
      // Locked: leaving before the tier flips would bounce a paying buyer
      // straight back here (the app gate still reads 'free'), so a locked
      // buyer waits longer before giving up.
      const want = buyingConnect ? 'connect' : 'pro';
      const flipped = (await waitForTierFlip(30_000, want)) || (isLocked && (await waitForTierFlip(90_000, want)));
      invalidateCoachAccess();
      if (flipped) {
        // Honor the reminder screen's promise ONLY when the purchase
        // actually carries a trial. Selecting Annual is not enough — an
        // existing subscriber who upgrades has no intro trial, and
        // scheduling would fire a false "your trial converts in 2 days"
        // notification 5 days later. Check the active entitlement's
        // periodType (INTRO | TRIAL) rather than trusting the plan.
        const onTrial = entitlementOnTrial(customerInfo);
        if (onTrial) {
          void scheduleTrialReminder(buyingConnect ? 'connect' : 'pro').then((scheduled) => {
            track('trial_reminder_scheduled', { scheduled, plan });
          });
        }
        // Warm the dashboard cache while the success screen is up, so the
        // landing paints real data instead of "Level 1 · no workouts".
        void prefetchDashboard(supabase, user?.id);
        paywallResolved.current = true;
        // The bridge only reads user_profiles on sign-in, so stamp the new tier
        // now or every event until the next cold start still says 'free'.
        setUserProps({ tier: plan, on_trial: onTrial });
        track('purchase_completed', {
          plan,
          on_trial: onTrial,
          context,
          source,
          side,
          period,
          paywall_layout: layout,
          seconds_to_purchase: Math.round((Date.now() - paywallOpenedAt.current) / 1000),
        });
        setOutcome({ plan, onTrial, trialDays: selectedTrial });
        setStep('success');
      } else if (isLocked) {
        // Paid, but the server has not caught up. Stay here: Restore leaves
        // once it has.
        setActivationPending(true);
        track('purchase_completed', { plan, on_trial: false, context, source, tier_flip: 'pending', side, period, paywall_layout: layout });
        toast.info("Payment received. It's taking a moment. Tap Restore in a minute.", { durationMs: 10000 });
      } else {
        paywallResolved.current = true;
        track('purchase_completed', { plan, on_trial: false, context, source, tier_flip: 'pending', side, period, paywall_layout: layout });
        toast.info(
          "Purchase received. We're finalizing. Pull to refresh or relaunch in a minute.",
          { durationMs: 8000 },
        );
        finish();
      }
    } catch (e) {
      if (e instanceof PurchaseCancelledError) {
        /* backed out of the payment sheet, stay put */
        track('purchase_failed', { plan, reason: 'cancelled', context, side, period, paywall_layout: layout });
      } else if (e instanceof PurchasePendingError) {
        // Nothing failed: the store is waiting on the buyer's bank (an Indian
        // card or UPI mandate, Ask to Buy, SEPA). Keep "Activating Pro…" up
        // and poll well past the normal window instead of saying "failed".
        track('purchase_pending', { plan, context, source, side, period, paywall_layout: layout });
        setPurchasing(false);
        setVerifying(true);
        const flipped = await waitForTierFlip(120_000, buyingConnect ? 'connect' : 'pro');
        invalidateCoachAccess();
        track('purchase_pending_resolved', { plan, context, source, flipped, side, period, paywall_layout: layout });
        if (flipped) {
          // A pending purchase never returned customerInfo. Read it fresh: a
          // product that offers a trial says nothing about whether THIS buyer
          // got one (a returning subscriber does not), and the day-5 reminder
          // must not promise a trial they are not on.
          const onTrial = entitlementOnTrial(await getCustomerInfo());
          // Conversion tracking and the reminder do not need this screen, so
          // they run even if the buyer left during the wait. These are exactly
          // the slow-bank buyers this branch exists for.
          if (onTrial) {
            void scheduleTrialReminder(buyingConnect ? 'connect' : 'pro').then((scheduled) => {
              track('trial_reminder_scheduled', { scheduled, plan });
            });
          }
          paywallResolved.current = true;
          setUserProps({ tier: plan, on_trial: onTrial });
          track('purchase_completed', { plan, on_trial: onTrial, context, source, was_pending: true, side, period, paywall_layout: layout });
          if (!mounted.current) return;
          void prefetchDashboard(supabase, user?.id);
          setOutcome({ plan, onTrial, trialDays: selectedTrial });
          setStep('success');
        } else {
          if (!mounted.current) return;
          setPendingOrder(true);
          toast.info(
            PENDING_STILL_WAITING,
            { durationMs: 10000 },
          );
        }
      } else if (e instanceof PurchasesUnavailableError) {
        track('purchase_failed', { plan, reason: 'unavailable', context, side, period, paywall_layout: layout });
        toast.error(e.message, { durationMs: 6000 });
      } else {
        // Carry the store's own reason into the event; a bare 'error' left
        // a Pending-then-Canceled Play order undiagnosable (2026-10-23).
        const err = describePurchaseError(e);
        console.warn('[upgrade] purchase failed:', err, e);
        track('purchase_failed', {
          plan,
          reason: 'error',
          context,
          source,
          error_code: err.code,
          error_readable: err.readable,
          error_underlying: err.underlying,
          error_message: err.message,
          side,
          period,
          paywall_layout: layout,
        });
        toast.error("That didn't go through. Try again. If you were charged, tap Restore.", { durationMs: 8000 });
      }
    } finally {
      setPurchasing(false);
      setVerifying(false);
    }
  }, [packages, plannedKey, selectedTrial, buyingConnect, side, period, layout, purchasing, verifying, pendingOrder, activationPending, user?.id, waitForTierFlip, toast, finish, supabase, context, isFunnel, isLocked, source]);

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
        // Only a found entitlement ends the pending lock; an empty restore
        // may just mean the bank has not approved yet.
        setPendingOrder(false);
        // A restore carries no plan: either Pro or Connect landing counts.
        const flipped = (await waitForTierFlip(30_000, 'either')) || (isLocked && (await waitForTierFlip(90_000, 'either')));
        invalidateCoachAccess();
        if (flipped) {
          setActivationPending(false);
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
      const err = describePurchaseError(e);
      track('purchase_restore_failed', {
        reason: 'error',
        context,
        error_code: err.code,
        error_readable: err.readable,
        error_underlying: err.underlying,
        error_message: err.message,
      });
      console.warn('[upgrade] restore failed:', err, e);
      toast.error('Restore failed. Try again later.');
    } finally {
      setRestoring(false);
    }
  }, [restoring, waitForTierFlip, toast, finish, isLocked]);

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

  const ctaLabel = paywallCta(side, period, selectedTrial);
  const selectedPrice = sidePrices[period] ?? null;
  // Connect products not in the offering yet (or not on this build's store):
  // the switch stays, but that side says so instead of an empty price row.
  const sideUnavailable = !loading && Object.keys(sidePrices).length === 0;

  const switchSide = useCallback((next: PaywallSide) => {
    if (next === side) return;
    track('paywall_side_switched', { from: side, to: next, context, paywall_layout: layout });
    setSide(next);
    setPeriod('annual');
  }, [side, context, layout]);
  const selectPeriod = useCallback((next: PaywallPeriod) => {
    track('paywall_period_selected', { side, period: next, previous_period: period, paywall_layout: layout });
    track('paywall_plan_selected', { plan: planFor(side, next), previous_plan: plannedKey });
    setPeriod(next);
  }, [side, period, layout, plannedKey]);
  return (
    <SafeAreaView style={[u.safeArea, { backgroundColor: C.background }]}>
      {/* No iOS swipe-back past a locked paywall. */}
      <Stack.Screen options={{ gestureEnabled: !lockedNow }} />
      {step === 'warmup' && (
        <Animated.View key="warmup" entering={FadeIn.duration(250)} style={u.stepFill}>
          <View style={u.centerFill}>
            {/* 2026-10-23: the first funnel beat builds trust before any
                price: the goal stops being the user's burden alone. The free
                week moved to the footer note below. */}
            <Animated.Text
              entering={FadeInDown.duration(400)}
              style={[u.displayTitle, { color: C.foreground, textAlign: 'center' }]}
            >
              You don't have to do this alone.
            </Animated.Text>
            <Animated.View entering={FadeInDown.delay(150).duration(400)} style={u.quoteWrap}>
              {/* Drona's orb, the same one as the coach chat, speaking the
                  promise below. */}
              <DronaHeroOrb style={u.trustOrb} />
              <View style={[u.quoteBubble, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
                <Text style={[u.quoteText, { color: C.foreground }]}>
                  I'm Drona, your coach. I'll make your plan, check on you,
                  and change the plan when life gets busy.
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
              accessibilityLabel="Sounds good"
            >
              {/* The buyer's answer to Drona's promise, not a sales verb. */}
              <Text style={u.ctaText}>Sounds good</Text>
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
              You'll get a message on day 5, two days before you pay anything.
              Turn on notifications so you don't miss it.
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
              accessibilityLabel="Continue"
            >
              <Text style={u.ctaText}>Continue</Text>
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
            {lockedNow ? <View style={u.closeBtn} /> : (
            <TouchableOpacity
              onPress={() => {
                track('paywall_skipped', { via: 'close', context, seconds_on_screen: Math.round((Date.now() - paywallOpenedAt.current) / 1000) });
                finish();
              }}
              accessibilityRole="button"
              accessibilityLabel="Close, continue on the free plan"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              // Leaving mid-purchase would drop the "Activating Pro" wait.
              disabled={purchasing || verifying || restoring}
              style={[u.closeBtn, { backgroundColor: C.card }, (purchasing || verifying || restoring) && { opacity: 0.4 }]}
            >
              <Feather name="x" size={IconSize.md} color={C.textMuted} />
            </TouchableOpacity>
            )}
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
            {/* Two-sided paywall (owner's design 2026-11-12, plan file
                .planning/connect-plan-paywall.md section 3): one title, a
                switch between Drona (Pro) and Your own AI (Connect), one
                concrete example, what each side includes, then its prices. */}
            <Text style={[u.pwTitle, { color: C.foreground }]}>{SIDE_TITLE[side]}</Text>
            <PlanSwitch side={side} onChange={switchSide} disabled={purchasing || verifying} />
            <Text style={[u.pwSub, { color: C.textSecondary }]}>{SIDE_SUB[side]}</Text>
            <ExampleCard side={side} />
            <View style={u.pwGap} />
            <Features side={side} layout={layout} />

            <View style={u.planSpacer} />

            {loading ? (
              <View style={u.spinnerWrap}>
                <OrbLoader size="large" state="searching" />
              </View>
            ) : (
              <View style={u.plans}>
                {sideUnavailable && !storeDown && purchasesUsable && side === 'own_ai' && (
                  <Text style={[u.expoGoText, { color: C.textMuted }]}>
                    Your own AI plans are coming to this version soon.
                  </Text>
                )}
                {(storeDown || (sideUnavailable && side === 'drona')) && purchasesUsable && (
                  <TouchableOpacity
                    onPress={() => { track('paywall_store_retry', { source, context }); setLoading(true); setStoreTry((n) => n + 1); }}
                    accessibilityRole="button"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={[u.expoGoText, { color: C.textMuted }]}>
                      {`Couldn't reach ${STORE_NAME}. Tap to try again.`}
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
            {/* Prices sit in the fixed footer, right above the button, so they
                are never scrolled away (the features scroll on short phones). */}
            {!loading && !sideUnavailable && (
              <View style={u.pwPrices}>
                <PriceBoxes
                  periods={SIDE_PERIODS[side]}
                  prices={sidePrices}
                  selected={period}
                  onSelect={selectPeriod}
                  disabled={purchasing || verifying}
                />
              </View>
            )}
            <Animated.View style={ctaPulseStyle}>
              <PressableScale
                onPress={handlePurchase}
                disabled={purchasing || verifying || loading || pendingOrder || activationPending || !selectedPrice}
                style={[u.cta, Shadow.playBtn, { backgroundColor: PAYWALL_LIME }, (loading || pendingOrder || activationPending || !selectedPrice) && { opacity: 0.7 }]}
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
                    <OrbLoader size="small" color={Colors.primaryFg} />
                    <Text style={u.ctaText}>Confirming with {STORE_NAME}…</Text>
                  </>
                ) : verifying ? (
                  <>
                    <OrbLoader size="small" color={Colors.primaryFg} />
                    <Text style={u.ctaText}>{buyingConnect ? 'Activating…' : 'Activating Pro…'}</Text>
                  </>
                ) : pendingOrder ? (
                  <Text style={u.ctaText}>Waiting for your bank</Text>
                ) : activationPending ? (
                  <Text style={u.ctaText}>Payment received</Text>
                ) : (
                  <Text style={u.ctaText}>{ctaLabel}</Text>
                )}
              </PressableScale>
            </Animated.View>
            {selectedPrice && (
              <Text style={[u.pwPriceLine, { color: C.textSecondary }]}>
                {priceLine(period, selectedPrice, selectedTrial)}
              </Text>
            )}
            {/* 2026-10-23: the trust line ("No payment today · Miss your goal?
                Full refund.") is gone at the owner's call to cut clutter. The
                trial still reads off the badges and the CTA, and the goal
                refund rules stay in the Terms. */}
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
                  <OrbLoader size="small" color={C.textMuted} />
                ) : (
                  <Text style={[u.footLink, { color: C.textMuted }]}>Restore</Text>
                )}
              </TouchableOpacity>
              {/* One item, two links: Apple wants both pages on a paywall,
                  and one item leaves room for "Have a code?". */}
              <View style={u.legalPair}>
                <TouchableOpacity
                  onPress={() => Linking.openURL('https://tryoverload.app/terms.html')}
                  accessibilityRole="link"
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 4 }}
                >
                  <Text style={[u.footLink, { color: C.textMuted }]}>Terms</Text>
                </TouchableOpacity>
                <Text style={[u.footLink, { color: C.textMuted }]}>{' & '}</Text>
                <TouchableOpacity
                  onPress={() => Linking.openURL('https://tryoverload.app/privacy.html')}
                  accessibilityRole="link"
                  hitSlop={{ top: 10, bottom: 10, left: 4, right: 10 }}
                >
                  <Text style={[u.footLink, { color: C.textMuted }]}>Privacy</Text>
                </TouchableOpacity>
              </View>
              {/* Friend, campaign or store discount code: the invite screen
                  takes all three. A locked new account leaves the paywall
                  this way when a code gives it Pro. */}
              <TouchableOpacity
                onPress={() => { track('paywall_code_tapped', { source, context }); router.push('/invite' as any); }}
                disabled={purchasing || verifying || restoring}
                accessibilityRole="button"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[u.footLink, { color: C.textMuted }]}>Have a code?</Text>
              </TouchableOpacity>
              {isLocked && (
                <TouchableOpacity
                  onPress={handleSignOut}
                  disabled={purchasing || verifying || restoring}
                  accessibilityRole="button"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={[u.footLink, { color: C.textMuted }]}>Sign out</Text>
                </TouchableOpacity>
              )}
              {isLocked && (
                <TouchableOpacity
                  onPress={handleDeleteAccount}
                  disabled={deleting || purchasing || verifying || restoring}
                  accessibilityRole="button"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={[u.footLink, { color: C.textMuted }]}>{deleting ? 'Deleting…' : 'Delete account'}</Text>
                </TouchableOpacity>
              )}
              {/* Paid but still locked (a store webhook that never landed)
                  and Restore can't fix it: a person to write to. */}
              {isLocked && (
                <TouchableOpacity
                  onPress={() => {
                    // No mail app: say where to write instead.
                    Linking.openURL('mailto:support@tryoverload.app?subject=Overload%20Pro%20help').catch(() => {
                      toast.info('Email us at support@tryoverload.app', { durationMs: 8000 });
                    });
                  }}
                  accessibilityRole="link"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={[u.footLink, { color: C.textMuted }]}>Help</Text>
                </TouchableOpacity>
              )}
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
              {outcome && isConnectPlan(outcome.plan)
                ? outcome.plan === 'connect_lifetime'
                  ? 'Overload Connect is yours for good. Connect your AI in Profile.'
                  : outcome.onTrial
                    ? `${outcome.trialDays > 0 ? `Your ${outcome.trialDays} free days start` : 'Your free trial starts'} now. Connect your AI in Profile.`
                    : 'Overload Connect is active. Connect your AI in Profile.'
                : outcome?.plan === 'founding_lifetime'
                ? "Founding member. Overload Pro is yours for good, and I'm yours to keep."
                : outcome?.onTrial
                  ? `Your ${outcome.trialDays > 0 ? `${outcome.trialDays} days` : 'free trial'} ${outcome.trialDays > 0 ? 'start' : 'starts'} now. I'll remind you before anything is charged.`
                  : "Overload Pro is active. Give me a week of your training and judge me on the results."}
            </Animated.Text>
            <Animated.View
              entering={FadeInDown.delay(320).duration(400)}
              style={[u.unlockCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
            >
              {(outcome && isConnectPlan(outcome.plan)
                ? ['Food and workout tracker', 'Log in ChatGPT, Claude, and more', 'Charts and history']
                : ['Unlimited coach chat', 'Unlimited AI food logs', 'A plan made for you, updated every week']
              ).map((line, i) => (
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
  // The orb box carries a halo, so trim it above; leave room below so the
  // sphere and the bubble do not crowd each other.
  trustOrb: { marginTop: -Spacing.md, marginBottom: Spacing.sm },
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
    flexGrow: 1,
    paddingHorizontal: Spacing.xxl,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  planSpacer: { flexGrow: 1, minHeight: Spacing.lg },
  // Two-sided paywall (2026-11-12).
  pwTitle: {
    fontFamily: FontFamily.onboardingHeading,
    fontSize: 24,
    lineHeight: 29,
    letterSpacing: -0.5,
    marginTop: 0,
    marginBottom: 14,
  },
  pwSub: { fontSize: 13, textAlign: 'center', marginTop: 7, marginBottom: 11, fontFamily: FontFamily.onboardingBody },
  pwGap: { height: 12 },
  pwPrices: { marginBottom: 12 },
  pwPriceLine: { fontSize: 12, textAlign: 'center', marginTop: 8, fontFamily: FontFamily.onboardingBody },
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
  // Up to six links (Restore, Terms, Privacy, Have a code?, and when locked
  // Sign out and Help): a smaller gap, and they wrap on narrow phones.
  footLinks: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    columnGap: Spacing.lg,
    rowGap: Spacing.sm,
    marginTop: Spacing.lg,
  },
  footLink: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  legalPair: { flexDirection: 'row', alignItems: 'center' },

  expoGoNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.lg,
  },
  expoGoText: { flex: 1, fontSize: FontSize.xs, lineHeight: 18 },
});
