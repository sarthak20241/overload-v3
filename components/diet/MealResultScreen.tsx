/**
 * MealResultScreen: Drona's read of a meal, full screen, before it goes in.
 *
 * Laid out as a Drona card (components/coach/DronaCardPopup.tsx), size for
 * size: Drona's orb and a kicker, your words as the title, his line as the
 * body, the meal's numbers in the card's proof strip, then the foods, where
 * it goes (meal and day), and a pinned footer with a box to tell Drona what
 * to change and the card's two buttons (Discard outlined, Add filled). The
 * orb rests while the meal waits for you and moves while Drona works on it
 * (a correction, a double-check). Nothing is written until Add.
 *
 * It replaces the popover card, so it keeps everything that card did: memory
 * notes ("Same as you logged on Oct 14") and saved-meal offers ride in as the
 * line's note and Drona's notice, a doubtful line offers a double-check, a
 * line the user also logs another variant of offers the swap, a whole-day
 * message groups its lines by meal, and the tier that ran is in the header.
 * Amounts change in place with - and + (lib/mealReady stepAmount), and a tap
 * on the amount or the line opens the full line editor for the unit, the food
 * and the numbers.
 *
 * A correction typed here keeps the screen up: the meal stays on screen,
 * dimmed, under one "Updating" line until Drona's answer replaces it.
 *
 * Pure view. The screen owns the flow and every callback, so a change here is
 * the change on the meal (nutrition.tsx). Root Portal, never RN <Modal>
 * (Android edge-to-edge, components/ui/Portal.tsx). The screen declares it
 * BEFORE the line editor, save and day sheets so those open on top.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView, TextInput, BackHandler,
} from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import { Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { Portal } from '@/components/ui/Portal';
import { OrbLoader } from '@/components/ui/OrbLoader';
import { PulsingStatus } from '@/components/coach/OrbStage';
import { sectionsOfItems, type ParsedMeal, type ParsedMealItem } from '@/lib/dietData';
import { formatServing, formatMacroGrams, type MealType } from '@/lib/foods';
import { isMeasurementUnit } from '@/lib/units';
import { optionAt, swapLabel } from '@/lib/variantSwap';
import type { ParseSpeed } from '@/lib/parseSpeed';
import { uncertain, provenance } from './ParsedMealCard';

const MEAL_OPTIONS: { value: MealType; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snacks' },
];
const mealLabel = (m: MealType) => MEAL_OPTIONS.find((o) => o.value === m)?.label ?? 'Snacks';

const TIER: Record<ParseSpeed, { icon: 'zap' | 'target' | 'award'; label: string }> = {
  quick: { icon: 'zap', label: 'Quick' },
  thorough: { icon: 'target', label: 'Thorough' },
  precise: { icon: 'award', label: 'Precise' },
};

const r0 = (n: number) => Math.round(n);
/** DronaCardPopup's button height. */
const BUTTON_HEIGHT = 50;

interface Props {
  open: boolean;
  meal: ParsedMeal | null;
  mealType: MealType;
  /** Everything the user wrote for this meal. */
  words: string;
  /** The tier this meal was read with. */
  tier?: ParseSpeed | null;
  /** "Today", "Yesterday", "Sat, Nov 1": the day it goes to. */
  dayLabel: string;
  notice?: string | null;
  proposalLabel?: string | null;
  saved?: boolean;
  adding?: boolean;
  checkingIndex?: number | null;
  /** A correction is being read. The meal stays, dimmed, under this line. */
  updating?: string | null;
  /** Close and keep the meal waiting on Nutrition. */
  onClose: () => void;
  onDiscard: () => void;
  onAdd: () => void;
  onMealTypeChange: (m: MealType) => void;
  onMoveGroup: (from: MealType, to: MealType) => void;
  onPickDay: () => void;
  onEditItem: (i: number) => void;
  onRemoveItem: (i: number) => void;
  onSwapItem: (i: number, k: number) => void;
  onCheckItem: (i: number) => void;
  onStepAmount: (i: number, dir: 1 | -1) => void;
  onAcceptProposal: () => void;
  onDismissNotice: () => void;
  onSave: () => void;
  /** Send a correction ("make it 2 rotis"). */
  onCorrect: (text: string) => void;
  /** Put the words back in the food box to change and send again. */
  onEditWords?: () => void;
}

