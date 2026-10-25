/**
 * MealSuggestions: the user's usual foods for one meal, drawn as ghost rows
 * inside that meal's section, right where they would land.
 *
 * A ghost row is an empty slot: a grey dashed outline, muted name, and a small
 * soft-lime + as its one spot of color. It reads as "not in your day yet"
 * without a lime edge, which the food box owns. It sits in the
 * meal it belongs to, so there is no separate list to scan and no question of
 * where a tap will log. Three show at first; the rest are one tap behind
 * "N more", so a long habit list never pushes the diary down the screen.
 *
 *   tap the row      logs it now: the whole row is the target, not a corner
 *   pencil           opens it in the review card, to change the portion first
 *   Add all          logs every usual (had more than half the time) at once
 *
 * Adding answers at once, before the write lands: the row fills in, its +
 * turns into a check with a small spring, and "Added" replaces the calories.
 * When the diary reloads, the row leaves (fade, the list closes up) and the
 * logged line fades in above it. Add all runs the same beat down the rows,
 * a step apart, so the meal visibly fills itself. A failed write turns the
 * row back (the parent drops its key) and buzzes a warning.
 */
import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, {
  FadeIn, FadeOut, LinearTransition,
  useSharedValue, useAnimatedStyle, withDelay, withSequence, withSpring, withTiming,
} from 'react-native-reanimated';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { formatServing } from '@/lib/foods';
import { DronaMark } from '@/components/coach/DronaMark';
import type { FoodSuggestion } from '@/lib/foodPatterns';

const FIRST_SHOWN = 3;
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
/** The gap between rows when Add all fills a meal. */
const STAGGER_MS = 70;

interface Props {
  items: FoodSuggestion[];
  /** The meal already has food: only the missing usuals are here. */
  mealLogged: boolean;
  mealLabel: string;
  /** Weekday of the day on screen, for "Usual on Sundays". */
  weekday: number;
  /** The day before, as said mid-sentence: "yesterday" or "Monday". */
  fromWord: string;
  /** Keys added and waiting for the diary to catch up: drawn as "Added". */
  addedKeys: ReadonlySet<string>;
  onAdd: (items: FoodSuggestion[], all: boolean) => void;
  onEdit: (item: FoodSuggestion) => void;
}

export function MealSuggestions({ items, mealLogged, mealLabel, weekday, fromWord, addedKeys, onAdd, onEdit }: Props) {
  const { C } = useTheme();
  const [expanded, setExpanded] = useState(false);
  // Add all's wave: each key's place in line. Cleared by a single-row add.
  const [stagger, setStagger] = useState<Map<string, number>>(new Map());
  if (items.length === 0) return null;

  const shown = expanded ? items : items.slice(0, FIRST_SHOWN);
  const hidden = items.length - shown.length;
  const open = items.filter((s) => !addedKeys.has(s.key));
  const usual = open.filter((s) => s.usual);
  const usualKcal = Math.round(usual.reduce((t, s) => t + s.kcal, 0));
  // No habit yet: the rows are the day before's meal, and the title says so.
  const fromPrev = items.every((s) => s.reason === 'previous_day');
  const title = fromPrev
    ? `From ${fromWord}`
    : mealLogged ? 'You usually have this too' : `Your usual ${mealLabel.toLowerCase()}`;
  // Add all fills top to bottom: each row's beat waits for the ones above it.
  const order = new Map(usual.map((s, i) => [s.key, i]));

  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(150)} layout={LinearTransition.duration(220)} style={s.wrap}>
      <View style={s.head}>
        <DronaMark size={9} color={C.accentText} state="static" />
        <Text style={[s.headTxt, { color: C.textMuted }]} numberOfLines={1}>{title}</Text>
        <View style={{ flex: 1 }} />
        {usual.length > 1 && (
          <Pressable
            onPress={() => {
              setStagger(new Map(order));
              onAdd(usual, true);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={fromPrev
              ? `Add all ${usual.length} foods from ${fromWord}, ${usualKcal} calories`
              : `Add all ${usual.length} usual foods, ${usualKcal} calories`}
          >
            <Text style={[s.addAll, { color: C.textSecondary }]}>{`Add all · ${usualKcal}`}</Text>
          </Pressable>
        )}
      </View>

      {shown.map((it) => (
        <SuggestionRow
          key={it.key}
          item={it}
          added={addedKeys.has(it.key)}
          delayMs={(stagger.get(it.key) ?? 0) * STAGGER_MS}
          why={it.reason === 'weekday' ? `Usual on ${WEEKDAYS[weekday]}` : null}
          onAdd={() => { setStagger(new Map()); onAdd([it], false); }}
          onEdit={() => onEdit(it)}
        />
      ))}

      {items.length > FIRST_SHOWN && (
        <Pressable onPress={() => setExpanded((e) => !e)} hitSlop={8} style={s.more} accessibilityRole="button">
          <Text style={[s.moreTxt, { color: C.textMuted }]}>{expanded ? 'Show less' : `${hidden} more you have here`}</Text>
          <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={12} color={C.textMuted} />
        </Pressable>
      )}
    </Animated.View>
  );
}

