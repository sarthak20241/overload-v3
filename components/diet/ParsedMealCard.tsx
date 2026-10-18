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
 *   sent      - "Just log it": the stream dropped after the request left; the
 *               diary settles it. One line + dismiss.
 *
 * There is deliberately NO state for a finished "Just log it". The write is the
 * answer, so the card leaves and the diary rows are the receipt, each wearing
 * "Added by Drona - Undo". A card there also read as an invitation to reply, and
 * a reply after a write logged the meal a second time. See nutrition.tsx.
 *
 * A review card is tall and sits in an absolutely-positioned wrapper over the
 * day list, so it hides the very entries a user wants to check against before
 * confirming. It can be COLLAPSED to a one-line summary that keeps the parse
 * alive while giving the screen back: nothing is written and nothing is thrown
 * away, so browsing the day is no longer a choice between the card and the
 * screen behind it.
 *
 * The user picks the section and confirms; only then do the entries land in that
 * meal section underneath. Numbers carry receipts: catalog lines are silent,
 * sourced/estimated lines say where they came from.
 *
 * Two instances can be mounted at once: the inline card (hidden) and the one
 * in MealCardPopover. Keep this component free of side effects - no
 * analytics, no writes in effects - or they would fire twice. Those belong in
 * the screen's callbacks, which run once.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat, Easing,
  useReducedMotion, FadeIn,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow } from '@/constants/theme';
import { sectionsOfItems, type ParsedMeal, type ParsedMealItem } from '@/lib/dietData';
import type { MealType } from '@/lib/foods';
import { formatServing, formatMacroGrams } from '@/lib/foods';
import { optionAt, swapLabel } from '@/lib/variantSwap';
import { DronaMark } from '@/components/coach/DronaMark';
import { copyToClipboard } from '@/lib/clipboard';
import { haptics } from '@/lib/haptics';

/** One more state for "Just log it": `sent` (the stream dropped after the
 *  request left; the diary will show what happened). A SUCCESSFUL auto-log has
 *  no state here at all - the card is gone and the rows speak for themselves. */
export type ParseCardState = 'analysing' | 'streaming' | 'review' | 'declined' | 'error' | 'sent';

/** A row whose name is known but whose numbers have not landed yet. */
export interface StreamingRow {
  name: string;
  quantity: number;
  unit: string;
  /** The model's own guess for this line. The counters animate toward these, so
   *  they approach something true rather than spinning at nothing. All four
   *  together: the streaming row shows the same four numbers the settled row
   *  will, so nothing appears, moves or resizes when the catalog answers. */
  est_kcal: number | null;
  est_protein_g: number | null;
  est_carb_g: number | null;
  est_fat_g: number | null;
}

const MEAL_OPTIONS: { value: MealType; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snacks' },
];

const mealLabel = (m: MealType) => MEAL_OPTIONS.find((o) => o.value === m)?.label ?? 'Snacks';

interface Props {
  state: ParseCardState;
  /** Rows to show while the numbers are still resolving (state 'streaming'). */
  streamingRows?: StreamingRow[] | null;
  rawText: string;
  /** Height cap for the whole card. Long meals used to grow past the top of
   *  the screen (the card is pinned above the input, outside any scroll), so
   *  the item list scrolls inside this cap while the totals row and the
   *  section/actions footer stay pinned and always reachable. */
  maxHeight?: number;
  meal?: ParsedMeal | null;
  mealType?: MealType;                       // currently selected section (review)
  message?: string | null;
  adding?: boolean;                          // Add in flight (review)
  saved?: boolean;                           // this parse was saved as a meal/recipe
  onMealTypeChange?: (m: MealType) => void;
  /** Multi-section meal only ("eggs for breakfast, dal at lunch"): move every
   *  line of one group to another section. The single-section card keeps the
   *  chip row and onMealTypeChange; this never shows there. */
  onMoveGroup?: (from: MealType, to: MealType) => void;
  /** A reply that is not a meal (Drona answering a question about these lines,
   *  or a failed follow-up) shown ON the card so the meal survives. */
  notice?: string | null;
  /** I14: index of the line the user asked us to double-check, or null. That
   *  line's button becomes a spinner and Add is disabled while it runs, so the
   *  numbers cannot change under a tap the way the old automatic refine allowed. */
  checkingIndex?: number | null;
  /** Ask the web about one line. Only offered on lines we already admit doubt
   *  about; a confident meal shows nothing. */
  onCheckItem?: (index: number) => void;
  /** Label for a researched alternative the user can accept in one tap. */
  proposalLabel?: string | null;
  onAcceptProposal?: () => void;
  onDismissNotice?: () => void;
  /** Tap a line to correct its serving/quantity/macros before adding. */
  onEditItem?: (index: number) => void;
  /** Remove a single line from the card before adding. */
  onRemoveItem?: (index: number) => void;
  /** Swap a line to the k-th variant the user also logs (lib/variantSwap). */
  onSwapItem?: (index: number, option: number) => void;
  onAdd?: () => void;
  onSave?: () => void;                        // save this parse as a meal/recipe
  onRetry?: () => void;
  onDismiss?: () => void;
  /** Put the user's own words back in the food box to edit and resend. The
   *  screen owns what that does to this card. Absent while a parse runs. */
  onEditWords?: () => void;
  /** Collapsed to the summary line. Owned by the screen so a fresh parse can
   *  reopen it: a new meal the user has not seen yet must never arrive hidden. */
  minimized?: boolean;
  onToggleMinimize?: () => void;
  /** "Just log it" is on for the parse in flight. The waiting copy says
   *  "adding", not "reading": send already committed, and the card should
   *  not read as if a review step were coming. */
  autoLogging?: boolean;
  /** What Drona is doing on a multi-step message ("Checking yesterday's
   *  breakfast"), shown in place of "Drona is reading that". */
  statusLabel?: string | null;
  /** Lift the review card into the bigger popover. Gets the card's height with
   *  nothing capping it, so the popover can grow to fit instead of to a fixed
   *  block. Offered on `review` only. */
  onExpand?: (naturalHeight: number) => void;
  /** This instance IS the popover: it fills its frame, swaps the minimize and
   *  expand controls for one that puts it back, and skips the mount fade so
   *  the morph starts from a card that is already there. */
  expanded?: boolean;
  onCollapse?: () => void;
  /** Popover only: the card's height with nothing capping it, reported as it
   *  changes (a notice lands, a line goes, a follow-up is being read) so the
   *  frame can follow its content. */
  onNaturalHeight?: (h: number) => void;
  /** Bumped by the screen when Drona's reply lands. Each new value lifts the
   *  card into the popover once it has laid out, so a reply arrives big by
   *  default rather than as a strip the user has to open. */
  autoExpandKey?: number;
}