export function MealResultScreen(props: Props) {
  const {
    open, meal, mealType, words, tier, dayLabel, notice, proposalLabel, saved, adding, checkingIndex, updating,
    onClose, onDiscard, onAdd, onMealTypeChange, onMoveGroup, onPickDay, onEditItem, onRemoveItem, onSwapItem,
    onCheckItem, onStepAmount, onAcceptProposal, onDismissNotice, onSave, onCorrect, onEditWords,
  } = props;
  const { C } = useTheme();
  const s = makeStyles(C);
  const insets = useSafeAreaInsets();
  const { kbHeight } = useKeyboardAwareScroll();
  const [fix, setFix] = useState('');
  const [openGroup, setOpenGroup] = useState<MealType | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);
  // A fresh open starts at the top with an empty box.
  useEffect(() => { if (open) { setFix(''); setOpenGroup(null); } }, [open]);

  if (!open || !meal) return <Portal>{null}</Portal>;

  const busyChecking = checkingIndex != null;
  const busy = !!updating || !!adding;
  // Frozen while a lookup or a correction is in flight: the lines may change
  // under a tap, and Add must never log numbers the user did not see.
  const frozen = busy || busyChecking;
  const items = meal.items;
  const sum = items.reduce(
    (a, it) => ({
      kcal: a.kcal + it.kcal, p: a.p + it.protein_g, c: a.c + it.carb_g, f: a.f + it.fat_g,
      fib: it.fiber_g == null ? a.fib : (a.fib ?? 0) + it.fiber_g,
    }),
    { kcal: 0, p: 0, c: 0, f: 0, fib: null as number | null },
  );
  const sections = sectionsOfItems(items, mealType);
  const multi = sections.length > 1;
  const destination = multi ? `${sections.length} meals` : mealLabel(mealType);
  const title = multi ? 'Your meals' : `Your ${mealLabel(mealType).toLowerCase().replace(/s$/, '')}`;

  const sendFix = () => {
    const t = fix.trim();
    if (!t || busy) return;
    setFix('');
    onCorrect(t);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  const renderRow = (it: ParsedMealItem, i: number, divider: boolean) => {
    const options = it.alternatives ?? [];
    const prov = it.saved_meal ? 'saved meal' : swapLabel(it) ?? provenance(it.source);
    // A saved meal's own rows keep the amount the user saved, which is not
    // always a real portion ("1 g" for a whole bowl), so - and + would scale
    // the wrong thing. The editor still opens on a tap.
    const stepper = !it.saved_meal;
    return (
      <View key={i} style={[s.item, divider && s.itemDivider]}>
        <Pressable
          onPress={frozen ? undefined : () => onEditItem(i)}
          disabled={frozen}
          style={({ pressed }) => [s.itemHead, pressed && s.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${it.food_name}, ${r0(it.kcal)} calories`}
          accessibilityHint="Opens the portion, food and numbers"
        >
          <View style={s.itemNameCol}>
            <Text style={s.itemName} numberOfLines={2}>{it.food_name}</Text>
            {(prov || it.verified) && (
              <View style={s.chips}>
                {it.verified && (
                  <View style={s.verifiedChip}>
                    <Feather name="check" size={9} color={C.accentText} />
                    <Text style={s.verifiedText}>VERIFIED</Text>
                  </View>
                )}
                {prov && <Text style={s.provChip}>{prov}</Text>}
              </View>
            )}
          </View>
          <Text style={s.itemKcal}>{r0(it.kcal)}<Text style={s.itemKcalUnit}> kcal</Text></Text>
        </Pressable>

        <View style={s.amountRow}>
          <View style={[s.amount, !stepper && s.amountPlain]}>
            {stepper && (
            <Pressable
              onPress={() => onStepAmount(i, -1)}
              disabled={frozen}
              hitSlop={6}
              style={s.stepBtn}
              accessibilityRole="button"
              accessibilityLabel={`Less ${it.food_name}`}
            >
              <Feather name="minus" size={12} color={C.textSecondary} />
            </Pressable>
            )}
            <Pressable
              onPress={() => onEditItem(i)}
              disabled={frozen}
              hitSlop={4}
              style={s.amountTxtBox}
              accessibilityRole="button"
              accessibilityLabel={`Amount ${formatServing(it.quantity, it.serving_label)}`}
              accessibilityHint="Opens the editor to change the amount or the unit"
            >
              <Text style={s.amountTxt} numberOfLines={1}>{formatServing(it.quantity, it.serving_label)}</Text>
              <Feather name="chevron-down" size={11} color={C.textMuted} />
            </Pressable>
            {stepper && (
            <Pressable
              onPress={() => onStepAmount(i, 1)}
              disabled={frozen}
              hitSlop={6}
              style={s.stepBtn}
              accessibilityRole="button"
              accessibilityLabel={`More ${it.food_name}`}
            >
              <Feather name="plus" size={12} color={C.textSecondary} />
            </Pressable>
            )}
          </View>
          <View style={s.macros}>
            <Text style={[s.macroNum, { color: C.macro.protein }]}>{formatMacroGrams(it.protein_g)}g P</Text>
            <Text style={[s.macroNum, { color: C.macro.carbs }]}>{formatMacroGrams(it.carb_g)}g C</Text>
            <Text style={[s.macroNum, { color: C.macro.fat }]}>{formatMacroGrams(it.fat_g)}g F</Text>
          </View>
          {items.length > 1 && (
            <Pressable
              onPress={() => onRemoveItem(i)}
              disabled={frozen}
              hitSlop={8}
              style={s.removeBtn}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${it.food_name}`}
            >
              <Feather name="x" size={13} color={C.textMuted} />
            </Pressable>
          )}
        </View>

        {it.assumption && <Text style={s.assumption}>{it.assumption}</Text>}

        {options.length > 0 && (
          <View style={s.swapRow}>
            <Text style={s.swapLead}>Not this one?</Text>
            {options.map((o, k) => (
              <Pressable
                key={`${o.food_name}-${k}`}
                onPress={() => onSwapItem(i, k)}
                disabled={frozen}
                hitSlop={8}
                style={({ pressed }) => [s.swapChip, pressed && s.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`Swap to ${o.food_name}, ${r0(optionAt(o, it.grams).kcal)} calories`}
              >
                <Text style={s.swapTxt} numberOfLines={1}>
                  {o.food_name} · {r0(optionAt(o, it.grams).kcal)} cal
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {uncertain(it) && options.length === 0 && (
          <Pressable
            onPress={() => onCheckItem(i)}
            disabled={frozen}
            hitSlop={8}
            style={s.checkBtn}
            accessibilityRole="button"
            accessibilityLabel={`Double-check ${it.food_name} online`}
            accessibilityHint="Looks this food up on the web and offers the numbers it finds"
          >
            {checkingIndex === i ? (
              <>
                <OrbLoader size="small" color={C.textSecondary} />
                <Text style={s.checkTxt}>Checking...</Text>
              </>
            ) : (
              <>
                <Feather name="search" size={11} color={C.textSecondary} />
                <Text style={s.checkTxt}>Double-check</Text>
              </>
            )}
          </Pressable>
        )}
      </View>
    );
  };

  // The meal in one calm strip, the way a Drona card shows its proof: equal
  // columns, hairline between them. Whole grams: a meal total reads at a
  // glance, and the lines below keep their decimals.
  const facts: { label: string; value: string; color: string }[] = [
    { label: 'kcal', value: r0(sum.kcal).toLocaleString(), color: C.textMuted },
    { label: 'protein', value: `${r0(sum.p)}g`, color: C.macro.protein },
    { label: 'carbs', value: `${r0(sum.c)}g`, color: C.macro.carbs },
    { label: 'fat', value: `${r0(sum.f)}g`, color: C.macro.fat },
  ];
  // Drona's orb in the card's head: resting while the meal waits for the
  // user, moving whenever he is working on it.
  const orbState = updating ? 'working' : busyChecking ? 'searching' : 'listening';
  const kicker = updating ? 'DRONA IS UPDATING' : busyChecking ? 'DRONA IS CHECKING' : title.toUpperCase();

  return (
    <Portal>
      <Animated.View
        entering={SlideInDown.duration(360).easing(Easing.out(Easing.cubic))}
        exiting={SlideOutDown.duration(220)}
        style={[s.root, { paddingTop: insets.top }]}
      >
        <View style={s.header}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={s.headerBtn}
            accessibilityRole="button"
            accessibilityLabel="Close"
            accessibilityHint="Keeps this meal waiting on Nutrition"
          >
            <Feather name="chevron-down" size={22} color={C.foreground} />
          </Pressable>
          <View style={s.headerRight}>
            {tier && (
              <View style={s.tierChip} accessibilityLabel={`Read with ${TIER[tier].label}`}>
                <Feather
                  name={TIER[tier].icon}
                  size={11}
                  color={tier === 'quick' ? C.textSecondary : C.accentText}
                />
                <Text style={[s.tierTxt, { color: tier === 'quick' ? C.textSecondary : C.accentText }]}>
                  {TIER[tier].label}
                </Text>
              </View>
            )}
            {saved ? (
              <View style={s.savedChip} accessibilityLabel="Saved for next time">
                <Feather name="check" size={13} color={C.accentText} />
                <Text style={s.savedTxt}>Saved</Text>
              </View>
            ) : (
              <Pressable onPress={onSave} disabled={frozen} hitSlop={8} style={s.saveIcon} accessibilityRole="button" accessibilityLabel="Save this meal for next time">
                <Feather name="bookmark" size={16} color={C.textSecondary} />
              </Pressable>
            )}
          </View>
        </View>

        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={s.body}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          {/* Who is talking */}
          <View style={s.head}>
            <View style={s.mark}>
              <OrbLoader size={32} color={C.accentText} state={orbState} accessibilityLabel={updating ?? 'Drona'} />
            </View>
            <Text style={s.kicker}>{kicker}</Text>
          </View>

          {/* What you ate, in your words */}
          {!!words && (
            <View style={s.wordsRow}>
              <Text style={s.cardTitle} accessibilityRole="header">{words}</Text>
              {!!onEditWords && !busy && (
                <Pressable
                  onPress={onEditWords}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Edit what you wrote"
                  accessibilityHint="Puts your words back in the box to change and send again"
                >
                  <Feather name="corner-down-left" size={13} color={C.textMuted} style={{ marginTop: 6 }} />
                </Pressable>
              )}
            </View>
          )}

          {/* Drona's word on it: his line, what he is doing now, or a
              notice that asks for a choice. */}
          {updating ? (
            <PulsingStatus label={updating} color={C.textSecondary} style={s.cardBody} />
          ) : !notice && meal.drona_line ? (
            <Text style={s.cardBody}>{meal.drona_line}</Text>
          ) : null}

          <View style={[busy && s.dim]} pointerEvents={busy ? 'none' : 'auto'}>
            <View
              style={s.facts}
              accessibilityLabel={`${r0(sum.kcal)} calories, ${r0(sum.p)} grams protein, ${r0(sum.c)} grams carbs, ${r0(sum.f)} grams fat`}
            >
              {facts.map((f, k) => (
                <View key={f.label} style={s.factWrap}>
                  {k > 0 && <View style={s.factDivider} />}
                  <View style={s.fact}>
                    <Text style={s.factValue}>{f.value}</Text>
                    <Text style={[s.factLabel, { color: f.color }]}>{f.label}</Text>
                  </View>
                </View>
              ))}
            </View>
            {sum.fib != null && sum.fib > 0 && (
              <Text style={s.fiber}>Fiber {r0(sum.fib)} g</Text>
            )}

            {!!notice && (
              <View style={s.notice}>
                <View style={s.noticeHead}>
                  <Text style={s.noticeTxt}>{notice}</Text>
                  <Pressable onPress={onDismissNotice} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss">
                    <Feather name="x" size={13} color={C.textMuted} style={{ marginTop: 3 }} />
                  </Pressable>
                </View>
                {!!proposalLabel && (
                  <View style={s.proposalRow}>
                    <Pressable
                      onPress={onDismissNotice}
                      style={({ pressed }) => [s.keepBtn, { opacity: pressed ? 0.7 : 1 }]}
                      accessibilityRole="button"
                    >
                      <Text style={s.keepTxt}>Keep mine</Text>
                    </Pressable>
                    <Pressable
                      onPress={onAcceptProposal}
                      style={({ pressed }) => [s.useBtn, { opacity: pressed ? 0.85 : 1 }]}
                      accessibilityRole="button"
                    >
                      <Text style={s.useTxt}>{proposalLabel}</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            )}

            <View style={s.eyebrowRow}>
              <Text style={s.eyebrow}>Foods</Text>
              <Text style={s.eyebrowCount}>{items.length} {items.length === 1 ? 'item' : 'items'}</Text>
            </View>
            <View style={s.list}>
              {multi
                ? sections.flatMap((sec, n) => {
                  const rows = items.map((it, i) => ({ it, i })).filter(({ it }) => (it.meal_type ?? mealType) === sec);
                  const isOpen = openGroup === sec;
                  return [
                    <View key={`h-${sec}`} style={n > 0 && s.groupGap}>
                      <Pressable
                        onPress={frozen ? undefined : () => setOpenGroup(isOpen ? null : sec)}
                        hitSlop={4}
                        style={s.groupHead}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: isOpen }}
                        accessibilityLabel={`${mealLabel(sec)}, ${rows.length} ${rows.length === 1 ? 'item' : 'items'}`}
                        accessibilityHint="Move these lines to another meal"
                      >
                        <Text style={s.groupHeadTxt}>{mealLabel(sec)}</Text>
                        <Text style={s.groupHeadCount}>{rows.length} {rows.length === 1 ? 'item' : 'items'}</Text>
                        <Feather name={isOpen ? 'chevron-up' : 'chevron-down'} size={13} color={C.textMuted} />
                      </Pressable>
                      {isOpen && (
                        <View style={s.chipRow}>
                          {MEAL_OPTIONS.map((o) => {
                            const on = o.value === sec;
                            return (
                              <Pressable
                                key={o.value}
                                onPress={() => { setOpenGroup(null); onMoveGroup(sec, o.value); }}
                                hitSlop={4}
                                style={[s.chip, on ? s.chipOn : s.chipOff]}
                              >
                                <Text style={[s.chipTxt, { color: on ? C.background : C.textSecondary }]}>{o.label}</Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}
                    </View>,
                    ...rows.map(({ it, i }, k) => renderRow(it, i, k > 0)),
                  ];
                })
                : items.map((it, i) => renderRow(it, i, i > 0))}
            </View>

            {!multi && (
              <>
                <Text style={[s.eyebrow, s.placeEyebrow]}>Meal</Text>
                <View style={s.chipRow}>
                  {MEAL_OPTIONS.map((o) => {
                    const on = o.value === mealType;
                    return (
                      <Pressable
                        key={o.value}
                        onPress={() => onMealTypeChange(o.value)}
                        hitSlop={4}
                        style={[s.chip, on ? s.chipOn : s.chipOff]}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: on }}
                      >
                        <Text style={[s.chipTxt, { color: on ? C.background : C.textSecondary }]}>{o.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}
            <Text style={[s.eyebrow, s.placeEyebrow]}>Day</Text>
            <Pressable
              onPress={onPickDay}
              style={({ pressed }) => [s.dayBtn, pressed && s.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Day: ${dayLabel}`}
              accessibilityHint="Pick another day for this meal"
            >
              <Feather name="calendar" size={13} color={C.textSecondary} />
              <Text style={s.dayTxt}>{dayLabel}</Text>
              <Feather name="chevron-down" size={12} color={C.textMuted} style={{ marginLeft: 'auto' }} />
            </Pressable>
          </View>
        </ScrollView>

        <View style={[s.footer, { paddingBottom: kbHeight > 0 ? Spacing.sm : insets.bottom + Spacing.sm, marginBottom: kbHeight }]}>
          {/* The correction box. Voice comes later: the mic will sit left of
              the send circle, so the field keeps that room now. */}
          <View style={s.fixBox}>
            <TextInput
              style={s.fixInput}
              value={fix}
              onChangeText={setFix}
              placeholder="Tell Drona what to change"
              placeholderTextColor={C.textSecondary}
              returnKeyType="send"
              onSubmitEditing={sendFix}
              blurOnSubmit={false}
              multiline
              editable={!busy}
            />
            <Pressable
              onPress={sendFix}
              disabled={!fix.trim() || busy}
              hitSlop={8}
              style={[s.fixSend, { opacity: !fix.trim() || busy ? 0.35 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel="Send the change to Drona"
            >
              <Feather name="arrow-up" size={15} color={C.background} />
            </Pressable>
          </View>
          {kbHeight === 0 && (
            <View style={s.actions}>
              {/* The card's two answers: same height, same corners, rank from
                  fill against outline. */}
              <Pressable
                onPress={onDiscard}
                style={({ pressed }) => [s.secondary, { opacity: pressed ? 0.7 : 1 }]}
                accessibilityRole="button"
              >
                <Text style={s.secondaryText}>Discard</Text>
              </Pressable>
              <Pressable
                onPress={onAdd}
                disabled={frozen}
                style={({ pressed }) => [s.primary, { opacity: frozen ? 0.5 : pressed ? 0.85 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel={`Add to ${destination}`}
              >
                <Text style={s.primaryText}>{adding ? 'Adding...' : `Add to ${destination}`}</Text>
              </Pressable>
            </View>
          )}
        </View>
      </Animated.View>
    </Portal>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    root: { ...StyleSheet.absoluteFillObject, backgroundColor: C.background },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      height: 48, paddingHorizontal: Spacing.lg,
    },
    headerBtn: { width: 44, height: 36, justifyContent: 'center' },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
    tierChip: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingVertical: 4, paddingHorizontal: 8, borderRadius: Radius.full,
      borderWidth: 1, borderColor: C.borderSubtle,
    },
    tierTxt: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
    // The card's own padding (DronaCardPopup), on a full screen.
    body: { paddingHorizontal: Spacing.xxl, paddingTop: Spacing.sm, paddingBottom: Spacing.xxl },
    pressed: { opacity: 0.6 },
    dim: { opacity: 0.45 },

    // The Drona card's head, title and body, size for size.
    head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm + 2, marginBottom: Spacing.xl },
    mark: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    kicker: { flex: 1, fontSize: FontSize.xs, fontWeight: FontWeight.bold, letterSpacing: 1.4, color: C.textMuted },
    wordsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
    cardTitle: { flex: 1, fontSize: FontSize.xl, lineHeight: 24, fontWeight: FontWeight.bold, color: C.foreground },
    cardBody: { fontSize: FontSize.base, lineHeight: 21, color: C.textSecondary, marginTop: Spacing.sm },

    // The proof strip: equal columns, hairline between them, no pills.
    facts: {
      flexDirection: 'row', alignItems: 'stretch', backgroundColor: C.muted,
      borderRadius: Radius.lg, paddingVertical: Spacing.md + 2, marginTop: Spacing.xl,
    },
    factWrap: { flex: 1, flexDirection: 'row', alignItems: 'stretch' },
    factDivider: { width: StyleSheet.hairlineWidth, marginVertical: 2, backgroundColor: C.borderSubtle },
    fact: { flex: 1, alignItems: 'center', paddingHorizontal: Spacing.xs },
    factValue: {
      fontSize: FontSize.xxl, lineHeight: 26, fontWeight: FontWeight.bold, color: C.foreground,
      fontVariant: ['tabular-nums'],
    },
    factLabel: { fontSize: FontSize.xs, lineHeight: 13, textAlign: 'center', marginTop: 3, fontWeight: FontWeight.medium },
    fiber: { fontSize: FontSize.sm, color: C.textSecondary, marginTop: Spacing.sm, textAlign: 'center', fontVariant: ['tabular-nums'] },

    // A notice asks for a choice, so it sits in the same muted block as the
    // proof, with the card's two button styles at a smaller size.
    notice: { backgroundColor: C.muted, borderRadius: Radius.lg, padding: Spacing.lg, marginTop: Spacing.md },
    noticeHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    noticeTxt: { flex: 1, fontSize: FontSize.base, lineHeight: 21, color: C.foreground },
    proposalRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
    keepBtn: {
      flex: 1, height: 40, borderRadius: Radius.lg, borderWidth: 1, borderColor: C.border,
      alignItems: 'center', justifyContent: 'center',
    },
    keepTxt: { fontSize: FontSize.md, color: C.foreground, fontWeight: FontWeight.semibold },
    useBtn: {
      flex: 1, height: 40, borderRadius: Radius.lg, backgroundColor: C.foreground,
      alignItems: 'center', justifyContent: 'center',
    },
    useTxt: { fontSize: FontSize.md, color: C.background, fontWeight: FontWeight.bold },

    eyebrowRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.xl },
    eyebrow: {
      fontSize: FontSize.xs, color: C.textMuted, fontWeight: FontWeight.semibold,
      letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase',
    },
    eyebrowCount: { marginLeft: 'auto', fontSize: FontSize.xs, color: C.textMuted },
    placeEyebrow: { marginTop: Spacing.xl, marginBottom: Spacing.sm },
    list: { marginTop: Spacing.xs },

    item: { paddingVertical: Spacing.md },
    itemDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
    itemHead: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md },
    itemNameCol: { flex: 1 },
    itemName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: C.foreground, lineHeight: 19 },
    chips: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 },
    provChip: {
      fontSize: 10, color: C.textMuted, fontWeight: FontWeight.medium,
      letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase',
    },
    verifiedChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    verifiedText: { fontSize: 9, color: C.accentText, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow },
    itemKcal: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: C.foreground, fontVariant: ['tabular-nums'] },
    itemKcalUnit: { fontSize: FontSize.xs, fontWeight: FontWeight.medium, color: C.textMuted },

    amountRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.sm },
    amount: {
      flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: C.border,
      borderRadius: Radius.full, backgroundColor: C.inputBg, flexShrink: 1,
    },
    stepBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
    amountPlain: { paddingHorizontal: 10, paddingVertical: 6 },
    amountTxtBox: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 2, flexShrink: 1 },
    amountTxt: { fontSize: FontSize.sm, color: C.foreground, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'], flexShrink: 1 },
    macros: { flexDirection: 'row', gap: Spacing.sm, marginLeft: 'auto' },
    macroNum: { fontSize: 11, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
    removeBtn: { padding: 4, marginLeft: -4 },
    assumption: { fontSize: FontSize.sm, color: C.textDim, fontStyle: 'italic', marginTop: 6, lineHeight: 17 },
    swapRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 8 },
    swapLead: { fontSize: FontSize.xs, color: C.textSecondary },
    swapChip: {
      paddingVertical: 5, paddingHorizontal: 10, maxWidth: '100%',
      borderRadius: Radius.full, borderWidth: 1, borderColor: C.borderSubtle,
    },
    swapTxt: { fontSize: FontSize.xs, color: C.foreground, fontWeight: FontWeight.medium },
    checkBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
      marginTop: 8, paddingVertical: 4, paddingHorizontal: 8,
      borderRadius: Radius.full, borderWidth: 1, borderColor: C.borderSubtle,
    },
    checkTxt: { fontSize: FontSize.xs, color: C.textSecondary, fontWeight: FontWeight.semibold },

    groupGap: { marginTop: Spacing.md },
    groupHead: {
      flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: Spacing.xs,
    },
    groupHeadTxt: {
      fontSize: 10, color: C.textSecondary, fontWeight: FontWeight.semibold,
      letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase',
    },
    groupHeadCount: { fontSize: FontSize.xs, color: C.textMuted, marginRight: 'auto' },
    chipRow: { flexDirection: 'row', gap: 6 },
    chip: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: Radius.md, borderWidth: 1 },
    chipOn: { backgroundColor: C.foreground, borderColor: C.foreground },
    chipOff: { backgroundColor: 'transparent', borderColor: C.border },
    chipTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
    dayBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      borderWidth: 1, borderColor: C.border, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: Spacing.md,
    },
    dayTxt: { fontSize: FontSize.base, color: C.foreground, fontWeight: FontWeight.medium },

    footer: {
      paddingHorizontal: Spacing.xxl, paddingTop: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.background,
    },
    fixBox: {
      flexDirection: 'row', alignItems: 'flex-end', gap: 8,
      backgroundColor: C.inputBg, borderRadius: Radius.xxl, paddingHorizontal: Spacing.lg, paddingVertical: 10,
    },
    fixInput: {
      flex: 1, fontSize: FontSize.base, lineHeight: 20, color: C.foreground, padding: 0,
      marginBottom: 4, maxHeight: 80, textAlignVertical: 'top',
    },
    fixSend: {
      width: 28, height: 28, borderRadius: 14, backgroundColor: C.foreground,
      alignItems: 'center', justifyContent: 'center',
    },
    actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm + 2, marginTop: Spacing.md },
    saveIcon: { padding: 6 },
    savedChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 4 },
    savedTxt: { fontSize: FontSize.sm, color: C.accentText, fontWeight: FontWeight.semibold },
    // DronaCardPopup's buttons: same height and corners, rank from fill
    // against outline. Add is the one lime surface on the screen.
    secondary: {
      flex: 1, height: BUTTON_HEIGHT, borderRadius: Radius.lg, borderWidth: 1, borderColor: C.border,
      alignItems: 'center', justifyContent: 'center',
    },
    secondaryText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: C.foreground },
    primary: {
      flex: 2, height: BUTTON_HEIGHT, borderRadius: Radius.lg, backgroundColor: Colors.primary,
      alignItems: 'center', justifyContent: 'center',
    },
    primaryText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  });
}
