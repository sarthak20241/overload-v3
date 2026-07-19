/**
 * ParsedMealCard — the confirm step for an AI-parsed meal, pinned above the input.
 *
 * Nothing is logged until the user taps Add. Four states:
 *   analysing — the raw text the user typed + a shimmering "Drona is reading that"
 *   review    — the resolved items (name, serving, per-line macros) each with its
 *               provenance (catalog = unmarked, off/web = "from label", estimate =
 *               "Drona's estimate") and any assumption, PLUS a meal-section selector
 *               (the user places the meal wherever they want) and an explicit
 *               "Add to <section>" button. Drona's one-liner rides along as a preview.
 *   declined  — non-food input: Drona's redirect line + dismiss.
 *   error     — parse/transport failure: message + Retry.
 *
 * The user picks the section and confirms; only then do the entries land in that
 * meal section underneath. Numbers carry receipts: catalog lines are silent,
 * sourced/estimated lines say where they came from.
 */
import React, { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat, Easing,
  useReducedMotion, FadeIn,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow } from '@/constants/theme';
import type { ParsedMeal, ParsedMealItem } from '@/lib/dietData';
import type { MealType } from '@/lib/foods';

export type ParseCardState = 'analysing' | 'review' | 'declined' | 'error';

const MEAL_OPTIONS: { value: MealType; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snacks' },
];

const mealLabel = (m: MealType) => MEAL_OPTIONS.find((o) => o.value === m)?.label ?? 'Snacks';

interface Props {
  state: ParseCardState;
  rawText: string;
  meal?: ParsedMeal | null;
  mealType?: MealType;                       // currently selected section (review)
  message?: string | null;
  adding?: boolean;                          // Add in flight (review)
  saved?: boolean;                           // this parse was saved as a meal/recipe
  onMealTypeChange?: (m: MealType) => void;
  /** Tap a line to correct its serving/quantity/macros before adding. */
  onEditItem?: (index: number) => void;
  onAdd?: () => void;
  onSave?: () => void;                        // save this parse as a meal/recipe
  onRetry?: () => void;
  onDismiss?: () => void;
}

const r0 = (n: number) => Math.round(n);

/** Provenance label for a line. Catalog matches are trusted and stay unmarked;
 *  anything sourced or guessed says so, so numbers always carry receipts. */
function provenance(source: ParsedMealItem['source']): string | null {
  switch (source) {
    case 'off':
    case 'web': return 'from label';
    case 'estimate': return "Drona's estimate";
    case 'manual': return 'edited';
    default: return null; // catalog
  }
}

