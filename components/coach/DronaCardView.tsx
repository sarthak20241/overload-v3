import { View, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { PressableScale } from '@/components/ui/PressableScale';
import { DronaMark } from '@/components/coach/DronaMark';
import type { SavedDronaCard } from '@/lib/dronaCard';

// The weekly card from Drona, under the TODAY card on the dashboard. P0 shows
// two kinds, both CALM: a request (do this, it is worth it) and a notice (I am
// reading, not steering). Neither competes with TODAY for the lime, because
// TODAY is still the day's action; this is the week talking.
//
// Every card carries its numbers as chips. A user who cannot check what the
// card claims has to trust it blindly, and one wrong card then costs the lot.

interface Props {
  card: SavedDronaCard;
  /** The request's own action (log a weight, open food, start the session). */
  onAct: () => void;
  /** Got it / not now: the card goes away for this week. */
  onDismiss: () => void;
}

export function DronaCardView({ card, onAct, onDismiss }: Props) {
  const { C } = useTheme();
  const isNotice = card.kind === 'notice';
  const actionLabel = isNotice ? 'Got it' : labelFor(card.payload.action);

  return (
    <View
      style={[
        s.card,
        { backgroundColor: C.card, borderColor: C.borderSubtle },
        Shadow.card,
      ]}
    >
      <View style={s.head}>
        <DronaMark size={22} />
        <Text style={[s.kicker, { color: C.textMuted }]}>
          {isNotice ? 'DRONA NOTICED' : 'DRONA ASKS'}
        </Text>
      </View>

      <Text style={[s.title, { color: C.foreground }]}>{card.title}</Text>
      <Text style={[s.body, { color: C.textSecondary }]}>{card.body}</Text>

      {card.evidence.length > 0 && (
        <View style={s.chips}>
          {card.evidence.slice(0, 3).map((e) => (
            <View key={e.label} style={[s.chip, { backgroundColor: C.muted, borderColor: C.borderSubtle }]}>
              <Text style={[s.chipValue, { color: C.foreground }]}>{e.value}</Text>
              <Text style={[s.chipLabel, { color: C.textDim }]}>{e.label}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={s.actions}>
        <PressableScale
          onPress={isNotice ? onDismiss : onAct}
          style={[s.primary, { backgroundColor: C.foreground }]}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          <Text style={[s.primaryText, { color: C.background }]}>{actionLabel}</Text>
        </PressableScale>
        {!isNotice && (
          <PressableScale
            onPress={onDismiss}
            style={[s.secondary, { borderColor: C.borderSubtle }]}
            accessibilityRole="button"
            accessibilityLabel="Not now"
          >
            <Text style={[s.secondaryText, { color: C.textMuted }]}>Not now</Text>
          </PressableScale>
        )}
      </View>
    </View>
  );
}

function labelFor(action?: string): string {
  switch (action) {
    case 'log_weight':
      return 'Log a weigh-in';
    case 'log_food':
      return 'Log food';
    case 'start_session':
      return 'See what is due';
    default:
      return 'Open';
  }
}

const s = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  kicker: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, letterSpacing: 1 },
  title: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
  body: { fontSize: FontSize.sm, lineHeight: 19 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs, marginTop: Spacing.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    borderRadius: Radius.sm,
    borderWidth: 1,
  },
  chipValue: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  chipLabel: { fontSize: FontSize.xs },
  actions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  primary: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: Radius.md,
    alignItems: 'center',
  },
  primaryText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  secondary: {
    paddingVertical: 11,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  secondaryText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
});
