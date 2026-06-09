/**
 * Paywall — three product cards (Monthly, Annual, Founding Lifetime) that
 * drive the RevenueCat purchase flow and then poll get_coach_access_status
 * until the user's tier flips. Used from:
 *
 *   - CoachAccessGate `trial_ended` screen (primary entry)
 *   - CoachAccessGate `start_trial` (as a "Skip trial, go lifetime" option)
 *   - Inside the chat menu for trialing users (upgrade-anytime affordance)
 *
 * Behavior contract:
 *   1. On mount, fetch RC offerings + founding-tier status in parallel.
 *   2. Render whichever of {monthly, annual, founding_lifetime} are present
 *      in the offering. Hide the lifetime card if it's sold out
 *      (`closed_at` is non-null in get_founding_status).
 *   3. Tap a card → call Purchases.purchasePackage. Apple's payment sheet
 *      appears; user confirms or cancels.
 *   4. On successful purchase, we know iOS confirmed but our DB tier hasn't
 *      flipped yet — that's the RC webhook's job. Poll
 *      get_coach_access_status every 1.5s up to 30s, looking for
 *      state === 'paid'. Then call `refresh()` on the parent's
 *      useCoachAccess hook and close.
 *   5. Cancellation, network failure, or webhook timeout all surface as
 *      toasts; the paywall stays mounted so the user can retry.
 *
 * Expo Go fallback: react-native-purchases needs a native binding, so
 * tapping a card in Expo Go throws PurchasesUnavailableError. We catch it
 * and show a friendly "Need a dev build" toast — the layout still renders,
 * which is good enough to iterate on visuals.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator,
  StyleSheet, Linking,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useToast } from '@/components/ui/Toast';
import { useClerkUser } from '@/hooks/useClerkUser';
import {
  getCoachOfferings,
  purchaseCoachPackage,
  restorePurchases,
  isPurchasesAvailable,
  ensureIdentity,
  PurchasesUnavailableError,
  PurchaseCancelledError,
  type RevenueCatPackage,
  type PlanKey,
} from '@/lib/revenuecat';

interface FoundingStatus {
  tier: string;
  cap: number;
  claimed: number;
  closed_at: string | null;
}

interface PaywallProps {
  supabase: SupabaseClient;
  onClose: () => void;
  // Called after a successful purchase has been verified server-side
  // (state flipped to 'paid'). The parent should call its useCoachAccess
  // `refresh()` here so the modal re-routes to the chat menu.
  onPurchased: () => Promise<void> | void;
}

// Display metadata for each plan. RC's product titles are usually generic
// ("Monthly Subscription"); we override with our own marketing copy.
const PLAN_COPY: Record<PlanKey, { title: string; subtitle: string; badge?: string }> = {
  monthly: {
    title: 'Monthly',
    subtitle: 'Cancel anytime',
  },
  annual: {
    title: 'Annual',
    subtitle: 'Save vs. monthly · billed yearly',
    badge: 'Best value',
  },
  founding_lifetime: {
    title: 'Founding Lifetime',
    subtitle: 'One-time payment · Drona forever',
    badge: 'Limited',
  },
};

const PLAN_ORDER: PlanKey[] = ['annual', 'monthly', 'founding_lifetime'];

export function Paywall({ supabase, onClose, onPurchased }: PaywallProps) {
  const { C } = useTheme();
  const toast = useToast();
  const { user } = useClerkUser();

  const [loading, setLoading] = useState(true);
  const [packages, setPackages] = useState<Partial<Record<PlanKey, RevenueCatPackage>>>({});
  const [founding, setFounding] = useState<FoundingStatus | null>(null);
  const [purchasingPlan, setPurchasingPlan] = useState<PlanKey | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const purchasesUsable = isPurchasesAvailable();

  // Initial data fetch. Run offerings + founding-status in parallel.
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
        const lifetime = rows.find((r) => r.tier === 'founding_lifetime') ?? null;
        setFounding(lifetime);
      } catch (e) {
        if (!cancelled) {
          console.warn('[paywall] load failed:', e);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // Poll the access RPC until state === 'paid', up to a timeout. Called
  // after a successful purchasePackage() so we don't dismiss the paywall
  // before the RC webhook has actually flipped user_profiles.tier.
  const waitForTierFlip = useCallback(async (): Promise<boolean> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const { data } = await supabase.rpc('get_coach_access_status');
        if ((data as { state?: string } | null)?.state === 'paid') return true;
      } catch {
        // Network blip — keep polling.
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }, [supabase]);

  const handlePurchase = useCallback(
    async (plan: PlanKey) => {
      const pkg = packages[plan];
      if (!pkg) {
        toast.error('Plan unavailable. Try again.');
        return;
      }
      if (purchasingPlan) return; // guard double-tap
      setPurchasingPlan(plan);
      try {
        // Belt-and-suspenders: guarantee the SDK is logged in as the Clerk
        // user BEFORE the transaction, so the purchase is attributed to the
        // Clerk id (not an anonymous RC id). Without this, the webhook's
        // app_user_id wouldn't match user_profiles.clerk_user_id and the
        // tier would never flip.
        if (user?.id) await ensureIdentity(user.id);
        await purchaseCoachPackage(pkg);
        // iOS confirmed the transaction; RC webhook will tell our backend
        // to flip the tier. Poll until we see it.
        setPurchasingPlan(null);
        setVerifying(true);
        const flipped = await waitForTierFlip();
        if (flipped) {
          toast.success("You're in. Welcome to Coach Drona.");
          await onPurchased();
          onClose();
        } else {
          toast.info(
            "Purchase received — we're finalizing. Pull to refresh or relaunch in a minute.",
            { durationMs: 8000 },
          );
        }
      } catch (e) {
        if (e instanceof PurchaseCancelledError) {
          // User backed out of the Apple sheet — no toast needed.
        } else if (e instanceof PurchasesUnavailableError) {
          toast.error(e.message, { durationMs: 6000 });
        } else {
          console.warn('[paywall] purchase failed:', e);
          toast.error('Purchase failed. Try again or contact support.');
        }
      } finally {
        setPurchasingPlan(null);
        setVerifying(false);
      }
    },
    [packages, purchasingPlan, waitForTierFlip, toast, onClose, onPurchased, user],
  );

  const handleRestore = useCallback(async () => {
    if (restoring) return;
    setRestoring(true);
    try {
      const info = await restorePurchases();
      if (!info) {
        toast.info('Purchases unavailable in this build.');
        return;
      }
      const hasActive = Object.values(info.entitlements?.active ?? {}).some(
        (e) => e.isActive,
      );
      if (hasActive) {
        const flipped = await waitForTierFlip();
        if (flipped) {
          toast.success('Restored. Welcome back.');
          await onPurchased();
          onClose();
        } else {
          toast.info("Restored — we're finalizing. Try again in a minute.");
        }
      } else {
        toast.info('No previous purchases on this Apple ID.');
      }
    } catch (e) {
      console.warn('[paywall] restore failed:', e);
      toast.error('Restore failed. Try again later.');
    } finally {
      setRestoring(false);
    }
  }, [restoring, waitForTierFlip, toast, onPurchased, onClose]);

  const foundingSoldOut =
    founding !== null
    && (founding.closed_at !== null || founding.claimed >= founding.cap);
  const foundingLeft = founding ? Math.max(0, founding.cap - founding.claimed) : null;

  return (
    <View style={{ flex: 1 }}>
      <View style={s.header}>
        <TouchableOpacity
          onPress={onClose}
          style={[s.closeCircle, { backgroundColor: C.muted }]}
          accessibilityLabel="Close paywall"
        >
          <Feather name="x" size={16} color={C.foreground} />
        </TouchableOpacity>
        <Text style={[s.title, { color: C.foreground }]}>Choose your plan</Text>
        <TouchableOpacity
          onPress={handleRestore}
          disabled={restoring}
          style={s.restoreBtn}
          accessibilityLabel="Restore purchases"
        >
          {restoring ? (
            <ActivityIndicator size="small" color={C.foreground} />
          ) : (
            <Text style={[s.restoreText, { color: C.mutedFg }]}>Restore</Text>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.body}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[s.tagline, { color: C.mutedFg }]}>
          Train with Coach Drona — direct, demanding, built for serious lifters.
          One subscription unlocks chat, plan generation, and workout templates.
        </Text>

        {loading ? (
          <View style={s.spinnerWrap}>
            <ActivityIndicator color={C.foreground} />
          </View>
        ) : (
          <View style={s.plansWrap}>
            {PLAN_ORDER.map((plan) => {
              const pkg = packages[plan];
              const copy = PLAN_COPY[plan];
              const isLifetime = plan === 'founding_lifetime';
              if (isLifetime && foundingSoldOut) {
                // Don't show a sold-out card — the AppSumo path covers that
                // case separately and we don't want to tease unavailability.
                return null;
              }
              const disabled = !pkg || purchasingPlan !== null || verifying;
              const isThisPurchasing = purchasingPlan === plan;
              const highlight = plan === 'annual';
              const priceLabel = pkg?.product?.priceString ?? '—';
              const sub = isLifetime && foundingLeft !== null
                ? `${foundingLeft} of ${founding!.cap} spots left`
                : copy.subtitle;

              return (
                <TouchableOpacity
                  key={plan}
                  onPress={() => handlePurchase(plan)}
                  disabled={disabled}
                  activeOpacity={0.85}
                  style={[
                    s.planCard,
                    {
                      backgroundColor: highlight ? C.primarySubtle : C.card,
                      borderColor: highlight ? Colors.primary : C.borderSubtle,
                      borderWidth: highlight ? 2 : 1,
                      opacity: !pkg ? 0.5 : 1,
                    },
                  ]}
                >
                  <View style={s.planTop}>
                    <Text style={[s.planTitle, { color: C.foreground }]}>{copy.title}</Text>
                    {copy.badge && (
                      <View style={[
                        s.badge,
                        { backgroundColor: highlight ? Colors.primary : C.muted },
                      ]}>
                        <Text
                          style={[
                            s.badgeText,
                            { color: highlight ? Colors.primaryFg : C.foreground },
                          ]}
                        >
                          {copy.badge}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={[s.planPrice, { color: C.foreground }]}>
                    {priceLabel}
                    {plan === 'monthly' && pkg && (
                      <Text style={[s.planPriceUnit, { color: C.mutedFg }]}> / month</Text>
                    )}
                    {plan === 'annual' && pkg && (
                      <Text style={[s.planPriceUnit, { color: C.mutedFg }]}> / year</Text>
                    )}
                  </Text>
                  <Text style={[s.planSub, { color: C.mutedFg }]}>{sub}</Text>
                  {isThisPurchasing && (
                    <View style={s.purchasingOverlay}>
                      <ActivityIndicator color={Colors.primaryFg} />
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}

            {!purchasesUsable && (
              <View style={[s.expoGoNote, { backgroundColor: C.muted }]}>
                <Feather name="info" size={14} color={C.mutedFg} />
                <Text style={[s.expoGoText, { color: C.mutedFg }]}>
                  In-app purchases require a TestFlight or App Store build.
                  The buttons above will explain this when tapped.
                </Text>
              </View>
            )}
          </View>
        )}

        {verifying && (
          <View style={s.verifyingBanner}>
            <ActivityIndicator color={C.foreground} />
            <Text style={[s.verifyingText, { color: C.foreground }]}>
              Verifying your purchase…
            </Text>
          </View>
        )}

        <View style={s.legal}>
          <Text style={[s.legalText, { color: C.mutedFg }]}>
            Subscriptions auto-renew until cancelled. Manage in Settings → Apple ID →
            Subscriptions.{' '}
            <Text
              style={[s.legalLink, { color: C.foreground }]}
              onPress={() => Linking.openURL('https://tryoverload.app/terms.html')}
            >
              Terms
            </Text>
            {' · '}
            <Text
              style={[s.legalLink, { color: C.foreground }]}
              onPress={() => Linking.openURL('https://tryoverload.app/privacy.html')}
            >
              Privacy
            </Text>
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  closeCircle: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  restoreBtn: {
    minWidth: 60,
    alignItems: 'flex-end',
  },
  restoreText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  body: {
    flexGrow: 1,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xl,
  },
  tagline: {
    fontSize: FontSize.base,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: Spacing.xl,
  },
  spinnerWrap: {
    paddingVertical: Spacing.xxxl,
    alignItems: 'center',
  },
  plansWrap: {
    gap: Spacing.md,
  },
  planCard: {
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    position: 'relative',
  },
  planTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  planTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.md,
  },
  badgeText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  planPrice: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    marginTop: 2,
  },
  planPriceUnit: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.regular,
  },
  planSub: {
    fontSize: FontSize.sm,
    marginTop: 4,
  },
  purchasingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.xl,
  },
  expoGoNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    marginTop: Spacing.md,
  },
  expoGoText: {
    flex: 1,
    fontSize: FontSize.xs,
    lineHeight: 18,
  },
  verifyingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    marginTop: Spacing.lg,
    justifyContent: 'center',
  },
  verifyingText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  legal: {
    marginTop: Spacing.xxl,
    paddingHorizontal: Spacing.md,
  },
  legalText: {
    fontSize: FontSize.xs,
    lineHeight: 16,
    textAlign: 'center',
  },
  legalLink: {
    textDecorationLine: 'underline',
  },
});