export function ParsedMealCard({
  state, rawText, meal, mealType, message, adding, saved,
  onMealTypeChange, onEditItem, onAdd, onSave, onRetry, onDismiss,
}: Props) {
  const { C } = useTheme();
  const s = makeStyles(C);
  const selected: MealType = mealType ?? meal?.meal_type ?? 'snack';

  return (
    <Animated.View entering={FadeIn.duration(160)} style={s.card}>
      {!!rawText && <Text style={s.raw} numberOfLines={2}>{rawText}</Text>}

      {state === 'analysing' && <Analysing C={C} />}

      {state === 'review' && meal && (
        <View>
          {meal.items.map((it, i) => {
            const prov = provenance(it.source);
            return (
              <Pressable
                key={i}
                onPress={onEditItem ? () => onEditItem(i) : undefined}
                disabled={!onEditItem}
                style={({ pressed }) => [s.item, i > 0 && s.itemDivider, pressed && s.itemPressed]}
                accessibilityLabel={`Edit ${it.food_name}, ${r0(it.kcal)} calories`}
                accessibilityHint="Opens serving, quantity and macro editing"
              >
                <View style={s.itemHead}>
                  <Text style={s.itemName} numberOfLines={1}>
                    {it.food_name}
                    <Text style={s.serving}>{'  '}{it.quantity !== 1 ? `${it.quantity} × ` : ''}{it.serving_label}</Text>
                  </Text>
                  {prov && <Text style={s.provChip}>{prov}</Text>}
                  {onEditItem && <Feather name="edit-2" size={11} color={C.textMuted} />}
                </View>
                <View style={s.macros}>
                  <Text style={[s.macroNum, { color: C.foreground }]}>{r0(it.kcal)}</Text>
                  <Text style={[s.macroNum, { color: C.macro.protein }]}>{r0(it.protein_g)}g P</Text>
                  <Text style={[s.macroNum, { color: C.macro.carbs }]}>{r0(it.carb_g)}g C</Text>
                  <Text style={[s.macroNum, { color: C.macro.fat }]}>{r0(it.fat_g)}g F</Text>
                </View>
                {it.assumption && <Text style={s.assumption}>{it.assumption}</Text>}
              </Pressable>
            );
          })}

          {/* Section selector — the user decides where this meal goes. */}
          <View style={s.sectionRow}>
            {MEAL_OPTIONS.map((o) => {
              const on = o.value === selected;
              return (
                <Pressable
                  key={o.value}
                  onPress={() => onMealTypeChange?.(o.value)}
                  hitSlop={4}
                  style={[s.chip, on ? s.chipOn : s.chipOff]}
                >
                  <Text style={[s.chipTxt, { color: on ? C.background : C.textSecondary }]}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {meal.drona_line ? (
            <View style={s.dronaRow}>
              <View style={s.avatar}><Feather name="zap" size={10} color={C.accentText} /></View>
              <Text style={s.dronaTxt} numberOfLines={2}>{meal.drona_line}</Text>
            </View>
          ) : null}

          <View style={s.actions}>
            {saved ? (
              <View style={s.savedChip} accessibilityLabel="Saved for next time">
                <Feather name="check" size={13} color={C.accentText} />
                <Text style={s.savedTxt}>Saved</Text>
              </View>
            ) : onSave ? (
              <Pressable onPress={onSave} hitSlop={8} style={s.saveIcon} accessibilityLabel="Save this meal for next time">
                <Feather name="bookmark" size={16} color={C.textSecondary} />
              </Pressable>
            ) : null}
            <Pressable onPress={onDismiss} hitSlop={8} style={s.discard}>
              <Text style={s.discardTxt}>Discard</Text>
            </Pressable>
            <Pressable
              onPress={onAdd}
              disabled={adding}
              style={[s.addBtn, { opacity: adding ? 0.5 : 1 }]}
            >
              <Feather name="plus" size={14} color={C.background} />
              <Text style={s.addTxt}>{adding ? 'Adding...' : `Add to ${mealLabel(selected)}`}</Text>
            </Pressable>
          </View>
        </View>
      )}

      {state === 'declined' && (
        <View style={s.dronaRow}>
          <View style={s.avatar}><Feather name="zap" size={10} color={C.accentText} /></View>
          <Text style={[s.dronaTxt, { flex: 1 }]}>{message ?? "That did not look like food. Tell me what you ate."}</Text>
          {onDismiss && (
            <Pressable onPress={onDismiss} hitSlop={10} style={s.dismiss}>
              <Feather name="x" size={15} color={C.textMuted} />
            </Pressable>
          )}
        </View>
      )}

      {state === 'error' && (
        <View style={s.actions}>
          <Text style={[s.dronaTxt, { flex: 1 }]}>{message ?? 'Drona could not read that one.'}</Text>
          {onDismiss && (
            <Pressable onPress={onDismiss} hitSlop={8} style={s.discard}>
              <Text style={s.discardTxt}>Dismiss</Text>
            </Pressable>
          )}
          {onRetry && (
            <Pressable onPress={onRetry} hitSlop={8} style={s.addBtn}>
              <Feather name="rotate-cw" size={13} color={C.background} />
              <Text style={s.addTxt}>Retry</Text>
            </Pressable>
          )}
        </View>
      )}
    </Animated.View>
  );
}

/** The "Drona is reading that" shimmer while the parse is in flight. */
function Analysing({ C }: { C: ReturnType<typeof useTheme>['C'] }) {
  const s = makeStyles(C);
  const pulse = useSharedValue(0.4);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) { pulse.value = 0.85; return; }
    pulse.value = withRepeat(
      withTiming(1, { duration: 720, easing: Easing.inOut(Easing.ease) }),
      -1, true,
    );
  }, [reduced, pulse]);

  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View style={[s.dronaRow, style]}>
      <View style={s.avatar}><Feather name="zap" size={10} color={C.accentText} /></View>
      <Text style={s.dronaTxt}>Drona is reading that...</Text>
    </Animated.View>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    card: {
      backgroundColor: C.card, borderRadius: Radius.lg, borderWidth: 1,
      borderColor: C.borderSubtle, padding: Spacing.md, ...Shadow.card,
    },
    raw: { fontSize: FontSize.sm, color: C.textDim, marginBottom: Spacing.sm },

    item: { paddingVertical: Spacing.xs },
    itemPressed: { opacity: 0.6 },
    itemDivider: { borderTopWidth: 1, borderTopColor: C.borderSubtle, marginTop: Spacing.xs, paddingTop: Spacing.sm },
    itemHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    itemName: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.medium, color: C.foreground },
    serving: { fontSize: FontSize.sm, color: C.textMuted, fontWeight: FontWeight.regular },
    provChip: {
      fontSize: 10, color: C.textMuted, fontWeight: FontWeight.medium,
      letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase',
    },
    macros: { flexDirection: 'row', gap: Spacing.md, marginTop: 5 },
    macroNum: { fontSize: 11, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
    assumption: { fontSize: FontSize.sm, color: C.textDim, fontStyle: 'italic', marginTop: 4 },

    sectionRow: {
      flexDirection: 'row', gap: 6, marginTop: Spacing.md,
      paddingTop: Spacing.md, borderTopWidth: 1, borderTopColor: C.borderSubtle,
    },
    chip: {
      flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: Radius.md, borderWidth: 1,
    },
    chipOn: { backgroundColor: C.accentText, borderColor: C.accentText },
    chipOff: { backgroundColor: 'transparent', borderColor: C.border },
    chipTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },

    dronaRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: Spacing.md },
    avatar: {
      width: 20, height: 20, borderRadius: 10, backgroundColor: C.primarySubtle,
      alignItems: 'center', justifyContent: 'center',
    },
    dronaTxt: { flex: 1, fontSize: FontSize.sm, lineHeight: 18, color: C.textSecondary },

    actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.md },
    saveIcon: { padding: 8 },
    savedChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 8 },
    savedTxt: { fontSize: FontSize.sm, color: C.accentText, fontWeight: FontWeight.semibold },
    discard: { paddingVertical: 8, paddingHorizontal: 12 },
    discardTxt: { fontSize: FontSize.base, color: C.textSecondary, fontWeight: FontWeight.medium },
    addBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      backgroundColor: C.accentText, borderRadius: Radius.md, paddingVertical: 11,
    },
    addTxt: { fontSize: FontSize.base, color: C.background, fontWeight: FontWeight.semibold },
    dismiss: { padding: 2 },
  });
}