/** The item list never squeezes below this (or below its own content, when
 *  shorter). Without a floor a notice, a proposal and the pinned footer could
 *  take every pixel under the card's cap and leave the foods a zero-height
 *  strip, which read as the note sitting on top of them. About a row and a
 *  half: the first line whole, the next one peeking to say the list scrolls. */
const ITEM_FLOOR = 88;

const r0 = (n: number) => Math.round(n);

/** Provenance label for a line. Catalog matches are trusted and stay unmarked;
 *  anything sourced or guessed says so, so numbers always carry receipts. */
/**
 * Lines the card is allowed to offer a double-check on (I14).
 *
 * Only where we ALREADY admit doubt, which is the whole discipline here:
 * offering to re-check a confident line on every meal teaches the user to
 * trust none of the numbers, which is worse than being occasionally wrong.
 *
 * Three shapes qualify, and the third is why this is not just a confidence
 * check. An ESTIMATE is a line we could not ground at all. A LOW-confidence
 * line is one a guardrail demoted. And a line carrying an ASSUMPTION is one
 * that says out loud it guessed - "I logged the toned one, not the double
 * toned" - which can still be high confidence. That last case is the one with
 * no recovery path at all, even before I15 removed the automatic one, so
 * leaving it out would miss the users this feature exists for.
 *
 * Note MEDIUM is deliberately not enough on its own: verifyItems marks every
 * FatSecret line medium because the row read is skipped for ephemeral ids, so
 * treating medium as doubt would put a button on ordinary, correct lines and
 * teach people to distrust all of them.
 *
 * A line the user typed themselves (manual) is never questioned: their numbers
 * are the answer, not a guess to be improved on.
 */
function uncertain(it: ParsedMealItem): boolean {
  if (it.source === 'manual') return false;
  return it.source === 'estimate' || it.confidence === 'low' || !!it.assumption;
}

function provenance(source: ParsedMealItem['source']): string | null {
  switch (source) {
    case 'off':
    case 'fatsecret':
    case 'web': return 'from label';
    case 'estimate': return "Drona's estimate";
    case 'manual': return 'edited';
    default: return null; // catalog
  }
}

