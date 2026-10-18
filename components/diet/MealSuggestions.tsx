/**
 * MealSuggestions: the user's usual foods for one meal, drawn as ghost rows
 * inside that meal's section, right where they would land.
 *
 * A ghost row is the logged row's outline without its fill: dashed border, no
 * card, muted name. It reads as "not in your day yet", and it sits in the
 * meal it belongs to, so there is no separate list to scan and no question of
 * where a tap will log. Three show at first; the rest are one tap behind
 * "N more", so a long habit list never pushes the diary down the screen.
 *
 *   +  on a row      logs it now (the diary row then wears an Undo)
 *   tap the row      opens it in the review card, to change the portion first
 *   Add all          logs every usual (had more than half the time) at once
 */
import { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { formatServing } from '@/lib/foods';
import { DronaMark } from '@/components/coach/DronaMark';
import type { FoodSuggestion } from '@/lib/foodPatterns';

const FIRST_SHOWN = 3;
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

interface Props {
  items: FoodSuggestion[];
  /** The meal already has food: only the missing usuals are here. */
  mealLogged: boolean;
  mealLabel: string;
  /** Weekday of the day on screen, for "Usual on Sundays". */
  weekday: number;
  /** A key currently being written, so its + shows progress and cannot double-log. */
  busyKey: string | null;
  onAdd: (items: FoodSuggestion[], all: boolean) => void;
  onEdit: (item: FoodSuggestion) => void;
}

export function MealSuggestions({ items, mealLogged, mealLabel, weekday, busyKey, onAdd, onEdit }: Props) {
  const { C } = useTheme();
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  const shown = expanded ? items : items.slice(0, FIRST_SHOWN);
  const hidden = items.length - shown.length;
  const usual = items.filter((s) => s.usual);
  const usualKcal = Math.round(usual.reduce((t, s) => t + s.kcal, 0));
  const busy = busyKey != null;
  const title = mealLogged ? 'You usually have this too' : `Your usual ${mealLabel.toLowerCase()}`;

  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(150)} layout={LinearTransition.duration(200)} style={s.wrap}>
      <View style={s.head}>
        <DronaMark size={9} color={C.accentText} state="static" />
        <Text style={[s.headTxt, { color: C.textMuted }]} numberOfLines={1}>{title}</Text>
        <View style={{ flex: 1 }} />
        {usual.length > 1 && (
          <Pressable
            onPress={() => onAdd(usual, true)}
            disabled={busy}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Add all ${usual.length} usual foods, ${usualKcal} calories`}
          >
            <Text style={[s.addAll, { color: C.accentText, opacity: busy ? 0.4 : 1 }]}>
              {`Add all · ${usualKcal}`}
            </Text>
          </Pressable>
        )}
      </View>

      {shown.map((it) => {
        const rowBusy = busyKey === it.key || busyKey === '*';
        const why = it.reason === 'weekday' ? `Usual on ${WEEKDAYS[weekday]}` : null;
        return (
          <Animated.View key={it.key} entering={FadeIn.duration(180)} layout={LinearTransition.duration(200)} style={s.rowWrap}>
            <Pressable
              onPress={() => onEdit(it)}
              disabled={busy}
              style={({ pressed }) => [s.row, { borderColor: C.border, backgroundColor: pressed ? C.card : 'transparent' }]}
              accessibilityRole="button"
              accessibilityLabel={`${it.food_name}, ${formatServing(it.quantity, it.serving_unit)}, ${Math.round(it.kcal)} calories. Tap to change the portion before adding`}
            >
              <Text style={[s.name, { color: C.textSecondary }]} numberOfLines={1}>
                {it.food_name} <Text style={[s.serving, { color: C.textMuted }]}>· {formatServing(it.quantity, it.serving_unit)}</Text>
              </Text>
              {why && <Text style={[s.why, { color: C.accentText }]} numberOfLines={1}>{why}</Text>}
              <Text style={[s.kcal, { color: C.textMuted }]}>{`${Math.round(it.kcal)} cal`}</Text>
            </Pressable>
            <Pressable
              onPress={() => onAdd([it], false)}
              disabled={busy}
              hitSlop={10}
              style={[s.plus, { borderColor: C.accentText, opacity: busy && !rowBusy ? 0.4 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel={`Add ${it.food_name}`}
            >
              <Feather name={rowBusy ? 'loader' : 'plus'} size={13} color={C.accentText} />
            </Pressable>
          </Animated.View>
        );
      })}

      {(hidden > 0 || expanded) && items.length > FIRST_SHOWN && (
        <Pressable onPress={() => setExpanded((e) => !e)} hitSlop={8} style={s.more} accessibilityRole="button">
          <Text style={[s.moreTxt, { color: C.textMuted }]}>{expanded ? 'Show less' : `${hidden} more you have here`}</Text>
          <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={12} color={C.textMuted} />
        </Pressable>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: Spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
  headTxt: { fontSize: FontSize.xs, flexShrink: 1 },
  addAll: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  rowWrap: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: 6 },
  row: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    borderWidth: 1, borderStyle: 'dashed', borderRadius: Radius.md,
    paddingVertical: 9, paddingHorizontal: Spacing.md,
  },
  name: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  serving: { fontSize: FontSize.xs, fontWeight: FontWeight.regular },
  why: { fontSize: FontSize.xs, fontWeight: FontWeight.medium, flexShrink: 0 },
  kcal: { fontSize: FontSize.xs, fontVariant: ['tabular-nums'] },
  plus: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  // A full-height row, not a line of text: "Add to <meal>" sits right below
  // with its own hitSlop, and a short target here lost taps to it.
  more: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, marginTop: 2, marginBottom: Spacing.xs, paddingLeft: 2 },
  moreTxt: { fontSize: FontSize.xs },
});
