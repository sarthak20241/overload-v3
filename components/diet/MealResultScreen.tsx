/**
 * MealResultScreen: Drona's read of a meal, full screen, before it goes in.
 *
 * In the Drona card's language (components/coach/DronaCardPopup.tsx: its
 * corners, proof strip, button height and weights), cut down to what a
 * decision needs, top to bottom:
 *   1. one header row: close, Drona's orb and the meal ("Your snack"), save;
 *      under it one quiet line with your own words (tap to edit) and the tier;
 *   2. the meal's numbers in the card's proof strip;
 *   3. Drona's line, what he is doing now, or a notice that asks for a choice;
 *   4. the foods, two quiet lines each: name and kcal, then the amount
 *      control and the macros. Notes and actions only when a line has them;
 *   5. one compact "Snack ▾ · Today ▾" row for where it goes;
 *   6. a pinned footer: the box to tell Drona what to change, then Discard
 *      as plain text and Add as the single filled button.
 * Four type sizes (22 / 16 / 14 / 12) and an 8 pt rhythm.
 *
 * The orb rests while the meal waits for you and moves while Drona works on
 * it (a correction, a double-check). Nothing is written until Add.
 *
 * It replaces the popover card, so it keeps everything that card did: memory
 * notes ("Same as you logged on Oct 14") and saved-meal offers ride in as the
 * line's note and Drona's notice, a doubtful line offers a double-check, a
 * line the user also logs another variant of offers the swap, a whole-day
 * message groups its lines by meal, and the tier that ran is shown. Amounts
 * change in place with - and + (lib/mealReady stepAmount), and a tap on the
 * amount or the line opens the full line editor for the unit, the food and
 * the numbers.
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
import Animated, { SlideInDown, SlideOutDown, Easing, FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import { Colors, Spacing, Radius, FontWeight, LetterSpacing } from '@/constants/theme';
import { Portal } from '@/components/ui/Portal';
import { OrbLoader } from '@/components/ui/OrbLoader';
import { PulsingStatus } from '@/components/coach/OrbStage';
import { sectionsOfItems, type ParsedMeal, type ParsedMealItem } from '@/lib/dietData';
import { formatServing, formatMacroGrams, type MealType } from '@/lib/foods';
import { optionAt, swapLabel } from '@/lib/variantSwap';
import { addLabel } from '@/lib/mealReady';
import type { ParseSpeed } from '@/lib/parseSpeed';
import { uncertain, provenance } from './ParsedMealCard';

const MEAL_OPTIONS: { value: MealType; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snack' },
];
const mealLabel = (m: MealType) => MEAL_OPTIONS.find((o) => o.value === m)?.label ?? 'Snack';

const TIER: Record<ParseSpeed, { icon: 'zap' | 'target' | 'award'; label: string }> = {
  quick: { icon: 'zap', label: 'Quick' },
  thorough: { icon: 'target', label: 'Thorough' },
  precise: { icon: 'award', label: 'Precise' },
};

/** The screen's whole type scale. Nothing here uses another size. */
const T = { title: 22, body: 16, small: 14, tiny: 12 } as const;

const r0 = (n: number) => Math.round(n);
/** DronaCardPopup's button height. */
const BUTTON_HEIGHT = 50;
/** The smallest tap target on the screen (iOS 44 pt). */
const TAP = 44;

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
  /** A guide line over the footer (the food box tour's review step). */
  tip?: React.ReactNode;
}