export function ParsedMealCard({
  state, streamingRows, rawText, maxHeight, meal, mealType, message, adding, saved, notice, proposalLabel,
  checkingIndex, onCheckItem,
  onMealTypeChange, onMoveGroup, onAcceptProposal, onDismissNotice, onEditItem, onRemoveItem, onSwapItem, onAdd, onSave, onRetry, onDismiss, onEditWords,
  minimized, onToggleMinimize,
  autoLogging, statusLabel,
  onExpand, expanded, onCollapse, onNaturalHeight, autoExpandKey,
}: Props) {
  const busyChecking = checkingIndex !== null && checkingIndex !== undefined;
  const { C } = useTheme();
  const s = makeStyles(C);
  const selected: MealType = mealType ?? meal?.meal_type ?? 'snack';
  // Collapsing is only offered on `review`. The other three states are already
  // short and transient, and hiding a decline or an error would just lose it.
  // Not while work is in flight either: collapsing would hide the "Adding..."
  // or checking status and leave Discard as the one live control on the strip,
  // which is the same race onEditItem/onRemoveItem are already frozen for.
  const collapsible = state === 'review' && !!meal && !!onToggleMinimize
    && !adding && !busyChecking && !expanded;
  // Frozen while Add writes or a double-check runs, same as minimize: the
  // card should not move under a tap whose result is still landing.
  const expandable = state === 'review' && !!meal && !!onExpand && !expanded
    && !adding && !busyChecking;
  // What the card would measure with no cap: its laid-out height, minus the
  // list's squeezed viewport, plus everything the list holds.
  // State, not refs: the popover follows this number as the content changes.
  const [cardH, setCardH] = useState(0);
  const [listH, setListH] = useState(0);
  const [listContentH, setListContentH] = useState(0);
  const [noticeH, setNoticeH] = useState(0);
  const [noticeContentH, setNoticeContentH] = useState(0);
  const [bodyH, setBodyH] = useState(0);
  const hasList = state === 'review' && !!meal;
  // The card stays mounted across a follow-up (review -> analysing -> review)
  // while the list unmounts in between. Forget the old list's sizes then, so
  // the next auto-expand waits for the new list instead of sizing the popover
  // from the last meal.
  useEffect(() => {
    if (hasList) return;
    setListH(0);
    setListContentH(0);
  }, [hasList]);
  // With a list, only two things squeeze: the list and a notice's words.
  // Swap each one's squeezed viewport for its full content and what is left
  // is the uncapped height. That holds at any frame height, which is why the
  // popover can resize the card without the number moving under it.
  const shownNotice = state === 'review' && !!notice;
  const natural = hasList
    ? cardH - listH + listContentH
      + (shownNotice ? noticeContentH - noticeH : 0)
    // No list to stretch: the body is its own size. Padding + hairline border.
    : bodyH + Spacing.md * 2 + 2;
  const expand = expandable ? () => onExpand!(natural) : undefined;

  const reported = useRef(0);
  useEffect(() => {
    if (!expanded || !onNaturalHeight || natural <= 0) return;
    // The card's two measurements land in separate layout events, so a
    // half-updated pair can read a few points off. Small wobble is not a
    // change worth moving the frame for.
    if (Math.abs(natural - reported.current) < 4) return;
    reported.current = natural;
    onNaturalHeight(natural);
  }, [expanded, onNaturalHeight, natural]);


  // Your own words: two lines by default. A tap shows the rest; once all of
  // it is showing (or it always fit), a tap copies it. The line count comes
  // from an invisible, unclamped copy of the text at the same width, since a
  // clamped Text only reports the lines it drew.
  const [wordsOpen, setWordsOpen] = useState(false);
  const [wordsLines, setWordsLines] = useState(0);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    // Set on every (re)run, not only at first render: React may run this
    // effect's cleanup and then the effect again (fast refresh, strict
    // mode), and a ref left false by that cleanup hid the label for good.
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);
  useEffect(() => { setWordsOpen(false); setCopied(false); }, [rawText]);
  const wordsCut = !wordsOpen && wordsLines > 2;
  const onWordsPress = async () => {
    if (wordsCut) { setWordsOpen(true); return; }
    const ok = await copyToClipboard(rawText);
    if (!ok || !mounted.current) return;
    haptics.tick();
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1800);
  };
  const isCollapsed = collapsible && !!minimized;

  // A fresh reply opens big: wait for the first full layout so the popover
  // starts from the card's real rect and knows how tall to grow.
  const handledKey = useRef(autoExpandKey ?? 0);
  useEffect(() => {
    if (!autoExpandKey || autoExpandKey === handledKey.current) return;
    // A reply that lands while the card is collapsed to its strip is dropped,
    // not saved for later: popping open minutes afterwards, when the user
    // reopens the strip, would be a surprise.
    if (!expand || isCollapsed) { handledKey.current = autoExpandKey; return; }
    // All three: the list's own viewport too. Its content size can land
    // before its layout, and natural would then count the list twice.
    if (cardH <= 0 || listH <= 0 || listContentH <= 0) return;
    handledKey.current = autoExpandKey;
    expand();
    // expand is rebuilt every render; what decides whether to fire is here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoExpandKey, cardH, listH, listContentH, isCollapsed, expandable]);
  const items = state === 'review' && meal ? meal.items : [];
  const sum = items.reduce(
    (a, it) => ({ kcal: a.kcal + it.kcal, p: a.p + it.protein_g, c: a.c + it.carb_g, f: a.f + it.fat_g }),
    { kcal: 0, p: 0, c: 0, f: 0 },
  );
  // Full-day message: lines span more than one section. The card groups them
  // under small headers and drops the chip row (there is no single "where does
  // this go"); a header opens the same four chips for just that group. The
  // ordinary one-meal card is untouched by any of this.
  const sections = sectionsOfItems(items, selected);
  const multi = sections.length > 1;
  const [openGroup, setOpenGroup] = useState<MealType | null>(null);
  const destination = multi ? `${sections.length} meals` : mealLabel(selected);

  /** One line of the review list. `i` is the line's index in meal.items - the
   *  handle every callback uses - and stays the same whether the list is flat
   *  or grouped, which is what keeps edit/remove/check pointed at the right
   *  line when groups reorder the display. */
  const renderRow = (it: ParsedMealItem, i: number, divider: boolean) => {
    // A saved meal's own rows are the user's numbers from My Meals, not an
    // edit: "edited" on them read as if something had been changed.
    // A line with variants to swap to was answered from the user's own log.
    // As served it is the one they log most (userFoodMemory.decideMemory);
    // after a swap it is one they log less.
    const options = it.alternatives ?? [];
    const prov = it.saved_meal ? 'saved meal' : swapLabel(it) ?? provenance(it.source);
    return (
      <Pressable
        key={i}
        onPress={onEditItem ? () => onEditItem(i) : undefined}
        disabled={!onEditItem}
        style={({ pressed }) => [s.item, divider && s.itemDivider, pressed && s.itemPressed]}
        // The screen withholds onEditItem while a check is in flight, so the
        // row is read-only for that window. Announcing "Edit ..." and promising
        // an editor tells a screen-reader user to do what the row cannot.
        accessibilityLabel={onEditItem
          ? `Edit ${it.food_name}, ${r0(it.kcal)} calories`
          : `${it.food_name}, ${r0(it.kcal)} calories`}
        accessibilityHint={onEditItem ? "Opens serving, quantity and macro editing" : undefined}
      >
        <View style={s.itemHead}>
          <Text style={s.itemName} numberOfLines={1}>
            {it.food_name}
            <Text style={s.serving}>{'  '}{formatServing(it.quantity, it.serving_label)}</Text>
          </Text>
          {/* Precise only, and only when two INDEPENDENT sources landed on the
              same energy. It sits where the provenance chip goes because a
              verified line comes back as 'catalog', which prints no chip - so
              this fills a slot rather than fighting one. Deliberately narrow:
              it claims agreement, not correctness, and nothing else in the app
              may set it. */}
          {it.verified && (
            <View style={s.verifiedChip}>
              <Feather name="check" size={9} color={C.accentText} />
              <Text style={s.verifiedText}>VERIFIED</Text>
            </View>
          )}
          {prov && <Text style={s.provChip}>{prov}</Text>}
          {onEditItem && <Feather name="edit-2" size={11} color={C.textMuted} />}
          {onRemoveItem && items.length > 1 && (
            <Pressable
              onPress={(e) => { e.stopPropagation(); onRemoveItem(i); }}
              hitSlop={6}
              style={s.removeBtn}
              accessibilityLabel={`Remove ${it.food_name}`}
            >
              <Feather name="x" size={13} color={C.textMuted} />
            </Pressable>
          )}
        </View>
        <View style={s.macros}>
          <Text style={[s.macroNum, { color: C.foreground }]}>{r0(it.kcal)} cal</Text>
          <Text style={[s.macroNum, { color: C.macro.protein }]}>{formatMacroGrams(it.protein_g)}g P</Text>
          <Text style={[s.macroNum, { color: C.macro.carbs }]}>{formatMacroGrams(it.carb_g)}g C</Text>
          <Text style={[s.macroNum, { color: C.macro.fat }]}>{formatMacroGrams(it.fat_g)}g F</Text>
        </View>
        {it.assumption && <Text style={s.assumption}>{it.assumption}</Text>}
        {/* The other variant the user logs, one tap away. Its numbers came
            with the parse, so the swap is instant and offline. */}
        {onSwapItem && options.length > 0 && (
          <View style={s.swapRow}>
            <Text style={s.swapLead}>Not this one?</Text>
            {options.map((o, k) => (
              <Pressable
                key={`${o.food_name}-${k}`}
                onPress={(e) => { e.stopPropagation(); onSwapItem(i, k); }}
                hitSlop={8}
                style={({ pressed }) => [s.swapChip, pressed && s.itemPressed]}
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
        {/* I14. Deliberately a BUTTON, not a tappable sentence: nobody
            knows to tap prose, and the row itself already opens the
            editor, so a tap inside it would be ambiguous. Its own hit
            area, its own label, and it turns into the progress
            indicator in place rather than moving the card around. */}
        {onCheckItem && uncertain(it) && options.length === 0 && (
          <Pressable
            onPress={(e) => { e.stopPropagation(); onCheckItem(i); }}
            disabled={checkingIndex !== null && checkingIndex !== undefined}
            hitSlop={8}
            style={s.checkBtn}
            accessibilityLabel={`Double-check ${it.food_name} online`}
            accessibilityHint="Looks this food up on the web and offers the numbers it finds"
          >
            {checkingIndex === i
              ? (
                <>
                  <ActivityIndicator size="small" color={C.textSecondary} />
                  <Text style={s.checkTxt}>Checking…</Text>
                </>
              )
              : (
                <>
                  <Feather name="search" size={11} color={C.textSecondary} />
                  <Text style={s.checkTxt}>Double-check</Text>
                </>
              )}
          </Pressable>
        )}
      </Pressable>
    );
  };

  if (isCollapsed && meal) {
    const kcal = r0(meal.items.reduce((sum, it) => sum + it.kcal, 0));
    const n = meal.items.length;
    const summary = `${n} ${n === 1 ? 'item' : 'items'} · ${kcal} kcal → ${destination}`;
    return (
      <Animated.View entering={FadeIn.duration(160)} style={[s.card, s.cardCollapsed]}>
        {/* Expand and Discard are SIBLINGS, not nested. A Pressable inside an
            accessible Pressable can be collapsed into the outer button by
            VoiceOver / TalkBack, leaving Discard unreachable. */}
        <View style={s.collapsedRow}>
          <Pressable
            onPress={onToggleMinimize}
            style={s.collapsedMain}
            accessibilityRole="button"
            accessibilityState={{ expanded: false }}
            accessibilityLabel={`Waiting to be added: ${summary}`}
            accessibilityHint="Opens the parsed meal again"
          >
            <DronaMark size={16} />
            <Text style={s.collapsedTxt} numberOfLines={1}>{summary}</Text>
            <Feather name="chevron-up" size={15} color={C.textMuted} />
          </Pressable>
          {!!onDismiss && (
            <Pressable
              onPress={onDismiss}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Discard"
            >
              <Feather name="x" size={14} color={C.textMuted} />
            </Pressable>
          )}
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      entering={expanded ? undefined : FadeIn.duration(160)}
      style={[s.card, expanded ? s.cardFill : maxHeight != null && { maxHeight }]}
      onLayout={(e) => setCardH(e.nativeEvent.layout.height)}
    >
      {/* A tap on the card's own surface (totals, words, the Drona line,
          padding) lifts it out. Every control inside is its own Pressable and
          answers first, so a tap on a line still opens that line's editor.
          Not accessible itself: it would swallow the controls for VoiceOver,
          and the expand button in the header is the labelled route. */}
      <Pressable
        onPress={expand}
        disabled={!expand}
        accessible={false}
        style={expanded && hasList ? s.fill : s.shrink}
        onLayout={(e) => setBodyH(e.nativeEvent.layout.height)}
      >
      {(!!rawText || collapsible || expandable || (expanded && !!onCollapse)) && (
        <View style={s.rawRow}>
          {/* What the user said, set apart as theirs: its own bubble in the
              input's colour, full-strength text. Everything below it is
              Drona's answer, so the two never read as one block. */}
          {!!rawText && (
            <View style={s.rawGrow}>
              <Pressable
                onPress={onWordsPress}
                style={({ pressed }) => [s.youBubble, pressed && s.itemPressed]}
                accessibilityRole="button"
                accessibilityLabel={copied ? 'Copied to clipboard' : `You said: ${rawText}`}
                accessibilityHint={wordsCut ? 'Shows your whole message' : 'Copies your message'}
              >
                <Text style={s.youTxt} numberOfLines={wordsOpen ? undefined : 2}>{rawText}</Text>
                <Text
                  style={[s.youTxt, s.youMeasure]}
                  onTextLayout={(e) => setWordsLines(e.nativeEvent.lines.length)}
                  accessible={false}
                  importantForAccessibility="no"
                >
                  {rawText}
                </Text>
                {/* Says it in words, on the bubble it is about, without
                    moving the text. */}
                {/* A plain view, shown and hidden. Both a layout-animation
                    enter and a shared-value fade left it invisible inside the
                    popover's frame on device. */}
                {copied && (
                  <View style={s.youCopied} pointerEvents="none">
                    <Text style={s.youCopiedTxt}>Copied to clipboard</Text>
                  </View>
                )}
              </Pressable>
            </View>
          )}
          {/* The user's own words, one tap from the box again. A return arrow,
              not a pencil: the pencils on the lines below edit one food, this
              sends the whole message back down to the box. Same size and weight
              as the copy icon under a Drona chat bubble. */}
          {!!rawText && !!onEditWords && (
            <Pressable
              onPress={onEditWords}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Edit what you wrote"
              accessibilityHint="Puts your words back in the box to change and send again"
            >
              <Feather name="corner-down-left" size={12} color={C.textMuted} style={{ marginTop: 9 }} />
            </Pressable>
          )}
          {expandable && (
            <Pressable
              onPress={expand}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Open bigger"
              accessibilityHint="Lifts this meal into a bigger view to look it over"
            >
              <Feather name="maximize-2" size={12} color={C.textMuted} style={{ marginTop: 9 }} />
            </Pressable>
          )}
          {expanded && !!onCollapse && (
            <Pressable
              onPress={onCollapse}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Put it back"
              accessibilityHint="Returns this meal to the food bar"
            >
              <Feather name="minimize-2" size={13} color={C.textMuted} style={{ marginTop: 8 }} />
            </Pressable>
          )}
          {collapsible && (
            <Pressable
              onPress={onToggleMinimize}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ expanded: true }}
              accessibilityLabel="Minimize"
              accessibilityHint="Keeps this meal waiting while you browse the day"
            >
              <Feather name="chevron-down" size={15} color={C.textMuted} style={{ marginTop: 7 }} />
            </Pressable>
          )}
        </View>
      )}

      {state === 'analysing' && <Analysing C={C} autoLogging={!!autoLogging} label={statusLabel ?? null} />}

      {state === 'streaming' && !!streamingRows && (
        <View>
          {streamingRows.map((r, i) => (
            <SettlingRow key={i} row={r} C={C} s={s} first={i === 0} />
          ))}
          {/* Just log it: the rows still fill in while the app is open (people
              like watching it), but the footer says where this is going. */}
          {autoLogging && <Text style={s.autoNote}>Adding to your diary as it settles</Text>}
        </View>
      )}

      {state === 'sent' && (
        <View style={s.dronaRow}>
          <View style={s.avatar}><DronaMark size={10} color={C.accentText} state="static" /></View>
          <Text style={[s.dronaTxt, { flex: 1 }]}>{message ?? 'Sent. Drona is adding it to your diary; give it a moment.'}</Text>
          {onDismiss && (
            <Pressable onPress={onDismiss} hitSlop={10} style={s.dismiss} accessibilityLabel="Dismiss">
              <Feather name="x" size={15} color={C.textMuted} />
            </Pressable>
          )}
        </View>
      )}

      {state === 'review' && meal && (
        <View style={[s.reviewBody, expanded && s.fill]}>
          {/* The card reads top to bottom in five zones, each with its own
              look so they never run together: 1. what you said (the bubble
              above), 2. the meal total, 3. the foods, 4. Drona, 5. the
              controls. */}

          {/* 2. The meal total, pinned above the scrolling lines so the whole
              read stays visible however long the list is. A labelled block
              with the calories at headline size. Single-line meals skip it:
              the line IS the total. */}
          {items.length > 1 && (
            <View style={s.totals} accessibilityLabel={`Total ${r0(sum.kcal)} calories, ${items.length} items`}>
              <View style={s.totalsHead}>
                <Text style={s.eyebrow}>Meal total</Text>
                <Text style={s.totalCount}>{items.length} items</Text>
              </View>
              <View style={s.totalsRow}>
                <Text style={s.totalKcal}>
                  {r0(sum.kcal)}<Text style={s.totalKcalUnit}> kcal</Text>
                </Text>
                <View style={s.totalMacros}>
                  <Text style={[s.totalNum, { color: C.macro.protein }]}>{formatMacroGrams(sum.p)}g P</Text>
                  <Text style={[s.totalNum, { color: C.macro.carbs }]}>{formatMacroGrams(sum.c)}g C</Text>
                  <Text style={[s.totalNum, { color: C.macro.fat }]}>{formatMacroGrams(sum.f)}g F</Text>
                </View>
              </View>
            </View>
          )}

          {/* 3. The foods. Only this scrolls; the totals above and Drona and
              the controls below stay pinned. Dragging the list also drops the
              keyboard, which buys back the space it was taking. */}
          <ScrollView
            style={[
              s.itemsScroll,
              items.length > 1 && s.itemsAfterTotals,
              expanded && s.fill,
              { minHeight: Math.min(listContentH, ITEM_FLOOR) },
            ]}
            onLayout={(e) => setListH(e.nativeEvent.layout.height)}
            onContentSizeChange={(_w, h) => setListContentH(h)}
            bounces={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator
            persistentScrollbar
          >
          {(multi
            // Grouped: each section's lines under a small header, original
            // indices kept so edit/remove/check still address the right line.
            ? sections.flatMap((sec) => {
              const rows = meal.items
                .map((it, i) => ({ it, i }))
                .filter(({ it }) => (it.meal_type ?? selected) === sec);
              const open = openGroup === sec;
              return [
                <View key={`h-${sec}`}>
                  <Pressable
                    onPress={onMoveGroup ? () => setOpenGroup(open ? null : sec) : undefined}
                    disabled={!onMoveGroup}
                    hitSlop={4}
                    style={s.groupHead}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    accessibilityLabel={`${mealLabel(sec)}, ${rows.length} ${rows.length === 1 ? 'item' : 'items'}`}
                    accessibilityHint="Move these lines to another meal"
                  >
                    <Text style={s.groupHeadTxt}>{mealLabel(sec)}</Text>
                    <Text style={s.groupHeadCount}>{rows.length} {rows.length === 1 ? 'item' : 'items'}</Text>
                    {!!onMoveGroup && (
                      <Feather name={open ? 'chevron-up' : 'chevron-down'} size={13} color={C.textMuted} />
                    )}
                  </Pressable>
                  {open && (
                    <View style={s.groupChips}>
                      {MEAL_OPTIONS.map((o) => {
                        const on = o.value === sec;
                        return (
                          <Pressable
                            key={o.value}
                            onPress={() => { setOpenGroup(null); onMoveGroup?.(sec, o.value); }}
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
            : meal.items.map((it, i) => renderRow(it, i, i > 0)))}
          </ScrollView>

          {/* 4. Drona. A notice (an answer about these lines, a saved meal on
              offer) or his one-liner, never both: two Drona lines at once is
              noise, and it is room the foods need. Both sit in the same
              tinted block with his mark, so his voice always looks like his. */}
          {!!notice ? (
            <View style={[s.coach, s.notice]}>
              {/* The words scroll inside the notice when room runs short (the
                  keyboard is up, a long answer), so the notice gives way
                  alongside the list instead of pushing it out. The choice
                  buttons below stay put. */}
              <ScrollView
                style={s.noticeScroll}
                bounces={false}
                nestedScrollEnabled
                onLayout={(e) => setNoticeH(e.nativeEvent.layout.height)}
                onContentSizeChange={(_w, h) => setNoticeContentH(h)}
              >
                <View style={s.noticeHead}>
                  <View style={s.avatar}><DronaMark size={10} color={C.accentText} state="static" /></View>
                  <Text style={s.noticeTxt}>{notice}</Text>
                  <Pressable onPress={onDismissNotice} hitSlop={8} accessibilityLabel="Dismiss">
                    <Feather name="x" size={13} color={C.textMuted} style={{ marginTop: 3 }} />
                  </Pressable>
                </View>
              </ScrollView>
              {/* A researched alternative: the user decides, we never swap
                  silently. Both choices are local, so neither costs a wait. */}
              {!!proposalLabel && (
                <View style={s.proposalRow}>
                  <Pressable onPress={onDismissNotice} hitSlop={6} style={s.keepBtn}>
                    <Text style={s.keepTxt}>Keep mine</Text>
                  </Pressable>
                  <Pressable onPress={onAcceptProposal} hitSlop={6} style={s.useBtn}>
                    <Text style={s.useTxt}>{proposalLabel}</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ) : meal.drona_line ? (
            <View style={[s.coach, s.coachRow]}>
              <View style={s.avatar}><DronaMark size={10} color={C.accentText} state="static" /></View>
              <Text style={s.dronaTxt} numberOfLines={expanded ? undefined : 2}>{meal.drona_line}</Text>
            </View>
          ) : null}

          {/* 5. The controls, behind a rule: where it goes, then what to do.
              A multi-section meal has no single "where", so its chip row
              yields to the group headers in the list. */}
          <View style={s.footer}>
          {!multi && (
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
          )}

          <View style={[s.actions, multi && s.actionsFirst]}>
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
              // Also disabled while a double-check runs. Letting Add stay live
              // during a lookup would rebuild the exact race I15 removed: tap
              // Add, numbers change, log something you never saw.
              disabled={adding || busyChecking}
              style={[s.addBtn, { opacity: adding || busyChecking ? 0.5 : 1 }]}
            >
              <Feather name="plus" size={14} color={C.background} />
              <Text style={s.addTxt}>{adding ? 'Adding...' : `Add to ${destination}`}</Text>
            </Pressable>
          </View>
          </View>
        </View>
      )}

      {state === 'declined' && (
        <View style={s.dronaRow}>
          <View style={s.avatar}><DronaMark size={10} color={C.accentText} state="static" /></View>
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
      </Pressable>
    </Animated.View>
  );
}

/** The "Drona is reading that" shimmer while the parse is in flight. */
/**
 * A row that knows its name but not yet its number.
 *
 * The counter animates toward the model's own estimate rather than spinning at
 * nothing: when the catalog answers ~300ms later it usually agrees within ~10%,
 * so the number barely moves and reads as SETTLING. A figure that approaches
 * something true is honest; one that approaches nothing is decoration, and it
 * looks like a bug the moment the real value lands somewhere else.
 *
 * The animation is driven by ARRIVAL, not a fixed duration. If the catalog
 * answers in 200ms the row settles in 200ms - a timed animation would be
 * adding latency in order to look fast, which is the opposite of the point.
 */
function SettlingRow(
  { row, C, s, first }: {
    row: StreamingRow;
    C: ReturnType<typeof useTheme>['C'];
    s: ReturnType<typeof makeStyles>;
    first: boolean;
  },
) {
  const kcal = useSettling(row.est_kcal);
  const p = useSettling(row.est_protein_g);
  const c = useSettling(row.est_carb_g);
  const f = useSettling(row.est_fat_g);
  // Macros are small numbers, so one decimal would jitter every frame while a
  // calorie count reads fine as a whole number. Both settle to the same shape
  // the review row uses.
  const known = row.est_kcal !== null;

  return (
    <View style={[s.item, !first && s.itemDivider]}>
      <View style={s.itemHead}>
        <Text style={s.itemName} numberOfLines={1}>
          {row.name}
          <Text style={s.serving}>
            {'  '}{row.quantity !== 1 ? `${row.quantity} × ` : ''}{row.unit}
          </Text>
        </Text>
      </View>
      {/* Same four fields, same order, same units as the settled row above, so
          the only thing that changes when the catalog answers is the numbers -
          nothing appears, moves or resizes under the user's eyes. Dimmed
          throughout to say "not final yet" without a second layout. */}
      <View style={s.macros}>
        <Text style={[s.macroNum, { color: C.textMuted }]}>
          {known ? `${Math.round(kcal)} kcal` : '··· kcal'}
        </Text>
        {/* Each macro answers for ITSELF. One shared flag keyed off est_kcal
            meant a row with calories but a null protein rendered "0g P" -
            useSettling(null) eases toward 0 - which reads as "no protein in
            this food" rather than "not known yet". A wrong fact beats a
            placeholder to the eye, and protein is the number this audience
            reads first. */}
        <Text style={[s.macroNum, { color: C.textMuted }]}>{row.est_protein_g != null ? `${Math.round(p)}g P` : '···g P'}</Text>
        <Text style={[s.macroNum, { color: C.textMuted }]}>{row.est_carb_g != null ? `${Math.round(c)}g C` : '···g C'}</Text>
        <Text style={[s.macroNum, { color: C.textMuted }]}>{row.est_fat_g != null ? `${Math.round(f)}g F` : '···g F'}</Text>
      </View>
      <Text style={s.serving}>working it out</Text>
    </View>
  );
}

/**
 * Eases a counter from 0 toward `target`: fast at first, slowing as it nears,
 * so it reads as converging on an answer rather than counting up to one.
 *
 * Returns 0 for a null target — the caller renders "···" in that case instead,
 * since a number easing toward nothing is a lie about how much we know.
 */
function useSettling(target: number | null): number {
  const [shown, setShown] = useState(0);
  const to = target ?? 0;

  useEffect(() => {
    if (to <= 0) { setShown(0); return; }
    let raf: number;
    let v = 0;
    const step = () => {
      v += (to - v) * 0.18;
      setShown(v);
      // Macros can be small (0-2g), so a fixed 1-unit stop would never settle
      // proportionally. Stop within half a unit or 1% of the target.
      if (Math.abs(to - v) > Math.max(0.5, to * 0.01)) raf = requestAnimationFrame(step);
      else setShown(to);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to]);

  return shown;
}

function Analysing({ C, autoLogging, label }: { C: ReturnType<typeof useTheme>['C']; autoLogging: boolean; label: string | null }) {
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
      <View style={s.avatar}><DronaMark size={10} color={C.accentText} state="static" /></View>
      <Text style={s.dronaTxt}>
        {label ? `${label}...` : autoLogging ? 'Drona is adding that...' : 'Drona is reading that...'}
      </Text>
    </Animated.View>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    card: {
      backgroundColor: C.card, borderRadius: Radius.lg, borderWidth: 1,
      borderColor: C.borderSubtle, padding: Spacing.md, ...Shadow.card,
    },
    // The user's message. Sits left like the start of a thread, hugs its
    // text, and wears the input's fill so it reads as "what I typed".
    youBubble: {
      alignSelf: 'flex-start', maxWidth: '100%',
      backgroundColor: C.inputBg, borderRadius: Radius.md,
      paddingVertical: 6, paddingHorizontal: 10, marginBottom: Spacing.sm,
    },
    youTxt: { fontSize: FontSize.sm, lineHeight: 18, color: C.foreground },
    // Invisible twin of the text, same width as the bubble's text, unclamped.
    youMeasure: { position: 'absolute', top: 6, left: 10, right: 10, opacity: 0 },
    // Pinned to the bubble's bottom edge, hanging into the gap below it.
    youCopied: {
      position: 'absolute', right: 8, bottom: -9,
      paddingVertical: 2, paddingHorizontal: 8, borderRadius: Radius.full,
      backgroundColor: C.accentText,
    },
    youCopiedTxt: { fontSize: FontSize.xs, color: C.background, fontWeight: FontWeight.semibold },
    // The header icons sit level with the bubble's first line (its 6pt top
    // padding plus half the line), not below it, so they cost no height.
    rawRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
    rawGrow: { flex: 1 },

    // Collapsed: tighter padding than the open card so the strip reads as a
    // handle rather than an empty card.
    cardCollapsed: { paddingVertical: 10, paddingHorizontal: Spacing.md },
    collapsedRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
    // Takes the row so tapping anywhere but the X expands.
    collapsedMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
    collapsedTxt: {
      flex: 1, fontSize: FontSize.sm, color: C.foreground,
      fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'],
    },

    // flexShrink on the body + the scroll is what makes the maxHeight cap
    // squeeze the LIST rather than push the footer off the card.
    reviewBody: { flexShrink: 1 },
    shrink: { flexShrink: 1 },
    // Popover: the frame sets the height, the card fills it, and the list
    // takes whatever the frame grows by so the footer stays at the bottom.
    cardFill: { flex: 1 },
    fill: { flexGrow: 1, flexShrink: 1 },
    itemsScroll: { flexGrow: 0, flexShrink: 1 },

    // Zone 2: a summary, not another row. Labelled, calories at headline
    // size, ruled off from the foods below.
    totals: {
      paddingBottom: Spacing.sm + 2, borderBottomWidth: 1, borderBottomColor: C.border,
    },
    totalsHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
    eyebrow: {
      fontSize: FontSize.xs, color: C.textMuted, fontWeight: FontWeight.semibold,
      letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase',
    },
    totalsRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.md },
    totalKcal: {
      fontSize: FontSize.xxl, fontWeight: FontWeight.semibold, color: C.foreground,
      letterSpacing: LetterSpacing.snug, fontVariant: ['tabular-nums'],
    },
    totalKcalUnit: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: C.textMuted, letterSpacing: 0 },
    totalMacros: { flexDirection: 'row', gap: Spacing.md, marginLeft: 'auto' },
    totalNum: { fontSize: FontSize.md, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
    totalCount: { marginLeft: 'auto', fontSize: FontSize.xs, color: C.textMuted },
    itemsAfterTotals: { marginTop: Spacing.xs },

    // Zone 4: Drona's voice, a tinted block with his mark, notice or line.
    coach: { backgroundColor: C.primarySubtle, borderRadius: Radius.md, marginTop: Spacing.md },
    coachRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: Spacing.sm },

    // Zone 5: the controls, ruled off from everything above them.
    footer: {
      marginTop: Spacing.md, paddingTop: Spacing.md,
      borderTopWidth: 1, borderTopColor: C.border,
    },
    actionsFirst: { marginTop: 0 },

    // A near-zero shrink weight, not zero: when room runs short the food list
    // gives way first (down to its floor) and the notice keeps its words. Yoga
    // weights shrink by basis, so at an equal weight the long list and the
    // short notice gave way together and the notice ended up a single line.
    // Only once the list is at its floor does the notice start to scroll.
    notice: { padding: Spacing.sm, flexShrink: 0.01 },
    // One line always shows; the rest scrolls when the card is short.
    noticeScroll: { flexGrow: 0, flexShrink: 1, minHeight: 18 },
    noticeHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    proposalRow: { flexDirection: 'row', gap: 8, marginTop: Spacing.sm, justifyContent: 'flex-end' },
    keepBtn: { paddingVertical: 7, paddingHorizontal: Spacing.md },
    keepTxt: { fontSize: FontSize.sm, color: C.textSecondary, fontWeight: FontWeight.medium },
    useBtn: {
      backgroundColor: C.accentText, borderRadius: Radius.md,
      paddingVertical: 7, paddingHorizontal: Spacing.md,
    },
    useTxt: { fontSize: FontSize.sm, color: C.background, fontWeight: FontWeight.semibold },
    noticeTxt: { flex: 1, fontSize: FontSize.sm, lineHeight: 18, color: C.textSecondary },

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
    verifiedChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    verifiedText: {
      fontSize: 9, color: C.accentText, fontWeight: FontWeight.semibold,
      letterSpacing: LetterSpacing.eyebrow,
    },
    macros: { flexDirection: 'row', gap: Spacing.md, marginTop: 5 },
    macroNum: { fontSize: 11, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
    assumption: { fontSize: FontSize.sm, color: C.textDim, fontStyle: 'italic', marginTop: 4 },
    // Reads as a control, not as text: bordered pill, its own hit area, and it
    // sits left-aligned under the line it belongs to so the ownership is
    // obvious. alignSelf keeps it from stretching across the row.
    checkBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
      marginTop: 6, paddingVertical: 4, paddingHorizontal: 8,
      borderRadius: Radius.full, borderWidth: 1, borderColor: C.borderSubtle,
    },
    checkTxt: { fontSize: FontSize.xs, color: C.textSecondary, fontWeight: '600' },
    swapRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 6 },
    swapLead: { fontSize: FontSize.xs, color: C.textSecondary },
    swapChip: {
      paddingVertical: 5, paddingHorizontal: 10, maxWidth: '100%',
      borderRadius: Radius.full, borderWidth: 1, borderColor: C.borderSubtle,
    },
    swapTxt: { fontSize: FontSize.xs, color: C.foreground, fontWeight: FontWeight.medium },

    sectionRow: { flexDirection: 'row', gap: 6 },
    // Full-day message: one small header per section above its lines. Reads as
    // a label, not a control, until the chevron says it opens.
    groupHead: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      marginTop: Spacing.sm, paddingTop: Spacing.sm, paddingBottom: 2,
      borderTopWidth: 1, borderTopColor: C.borderSubtle,
    },
    groupHeadTxt: {
      fontSize: 10, color: C.textSecondary, fontWeight: FontWeight.semibold,
      letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase',
    },
    groupHeadCount: { fontSize: FontSize.xs, color: C.textMuted, marginRight: 'auto' },
    groupChips: { flexDirection: 'row', gap: 6, marginTop: 6, marginBottom: 4 },
    chip: {
      flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: Radius.md, borderWidth: 1,
    },
    chipOn: { backgroundColor: C.accentText, borderColor: C.accentText },
    chipOff: { backgroundColor: 'transparent', borderColor: C.border },
    chipTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },

    // NO flex here. This is a row of content inside a column, so it must size
    // to what it holds. `flex: 1` means flexBasis 0 plus grow, and in an
    // auto-height column there is no free space to grow into, so the row
    // collapsed to zero: the fixed-size avatar still drew and the flex:1 text
    // beside it got no width at all. That is why "hey" in the food bar showed
    // Drona's mark and no reply, for every decline, every 'sent' notice, and
    // the reading indicator. The review row already carried a local `flex: 0`
    // override for exactly this, which fixed one of the four places it bites.
    dronaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: Spacing.md },
    avatar: {
      width: 20, height: 20, borderRadius: 10, backgroundColor: C.primarySubtle,
      alignItems: 'center', justifyContent: 'center',
    },
    dronaTxt: { flex: 1, fontSize: FontSize.sm, lineHeight: 18, color: C.textSecondary },

    actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.md },
    saveIcon: { padding: 8 },
    savedChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 8 },
    savedTxt: { fontSize: FontSize.sm, color: C.accentText, fontWeight: FontWeight.semibold },
    removeBtn: { padding: 4 },
    discard: { paddingVertical: 8, paddingHorizontal: 12 },
    discardTxt: { fontSize: FontSize.base, color: C.textSecondary, fontWeight: FontWeight.medium },
    addBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      backgroundColor: C.accentText, borderRadius: Radius.md, paddingVertical: 11,
    },
    addTxt: { fontSize: FontSize.base, color: C.background, fontWeight: FontWeight.semibold },
    dismiss: { padding: 2 },

    autoNote: { fontSize: FontSize.xs, color: C.textMuted, marginTop: Spacing.sm },
  });
}
