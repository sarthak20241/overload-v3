/**
 * The save card for a food or meal Drona built from what the user said.
 *
 * One component for both places a create can come from: Coach Chat, and the
 * "Tell Drona what you ate" box on Nutrition. They receive the same tool output
 * (create_custom_food / create_custom_meal), so they draw the same card, and a
 * fix to one is a fix to both.
 *
 * Nothing is written until the button is tapped. The card's other job is
 * honesty about where the numbers came from: anything Drona estimated is
 * marked, because an unmarked guess reads as a number the user gave.
 */
import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { DronaMark } from '@/components/coach/DronaMark';
import { createActionLabel, type CoachFoodCreate, type CoachFoodCreateResult } from '@/lib/coachFoodCreate';
import type { MealType } from '@/lib/foods';

export function FoodCreateCard({
  create,
  result,
  busy,
  fallbackMeal,
  onApply,
  onDismiss,
  fullWidth = false,
}: {
  create: CoachFoodCreate;
  result: CoachFoodCreateResult | null;
  busy: boolean;
  /** The section a log lands in when Drona did not name one. */
  fallbackMeal: MealType;
  onApply: () => void;
  /** Food bar only: the card sits in the input area and needs a way out. The
   *  chat card scrolls away with the conversation and has no X. */
  onDismiss?: () => void;
  /** Chat bubbles cap at 92%; the food bar card spans its container. */
  fullWidth?: boolean;
}) {
  const { C } = useTheme();
  const done = !!result && !result.error;
  const partial = !!result?.error && !!result.savedMealId;

  const title = result
    ? (partial ? 'Saved, not logged' : result.error ? 'Not saved' : (result.logged ? 'Saved and logged' : 'Saved to My Meals'))
    : (create.kind === 'meal' ? 'Save this meal' : 'Save this food');

  const anyEstimate = create.estimated.length > 0 || create.lines.some((l) => l.estimated);
  const label = createActionLabel(create, fallbackMeal);

  return (
    <Animated.View
      entering={FadeInDown.duration(240)}
      style={[
        s.card,
        { backgroundColor: C.card, borderColor: C.primaryBorder },
        fullWidth ? s.full : s.bubble,
      ]}
    >
      <View style={s.head}>
        <DronaMark size={13} color={C.accentText} state="static" />
        <Text style={[s.title, { color: C.accentText }]}>{title}</Text>
        {onDismiss && !busy && (
          <TouchableOpacity onPress={onDismiss} hitSlop={10} style={s.dismiss} accessibilityLabel="Dismiss">
            <Feather name="x" size={15} color={C.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {!!create.summary && (
        <Text style={[s.summary, { color: C.foreground }]}>{create.summary}</Text>
      )}

      <View style={s.header}>
        <Text style={[s.name, { color: C.foreground }]} numberOfLines={2}>{create.name}</Text>
        <Text style={[s.total, { color: C.textMuted }]}>
          {create.totals.kcal} cal
          {create.totals.proteinG > 0 ? `  ${create.totals.proteinG}g P` : ''}
          {create.totals.carbG > 0 ? `  ${create.totals.carbG}g C` : ''}
          {create.totals.fatG > 0 ? `  ${create.totals.fatG}g F` : ''}
        </Text>
      </View>

      {/* Ingredients, for a meal. A single food is already fully described by
          the header, so repeating it as a one-row list is noise. */}
      {create.kind === 'meal' && (
        <View style={s.list}>
          {create.lines.map((l, i) => (
            <View key={i} style={s.row}>
              <Text style={[s.item, { color: C.foreground }]} numberOfLines={1}>
                {l.quantity !== 1 ? `${l.quantity} ` : ''}{l.name}
                {l.grams ? ` (${l.grams}g)` : ''}
              </Text>
              <Text style={[s.kcal, { color: l.estimated ? C.textDim : C.textMuted }]}>
                {l.kcal} cal{l.estimated ? ' ~' : ''}
              </Text>
            </View>
          ))}
        </View>
      )}

      {anyEstimate && (
        <Text style={[s.note, { color: C.textDim }]}>
          {create.kind === 'meal'
            ? 'The lines marked ~ are my estimate. Tap the meal in My Meals to fix them.'
            : `I estimated the ${create.estimated.map((f) => (f === 'kcal' ? 'calories' : f.replace('_g', ''))).join(', ')}. Change it in My Meals if I am off.`}
        </Text>
      )}

      {result?.error && (
        <Text style={[s.note, { color: C.textMuted }]}>{result.error}</Text>
      )}

      {!done && !partial && (
        <TouchableOpacity
          onPress={onApply}
          disabled={busy}
          style={[s.apply, { backgroundColor: Colors.primary, opacity: busy ? 0.6 : 1 }]}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={label}
        >
          {busy
            ? <ActivityIndicator size="small" color={Colors.primaryFg} />
            : <Feather name="bookmark" size={14} color={Colors.primaryFg} />}
          <Text style={s.applyText}>{label}</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  card: {
    padding: Spacing.lg,
    borderRadius: Radius.lg,
    borderWidth: 1,
    gap: 10,
  },
  bubble: { marginTop: 8, marginBottom: 4, alignSelf: 'flex-start', maxWidth: '92%' },
  full: { alignSelf: 'stretch' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: {
    flex: 1,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  dismiss: { padding: 2 },
  summary: { fontSize: FontSize.sm, lineHeight: 20 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: Spacing.md,
    marginTop: 2,
  },
  name: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  total: { fontSize: FontSize.sm, fontVariant: ['tabular-nums'] },
  list: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.md },
  item: { flex: 1, fontSize: FontSize.sm },
  kcal: { fontSize: FontSize.sm, fontVariant: ['tabular-nums'] },
  note: { fontSize: FontSize.xs, lineHeight: 16, marginTop: 2 },
  apply: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: Radius.md,
    marginTop: 2,
  },
  applyText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.primaryFg },
});