export function MealResultScreen(props: Props) {
  const {
    open, meal, mealType, words, tier, dayLabel, notice, proposalLabel, saved, adding, checkingIndex, updating,
    onClose, onDiscard, onAdd, onMealTypeChange, onMoveGroup, onPickDay, onEditItem, onRemoveItem, onSwapItem,
    onCheckItem, onStepAmount, onAcceptProposal, onDismissNotice, onSave, onCorrect, onEditWords, tip,
  } = props;
  const { C } = useTheme();
  const s = makeStyles(C);
  const insets = useSafeAreaInsets();
  const { kbHeight } = useKeyboardAwareScroll();
  const [fix, setFix] = useState('');
  // Which meal picker is open: the whole meal's ('all') or one group's.
  const [picker, setPicker] = useState<MealType | 'all' | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);
  // A fresh open starts at the top with an empty box.
  useEffect(() => { if (open) { setFix(''); setPicker(null); } }, [open]);

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
  const title = multi ? 'Your meals' : `Your ${mealLabel(mealType).toLowerCase()}`;
  // A source tag only says something when the lines differ. When every line
  // came the same way ("Drona's estimate" on all three), it is said once,
  // next to the count.
  const provOf = (it: ParsedMealItem) => (it.saved_meal ? 'saved meal' : swapLabel(it) ?? provenance(it.source));
  const provs = items.map(provOf);
  const sharedProv = provs.every((p) => p === provs[0]) ? provs[0] : undefined;
  const orbState = updating ? 'working' : busyChecking ? 'searching' : 'listening';

  const sendFix = () => {
    const t = fix.trim();
    if (!t || busy) return;
    setFix('');
    onCorrect(t);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  const renderRow = (it: ParsedMealItem, i: number, divider: boolean) => {
    const options = it.alternatives ?? [];
    const prov = sharedProv === undefined ? provOf(it) : null;
    // A saved meal's own rows keep the amount the user saved, which is not
    // always a real portion ("1 g" for a whole bowl), so - and + would scale
    // the wrong thing. The editor still opens on a tap.
    const stepper = !it.saved_meal;
    const checkable = uncertain(it) && options.length === 0;
    return (
      <View key={i} style={[s.item, divider && s.itemDivider]}>
        {/* Line 1: what it is, and what it costs */}
        <Pressable
          onPress={frozen ? undefined : () => onEditItem(i)}
          disabled={frozen}
          style={({ pressed }) => [s.line1, pressed && s.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${it.food_name}, ${r0(it.kcal)} calories`}
          accessibilityHint="Opens the portion, food and numbers"
        >
          <Text style={s.itemName} numberOfLines={2}>
            {it.food_name}
            {!!prov && <Text style={s.tag}>{'  '}{prov}</Text>}
          </Text>
          {it.verified && (
            <View style={s.verified} accessibilityLabel="Verified by two sources">
              <Feather name="check" size={10} color={C.accentText} />
            </View>
          )}
          <Text style={s.itemKcal}>{r0(it.kcal)}<Text style={s.unit}> kcal</Text></Text>
        </Pressable>

        {/* Line 2: how much, and what is in it */}
        <View style={s.line2}>
          <View style={s.amount}>
            {stepper && (
              <Pressable
                onPress={() => onStepAmount(i, -1)}
                disabled={frozen}
                hitSlop={6}
                style={({ pressed }) => [s.stepBtn, pressed && s.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`Less ${it.food_name}`}
              >
                <Feather name="minus" size={12} color={C.textSecondary} />
              </Pressable>
            )}
            <Pressable
              onPress={() => onEditItem(i)}
              disabled={frozen}
              style={({ pressed }) => [s.amountTxtBox, !stepper && s.amountPlain, pressed && s.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Amount ${formatServing(it.quantity, it.serving_label)}`}
              accessibilityHint="Opens the editor to change the amount or the unit"
            >
              <Text style={s.amountTxt} numberOfLines={1}>{formatServing(it.quantity, it.serving_label)}</Text>
            </Pressable>
            {stepper && (
              <Pressable
                onPress={() => onStepAmount(i, 1)}
                disabled={frozen}
                hitSlop={6}
                style={({ pressed }) => [s.stepBtn, pressed && s.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`More ${it.food_name}`}
              >
                <Feather name="plus" size={12} color={C.textSecondary} />
              </Pressable>
            )}
          </View>
          <Text style={s.macros} numberOfLines={1}>
            <Text style={{ color: C.macro.protein }}>{formatMacroGrams(it.protein_g)}P</Text>
            {'  '}
            <Text style={{ color: C.macro.carbs }}>{formatMacroGrams(it.carb_g)}C</Text>
            {'  '}
            <Text style={{ color: C.macro.fat }}>{formatMacroGrams(it.fat_g)}F</Text>
          </Text>
          {items.length > 1 && (
            <Pressable
              onPress={() => onRemoveItem(i)}
              disabled={frozen}
              hitSlop={6}
              style={({ pressed }) => [s.removeBtn, pressed && s.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${it.food_name}`}
            >
              <Feather name="x" size={14} color={C.textMuted} />
            </Pressable>
          )}
        </View>

        {/* Only when the line has something to say */}
        {!!it.assumption && <Text style={s.note}>{it.assumption}</Text>}

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
                  {o.food_name} · {r0(optionAt(o, it.grams).kcal)} kcal
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {checkable && (
          <Pressable
            onPress={() => onCheckItem(i)}
            disabled={frozen}
            hitSlop={{ top: 12, bottom: 12, left: 4, right: 12 }}
            style={({ pressed }) => [s.textAction, pressed && s.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`Double-check ${it.food_name} online`}
            accessibilityHint="Looks this food up on the web and offers the numbers it finds"
          >
            {checkingIndex === i ? (
              <>
                <OrbLoader size={14} state="searching" accessibilityLabel="Checking" />
                <Text style={s.textActionTxt}>Checking...</Text>
              </>
            ) : (
              <>
                <Feather name="search" size={11} color={frozen ? C.textMuted : C.textSecondary} />
                <Text style={[s.textActionTxt, frozen && { color: C.textMuted }]}>Double-check</Text>
              </>
            )}
          </Pressable>
        )}
      </View>
    );
  };

  const mealChips = (current: MealType, pick: (m: MealType) => void) => (
    <Animated.View entering={FadeIn.duration(160)} style={s.chipRow}>
      {MEAL_OPTIONS.map((o) => {
        const on = o.value === current;
        return (
          <Pressable
            key={o.value}
            onPress={() => { setPicker(null); pick(o.value); }}
            style={({ pressed }) => [s.chip, on ? s.chipOn : s.chipOff, pressed && s.pressed]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
          >
            <Text style={[s.chipTxt, { color: on ? C.background : C.textSecondary }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </Animated.View>
  );

  return (
    <Portal>
      <Animated.View
        entering={SlideInDown.duration(360).easing(Easing.out(Easing.cubic))}
        exiting={SlideOutDown.duration(220)}
        style={[s.root, { paddingTop: insets.top }]}
      >
        {/* 1. One header row */}
        <View style={s.header}>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Close"
            accessibilityHint="Keeps this meal waiting on Nutrition"
          >
            <Feather name="chevron-down" size={22} color={C.foreground} />
          </Pressable>
          <View style={s.headMid}>
            <View style={s.orb}>
              <OrbLoader size={28} color={C.accentText} state={orbState} accessibilityLabel={updating ?? 'Drona'} />
            </View>
            <Text style={s.title} numberOfLines={1} accessibilityRole="header">{title}</Text>
          </View>
          {saved ? (
            <View style={s.iconBtn} accessibilityLabel="Saved for next time">
              <Feather name="check" size={16} color={C.accentText} />
            </View>
          ) : (
            <Pressable
              onPress={onSave}
              disabled={frozen}
              style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Save this meal for next time"
            >
              <Feather name="bookmark" size={16} color={C.textSecondary} />
            </Pressable>
          )}
        </View>

        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={s.body}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          {/* Your words, small, under the header */}
          <View style={s.metaRow}>
            <Pressable
              onPress={onEditWords && !busy ? onEditWords : undefined}
              disabled={!onEditWords || busy}
              style={({ pressed }) => [s.wordsBtn, pressed && s.pressed]}
              accessibilityRole={onEditWords && !busy ? 'button' : 'text'}
              accessibilityLabel={`You said: ${words}`}
              accessibilityHint={onEditWords && !busy ? 'Puts your words back in the box to change and send again' : undefined}
            >
              <Text style={s.words} numberOfLines={2}>{words}</Text>
              {!!onEditWords && !busy && <Feather name="corner-down-left" size={12} color={C.textMuted} />}
            </Pressable>
            {tier && (
              <View style={s.tier} accessibilityLabel={`Read with ${TIER[tier].label}`}>
                <Feather name={TIER[tier].icon} size={11} color={tier === 'quick' ? C.textMuted : C.accentText} />
                <Text style={[s.tierTxt, tier !== 'quick' && { color: C.accentText }]}>{TIER[tier].label}</Text>
              </View>
            )}
          </View>

          <View style={[busy && s.dim]} pointerEvents={busy ? 'none' : 'auto'}>
            {/* 2. The numbers, in the Drona card's proof strip */}
            <View
              style={s.facts}
              accessibilityLabel={`${r0(sum.kcal)} calories, ${r0(sum.p)} grams protein, ${r0(sum.c)} grams carbs, ${r0(sum.f)} grams fat`}
            >
              {[
                { label: 'kcal', value: r0(sum.kcal).toLocaleString(), color: C.textMuted },
                { label: 'protein', value: `${r0(sum.p)}g`, color: C.macro.protein },
                { label: 'carbs', value: `${r0(sum.c)}g`, color: C.macro.carbs },
                { label: 'fat', value: `${r0(sum.f)}g`, color: C.macro.fat },
              ].map((f, k) => (
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
              <Text style={s.fiber}>{r0(sum.fib)}g fiber</Text>
            )}
          </View>

          {/* 3. Drona's word: what he is doing, a choice, or his line */}
          {updating ? (
            <PulsingStatus label={updating} color={C.textSecondary} style={s.drona} />
          ) : notice ? (
            <View style={s.notice}>
              <View style={s.noticeHead}>
                <Text style={s.noticeTxt}>{notice}</Text>
                <Pressable
                  onPress={onDismissNotice}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss"
                >
                  <Feather name="x" size={14} color={C.textMuted} style={{ marginTop: 2 }} />
                </Pressable>
              </View>
              {!!proposalLabel && (
                <View style={s.proposalRow}>
                  <Pressable
                    onPress={onDismissNotice}
                    style={({ pressed }) => [s.keepBtn, pressed && s.pressed]}
                    accessibilityRole="button"
                  >
                    <Text style={s.keepTxt}>Keep mine</Text>
                  </Pressable>
                  <Pressable
                    onPress={onAcceptProposal}
                    style={({ pressed }) => [s.useBtn, pressed && s.pressed]}
                    accessibilityRole="button"
                  >
                    <Text style={s.useTxt}>{proposalLabel}</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ) : meal.drona_line ? (
            <Text style={s.drona}>{meal.drona_line}</Text>
          ) : null}

          <View style={[busy && s.dim]} pointerEvents={busy ? 'none' : 'auto'}>
            {/* 4. The foods */}
            <View style={s.listHead}>
              <Text style={s.eyebrow}>Foods</Text>
              <Text style={s.listCount}>
                {items.length} {items.length === 1 ? 'item' : 'items'}{sharedProv ? ` · ${sharedProv}` : ''}
              </Text>
            </View>
            {multi
              ? sections.flatMap((sec, n) => {
                const rows = items.map((it, i) => ({ it, i })).filter(({ it }) => (it.meal_type ?? mealType) === sec);
                return [
                  <View key={`h-${sec}`} style={n > 0 && s.groupGap}>
                    <Pressable
                      onPress={frozen ? undefined : () => setPicker(picker === sec ? null : sec)}
                      style={({ pressed }) => [s.groupHead, pressed && s.pressed]}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: picker === sec }}
                      accessibilityLabel={`${mealLabel(sec)}, ${rows.length} ${rows.length === 1 ? 'item' : 'items'}`}
                      accessibilityHint="Move these lines to another meal"
                    >
                      <Text style={s.groupHeadTxt}>{mealLabel(sec)}</Text>
                      <Feather name={picker === sec ? 'chevron-up' : 'chevron-down'} size={12} color={C.textMuted} />
                    </Pressable>
                    {picker === sec && mealChips(sec, (to) => onMoveGroup(sec, to))}
                  </View>,
                  ...rows.map(({ it, i }, k) => renderRow(it, i, k > 0)),
                ];
              })
              : items.map((it, i) => renderRow(it, i, i > 0))}

            {/* 5. Where it goes: one compact row */}
            <View style={s.placeRow}>
              {!multi && (
                <>
                  <Pressable
                    onPress={() => setPicker(picker === 'all' ? null : 'all')}
                    style={({ pressed }) => [s.placeBtn, pressed && s.pressed]}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: picker === 'all' }}
                    accessibilityLabel={`Meal: ${mealLabel(mealType)}`}
                    accessibilityHint="Pick the meal this goes to"
                  >
                    <Text style={s.placeTxt}>{mealLabel(mealType)}</Text>
                    <Feather name={picker === 'all' ? 'chevron-up' : 'chevron-down'} size={14} color={C.textMuted} />
                  </Pressable>
                  <Text style={s.placeDot}>·</Text>
                </>
              )}
              <Pressable
                onPress={onPickDay}
                style={({ pressed }) => [s.placeBtn, pressed && s.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`Day: ${dayLabel}`}
                accessibilityHint="Pick another day for this meal"
              >
                <Text style={s.placeTxt}>{dayLabel}</Text>
                <Feather name="chevron-down" size={14} color={C.textMuted} />
              </Pressable>
            </View>
            {!multi && picker === 'all' && mealChips(mealType, onMealTypeChange)}
          </View>
        </ScrollView>

        {/* 6. The footer: tell Drona, then the one decision */}
        <View style={[s.footer, { paddingBottom: kbHeight > 0 ? Spacing.sm : insets.bottom + Spacing.sm, marginBottom: kbHeight }]}>
          {/* Hidden while typing a change, so it never crowds the box. */}
          {!!tip && kbHeight === 0 && <View style={s.tip}>{tip}</View>}
          {/* Voice comes later: the mic will sit left of the send circle, so
              the field keeps that room now. */}
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
              <Feather name="arrow-up" size={14} color={C.background} />
            </Pressable>
          </View>
          {kbHeight === 0 && (
            <View style={s.actions}>
              <Pressable
                onPress={onDiscard}
                style={({ pressed }) => [s.discard, pressed && s.pressed]}
                accessibilityRole="button"
              >
                <Text style={s.discardTxt}>Discard</Text>
              </Pressable>
              <Pressable
                onPress={onAdd}
                disabled={frozen}
                style={({ pressed }) => [s.primary, { opacity: frozen ? 0.5 : pressed ? 0.85 : 1 }]}
                accessibilityRole="button"
                accessibilityState={{ disabled: frozen }}
                accessibilityLabel={addLabel(destination, dayLabel)}
              >
                <Text style={s.primaryText} numberOfLines={1}>{adding ? 'Adding...' : addLabel(destination, dayLabel)}</Text>
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
    pressed: { opacity: 0.6 },
    dim: { opacity: 0.45 },

    // 1. Header: close · orb + meal · save, one row.
    header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: Spacing.md },
    iconBtn: { width: TAP, height: TAP, alignItems: 'center', justifyContent: 'center' },
    headMid: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm },
    orb: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    title: { fontSize: T.title, lineHeight: 28, fontWeight: FontWeight.bold, color: C.foreground, letterSpacing: LetterSpacing.snug },

    body: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xxl },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, justifyContent: 'center' },
    wordsBtn: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
    words: { flexShrink: 1, fontSize: T.small, lineHeight: 20, color: C.textMuted, textAlign: 'center' },
    tier: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    tierTxt: { fontSize: T.tiny, fontWeight: FontWeight.semibold, color: C.textMuted },

    // 2. The proof strip (DronaCardPopup), the one block on the screen.
    facts: {
      flexDirection: 'row', alignItems: 'stretch', backgroundColor: C.muted,
      borderRadius: Radius.lg, paddingVertical: Spacing.lg, marginTop: Spacing.lg,
    },
    factWrap: { flex: 1, flexDirection: 'row', alignItems: 'stretch' },
    factDivider: { width: StyleSheet.hairlineWidth, marginVertical: 2, backgroundColor: C.borderSubtle },
    fact: { flex: 1, alignItems: 'center', paddingHorizontal: Spacing.xs },
    factValue: { fontSize: T.title, lineHeight: 26, fontWeight: FontWeight.bold, color: C.foreground, fontVariant: ['tabular-nums'] },
    factLabel: { fontSize: T.tiny, lineHeight: 16, marginTop: 2, fontWeight: FontWeight.medium },
    fiber: { fontSize: T.tiny, color: C.textMuted, marginTop: Spacing.sm, textAlign: 'center', fontVariant: ['tabular-nums'] },

    // 3. Drona's word.
    drona: { fontSize: T.small, lineHeight: 20, color: C.textSecondary, marginTop: Spacing.lg },
    notice: { backgroundColor: C.muted, borderRadius: Radius.lg, padding: Spacing.lg, marginTop: Spacing.lg },
    noticeHead: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
    noticeTxt: { flex: 1, fontSize: T.small, lineHeight: 20, color: C.foreground },
    proposalRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
    keepBtn: {
      flex: 1, height: TAP, borderRadius: Radius.lg, borderWidth: 1, borderColor: C.border,
      alignItems: 'center', justifyContent: 'center',
    },
    keepTxt: { fontSize: T.small, color: C.foreground, fontWeight: FontWeight.semibold },
    useBtn: { flex: 1, height: TAP, borderRadius: Radius.lg, backgroundColor: C.foreground, alignItems: 'center', justifyContent: 'center' },
    useTxt: { fontSize: T.small, color: C.background, fontWeight: FontWeight.bold },

    // 4. Foods: two quiet lines a row.
    listHead: { flexDirection: 'row', alignItems: 'baseline', marginTop: Spacing.xxl, marginBottom: Spacing.xs },
    eyebrow: {
      fontSize: T.tiny, color: C.textMuted, fontWeight: FontWeight.semibold,
      letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase',
    },
    listCount: { marginLeft: 'auto', fontSize: T.tiny, color: C.textMuted },
    item: { paddingVertical: Spacing.md },
    itemDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
    line1: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm, minHeight: 24 },
    itemName: { flex: 1, fontSize: T.body, lineHeight: 22, fontWeight: FontWeight.medium, color: C.foreground },
    tag: { fontSize: T.tiny, fontWeight: FontWeight.regular, color: C.textMuted },
    verified: { marginTop: 6 },
    itemKcal: { fontSize: T.body, lineHeight: 22, fontWeight: FontWeight.semibold, color: C.foreground, fontVariant: ['tabular-nums'] },
    unit: { fontSize: T.tiny, fontWeight: FontWeight.regular, color: C.textMuted },
    line2: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.sm },
    amount: {
      flexDirection: 'row', alignItems: 'center', height: 32, flexShrink: 1,
      borderRadius: Radius.full, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border,
    },
    // 32 pt tall to keep the row quiet; hitSlop takes each to 44.
    stepBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    amountTxtBox: { justifyContent: 'center', height: 32, flexShrink: 1 },
    amountPlain: { paddingHorizontal: Spacing.md },
    amountTxt: { fontSize: T.small, color: C.foreground, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
    macros: { flex: 1, textAlign: 'right', fontSize: T.tiny, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
    removeBtn: { width: 32, height: 32, marginRight: -Spacing.sm, alignItems: 'center', justifyContent: 'center' },
    note: { fontSize: T.tiny, lineHeight: 16, color: C.textMuted, marginTop: Spacing.sm },
    swapRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: Spacing.sm },
    swapLead: { fontSize: T.tiny, color: C.textSecondary },
    swapChip: {
      paddingVertical: 6, paddingHorizontal: 10, maxWidth: '100%',
      borderRadius: Radius.full, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border,
    },
    swapTxt: { fontSize: T.tiny, color: C.foreground, fontWeight: FontWeight.medium },
    textAction: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: Spacing.sm },
    // Grey, not lime: Add is the one lime thing on the screen.
    textActionTxt: { fontSize: T.tiny, color: C.textSecondary, fontWeight: FontWeight.semibold },

    groupGap: { marginTop: Spacing.md },
    groupHead: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 32 },
    groupHeadTxt: {
      fontSize: T.tiny, color: C.textSecondary, fontWeight: FontWeight.semibold,
      letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase',
    },

    // 5. Where it goes.
    placeRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
      marginTop: Spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, paddingTop: Spacing.sm,
    },
    placeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, height: TAP, paddingHorizontal: Spacing.sm },
    placeTxt: { fontSize: T.body, fontWeight: FontWeight.semibold, color: C.foreground },
    placeDot: { fontSize: T.body, color: C.textMuted },
    chipRow: { flexDirection: 'row', gap: 6, marginTop: Spacing.xs },
    chip: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 36, borderRadius: Radius.md, borderWidth: 1 },
    chipOn: { backgroundColor: C.foreground, borderColor: C.foreground },
    chipOff: { backgroundColor: 'transparent', borderColor: C.border },
    chipTxt: { fontSize: T.small, fontWeight: FontWeight.medium },

    // 6. Footer.
    footer: {
      paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.background,
    },
    tip: { marginBottom: Spacing.sm },
    fixBox: {
      flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm,
      backgroundColor: C.inputBg, borderRadius: Radius.xxl, paddingHorizontal: Spacing.lg, paddingVertical: 10,
    },
    fixInput: {
      flex: 1, fontSize: T.body, lineHeight: 20, color: C.foreground, padding: 0,
      marginBottom: 4, maxHeight: 80, textAlignVertical: 'top',
    },
    fixSend: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.foreground, alignItems: 'center', justifyContent: 'center' },
    actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.sm },
    // The quiet no: plain text, a full tap target, no box.
    discard: { height: BUTTON_HEIGHT, paddingHorizontal: Spacing.lg, alignItems: 'center', justifyContent: 'center' },
    discardTxt: { fontSize: T.body, fontWeight: FontWeight.medium, color: C.textSecondary },
    // The one decision, and the one lime surface on the screen.
    primary: {
      flex: 1, height: BUTTON_HEIGHT, borderRadius: Radius.lg, backgroundColor: Colors.primary,
      alignItems: 'center', justifyContent: 'center',
    },
    primaryText: { fontSize: T.body, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  });
}