function SuggestionRow({ item, added, delayMs, why, onAdd, onEdit }: {
  item: FoodSuggestion;
  added: boolean;
  delayMs: number;
  why: string | null;
  onAdd: () => void;
  onEdit: () => void;
}) {
  const { C } = useTheme();
  // 0 = a suggestion, 1 = added. Drives the fill; the icon gets its own pop.
  const fill = useSharedValue(added ? 1 : 0);
  const pop = useSharedValue(1);
  // The icon and the words flip when the row's beat starts, not on the tap,
  // so Add all reads as a wave rather than every row at once.
  const [shownAdded, setShownAdded] = useState(added);

  useEffect(() => {
    if (!added) {
      fill.value = withTiming(0, { duration: 160 });
      setShownAdded(false);
      return;
    }
    fill.value = withDelay(delayMs, withTiming(1, { duration: 180 }));
    pop.value = withDelay(delayMs, withSequence(
      withTiming(0.55, { duration: 90 }),
      withSpring(1, { damping: 9, stiffness: 280, mass: 0.6 }),
    ));
    const t = setTimeout(() => setShownAdded(true), delayMs + 90);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [added]);

  const tint = useAnimatedStyle(() => ({ opacity: fill.value }));
  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(220)}
      layout={LinearTransition.duration(220)}
      style={s.rowWrap}
    >
      <Pressable
        onPress={onAdd}
        disabled={added}
        // A grey dashed outline: an empty slot waiting for this food. Grey, not
        // lime, so the food box keeps the loudest edge on the screen. textDim at
        // half alpha, not C.border: border is 8% black on light, and a dash
        // that thin vanishes.
        style={({ pressed }) => [
          s.row,
          {
            borderColor: shownAdded ? C.accentText : `${C.textDim}80`,
            borderStyle: shownAdded ? 'solid' : 'dashed',
          },
          pressed && { backgroundColor: C.muted },
        ]}
        accessibilityRole="button"
        accessibilityState={{ disabled: added }}
        accessibilityLabel={added
          ? `${item.food_name}, added`
          : `Add ${item.food_name}, ${formatServing(item.quantity, item.serving_unit)}, ${Math.round(item.kcal)} calories`}
      >
        {/* The fill sits under the content and fades in, so the row reads as
            becoming a logged line rather than swapping to one. */}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, s.tint, { backgroundColor: `${C.accentText}1F` }, tint]} />
        {/* The row's one spot of color: a small soft-lime +. Solid lime with
            a check once added. */}
        <Animated.View style={[s.icon, shownAdded
          ? { backgroundColor: C.accentText, borderColor: C.accentText }
          : { backgroundColor: C.primaryMuted, borderColor: C.primaryBorder }, iconStyle]}
        >
          <Feather name={shownAdded ? 'check' : 'plus'} size={11} color={shownAdded ? C.background : C.accentText} />
        </Animated.View>
        <Text style={[s.name, { color: shownAdded ? C.foreground : C.textSecondary }]} numberOfLines={1}>
          {item.food_name} <Text style={[s.serving, { color: C.textMuted }]}>· {formatServing(item.quantity, item.serving_unit)}</Text>
        </Text>
        {why && !shownAdded && <Text style={[s.why, { color: C.textSecondary }]} numberOfLines={1}>{why}</Text>}
        {shownAdded
          ? <Text style={[s.addedTxt, { color: C.accentText }]}>Added</Text>
          : <Text style={[s.kcal, { color: C.textMuted }]}>{`${Math.round(item.kcal)} cal`}</Text>}
      </Pressable>
      {/* A sibling, not nested: VoiceOver can fold a nested Pressable into the
          row's button and leave it unreachable. */}
      <Pressable
        onPress={onEdit}
        disabled={added}
        hitSlop={10}
        style={[s.edit, { opacity: added ? 0 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={`Change the portion of ${item.food_name} before adding`}
      >
        <Feather name="edit-2" size={13} color={C.textMuted} />
      </Pressable>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: Spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
  headTxt: { fontSize: FontSize.xs, flexShrink: 1 },
  addAll: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  rowWrap: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginTop: 6 },
  row: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    borderWidth: 1, borderRadius: Radius.md, overflow: 'hidden',
    paddingVertical: 9, paddingLeft: 10, paddingRight: Spacing.md,
  },
  tint: { borderRadius: Radius.md },
  icon: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  name: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  serving: { fontSize: FontSize.xs, fontWeight: FontWeight.regular },
  why: { fontSize: FontSize.xs, fontWeight: FontWeight.medium, flexShrink: 0 },
  kcal: { fontSize: FontSize.xs, fontVariant: ['tabular-nums'] },
  addedTxt: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  edit: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  // A full-height row, not a line of text: "Add to <meal>" sits right below
  // with its own hitSlop, and a short target here lost taps to it.
  more: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, marginTop: 2, marginBottom: Spacing.xs, paddingLeft: 2 },
  moreTxt: { fontSize: FontSize.xs },
});
