/**
 * InsightCard — one card in the dashboard's "Coach noticed" strip.
 *
 * Visual language: the accent (icon + kicker + glow) encodes the insight TYPE
 * so the user pre-attends to whether it's a win, a plateau, a warning, or a tip
 * before reading a word. The "Ask Drona" CTA is always the same Drona purple,
 * regardless of accent, so the deep-dive affordance stays learnable — tapping
 * anywhere on the card opens Coach Drona seeded with the insight's question.
 */
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import type { Insight, InsightType } from '@/lib/insights';
import { DronaMark } from '@/components/coach/DronaMark';

// Drona's brand color — the CTA is always this, so "Ask Drona" reads the same
// on every card no matter the accent.
const DRONA = '#a855f7';

type Feature = React.ComponentProps<typeof Feather>['name'];

const TYPE_STYLE: Record<InsightType, { color: string; icon: Feature; kicker: string }> = {
  victory: { color: Colors.success, icon: 'award', kicker: 'WIN' },
  plateau: { color: Colors.warning, icon: 'bar-chart-2', kicker: 'PLATEAU' },
  warning: { color: '#f97316', icon: 'alert-triangle', kicker: 'HEADS UP' },
  suggestion: { color: '#3b82f6', icon: 'trending-up', kicker: 'TIP' },
};

export function InsightCard({
  insight,
  width,
  index,
  onAsk,
  onDismiss,
}: {
  insight: Insight;
  width: number;
  index: number;
  onAsk: (insight: Insight) => void;
  onDismiss: (id: string) => void;
}) {
  const { C } = useTheme();
  const ts = TYPE_STYLE[insight.type];
  // Theme-aware accent for the semantic types so the icon + kicker stay legible
  // on the light theme (the bright base colors fail WCAG AA on white).
  const accent = insight.type === 'victory' ? C.successText
    : insight.type === 'plateau' ? C.warningText
    : ts.color;
  const icon = (insight.icon as Feature) || ts.icon;
  const kicker = insight.kicker || ts.kicker;

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 60).duration(320)}
      style={[styles.card, { width, backgroundColor: C.card, borderColor: C.borderSubtle }]}
    >
      {/* Accent glow — same trick as the dashboard stat cards, tinted by type. */}
      <View style={[styles.glow, { backgroundColor: accent, opacity: 0.05 }]} />

      {/* Dismiss sits above the card press target so it can't trigger onAsk. */}
      <TouchableOpacity
        onPress={() => onDismiss(insight.id)}
        style={styles.dismiss}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityRole="button"
        accessibilityLabel="Dismiss insight"
      >
        <Feather name="x" size={13} color={C.textDim} />
      </TouchableOpacity>

      <TouchableOpacity activeOpacity={0.85} onPress={() => onAsk(insight)} style={styles.pressable}>
        {/* Kicker row */}
        <View style={styles.kickerRow}>
          <View style={[styles.iconChip, { backgroundColor: `${accent}1f` }]}>
            <Feather name={icon} size={13} color={accent} />
          </View>
          <Text style={[styles.kicker, { color: accent }]}>{kicker}</Text>
        </View>

        {/* The "what" */}
        <Text style={[styles.title, { color: C.foreground }]} numberOfLines={2}>
          {insight.title}
        </Text>

        {/* The "why" */}
        <Text style={[styles.body, { color: C.textMuted }]} numberOfLines={3}>
          {insight.body}
        </Text>

        {/* Deep-dive CTA — always Drona purple. */}
        <View style={styles.ctaRow}>
          <DronaMark size={12} color={DRONA} state="static" />
          <Text style={[styles.cta, { color: DRONA }]}>Ask Drona</Text>
          <Feather name="chevron-right" size={13} color={DRONA} />
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
    minHeight: 156,
  },
  glow: {
    position: 'absolute',
    top: -24,
    right: -24,
    width: 96,
    height: 96,
    borderRadius: 48,
  },
  dismiss: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  pressable: {
    flex: 1,
    padding: Spacing.lg,
    gap: 6,
  },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  iconChip: {
    width: 28,
    height: 28,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kicker: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.8,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    letterSpacing: -0.3,
  },
  body: {
    fontSize: FontSize.sm,
    lineHeight: 18,
    flex: 1,
  },
  ctaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  cta: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
});
