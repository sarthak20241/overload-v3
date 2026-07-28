/**
 * Milestone upsell (paywall v3, surface 3): an inline dashboard card that
 * appears for FREE users only, right after something worth celebrating (a
 * `victory` insight: PR, streak week, volume record). Compliment first,
 * offer second, in Drona's voice. "Show me" opens the reusable /upgrade
 * paywall with the milestone headline.
 *
 * Deliberately hard to be annoyed by:
 *   - never an interstitial, never on app open — it rides the insights data
 *     the dashboard already computed;
 *   - at most one appearance per 7 days (SHOW_COOLDOWN);
 *   - "Not now" suppresses it for 14 days (SNOOZE_MS);
 *   - paid/trialing users never see it at all.
 *
 * All gating lives in this component so the dashboard wires it in one line.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Colors, FontSize, FontWeight, LetterSpacing, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useCoachAccess } from '@/hooks/useCoachAccess';
import type { Insight } from '@/lib/insights';

const LAST_SHOWN_KEY = 'milestone_upsell_last_shown_v1';
const SNOOZE_KEY = 'milestone_upsell_snooze_until_v1';
const SHOW_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
const SNOOZE_MS = 14 * 24 * 3600 * 1000;

export function MilestoneUpsellCard({ insights }: { insights: Insight[] }) {
  const { C } = useTheme();
  const router = useRouter();
  const { access } = useCoachAccess();
  const victory = insights.find((i) => i.type === 'victory') ?? null;

  // null = still reading the timestamps; false = gated off; true = show.
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (access.state !== 'free' || !victory) {
      setEligible(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [lastShownRaw, snoozeRaw] = await Promise.all([
          AsyncStorage.getItem(LAST_SHOWN_KEY),
          AsyncStorage.getItem(SNOOZE_KEY),
        ]);
        const now = Date.now();
        const lastShown = lastShownRaw ? Number(lastShownRaw) : 0;
        const snoozeUntil = snoozeRaw ? Number(snoozeRaw) : 0;
        const ok = now > snoozeUntil && now - lastShown > SHOW_COOLDOWN_MS;
        if (cancelled) return;
        setEligible(ok);
        // Count this appearance against the cooldown the moment it renders,
        // so backgrounding and reopening all week doesn't re-show it.
        if (ok) AsyncStorage.setItem(LAST_SHOWN_KEY, String(now)).catch(() => {});
      } catch {
        if (!cancelled) setEligible(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [access.state, victory]);

  const handleShowMe = useCallback(() => {
    router.push({ pathname: '/upgrade', params: { context: 'milestone' } });
  }, [router]);

  const handleNotNow = useCallback(() => {
    setDismissed(true);
    AsyncStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)).catch(() => {});
  }, []);

  if (!victory || !eligible || dismissed) return null;

  return (
    <Animated.View
      entering={FadeInDown.duration(400)}
      style={[m.card, { backgroundColor: C.primaryMuted, borderColor: C.primaryBorder }]}
    >
      <Text style={[m.eyebrow, { color: C.accentText }]}>COACH DRONA</Text>
      <Text style={[m.title, { color: C.foreground }]}>I saw that. {victory.title}</Text>
      <Text style={[m.body, { color: C.textSecondary }]}>
        Want your next four weeks programmed around it? I'll rebalance your
        volume and set new targets.
      </Text>
      <View style={m.actions}>
        <TouchableOpacity
          onPress={handleShowMe}
          style={m.cta}
          accessibilityRole="button"
          accessibilityLabel="Show me Overload Pro"
        >
          <Text style={m.ctaText}>Show me</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleNotNow}
          accessibilityRole="button"
          accessibilityLabel="Not now"
        >
          <Text style={[m.dismissText, { color: C.textMuted }]}>Not now</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const m = StyleSheet.create({
  card: {
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.lg,
    borderWidth: 1,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
  },
  eyebrow: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    marginBottom: Spacing.xs,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.snug,
    marginBottom: Spacing.xs,
  },
  body: {
    fontSize: FontSize.md,
    lineHeight: 19,
    marginBottom: Spacing.md,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.lg,
  },
  cta: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm + 1,
  },
  ctaText: {
    color: Colors.primaryFg,
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
  },
  dismissText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
  },
});
