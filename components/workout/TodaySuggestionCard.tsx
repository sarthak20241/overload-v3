import { View, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight, IconSize } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { PressableScale } from '@/components/ui/PressableScale';

// Element 2: the coach's suggestion for today, and the dashboard's PRIMARY action
// (it leads above the coach card). A LEAN row highlighted by a soft lime TINT fill
// (C.primaryMuted) + a faint lime edge, NOT a bright lime outline (which read odd).
// The icon tile is neutral (C.muted) so it stays legible on the tinted card; the
// lime lives in the fill, the glyph, and the "TODAY" label. The verbs (start /
// edit / discuss) live in the session preview it opens, never in this card.
// Three states: planned | new (lime tint, tappable), rest (calm, not actionable).

export interface TodaySuggestion {
  kind: 'planned' | 'rest' | 'new';
  routine: any | null;
}

interface Props {
  suggestion: TodaySuggestion;
  onPress: () => void;
}

export function TodaySuggestionCard({ suggestion, onPress }: Props) {
  const { C } = useTheme();
  const { kind, routine } = suggestion;

  if (kind === 'rest') {
    return (
      <View style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
        <View style={[s.iconWrap, { backgroundColor: C.muted }]}>
          <Feather name="moon" size={IconSize.sm} color={C.textMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.eyebrow, { color: C.textMuted }]}>TODAY</Text>
          <View style={s.titleRow}>
            <Text style={[s.title, { color: C.foreground }]}>Rest day</Text>
            <Text style={[s.meta, { color: C.textMuted }]}>  ·  recover</Text>
          </View>
        </View>
      </View>
    );
  }

  const isNew = kind === 'new';
  const exCount = routine?.routine_exercises?.length ?? 0;
  const title = isNew ? "Build today's session" : (routine?.name || "Today's session");

  return (
    <PressableScale
      onPress={onPress}
      style={[s.card, { backgroundColor: C.primaryMuted, borderColor: C.primaryBorder }]}
    >
      <View style={[s.iconWrap, { backgroundColor: C.muted }]}>
        <Feather name={isNew ? 'zap' : 'play'} size={IconSize.sm} color={C.accentText} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.eyebrow, { color: C.accentText }]}>TODAY</Text>
        <View style={s.titleRow}>
          <Text style={[s.title, { color: C.foreground, flexShrink: 1 }]} numberOfLines={1}>{title}</Text>
          {!isNew && exCount > 0 ? (
            <Text style={[s.meta, { color: C.textMuted }]} numberOfLines={1}>  ·  {exCount} ex</Text>
          ) : null}
        </View>
      </View>
      <Feather name="chevron-right" size={IconSize.md} color={C.textMuted} />
    </PressableScale>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  eyebrow: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 1 },
  title: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  meta: { fontSize: FontSize.sm },
});
