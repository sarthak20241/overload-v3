/**
 * Nutrition day view — the diet "diary" + journal in one screen.
 *
 * Structure = MyFitnessPal meal sections (Breakfast / Lunch / Dinner / Snacks),
 * each with its entries + subtotal, under a co-equal calories + protein summary
 * (MacroRing). Logging = the inline "Tell Drona what you ate" input at the bottom
 * (Journable model): you type/speak plain words, the entry resolves in place, and
 * tapping an entry shows Drona's read. With "Just log it" on (the logging-mode
 * sheet), send commits and the server writes the diary itself, so the user can
 * close the app; the diary reconciles what landed on the next open (lib/autoLog).
 * Calm/mature system: Inter (system fallback
 * for now), tabular figures, Colors.macro register, lime reserved for the action.
 *
 * v1 renders with sample data so the layout is verifiable on-device; the Supabase
 * day-load + the NL parse (Drona edge fn) wire in next.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, FlatList, Pressable, TextInput, StyleSheet, useWindowDimensions, AppState, Keyboard,
  type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import {
  Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow,
} from '@/constants/theme';
import { MacroRing } from '@/components/ui/MacroRing';
import { MacroBar } from '@/components/diet/MacroBar';
import { ParsedMealCard, type ParseCardState } from '@/components/diet/ParsedMealCard';
import { MealWaitSheet } from '@/components/diet/MealWaitSheet';
import { MealResultScreen } from '@/components/diet/MealResultScreen';
import {
  arrivalAction, readyLine, readyAction, packReady, unpackReady, readyStoreStep, settleRestoredKey, stepAmount, scaleLine, type ReadyKind,
} from '@/lib/mealReady';
import { isMeasurementUnit } from '@/lib/units';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { OrbLoader } from '@/components/ui/OrbLoader';
import { DayLoadFailed, DaySummaryLoading, MealRowsLoading } from '@/components/diet/DayLoading';
import { ParsedItemEditor } from '@/components/diet/ParsedItemEditor';
import { EntryEditSheet } from '@/components/diet/EntryEditSheet';
import { SwipeToRemove } from '@/components/diet/SwipeToRemove';
import { useToast } from '@/components/ui/Toast';
import { NutritionGoalSheet } from '@/components/diet/NutritionGoalSheet';
import { MaintenanceRow } from '@/components/diet/MaintenanceRow';
import { FuelDaysSheet } from '@/components/diet/FuelDaysSheet';
import { fuelOn } from '@/lib/fuelDays';
import { goalDayFor, latestLogDay, readLogDayPhrase } from '@/lib/logDay';
import { takePendingParse } from '@/lib/pendingParse';
import { SaveMealSheet } from '@/components/diet/SaveMealSheet';
import { SavedMealsSheet } from '@/components/diet/SavedMealsSheet';
import { DayPickerSheet } from '@/components/diet/DayPickerSheet';
import Svg, { Circle } from 'react-native-svg';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
import { ParseSpeedSheet } from '@/components/diet/ParseSpeedSheet';
import {
  getParseSpeed, setParseSpeed, effectiveParseSpeed, type ParseSpeed,
} from '@/lib/parseSpeed';
import { useCoachAccess } from '@/hooks/useCoachAccess';
import {
  useDayNutrition, useNutritionTargets, useNutritionStreak, setLogMeal, setLogDate, ymd,
  type PendingFoodMeal, parseMeal, parseMealStreaming, logParsedMeal, undoParsedMeal, capNotice, capUpgradeContext, sectionsOf,
  loadNutritionRange, dateFromYmd, listSavedMeals, savedMealAsItems, usePrefetchWeek,
  deleteMealEntry, type ParsedMeal, type LoggedEntry, type ParsedMealItem, type StreamedItem, type LoggedParseRef,
  FOOD_TURNS_KEPT,
} from '@/lib/dietData';
import {
  applyCoachFoodCreate,
  parseCoachFoodCreate,
  type CoachFoodCreate,
  type CoachFoodCreateResult,
} from '@/lib/coachFoodCreate';
import { FoodCreateCard } from '@/components/ai/FoodCreateCard';
import { haptics } from '@/lib/haptics';
import {
  getAutoLog, setAutoLog, newAutoLogClientId, addPending, removePending, touchPending,
  reconcilePending, markAddedByDrona, addedByDronaRef, forgetAddedByDrona,
  type PendingAutoLog,
} from '@/lib/autoLog';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import type { MealType } from '@/lib/foods';
import { formatServing, formatMacroGrams } from '@/lib/foods';
import { swapToAlternative } from '@/lib/variantSwap';
import { DronaMark } from '@/components/coach/DronaMark';
import { MealSuggestions } from '@/components/diet/MealSuggestions';
import { CopyMealSheet } from '@/components/diet/CopyMealSheet';
import { OrbRefreshControl, RefreshOrb, usePullRefresh } from '@/components/ui/OrbRefresh';
import { learnPatterns, mealsToSuggest, copyableFromDay, withPreviousDay, type FoodSuggestion, type HistoryEntry } from '@/lib/foodPatterns';
import { useFoodHistory, useDayMealLines, relogLines, lineAsItem } from '@/lib/foodPatternsData';
import { FoodBoxTourTip } from '@/components/diet/FoodBoxTourTip';
import { shouldOfferTour, tourEndReason, tourEndRetires, tourNext, tourSignalForFlow, TOUR_COPY, type TourEndReason, type TourEvent, type TourStep } from '@/lib/foodBoxTour';
import { getFoodBoxTourDone, setFoodBoxTourDone } from '@/lib/foodBoxTourStore';

/** The AI-logging flow state driving the bar + the ParsedMealCard above it.
 *  'review' holds a parsed-but-UNLOGGED meal: nothing is written until the user
 *  picks a section and taps Add. mealType is the currently-selected section. */
type ParseFlow =
  | { status: 'idle' }
  // `auto`: this parse was sent in "Just log it" mode, so the card says
  // "adding" rather than "reading" while it waits.
  // `statusLabel`: a multi-step message, and what Drona is doing for it now
  // ("Checking yesterday's breakfast"). Sent by the food agent only.
  | { status: 'analysing'; raw: string; auto?: boolean; statusLabel?: string }
  // Fast mode only: the names are known and the numbers are still settling, so
  // the card shows real rows with shimmering figures instead of a spinner.
  // Named rows arrive ~1.2s ahead of the finished parse; this is that window.
  | { status: 'streaming'; raw: string; rows: StreamedItem[]; auto?: boolean }
  // There is no state for "Just log it succeeded". The write IS the answer, so
  // the flow goes straight back to idle and the diary rows are the receipt -
  // each one wearing "Added by Drona - Undo". See the auto branch in runParse.
  // "Just log it": the stream dropped after the request left. The server
  // finishes without us; the pending list (lib/autoLog) settles it.
  | { status: 'sent'; raw: string; message: string; clientId: string }
  // `notice` carries a reply that is NOT a new meal (an answer to a question,
  // or a parse failure) while the reviewed meal stays on screen. Asking
  // "is that right?" must never throw away work the user hasn't added yet.
  | {
      status: 'review'; raw: string; meal: ParsedMeal; mealType: MealType;
      // Set once the user picks a section themselves. A follow-up re-parses
      // only the new text ("make it a small one"), so the server's fresh guess
      // is weaker evidence than a choice the user already made - without this
      // flag their pick silently reverts on the next message.
      mealTypePicked?: boolean;
      // Everything the user wrote for this meal, follow-ups joined ("1 apple;
      // make it a small one"). `raw` keeps only a correction's own words, so
      // the card's return arrow sends this instead. Absent: same as `raw`.
      words?: string;
      notice?: string | null;
      // Researched numbers that disagree with what is shown, offered as a
      // choice. Applying is local, so picking costs no round trip.
      proposal?: { items: ParsedMealItem[]; note: string } | null;
      // A line opened here to change its portion first, nothing parsed:
      // 'pattern' is a usual food, 'copy_day' the day before's food offered
      // while the meal has no habit. Add keeps the line's original labels
      // (relogColumns) and reports which one it was.
      origin?: 'pattern' | 'copy_day';
      // The diary day Add writes to, fixed when the parse was sent: the user
      // may page the diary elsewhere while it waits. Absent: the day on screen.
      dayIso?: string;
      // The tier that read this meal, for the result screen's chip.
      tier?: ParseSpeed;
    }
  | { status: 'declined'; raw: string; message: string; pendingMeal?: PendingFoodMeal | null }
  // On an add (write) failure we keep the reviewed meal so Retry re-attempts the
  // WRITE, not the whole AI parse (which would burn an API call + could differ).
  // `clientId`/`logDate`: a "Just log it" send that failed in transport. Retry
  // re-uses the SAME id, so if the request did reach the server (which then
  // finished without us) the retry is a no-op there instead of a double log.
  | {
      status: 'error'; raw: string; message: string; meal?: ParsedMeal; mealType?: MealType;
      clientId?: string; logDate?: string;
      /** The reviewed card's `words`, kept so Retry rebuilds it whole. */
      words?: string;
      /** A suggestion's origin, kept so a retried Add is still reported as one. */
      origin?: 'pattern' | 'copy_day';
      /** A failed Add keeps the day and tier it was for, so Retry (and a
       *  restart, which stores this as waiting) still means the same meal. */
      dayIso?: string;
      tier?: ParseSpeed;
    }
  // The user asked to SAVE a food or meal, and Drona drafted it. Nothing is
  // written until the card is tapped; `result` is what came back from that tap.
  | {
      status: 'create'; raw: string; create: CoachFoodCreate;
      result: CoachFoodCreateResult | null; busy: boolean;
    };

/** The "use your saved meal?" offer for a reviewed card, or null. The FIRST
 *  suggestion whose line is still on the card wins; the proposal is the whole
 *  card with that one line replaced by the saved meal's own rows, which is the
 *  shape onAcceptProposal already applies. Any failure is just no offer. */
async function savedMealOffer(
  supabase: Parameters<typeof listSavedMeals>[0],
  items: ParsedMealItem[],
  suggestions: { food_name: string; saved_id: string; saved_name: string }[],
): Promise<{ notice: string; proposal: { items: ParsedMealItem[]; note: string } } | null> {
  if (suggestions.length === 0) return null;
  try {
    const saved = await listSavedMeals(supabase);
    const key = (n: string) => n.trim().toLowerCase();
    for (const sug of suggestions) {
      const meal = saved.find((m) => m.id === sug.saved_id);
      const at = items.findIndex((it) => key(it.food_name) === key(sug.food_name));
      if (!meal || at < 0) continue;
      const swapped = savedMealAsItems(meal, items[at].meal_type);
      const kcal = Math.round(swapped.reduce((a, it) => a + it.kcal, 0));
      return {
        notice: `You have ${meal.name} saved, ${kcal} kcal with your own numbers. Want that instead of ${items[at].food_name}?`,
        proposal: { items: [...items.slice(0, at), ...swapped, ...items.slice(at + 1)], note: 'Use my saved meal' },
      };
    }
  } catch {
    // No offer. The card is right as it is.
  }
  return null;
}

const fmtK = (n: number) => Math.round(n).toLocaleString();
const calCaption = (eaten: number, goal: number) =>
  `${fmtK(eaten)} / ${fmtK(goal)} kcal`;

/** The meal a quick-add should default to when opened from the global logger
 *  (not a specific meal row). Infer from the clock instead of always seeding
 *  Snacks, so a morning quick-add lands in Breakfast. */
function mealForNow(): MealType {
  const h = new Date().getHours();
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 16) return 'lunch';
  if (h >= 16 && h < 22) return 'dinner';
  return 'snack';
}

/** "Today" / "Yesterday" / "Wed, Jul 9" for the diary date header. */
function dayLabel(date: Date): string {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (ymd(date) === ymd(today)) return 'Today';
  if (ymd(date) === ymd(yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Which door into food search: the icon inside the food box, a meal's own
 *  "Add to" row, or the guest bar (no box for guests). */
type SearchSource = 'box_icon' | 'meal_row' | 'guest_bar';

/** Open the full-screen food search targeting a meal (MFP model, not a drawer).
 *  The target meal goes through setLogMeal (a module store the screens read on
 *  focus) because food-search is a retained Tabs screen and router params went
 *  stale across re-opens — which made every log land in breakfast. */
let lastSearchOpenAt = 0;
function openSearch(meal: MealType, source: SearchSource) {
  lastSearchOpenAt = Date.now();
  track('food_search_opened', { source, meal });
  setLogMeal(meal);
  router.push({ pathname: '/food-search', params: { meal } });
}

/** How long "Your lunch is ready to check" stays up. Long enough to notice
 *  and reach from another screen; the strip on Nutrition keeps it after. */
const READY_TOAST_MS = 8000;
/** How long a swiped-away food can still be brought back. */
const UNDO_MS = 4000;
/** The delete waits a beat past the bar, so an Undo tap as the bar leaves
 *  still finds the rows pending instead of already deleted. */
const COMMIT_MS = UNDO_MS + 400;

interface MealDef { type: MealType; label: string; icon: keyof typeof Feather.glyphMap }

const MEALS: MealDef[] = [
  { type: 'breakfast', label: 'Breakfast', icon: 'sunrise' },
  { type: 'lunch', label: 'Lunch', icon: 'sun' },
  { type: 'dinner', label: 'Dinner', icon: 'sunset' },
  { type: 'snack', label: 'Snacks', icon: 'coffee' },
];

/** Composer chip face per tier. Kept next to MEALS rather than inline so the
 *  icon and the screen-reader label cannot drift apart. */
const SPEED_CHIP: Record<ParseSpeed, { icon: 'zap' | 'target' | 'award'; label: string }> = {
  quick: { icon: 'zap', label: 'Quick' },
  thorough: { icon: 'target', label: 'Thorough' },
  precise: { icon: 'award', label: 'Precise' },
};

const round = (n: number) => Math.round(n);
/** One shared empty list, so the copy sheet's inputs keep their identity. */
const NO_LINES: never[] = [];

/** Local midnight of the Sunday that starts `d`'s calendar week. */
const sundayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());

export default function NutritionScreen() {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  // Which calendar day the diary is showing. Defaults to today; ‹ ›, the week
  // strip and the calendar move it, back or ahead up to latestLogDay(). Logging
  // or editing on another day writes to that day (see the sync below).
  const [viewDate, setViewDate] = useState<Date>(() => new Date());
  const [calendarOpen, setCalendarOpen] = useState(false);
  // todayIso, the "Today" label and mealForNow() read the clock at render. A
  // screen left open re-renders at each hour (midnight included) and on coming
  // back to the foreground, so they never go stale with nothing else to redraw.
  const [, setClockHour] = useState(() => new Date().getHours());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      // React skips the render when the hour is unchanged.
      setClockHour(new Date().getHours());
      const now = new Date();
      const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
      clearTimeout(timer);
      timer = setTimeout(tick, nextHour.getTime() - now.getTime() + 1000);
    };
    tick();
    const sub = AppState.addEventListener('change', (next) => { if (next === 'active') tick(); });
    return () => { clearTimeout(timer); sub.remove(); };
  }, []);
  const viewIso = ymd(viewDate);
  const todayIso = ymd(new Date());
  const isToday = viewIso === todayIso;
  const latestIso = ymd(latestLogDay());
  const atLatest = viewIso >= latestIso;
  // The strip shows Sunday-start calendar weeks, so the columns (S M T W T F S)
  // never shuffle — only the highlight moves. It pages a week per swipe: back
  // two years (further if the calendar went there) and ahead to the week of the
  // last loggable day. The page on screen is always the week holding viewDate.
  const weekStart = sundayOf(viewDate);
  const weekStartIso = ymd(weekStart);
  const latestWeekIso = ymd(sundayOf(dateFromYmd(latestIso)));
  const floorWeekIso = ymd(sundayOf(new Date(new Date().getFullYear() - 2, new Date().getMonth(), new Date().getDate())));
  const firstWeekIso = weekStartIso < floorWeekIso ? weekStartIso : floorWeekIso;
  const weekStarts = useMemo(() => {
    const out: Date[] = [];
    const first = dateFromYmd(firstWeekIso);
    for (let i = 0; ; i++) {
      const w = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i * 7);
      if (ymd(w) > latestWeekIso) break;
      out.push(w);
    }
    return out;
  }, [firstWeekIso, latestWeekIso]);
  const weekIndex = weekStarts.findIndex((w) => ymd(w) === weekStartIso);
  const {
    byMeal, totals: dayTotals, totalsDayIso, loading, failedDayIso, reload,
    addPending: addPendingLines, settlePending: settlePendingLines, dropPending: dropPendingLines, rowKey,
  } = useDayNutrition(viewIso);
  // A pull re-reads the day on screen, for foods logged from another device.
  const { refreshing, onRefresh } = usePullRefresh(reload);
  // The numbers on screen belong to `totalsDayIso`. On a day switch that lags
  // `viewIso` by a fetch, and the old day's ring, macros and food sat under the
  // new day's header for a second or two. Shimmer until they agree: a stale
  // number is a wrong number, and an empty ring would be a wrong claim too.
  // A failed fetch never catches totalsDayIso up, so "waiting for it" alone
  // would shimmer forever. A failure for THIS day gets a Retry instead, and
  // still never the old day's numbers.
  const dayFailed = failedDayIso === viewIso && totalsDayIso !== viewIso;
  const dayLoading = !dayFailed && (loading || totalsDayIso !== viewIso);
  const dayUnknown = dayLoading || dayFailed;
  // The rest of this week, loaded in the background only once the day on
  // screen has landed, so it never competes with it.
  usePrefetchWeek(weekStartIso, !dayUnknown);
  const supabase = useSupabaseClient();
  const { isSignedIn, user } = useClerkUser();
  const { kbHeight } = useKeyboardAwareScroll();
  const { width: winW, height: winH } = useWindowDimensions();
  // Bottom edge of the calorie ring + macro bars, in the day scroll's CONTENT
  // coordinates, plus how far that content is currently scrolled. Subtracting
  // the second from the first is what turns it into a position on screen — the
  // two only agree while the day sits at its top, and the input bar the card
  // hangs off is pinned outside the scroll, so a user can absolutely be
  // scrolled down at a meal section when a parse lands.
  const [summaryBottom, setSummaryBottom] = useState(0);
  const [dayScrollY, setDayScrollY] = useState(0);
  // Quantised: this runs on every scroll frame, and the cap only has to move in
  // steps a person can see. Returning `prev` unchanged skips the re-render.
  // Floored at 0: iOS rubber-banding reports a negative offset for the length of
  // an overscroll bounce, which would push the summary's computed screen position
  // DOWN past where it is drawn and shrink the card for the duration of the pull.
  const onDayScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = Math.max(0, Math.round(e.nativeEvent.contentOffset.y / 16) * 16);
    setDayScrollY((prev) => (prev === y ? prev : y));
  }, []);
  // Top of the food box on screen, so the popover and its blur stop above it.
  // The bar's bottom padding lives here once: the bar's style uses it, and so
  // does the popover's edge, so the two cannot drift apart. Computed rather
  // than measured because the bar rides the keyboard by `bottom`, which
  // fires no onLayout on the row inside it.
  const barPadBottom = kbHeight > 0 ? Spacing.sm : insets.bottom + 12;
  const [inputRowH, setInputRowH] = useState(52);
  const popBottomEdge = winH - kbHeight - barPadBottom - inputRowH;
  // Cap the parse card so a long meal never runs past the top of the screen
  // (the card is pinned above the input, outside the day scroll — the lines
  // scroll INSIDE it instead).
  //
  // `hardAvail` is the whole gap between the safe area and the input bar. It is
  // the ceiling in both states, so the card's own header — and the minimize
  // control in it — is always on screen. Measured from the food box's real
  // top edge, less the card's gap above it: a fixed 96 for the bar assumed
  // one line of text at the default size, and a taller box (large text,
  // a second line) let the card's footer slide under it again.
  const hardAvail = popBottomEdge - Spacing.sm - insets.top;

  // Keyboard UP: take all of it. The keyboard already hides the day, so holding
  // the card short only buys blank space nobody can read behind — it costs the
  // user rows of the meal they are still correcting.
  //
  // Keyboard DOWN: start below the summary instead, so the ring and the macro
  // bars the card is about to change stay readable behind it. Two guards on
  // that: never starve the card below its header + a line + its footer (260),
  // and never let it run more than ~60% of the screen. Both stay under
  // `hardAvail`, since a floor is only a floor while it fits.
  // Where the summary's bottom edge actually sits on screen right now. Once it
  // has scrolled up past the safe area there is nothing left to protect, and
  // `Math.max` hands the card the whole gap back.
  const summaryScreenBottom = summaryBottom - dayScrollY;
  const belowSummary = summaryBottom > 0
    ? winH - kbHeight - Math.max(insets.top, summaryScreenBottom + Spacing.md) - 96
    : hardAvail;
  const restingHeight = Math.min(
    Math.min(winH * 0.6, hardAvail),
    Math.max(Math.min(260, hardAvail), belowSummary),
  );
  const cardMaxHeight = Math.max(0, kbHeight > 0 ? hardAvail : restingHeight);

  // AI food logging (Drona parse). Signed-in only; guests keep the picker.
  // Parse -> review card (nothing logged yet) -> the user picks the section and
  // taps Add -> we write it. No auto-dismiss, no timer: the user is in control.
  // The one exception is opt-in: with "Just log it" on (lib/autoLog), send IS
  // the commit and the SERVER writes the diary, so the user can close the app.
  // Undo lives on the receipt strip and on each diary row Drona added.
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);

  // A Drona card's "Try it" lands here with focus=ai: open the keyboard on the
  // box. This tab stays mounted, so clear the param once used, or the next
  // visit would focus it again and a second card could not. A focus effect, not
  // a plain one: leaving the tab before the timer fires must cancel it, or the
  // hidden box would raise the keyboard over another screen.
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  useFocusEffect(useCallback(() => {
    if (focus !== 'ai' || !isSignedIn) return;
    // After the tab switch settles; focusing mid-transition drops the keyboard.
    // Cleared after, not before: clearing re-runs this effect, whose cleanup
    // would cancel the pending focus.
    const t = setTimeout(() => {
      inputRef.current?.focus();
      router.setParams({ focus: undefined });
    }, 350);
    return () => clearTimeout(t);
  }, [focus, isSignedIn]));
  const [flow, setFlow] = useState<ParseFlow>({ status: 'idle' });
  // Mirror of `flow` for callbacks that must read it without re-subscribing
  // (runParse would otherwise capture a stale flow or churn its identity).
  const flowRef = useRef<ParseFlow>(flow);
  useEffect(() => { flowRef.current = flow; }, [flow]);
  // What was said, so a bare "yes" can answer whatever Drona just offered.
  // Kept in a ref (never rendered) and trimmed to the last few turns.
  const turnsRef = useRef<{ role: 'user' | 'drona'; text: string }[]>([]);
  const pushTurn = useCallback((role: 'user' | 'drona', text: string) => {
    if (!text.trim()) return;
    // Ten turns, the user's and Drona's, so a fix in message 5 still sees what
    // message 3 added (lib/dietData.ts sends them all). Cleared with the card.
    turnsRef.current = [...turnsRef.current, { role, text }].slice(-FOOD_TURNS_KEPT);
  }, []);
  const [adding, setAdding] = useState(false);
  const [editEntry, setEditEntry] = useState<LoggedEntry | null>(null);
  // Rows swiped away. They leave the list and the ring at once; the delete
  // itself waits behind the Undo bar (commitRemoves). An id stays here after
  // its delete lands, so a reload still in flight cannot flash the row back.
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const pendingRemoves = useRef<LoggedEntry[]>([]);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The toast context hands out a new object on every show, so effects and
  // callbacks read it through a ref. As a dep it re-ran the leave-screen flush
  // below on each show, which hid the Undo bar and deleted at once.
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const totals = useMemo(() => {
    if (removedIds.size === 0) return dayTotals;
    const t = { ...dayTotals };
    for (const m of MEALS) for (const e of byMeal[m.type]) {
      if (!removedIds.has(e.id)) continue;
      t.kcal -= e.kcal; t.protein_g -= e.protein_g; t.carb_g -= e.carb_g; t.fat_g -= e.fat_g;
    }
    return { kcal: Math.max(0, t.kcal), protein_g: Math.max(0, t.protein_g), carb_g: Math.max(0, t.carb_g), fat_g: Math.max(0, t.fat_g) };
  }, [dayTotals, byMeal, removedIds]);
  // `baseTargets` is an ordinary day. The viewed day may be a fuel day (a long
  // run, a leg day) with more on top, so the ring, bars and Drona line all
  // read `targets`, the viewed day's own numbers.
  const {
    targets: baseTargets, isCustom, apply: applyTargets,
    fuelDays, applyFuelDays, targetsOn, overrideOn, applyDayTarget,
  } = useNutritionTargets();
  const targets = targetsOn(viewDate);
  const viewFuel = fuelOn(fuelDays, viewDate.getDay());
  const [fuelOpen, setFuelOpen] = useState(false);
  // Real logging streak (consecutive days with a meal). Pass today's kcal so the
  // first log of the day bumps it immediately, not just on the next screen focus.
  const streak = useNutritionStreak(totals.kcal);
  const [goalOpen, setGoalOpen] = useState(false);
  // Saved meals: save a parse for later; log a saved one in a tap.
  const [saveItems, setSaveItems] = useState<ParsedMealItem[] | null>(null);
  const [savedReview, setSavedReview] = useState(false); // current parse was saved
  // Collapsed state for the parse card. Held here, not in the card, so a fresh
  // parse can force it open: a meal the user has not seen yet must never
  // arrive already hidden behind a summary line.
  const [cardMinimized, setCardMinimized] = useState(false);
  // After send: the calm wait (MealWaitSheet), then Drona's read full screen
  // (MealResultScreen). Neither holds the parse: closing the sheet, closing
  // the result or leaving the screen only stops watching. The parse runs on,
  // and a result nobody added waits on this screen (the strip above the food
  // box) until it is added or discarded. lib/mealReady decides, when a parse
  // lands, whether to open the result or tell the user with a toast.
  const [waitOpen, setWaitOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [resultDayOpen, setResultDayOpen] = useState(false);
  const waitOpenRef = useRef(false);
  waitOpenRef.current = waitOpen;
  const resultOpenRef = useRef(false);
  resultOpenRef.current = resultOpen;
  const focusedRef = useRef(false);
  const appActiveRef = useRef(AppState.currentState === 'active');
  // The meal last under review. A correction typed on the result screen
  // flips the flow to 'analysing', and the screen keeps showing this meal,
  // dimmed, until the answer replaces it.
  const lastReviewRef = useRef<Extract<ParseFlow, { status: 'review' }> | null>(null);
  if (flow.status === 'review') lastReviewRef.current = flow;
  // "Just log it" landed: the sections it wrote, so the arrival can say so.
  const autoLandedRef = useRef<MealType[] | null>(null);
  // A toast for a parse that landed while the app was in the background,
  // shown the next time it comes to the front.
  const tellLaterRef = useRef<(() => void) | null>(null);
  // Sheets live in the root portal, over every screen, so they only show
  // while this one is in front. Leaving closes them; nothing is thrown away.
  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    return () => {
      focusedRef.current = false;
      setWaitOpen(false);
      setResultOpen(false);
      setResultDayOpen(false);
    };
  }, []));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      appActiveRef.current = next === 'active';
      if (next !== 'active' || !tellLaterRef.current) return;
      const show = tellLaterRef.current;
      tellLaterRef.current = null;
      show();
    });
    return () => sub.remove();
  }, []);
  const openResult = useCallback((via: 'toast' | 'strip' | 'wait') => {
    if (flowRef.current.status !== 'review') return;
    track('meal_result_opened', { via });
    if (!focusedRef.current) router.navigate('/nutrition');
    Keyboard.dismiss();
    setWaitOpen(false);
    setResultOpen(true);
  }, []);
  /** Tell the user a parse landed while they were not watching it. */
  const tell = useCallback((kind: ReadyKind, meals: MealType[]) => {
    const show = () => toastRef.current.show({
      type: kind === 'error' ? 'error' : 'success',
      text: readyLine(kind, meals),
      action: {
        label: readyAction(kind),
        onPress: kind === 'review'
          ? () => openResult('toast')
          : () => { if (!focusedRef.current) router.navigate('/nutrition'); },
      },
      durationMs: READY_TOAST_MS,
    });
    if (!appActiveRef.current) { tellLaterRef.current = show; return; }
    show();
  }, [openResult]);
  // A parse landed: open the result for someone watching, tell anyone else.
  // Only on the step out of a running parse, so a Discard, an edit or a
  // restored meal never fires it.
  const prevStatusRef = useRef(flow.status);
  useEffect(() => {
    const was = prevStatusRef.current;
    prevStatusRef.current = flow.status;
    const running = (st: ParseFlow['status']) => st === 'analysing' || st === 'streaming';
    if (!running(was) || running(flow.status)) return;
    const how = arrivalAction({
      sheetOpen: waitOpenRef.current,
      resultOpen: resultOpenRef.current,
      screenFocused: focusedRef.current,
      appActive: appActiveRef.current,
    });
    setWaitOpen(false);
    const landed = autoLandedRef.current;
    autoLandedRef.current = null;
    const kind: ReadyKind | null = flow.status === 'review' ? 'review'
      : flow.status === 'idle' ? (landed ? 'logged' : null)
      : flow.status === 'declined' || flow.status === 'create' ? 'reply'
      : flow.status === 'error' ? 'error'
      : null;
    if (kind) track('meal_ready_shown', { kind, how });
    if (flow.status === 'review') {
      if (how === 'show') { Keyboard.dismiss(); setResultOpen(true); }
      else tell('review', sectionsOf(flow.meal));
      return;
    }
    // Not a meal to check (it went in, or it is a reply or a failure, which
    // show above the food box): the result screen has nothing to show.
    setResultOpen(false);
    if (kind && how !== 'show') tell(kind, landed ?? []);
  }, [flow, tell]);

  // A meal waiting to be added survives the app being closed: it is work
  // the user would otherwise type again. Read once per account before
  // anything is written, so the first idle render cannot wipe it.
  // `restoredKey` names the account whose meal was read back. It is a key,
  // not a flag, so the render that switches accounts already sees "not
  // read yet" and cannot file the last account's meal under the new key.
  const readyKey = user?.id ? `overload.mealReady.${user.id}` : null;
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
  const lastReadyKey = useRef<string | null>(null);
  useEffect(() => {
    // Another account signed in: whatever was on screen was the last
    // account's, so it goes, and its parse with it. Its stored meal stays
    // under its own key for when it signs back in.
    if (lastReadyKey.current && lastReadyKey.current !== readyKey) {
      parseTokenRef.current += 1;
      parseAbortRef.current?.abort();
      turnsRef.current = [];
      lastReviewRef.current = null;
      setWaitOpen(false);
      setResultOpen(false);
      setFlow({ status: 'idle' });
    }
    lastReadyKey.current = readyKey;
    // Any change, a sign-out included, means this account's meal is not read
    // back yet. Without this, signing back in as the same account found
    // "already read" with an idle flow and cleared the store mid-read.
    setRestoredKey((r) => settleRestoredKey(r, readyKey));
    if (!readyKey) return;
    let alive = true;
    AsyncStorage.getItem(readyKey)
      .then((raw) => {
        if (!alive) return;
        const back = unpackReady<Extract<ParseFlow, { status: 'review' }>>(raw);
        if (back) setFlow((f) => (f.status === 'idle' ? back : f));
      })
      .catch(() => {})
      .finally(() => { if (alive) setRestoredKey(readyKey); });
    return () => { alive = false; };
  }, [readyKey]);
  useEffect(() => {
    // lib/mealReady decides: an Add still writing keeps the meal stored, a
    // failed Add stores it as waiting again, only a finished card clears it.
    const step = readyStoreStep(flow, { key: readyKey, restoredKey, adding });
    if (!readyKey) return;
    if (step.kind === 'save') AsyncStorage.setItem(readyKey, packReady(step.flow)).catch(() => {});
    else if (step.kind === 'clear') AsyncStorage.removeItem(readyKey).catch(() => {});
  }, [flow, readyKey, restoredKey, adding]);

  // Parse tier (Quick default / Thorough opt-in / Precise for Pro). A ref
  // mirrors the state so onSend reads the CURRENT choice, matching the flowRef
  // idiom above.
  const [parseSpeed, setParseSpeedState] = useState<ParseSpeed>('quick');
  const parseSpeedRef = useRef<ParseSpeed>('quick');
  const [speedSheetOpen, setSpeedSheetOpen] = useState(false);
  // The dashboard's getting-started "Pick how I log food" lands here with
  // modes=<stamp>: open the mode sheet once per stamp, then clear it (this tab
  // stays mounted, like focus=ai above).
  const { modes: modesParam } = useLocalSearchParams<{ modes?: string }>();
  const modesShown = useRef<string | null>(null);
  useFocusEffect(useCallback(() => {
    if (!modesParam || modesShown.current === modesParam) return;
    modesShown.current = modesParam;
    const t = setTimeout(() => {
      setSpeedSheetOpen(true);
      router.setParams({ modes: undefined });
    }, 350);
    return () => clearTimeout(t);
  }, [modesParam]));
  // Live entitlement for the Precise tier. Trialing counts: a trial that could
  // not reach the tier it is meant to sell is not a trial.
  //
  // Anything else - free, unknown, still loading, offline - reads as NOT
  // entitled, which is the safe direction: it degrades Precise to Thorough and
  // still logs the meal. The server holds the real lock (index.ts 402s a free
  // tier asking for super), so a wrong guess here costs a tier, never access.
  const { access: coachAccess } = useCoachAccess();
  const canUsePrecise = coachAccess.state === 'paid' || coachAccess.state === 'trialing';
  const canUsePreciseRef = useRef(canUsePrecise);
  useEffect(() => { canUsePreciseRef.current = canUsePrecise; }, [canUsePrecise]);
  // Both statuses mean "a parse is running": 'analysing' before any rows,
  // 'streaming' once fast mode has painted names but not finished.
  const parseInFlight = flow.status === 'analysing' || flow.status === 'streaming';
  /** Which parse owns the card right now.
   *
   *  Guarding on the raw text is not enough: Discard is reachable mid-stream,
   *  so the user can dismiss a running parse, send something else, and the
   *  abandoned request still resolves and calls setFlow unconditionally -
   *  replacing the meal they are actually looking at. Log the same thing twice
   *  and the texts even match. A counter cannot collide with anything, and it
   *  is the same idiom `checkTokenRef` already uses for the double-check. */
  const parseTokenRef = useRef(0);
  /** Aborts the in-flight streamed parse. Paired with parseTokenRef: the token
   *  decides who may WRITE to the card, this stops the work for whoever may
   *  not. Without it a discarded or navigated-away parse still ran the whole
   *  model call server-side, billed, for a result nobody would ever see. */
  const parseAbortRef = useRef<AbortController | null>(null);
  // Unmount is the case a token cannot cover: there is no card left to guard.
  useEffect(() => () => parseAbortRef.current?.abort(), []);
  useEffect(() => {
    getParseSpeed().then((v) => { parseSpeedRef.current = v; setParseSpeedState(v); });
  }, []);
  const pickParseSpeed = (v: ParseSpeed) => {
    track('parse_tier_changed', { from: parseSpeedRef.current, to: v });
    parseSpeedRef.current = v;
    setParseSpeedState(v);
    void setParseSpeed(v);
  };
  // "Just log it" (lib/autoLog). Same ref-mirrors-state idiom as the tier, so
  // onSend reads the choice as of the tap.
  const [autoLog, setAutoLogState] = useState(false);
  const autoLogRef = useRef(false);
  useEffect(() => {
    getAutoLog().then((v) => { autoLogRef.current = v; setAutoLogState(v); });
  }, []);
  const pickAutoLog = (v: boolean) => {
    track('auto_log_toggled', { enabled: v, parse_tier: parseSpeedRef.current });
    autoLogRef.current = v;
    setAutoLogState(v);
    void setAutoLog(v);
  };
  // Sends the diary never confirmed, older than lib/autoLog's PENDING_LOST_MS.
  // Each is one line in the day with Retry: never re-sent silently.
  const [lostSends, setLostSends] = useState<PendingAutoLog[]>([]);
  // A dropped stream gets one follow-up look a few seconds later, while the
  // screen is still up; foreground and mount cover everything after that.
  const sentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (sentTimerRef.current) clearTimeout(sentTimerRef.current); }, []);

  /** Look every settled pending send up in the diary. Found rows get their
   *  "Added by Drona" chip and the day refreshes; a send the server never took
   *  becomes a visible miss. Runs on mount, on foreground, and once after a
   *  dropped stream. */
  const reconcile = useCallback(async () => {
    if (!supabase) return;
    const r = await reconcilePending(supabase);
    setLostSends(r.lost);
    if (r.found.length === 0) return;
    reload();
    // The card was waiting on one of these: the diary now shows it with its
    // chip, so the card has nothing left to say.
    setFlow((f) => (
      f.status === 'sent' && r.found.some((x) => x.pending.client_id === f.clientId)
        ? { status: 'idle' }
        : f
    ));
  }, [supabase, reload]);
  useEffect(() => {
    void reconcile();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void reconcile();
    });
    return () => sub.remove();
  }, [reconcile]);
  // What the chip and the sheet's tick both report: the tier that will run, not
  // merely the one stored. They must agree with onSend, which asks the same
  // question of the same two inputs.
  const runningSpeed = effectiveParseSpeed(parseSpeed, canUsePrecise);
  const [savedListOpen, setSavedListOpen] = useState(false);
  const nowMeal = mealForNow();
  const nowMealLabel = MEALS.find((m) => m.type === nowMeal)?.label ?? 'this meal';

  // ── Usual foods + copy the day before ──────────────────────────────────────
  // The diary's recent weeks, refetched whenever the day on screen changes
  // shape (an add, an edit, a delete), so what was logged a minute ago can be
  // copied or learned from without a restart. Signed-in only, like parsing.
  // Portion and numbers ride along with the ids: a portion edit keeps the
  // row's id, and the copy sheet and the usual portion must still see it.
  // Lines still saving are left out: the history has nothing new until the
  // save lands, and the read that follows it changes the version anyway.
  const diaryVersion = useMemo(
    () => `${totalsDayIso}|${MEALS.map((m) => byMeal[m.type].filter((e) => !e.pending).map((e) =>
      `${e.id}:${e.quantity}:${e.serving_unit}:${e.kcal}:${e.protein_g}:${e.carb_g}:${e.fat_g}`).join(',')).join('|')}`,
    [byMeal, totalsDayIso],
  );
  // null while the day is still loading: its empty first render would
  // otherwise count as a change and fetch the history twice per open.
  // Counted back from the day on screen when it is in the past, else today.
  const historyAnchor = viewIso < todayIso ? viewIso : todayIso;
  const { history, loaded: historyLoaded } = useFoodHistory(!isSignedIn ? 'guest' : dayUnknown ? null : diaryVersion, historyAnchor);
  const patterns = useMemo(() => learnPatterns(isSignedIn ? history : [], viewIso, todayIso), [history, viewIso, todayIso, isSignedIn]);

  // ── Food box tour (lib/foodBoxTour) ──────────────────────────────────────
  // Once, for someone who has only ever used food search: Drona points at the
  // box, and each step waits for the user's own tap on their own meal.
  const userId = user?.id ?? null;
  const [tourDone, setTourDone] = useState<boolean | null>(null);
  const [tourStep, setTourStep] = useState<TourStep | null>(null);
  // Nutrition is a retained tab: it loads, and could start the tour, while
  // the user is somewhere else. The tour only starts while it is on screen.
  const [screenFocused, setScreenFocused] = useState(false);
  const tourStepRef = useRef<TourStep | null>(null);
  useLayoutEffect(() => { tourStepRef.current = tourStep; }, [tourStep]);
  // The screen can outlive a sign-in change. A new user starts with no tour,
  // so one user's step can never be seen, or saved as done, by the next.
  useLayoutEffect(() => {
    tourStepRef.current = null;
    setTourStep(null);
    setTourDone(null);
  }, [userId]);
  useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    void getFoodBoxTourDone(userId).then((d) => { if (!cancelled) setTourDone(d); });
    return () => { cancelled = true; };
  }, [userId]);
  const markTourDone = useCallback(() => {
    setTourDone(true);
    if (userId) void setFoodBoxTourDone(userId);
  }, [userId]);
  /** Ends it before the last step: Skip, or the user went elsewhere. Moving
   *  off today only hides it (tourEndRetires); it comes back on today. */
  const endTour = useCallback((how: 'skipped' | 'left', reason?: TourEndReason) => {
    const step = tourStepRef.current;
    if (!step || step === 'done') { tourStepRef.current = null; setTourStep(null); return; }
    tourStepRef.current = null;
    setTourStep(null);
    if (tourEndRetires(reason)) markTourDone();
    if (how === 'skipped') track('food_tour_skipped', { step });
    else track('food_tour_left', { step, reason: reason ?? null });
  }, [markTourDone]);
  const tourEvent = useCallback((ev: TourEvent) => {
    const cur = tourStepRef.current;
    if (!cur || cur === 'done') return;
    const next = tourNext(cur, ev);
    if (next === cur) return;
    tourStepRef.current = next;
    setTourStep(next);
    track('food_tour_step', { step: next, from: cur });
    if (next === 'done') {
      markTourDone();
      track('food_tour_completed', {});
    }
  }, [markTourDone]);
  const offerTour = shouldOfferTour({
    signedIn: !!isSignedIn, done: tourDone, isToday, dayReady: !dayUnknown,
    flowIdle: flow.status === 'idle', historyLoaded, focused: screenFocused, history,
  });
  // While it points at the box: moved off today, or history landed showing
  // they already type meals. Either way the tip no longer fits.
  const tourEnd = tourStep ? tourEndReason(tourStep, { isToday, history }) : null;
  useEffect(() => {
    if (tourEnd) endTour('left', tourEnd);
  }, [tourEnd, endTour]);
  useEffect(() => {
    if (!offerTour || tourStep !== null) return;
    // A beat after the day lands, so the tip does not arrive with the shimmer.
    const t = setTimeout(() => {
      tourStepRef.current = 'type';
      setTourStep('type');
      track('food_tour_shown', {});
    }, 700);
    return () => clearTimeout(t);
  }, [offerTour, tourStep]);
  // The last line stays a moment, then goes. endTour on 'done' only clears it.
  useEffect(() => {
    if (tourStep !== 'done') return;
    const t = setTimeout(() => endTour('left'), 4000);
    return () => clearTimeout(t);
  }, [tourStep, endTour]);
  // Leaving the screen mid-tour ends it: it is a one-time thing, and coming
  // back to the same pointer every visit would nag.
  // Through a ref: a new endTour identity must not read as the screen blurring.
  const endTourRef = useRef(endTour);
  useLayoutEffect(() => { endTourRef.current = endTour; }, [endTour]);
  // A tap on search (the icon in the box, a meal's Add row) leaves the screen
  // too; say so, since search is what the tour is up against.
  useFocusEffect(useCallback(() => {
    // Back on the screen: a search opened before this visit is over.
    lastSearchOpenAt = 0;
    setScreenFocused(true);
    return () => {
      setScreenFocused(false);
      endTourRef.current('left', Date.now() - lastSearchOpenAt < 1500 ? 'search' : 'screen');
    };
  }, []));
  // Set by onAdd right before the card closes, so "the card went away after
  // Add" can be told apart from Discard.
  const tourAddedRef = useRef(false);
  const tourPrevFlow = useRef<ParseFlow>(flow);
  useEffect(() => {
    const was = tourPrevFlow.current;
    tourPrevFlow.current = flow;
    if (was.status === flow.status) return;
    const added = tourAddedRef.current;
    tourAddedRef.current = false;
    const sig = tourSignalForFlow(
      { status: was.status, auto: (was.status === 'analysing' || was.status === 'streaming') && !!was.auto },
      flow.status,
      added,
      tourStepRef.current,
    );
    if (!sig) return;
    if ('end' in sig) { endTour('left', sig.end); return; }
    // Someone who finds the box on their own never needs the tour later.
    // Also while storage has not answered yet (null): a send is a send.
    if (sig.event === 'sent' && tourStepRef.current === null && tourDone !== true) markTourDone();
    tourEvent(sig.event);
  }, [flow, tourDone, markTourDone, tourEvent, endTour]);
  // The food box's own events: tapped into, and left without sending.
  const boxFocusRef = useRef<{ sent: boolean } | null>(null);
  const onBoxFocus = useCallback(() => {
    boxFocusRef.current = { sent: false };
    track('food_box_focused', { tour: tourStepRef.current ?? 'none' });
    tourEvent('focused');
  }, [tourEvent]);
  const lastBoxSendAt = useRef(0);
  const abandonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (abandonTimer.current) clearTimeout(abandonTimer.current); }, []);
  const textRef = useRef(text);
  useLayoutEffect(() => { textRef.current = text; }, [text]);
  const onBoxBlur = useCallback(() => {
    const f = boxFocusRef.current;
    boxFocusRef.current = null;
    if (!f || f.sent) return;
    const hadText = textRef.current.trim().length > 0;
    // A tap on search (the icon in the box, or a meal's Add row) blurs the
    // box too. The tap and the blur land in either order, so look a beat
    // later and say which it was: switching to search is not giving up.
    // Also catches a send whose tap blurred the box before onSend ran.
    if (abandonTimer.current) clearTimeout(abandonTimer.current);
    abandonTimer.current = setTimeout(() => {
      abandonTimer.current = null;
      if (Date.now() - lastBoxSendAt.current < 1500) return;
      track('food_box_abandoned', { had_text: hadText, to_search: Date.now() - lastSearchOpenAt < 1500 });
    }, 300);
  }, []);
  const prevDate = new Date(viewDate.getFullYear(), viewDate.getMonth(), viewDate.getDate() - 1);
  const prevIso = ymd(prevDate);
  const prevLines = useDayMealLines(history, prevIso);
  const prevLabel = dayLabel(prevDate) === 'Yesterday' ? 'Yesterday' : prevDate.toLocaleDateString(undefined, { weekday: 'long' });
  // "yesterday" mid-sentence; a weekday keeps its capital.
  const prevWord = prevLabel === 'Yesterday' ? 'yesterday' : prevLabel;
  // A meal with no habit yet starts from the day before's food for it.
  const suggestions = useMemo(
    () => mealsToSuggest(withPreviousDay(patterns, prevLines), byMeal),
    [patterns, prevLines, byMeal],
  );
  const [copyMeal, setCopyMeal] = useState<MealType | null>(null);
  const [relogBusy, setRelogBusy] = useState<string | null>(null);
  // The copy sheet's guard. State lags a render, so two quick taps could both
  // read "not busy" and copy twice; a ref is set before the first await.
  const relogBusyRef = useRef(false);
  // Suggestions tapped and shown as "Added" before their write lands. The
  // ref is the double-tap guard (same reason as above); the state draws it.
  // A key leaves when its row does (the diary caught up) or its write fails.
  const addedRef = useRef<Set<string>>(new Set());
  const [addedKeys, setAddedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const markAdded = useCallback((keys: string[], on: boolean) => {
    for (const k of keys) { if (on) addedRef.current.add(k); else addedRef.current.delete(k); }
    setAddedKeys(new Set(addedRef.current));
  }, []);
  // Writes run one after another, so tapping three rows quickly logs all
  // three instead of dropping the two that came while the first was saving,
  // and two adds can never race to create the same meal row twice.
  const relogChain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const run = relogChain.current.then(job, job);
    relogChain.current = run.catch(() => {});
    return run;
  }, []);
  // Lines just added from a suggestion or a copy, so each wears a quiet Undo
  // until the screen goes away. Entry id -> the whole add, like the Drona chip.
  const [relogged, setRelogged] = useState<Map<string, { ref: LoggedParseRef; label: string }>>(() => new Map());
  // Each meal's suggestions count as shown once per day, not once per render.
  const shownRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (dayUnknown) return;
    for (const m of MEALS) {
      const list = suggestions[m.type];
      const k = `${viewIso}:${m.type}`;
      if (list.length === 0 || shownRef.current.has(k)) continue;
      shownRef.current.add(k);
      track('food_suggestions_shown', {
        meal_type: m.type, count: list.length, usual_count: list.filter((x) => x.usual).length,
        weekday_count: list.filter((x) => x.reason === 'weekday').length,
        previous_day_count: list.filter((x) => x.reason === 'previous_day').length,
        meal_logged: byMeal[m.type].length > 0, is_today: isToday,
      });
    }
  }, [suggestions, dayUnknown, viewIso, byMeal, isToday]);

  const rememberRelog = useCallback((ref: LoggedParseRef, label: string) => {
    setRelogged((cur) => {
      const next = new Map(cur);
      for (const sec of ref.sections) for (const id of sec.entryIds) next.set(id, { ref, label });
      return next;
    });
  }, []);

  const onAddSuggestions = useCallback((meal: MealType, picked: FoodSuggestion[], all: boolean) => {
    if (!supabase) return;
    const items = picked.filter((x) => !addedRef.current.has(x.key));
    if (items.length === 0) return;
    const keys = items.map((x) => x.key);
    // Answer the tap now: the lines go into the meal while the write is under
    // way (the save is a few round trips), and the suggestion reads "Added".
    markAdded(keys, true);
    const pendingId = addPendingLines(items, meal);
    haptics.tap();
    const fromPrev = items.every((x) => x.reason === 'previous_day');
    void enqueue(async () => {
      // A throw (not just an {error}) must still give the rows back.
      let res: Awaited<ReturnType<typeof relogLines>>;
      try {
        res = await relogLines(supabase, items, meal, viewDate, fromPrev ? 'copy_day' : 'pattern');
      } catch (e) {
        res = { error: e instanceof Error ? e.message : 'Could not add that' };
      }
      const { ref, error } = res;
      track('food_suggestion_logged', {
        meal_type: meal, item_count: items.length, all, edited: false, is_today: isToday, write_failed: !!error,
        from_previous_day: fromPrev,
      });
      if (error || !ref) {
        dropPendingLines(pendingId);
        markAdded(keys, false);
        haptics.warning();
        return;
      }
      haptics.success();
      settlePendingLines(pendingId, ref.sections.flatMap((sec) => sec.entryIds));
      rememberRelog(ref, fromPrev ? `Copied from ${prevWord}` : all ? 'Your usual' : 'From your usual');
      reload();
    });
  }, [supabase, viewDate, isToday, rememberRelog, reload, prevWord, markAdded, enqueue, addPendingLines, settlePendingLines, dropPendingLines]);

  // A key is "Added" only until its row leaves: once the diary shows the
  // line, mealsToSuggest drops the suggestion and the key goes with it, so an
  // Undo brings the suggestion back as a fresh, tappable row.
  useEffect(() => {
    if (addedRef.current.size === 0) return;
    const live = new Set(MEALS.flatMap((m) => suggestions[m.type].map((x) => x.key)));
    const gone = [...addedRef.current].filter((k) => !live.has(k));
    if (gone.length > 0) markAdded(gone, false);
  }, [suggestions, markAdded]);

  // Change the portion first: the line opens in the review card, the same
  // editor a typed meal gets, and Add writes it. Only from an idle box, so a
  // meal the user is still reviewing is never thrown away for a suggestion.
  const onEditSuggestion = useCallback((meal: MealType, item: FoodSuggestion) => {
    if (flowRef.current.status !== 'idle') { haptics.warning(); return; }
    track('food_suggestion_edited', { meal_type: meal, reason: item.reason, is_today: isToday });
    setCardMinimized(false);
    setFlow({
      status: 'review', raw: item.food_name, words: item.food_name,
      meal: {
        meal_type: meal,
        items: [lineAsItem(item, meal)],
        drona_line: item.reason === 'previous_day'
          ? `From ${prevWord}. Change the portion if today was different.`
          : 'Your usual. Change the portion if today was different.',
      },
      mealType: meal, mealTypePicked: true,
      origin: item.reason === 'previous_day' ? 'copy_day' : 'pattern',
      dayIso: viewIso,
    });
    setResultOpen(true);
  }, [isToday, prevWord, viewIso]);

  const onCopyLines = useCallback(async (lines: HistoryEntry[]) => {
    if (!supabase || !copyMeal || relogBusyRef.current) return;
    const meal = copyMeal;
    relogBusyRef.current = true;
    setRelogBusy('*');
    // Same as a suggestion: the lines show in the meal now, the sheet closes,
    // and a failed write takes them back off.
    const pendingId = addPendingLines(lines, meal);
    setCopyMeal(null);
    let res: Awaited<ReturnType<typeof relogLines>>;
    try {
      res = await enqueue(() => relogLines(supabase, lines, meal, viewDate, 'copy_day'));
    } catch (e) {
      res = { error: e instanceof Error ? e.message : 'Could not copy that' };
    } finally {
      relogBusyRef.current = false;
      setRelogBusy(null);
    }
    const { ref, error } = res;
    track('meal_copied', {
      meal_type: meal, item_count: lines.length, of_count: prevLines[meal].length,
      from_yesterday: prevLabel === 'Yesterday', is_today: isToday, write_failed: !!error,
    });
    if (error || !ref) {
      // The sheet closed on the tap, so open it again: the copy is one tap
      // from a retry, as it was before the lines showed early.
      dropPendingLines(pendingId);
      haptics.warning();
      setCopyMeal(meal);
      return;
    }
    haptics.success();
    settlePendingLines(pendingId, ref.sections.flatMap((sec) => sec.entryIds));
    rememberRelog(ref, `Copied from ${prevLabel === 'Yesterday' ? 'yesterday' : prevLabel}`);
    reload();
  }, [supabase, copyMeal, viewDate, prevLines, prevLabel, isToday, rememberRelog, reload, enqueue, addPendingLines, settlePendingLines, dropPendingLines]);

  const onUndoRelog = useCallback(async (ref: LoggedParseRef) => {
    if (!supabase) return;
    track('meal_undone', {
      section_count: ref.sections.length,
      entry_count: ref.sections.reduce((t, sec) => t + sec.entryIds.length, 0),
      via: 'relog',
    });
    // A throw or a failed delete keeps the chip: the lines may still be
    // there, and Undo can be tried again.
    let failed = false;
    try {
      failed = !!(await undoParsedMeal(supabase, ref)).error;
    } catch {
      failed = true;
    }
    if (failed) {
      haptics.warning();
      reload();
      return;
    }
    setRelogged((cur) => {
      const next = new Map(cur);
      for (const sec of ref.sections) for (const id of sec.entryIds) next.delete(id);
      return next;
    });
    reload();
  }, [supabase, reload]);

  // Keep the log-date store synced to the viewed day so every log/edit path
  // (parse bar, food-search, saved meals, entry move) writes to that day. Mirror
  // _logMeal: set it — including right before we navigate to food-search/detail —
  // and NEVER reset on blur. A blur cleanup would fire the instant openSearch()
  // pushes food-search, silently reverting a past-day log back to today.
  useEffect(() => { setLogDate(viewDate); }, [viewDate]);
  useFocusEffect(useCallback(() => { setLogDate(viewDate); }, [viewDate]));

  // kcal per day for the strip's rings. The network fetch runs only when the
  // visible week changes; a log/edit on the viewed day is patched in from the
  // totals we already hold, so one day's change never re-queries all seven.
  const [weekKcal, setWeekKcal] = useState<Record<string, number>>({});
  // The viewed day's live total, mirrored into a ref so the range fetch below can
  // re-apply it at commit time. A fetch in flight when food is logged would
  // otherwise resolve with pre-log rows and clobber the fresh ring.
  const livePatch = useRef<{ day: string; kcal: number } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      // The weeks either side too, so a swipe lands on rings already drawn.
      // Merged, not replaced: weeks swiped past keep their rings.
      const ws = dateFromYmd(weekStartIso);
      const from = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() - 7);
      const rows = await loadNutritionRange(supabase, from, 21);
      if (!alive) return;
      const map: Record<string, number> = {};
      for (const r of rows) map[r.dayIso] = r.kcal;
      setWeekKcal((prev) => {
        const p = livePatch.current;
        return p ? { ...prev, ...map, [p.day]: p.kcal } : { ...prev, ...map };
      });
    })();
    return () => { alive = false; };
  }, [supabase, weekStartIso]);
  // Keyed on totalsDayIso, NOT viewIso: on a day switch viewIso updates a render
  // before the refetch lands, so keying on viewIso would stamp the previous
  // day's kcal onto the newly selected day's ring until the fetch resolved.
  useEffect(() => {
    // '' means the numbers belong to no day yet (first load, nothing cached).
    if (!totalsDayIso) return;
    livePatch.current = { day: totalsDayIso, kcal: totals.kcal };
    setWeekKcal((prev) => (
      prev[totalsDayIso] === totals.kcal ? prev : { ...prev, [totalsDayIso]: totals.kcal }
    ));
  }, [totalsDayIso, totals.kcal]);

  // Step the diary a day back/forward; never past the last day a log can
  // land on (a few weeks ahead, for planning).
  const stepDay = useCallback((delta: number) => {
    track('nutrition_day_changed', { direction: delta > 0 ? 'forward' : 'back' });
    setViewDate((d) => {
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
      return ymd(next) > ymd(latestLogDay()) ? d : next;
    });
  }, []);

  // A swipe to another week keeps the weekday: Wednesday stays Wednesday,
  // except past the last loggable day, which is as far as a day can go.
  const weekListRef = useRef<FlatList<Date>>(null);
  // The week a swipe already moved to, so the drag-end and momentum-end
  // callbacks for one swipe count once. Cleared when the week changes.
  const swipedWeek = useRef<string | null>(null);
  const onWeekSwipe = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const ws = weekStarts[Math.round(e.nativeEvent.contentOffset.x / winW)];
    if (!ws || ymd(ws) === weekStartIso || ymd(ws) === swipedWeek.current) return;
    swipedWeek.current = ymd(ws);
    track('nutrition_day_changed', { direction: ymd(ws) > weekStartIso ? 'forward' : 'back' });
    const next = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + viewDate.getDay());
    setViewDate(ymd(next) > latestIso ? latestLogDay() : next);
  };
  // A slow drag released right on a page boundary settles with no momentum,
  // so onMomentumScrollEnd never fires. Count it here, only when it is
  // already resting on a page (mid-page, the momentum end handles it).
  const onWeekDragEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = e.nativeEvent.contentOffset.x;
    if (Math.abs(x - Math.round(x / winW) * winW) < 1) onWeekSwipe(e);
  };
  // ‹ ›, the calendar and "for tomorrow" logs move viewDate without a swipe;
  // bring the strip to its week. A one-week move slides, a jump snaps.
  const lastWeekIndex = useRef(weekIndex);
  useEffect(() => {
    if (weekIndex < 0) return;
    const animated = Math.abs(weekIndex - lastWeekIndex.current) === 1;
    lastWeekIndex.current = weekIndex;
    swipedWeek.current = null;
    weekListRef.current?.scrollToOffset({ offset: weekIndex * winW, animated });
  }, [weekIndex, winW]);

  /** `retry`: re-send a "Just log it" send with its ORIGINAL id and day (from
   *  the error card or a "Drona didn't get" line). Forces auto mode even if the
   *  toggle has since been flipped: the user is retrying that send, not making
   *  a new choice.
   *
   *  `from`: a sentence handed over from the food search (lib/pendingParse).
   *  Its meal is the row the user tapped Add on, so it outranks the card's and
   *  the clock's guess; its day is the one that screen was logging to. */
  const runParse = useCallback(async (
    raw: string,
    retry?: { clientId: string; logDate: string },
    from?: { mealHint: MealType; day: Date },
  ) => {
    const t = raw.trim();
    if (!t || !supabase) return;
    // "2 eggs for tomorrow": the message names its own day. Go there first, so
    // the diary on screen, the card's Add and a "Just log it" write all land on
    // it, and send the parser the food without the date. A retry keeps the day
    // it was first sent for and only needs the same words taken out.
    const named = readLogDayPhrase(t);
    const sendText = named ? named.rest : t;
    const logDay = !retry && named ? named.date : (from?.day ?? viewDate);
    if (!retry && ymd(logDay) !== ymd(viewDate)) {
      if (named) track('nutrition_day_changed', { direction: named.date > viewDate ? 'forward' : 'back', source: 'text' });
      setViewDate(logDay);
    }
    // Only a day ("for tomorrow"): moving there was the whole ask.
    if (!sendText) return;
    setSavedReview(false);
    setCardMinimized(false);
    // A meal still under review is context for the next line: "make it a small
    // one" should correct THAT samosa, not log a second one. Captured before we
    // switch to 'analysing' (which drops the reviewed meal from flow).
    const prevReview = flowRef.current.status === 'review' ? flowRef.current : null;
    const pendingMeal = !retry && flowRef.current.status === 'declined' ? flowRef.current.pendingMeal : null;
    // A RETRY carries no context, deliberately. It re-sends one specific past
    // send, so the meal on screen is not what it is about: passing `pending`
    // here made the retry text arrive as a CORRECTION of an unrelated reviewed
    // meal, mutating a card the user was still deciding on while the lost send
    // was never re-sent at all. The stored pending record survived, so the miss
    // line simply came back later and the damage looked unrelated to the tap.
    // `words` is the card's whole history: `raw` is only the last message that
    // rebuilt it, so after a correction the first one is gone from `raw`.
    const pending = retry || !prevReview
      ? null
      : { text: prevReview.raw, words: prevReview.words ?? prevReview.raw, items: prevReview.meal.items };
    // Leaving the review this check belonged to. Without this the stale index
    // rides into the NEXT card and freezes Add/Edit/Remove behind a spinner on
    // an unrelated line until the abandoned 5-9s lookup finally settles.
    setChecking(null);
    const token = ++parseTokenRef.current;
    parseAbortRef.current?.abort();
    const ac = new AbortController();
    parseAbortRef.current = ac;
    // "Just log it" applies to a fresh meal only. With a review card on screen
    // the user is in review mode for THAT meal whatever the toggle says: a
    // follow-up corrects the card, it never commits behind it. (The server
    // enforces the same rule on previous_items.)
    //
    // A retry is the exception and keeps its own identity: it was an auto send
    // when it was made, and re-sending it is not a new choice about the toggle.
    // It cleared `pending` above, so the two rules do not fight.
    const auto = retry
      ?? (!pending && autoLogRef.current
        ? { clientId: newAutoLogClientId(), logDate: ymd(logDay) }
        : null);
    if (auto) {
      // Pending BEFORE the request leaves: if the app dies mid-stream, the next
      // open still knows to look for this send in the diary.
      if (retry) await touchPending(auto.clientId);
      else await addPending({ client_id: auto.clientId, text: t, sent_at: Date.now(), log_date: auto.logDate });
      setLostSends((l) => l.filter((x) => x.client_id !== auto.clientId));
    }
    setFlow({ status: 'analysing', raw: t, auto: !!auto });
    // A correction typed on the result screen is read there. Anything else
    // gets the calm wait.
    if (!resultOpenRef.current) {
      // The sheet lives in the app window, so the keyboard would sit over it.
      Keyboard.dismiss();
      setWaitOpen(true);
    }
    const turns = retry ? [] : turnsRef.current.slice();
    pushTurn('user', t);
    // The card on screen is a better hint than the wall clock. "and a dosa"
    // added to a meal the user has placed in Dinner must join THAT meal, and
    // sending mealForNow() split the card in two whenever the clock disagreed:
    // an appended line has no carried section to fall back on, so the hint is
    // the only thing standing between it and the hour. Falls back to the clock
    // for a first-shot log, which is what it was always for.
    const args = {
      text: sendText,
      // A food-search hand-off names its meal outright: the user tapped Add
      // on Breakfast, so Breakfast it is, card or clock notwithstanding. Words
      // that name a meal ("for dinner") still win on the server.
      mealHint: from?.mealHint ?? prevReview?.mealType ?? mealForNow(),
      previous: pending,
      pendingMeal,
      turns,
      autoLog: auto,
      // The food bar can draw a save card, so it asks for creates.
      canCreate: true,
    };
    // Streaming is only worth it on a first-shot log: a correction needs the
    // full pipeline anyway, and parseMealStreaming falls back on its own, but
    // not opening the stream saves the wasted round trip. Thorough and Precise
    // both take that full-pipeline road; they differ only in the speed field,
    // and no field at all is what the server reads as smart.
    const tier = effectiveParseSpeed(parseSpeedRef.current, canUsePreciseRef.current);
    // Corrections stay on smart even for a Precise user. The lookup already
    // happened on the first shot and its answer is banked; re-running it to
    // change "2" to "3" would buy the same web searches a second time and slow
    // down the one interaction that has to feel instant.
    const precise = tier === 'precise' && !pending;
    const parseStartedAt = Date.now();
    track('meal_parse_started', {
      tier,
      auto_log: !!auto,
      is_correction: !!pending,
      chars: t.length,
    });
    // A Quick follow-up still says it is Quick. The correction itself runs the
    // full pipeline either way, but a fresh re-parse it triggers ("not from
    // saved meals") has to come back in the tier the user picked.
    const followUpSpeed = precise ? { speed: 'super' as const } : pending && tier === 'quick' ? { speed: 'fast' as const } : {};
    const res = pending || tier !== 'quick'
      ? await parseMeal(supabase, { ...args, ...followUpSpeed })
      : await parseMealStreaming(supabase, args, (rows) => {
        // A stream that resolves after the user has moved on must not repaint
        // the card they are now looking at.
        if (parseTokenRef.current !== token) return;
        setFlow((cur) => (
          cur.status === 'analysing' && cur.raw === t ? { status: 'streaming', raw: t, rows, auto: cur.auto } : cur
        ));
      }, ac.signal, (label) => {
        if (parseTokenRef.current !== token) return;
        setFlow((cur) => (cur.status === 'analysing' && cur.raw === t ? { ...cur, statusLabel: label } : cur));
      });
    // From here on we are writing to the card. If another parse has started, or
    // the user discarded this one, this result is stale - drop it whole rather
    // than let any branch below (declined, cap, error, review) speak for a
    // parse the user has moved on from.
    if (parseTokenRef.current !== token) return;
    // "Just log it" bookkeeping. Any real answer means the server is done with
    // this send, logged or not, so it leaves the pending list. `sent` is the
    // one non-answer: the stream dropped and the server may still be writing,
    // so it stays pending and a reconcile settles it. `error` stays too: a
    // transport failure cannot say whether the request arrived, and the card's
    // Retry re-uses the same id so the server writes at most once.
    if (auto && res.kind !== 'sent' && res.kind !== 'error') void removePending(auto.clientId);
    if (res.kind === 'sent') {
      setFlow({ status: 'sent', raw: t, message: res.message, clientId: auto?.clientId ?? '' });
      if (sentTimerRef.current) clearTimeout(sentTimerRef.current);
      sentTimerRef.current = setTimeout(() => { void reconcile(); }, 6000);
      return;
    }
    // A reply that is not a meal (an answer, or a failure) must NOT discard a
    // meal still under review — that is unlogged work the user would have to
    // retype. Keep the card and show the reply as a notice on it.
    if (res.kind === 'declined') {
      pushTurn('drona', res.message);
      // The user removed the last line, so there is no card left to protect.
      // Keeping it would show the line they just deleted under a message saying
      // it is gone. Matches what the X button already does at the last item.
      if (res.cleared) {
        setFlow({ status: 'idle' });
        return;
      }
      if (prevReview) {
        setFlow({ ...prevReview, notice: res.message, proposal: res.proposal ?? null });
        return;
      }
      setFlow({ status: 'declined', raw: t, message: res.message, pendingMeal: res.pendingMeal });
      return;
    }
    // The free tier's daily logs ran out. This is a paywall, not a breakage:
    // routing it through the error path told users "Something broke on my end"
    // and hid the upgrade entirely. Say what actually happened, keep their text
    // so nothing is lost, and open the same paywall the coach chat opens.
    if (res.kind === 'cap') {
      track('limit_reached', { feature: 'meal_parse', kind: res.scope, used: res.used ?? null, limit: res.limit ?? null });
      const capLine = capNotice(res);
      pushTurn('drona', capLine);
      if (prevReview) setFlow({ ...prevReview, notice: capLine, proposal: null });
      else setFlow({ status: 'declined', raw: t, message: capLine });
      router.push({ pathname: '/upgrade', params: { context: capUpgradeContext(res) } });
      return;
    }
    if (res.kind === 'error') {
      track('meal_parse_failed', { tier, duration_ms: Date.now() - parseStartedAt, auto_log: !!auto });
      // Clear any standing proposal: it answered the previous message, and
      // leaving it up would attach "use these numbers" to an error the user
      // just got for something else entirely.
      if (prevReview) { setFlow({ ...prevReview, notice: res.message, proposal: null }); return; }
      setFlow({
        status: 'error', raw: t, message: res.message,
        ...(auto ? { clientId: auto.clientId, logDate: auto.logDate } : {}),
      });
      return;
    }
    // Drona drafted a food or meal the user asked to save. Normalized with the
    // same function the chat uses, so a draft that cannot be acted on (no
    // calories, no items) becomes a plain reply instead of a card with a dead
    // button.
    if (res.kind === 'create') {
      const create = parseCoachFoodCreate(res.tool, res.input);
      if (!create) {
        setFlow({ status: 'declined', raw: t, message: 'I could not put that one together. Give me the name and the calories and I will save it.' });
        return;
      }
      track('drona_food_create_proposed', {
        kind: create.kind,
        item_count: create.lines.length,
        kcal: create.totals.kcal,
        log_now: create.logNow,
        estimated: create.estimated.length > 0 || create.lines.some((l) => l.estimated),
      });
      pushTurn('drona', create.summary || `Save ${create.name}?`);
      setFlow({ status: 'create', raw: t, create, result: null, busy: false });
      return;
    }
    pushTurn('drona', res.meal.drona_line);
    // "Just log it": the server already wrote these lines, so there is nothing
    // left to review and no card to show. The rows themselves are the receipt -
    // they land in their own sections wearing "Added by Drona - Undo", which is
    // the same undo the card's strip used to offer.
    //
    // A card here also read as an invitation to reply, and a reply after a
    // WRITE is not a correction. `previous` is only sent for a meal still under
    // review (see prevReview), so "make that 2 rotis" came back as a brand new
    // meal and was logged a SECOND time on top of the first. Nothing on screen
    // to answer is the honest shape of a send that is already finished.
    //
    // The turns go with it. They are what lets "and a dosa" attach to the meal
    // before it, and attaching to a meal that is already in the diary is the
    // same double-write by another route. This send is closed; the next
    // message starts a new one.
    if (auto && res.logged) {
      // The server wrote the diary itself, so none of the client writers
      // (logParsedMeal / logFood / logSavedMeal) run. Without this line the
      // whole "Just log it" mode is invisible in the meal_logged breakdown.
      track('meal_logged', {
        method: 'auto',
        item_count: res.meal.items.length,
        kcal: Math.round(res.meal.items.reduce((t, it) => t + (it.kcal ?? 0), 0)),
        meal_type: res.meal.meal_type ?? null,
        section_count: res.logged.sections.length,
        tier,
        duration_ms: Date.now() - parseStartedAt,
      });
      markAddedByDrona(res.logged);
      reload();
      turnsRef.current = [];
      autoLandedRef.current = sectionsOf(res.meal);
      setFlow({ status: 'idle' });
      return;
    }
    // Asked to log, and the server sent it back for review instead. Say why
    // on the card; the meal itself is fine to Add by hand.
    if (auto && res.autoLogSkipped) {
      track('meal_auto_log_skipped', { reason: res.autoLogSkipped, tier, item_count: res.meal.items.length });
    }
    const skippedNotice = auto && res.autoLogSkipped === 'implausible'
      ? 'One of these numbers looked off to Drona, so he left it for you to check before it goes in.'
      : auto && res.autoLogSkipped === 'write_error'
      ? 'Drona could not write that to your diary. Check it and tap Add.'
      : null;
    // The user's own section pick outranks a guess made from the follow-up
    // text alone; without a pick we take the server's.
    const keptMealType = prevReview?.mealTypePicked ? prevReview.mealType : null;
    // Parsed, not logged. Seed the section selector from the LINES, the same
    // rule onAdd, onRemoveItem, onEditSave and onMoveGroup already follow. The
    // meal-level field is only the fallback for a line that carries none, and
    // the two can disagree: it is the server's own guess and an older build
    // falls back to the time-of-day hint there, while each line carries the
    // section the parse resolved. Reading the meal-level field put a card whose
    // lines all said dinner behind a chip row and a button reading "Add to
    // Breakfast", and onAdd then wrote the lines to Dinner - the button lied
    // about where the food was going. Verified on device by forcing the
    // disagreement; the head is stamped back so a later fallback agrees too.
    const headOf = (its: ParsedMealItem[]): MealType =>
      its[0]?.meal_type ?? res.meal.meal_type;
    const words = pending ? `${prevReview?.words ?? pending.text}; ${t}` : undefined;
    // A follow-up either CORRECTS the pending meal (replace its lines) or ADDS
    // to it (append) — appending is what keeps "and a dosa" from silently
    // dropping the samosa the user already reviewed.
    const reviewFlow: ParseFlow = (pending && !res.meal.corrects_previous)
      ? (() => {
          const items = [...pending.items, ...res.meal.items];
          const head = keptMealType ?? headOf(items);
          return {
            status: 'review',
            raw: `${pending.text}; ${t}`,
            words,
            meal: { ...res.meal, items, meal_type: head },
            mealType: head,
            mealTypePicked: prevReview?.mealTypePicked,
            dayIso: prevReview?.dayIso ?? ymd(logDay),
            tier: prevReview?.tier ?? tier,
          };
        })()
      : (() => {
          const head = keptMealType ?? headOf(res.meal.items);
          return {
            status: 'review',
            raw: res.meal.continued_pending && pendingMeal ? `${pendingMeal.text}; ${t}` : t,
            words,
            meal: { ...res.meal, meal_type: head },
            mealType: head,
            mealTypePicked: prevReview?.mealTypePicked,
            dayIso: prevReview?.dayIso ?? ymd(logDay),
            tier: prevReview?.tier ?? tier,
          };
        })();
    // A food that is only PART of a saved meal was searched as asked ("oats",
    // saved "Oats with milk"). Offer the saved meal as a choice, never a swap:
    // the numbers on the card do not change unless the user taps. Loaded
    // BEFORE the card is set, so the card appears once, whole (I15 below).
    const offer = !skippedNotice && reviewFlow.status === 'review'
      ? await savedMealOffer(supabase, reviewFlow.meal.items, res.savedSuggestions ?? [])
      : null;
    if (parseTokenRef.current !== token) return;
    setFlow(
      skippedNotice ? { ...reviewFlow, notice: skippedNotice }
      : offer && reviewFlow.status === 'review' ? { ...reviewFlow, notice: offer.notice, proposal: offer.proposal }
      : reviewFlow,
    );
    // I15: NOTHING fires after this point. The card the user is reading is the
    // card they will log. The automatic web refine that used to run here swapped
    // numbers in while Add was already live, so a user could tap Add on 180 kcal
    // and log 240 - a review step whose contents change is not a review step.
    // Web lookups are now user-initiated only (the challenge button on a
    // low-confidence line) and belong to Super mode.
  }, [supabase, viewDate, reload, reconcile]);

  /** Index of the pending line being corrected (null = editor closed). Edits
   *  are pure client state: nothing is written until Add, so a correction just
   *  patches the reviewed meal in place. */
  const [editIndex, setEditIndex] = useState<number | null>(null);
  /** Index of the line a user-initiated web check is running on (I14). */
  /** The double-check in flight, or null.
   *
   *  Identified by a unique TOKEN, not by row index and not by the card's text.
   *  An index alone cannot say which card it belongs to: check row 0, discard,
   *  check row 0 of the next card, and the abandoned request's cleanup sees
   *  0 === 0 and unfreezes the live card's buttons mid-lookup - reopening the
   *  live-Add race I15 closed. Adding the raw text narrows that but does not
   *  shut it: log the same thing twice and both cards share a `raw`. A counter
   *  cannot collide with anything. */
  const [checking, setChecking] = useState<{ token: number; index: number } | null>(null);
  const checkTokenRef = useRef(0);
  const checkingIndex = checking?.index ?? null;
  const onEditItem = useCallback((i: number) => setEditIndex(i), []);

  /** I14: the user asked us to double-check ONE line.
   *
   *  Deliberately NOT runParse: that flips the flow to 'analysing', which drops
   *  the card off screen. The whole point here is that the meal stays put and
   *  only the line being checked shows activity.
   *
   *  It sends the same thing typing a challenge would send, so it lands on the
   *  existing researchPrevious path and comes back as a proposal with the
   *  "use these / keep mine" choice already built. The button is the
   *  discoverability fix; the machinery underneath is unchanged.
   */
  const onCheckItem = useCallback(async (i: number) => {
    const f = flowRef.current;
    if (f.status !== 'review' || !supabase) return;
    const item = f.meal.items[i];
    if (!item) return;
    // Captured for the staleness checks below. The lookup takes 5-9s, which is
    // plenty of time for the user to discard this card, start a new parse, edit
    // this line, or remove a different one.
    const raw = f.raw;
    const key = (it: ParsedMealItem) => `${it.food_name.toLowerCase()}|${it.grams}`;
    const originalKey = key(item);
    const token = ++checkTokenRef.current;
    setChecking({ token, index: i });
    try {
      // The server reads at most 12 previous lines. A tapped line past that is
      // sent on its own, so the check still reaches it; only this line is ever
      // applied from the answer, so the others need not ride along.
      const far = i >= 12;
      const res = await parseMeal(supabase, {
        // Phrased as ACCEPTING a lookup, not as asking a question. Tapping the
        // button IS the request, so the turn must land on requests_research
        // (which actually searches) rather than asks_about_previous (which
        // explains the provenance and then offers to search). Device-tested:
        // "is the X number right?" came back "Want me to look up the label
        // online?", asking the user to confirm something they had just done.
        // Food names are NOT ours: OFF is crowd-sourced and FatSecret rows come
        // from a third party, so a name is untrusted text being interpolated
        // into a model prompt. Strip newlines and control characters and cap the
        // length so a crafted product name cannot append instructions of its
        // own. Low severity - the lookup is bounded and its output is a
        // schema-constrained macro panel - but the guard costs nothing.
        // The user's own words when the server sent them: the card's name can
        // be the wrong row itself (a different brand's bar), and searching for
        // it would only "confirm" the mistake.
        text: `yes, look up the label for ${
          (item.said_name ?? item.food_name).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80)
        } online and check these numbers`,
        mealHint: f.mealType,
        previous: { text: f.raw, items: far ? [item] : f.meal.items },
        // Only this line is looked up; the rest of the card stays as it is.
        researchLine: far ? 0 : i,
        turns: turnsRef.current.slice(),
      });
      // The daily allowance covers this lookup too, so a cap here has to say so
      // and open the paywall. Handled BEFORE setFlow: routing is a side effect
      // and a state updater may be replayed or discarded, so it cannot live in
      // one. Falling through to the updater's `return cur` was silent — the
      // spinner just cleared and the tap looked like it did nothing.
      if (res.kind === 'cap') {
        track('limit_reached', { feature: 'meal_parse', kind: res.scope, used: res.used ?? null, limit: res.limit ?? null });
        const capLine = capNotice(res);
        // The state update is guarded; the NAVIGATION has to be guarded by the
        // same test. A check the user abandoned (they discarded the card, or
        // parsed something else) must not interrupt what they are doing now by
        // throwing the paywall over it. flowRef is the committed flow, so this
        // reads the same state the updater would, without a side effect inside
        // an updater.
        const stillCurrent = flowRef.current.status === 'review'
          && flowRef.current.raw === raw
          && checkTokenRef.current === token;
        setFlow((cur) => (
          cur.status === 'review' && cur.raw === raw
            ? { ...cur, notice: capLine, proposal: null }
            : cur
        ));
        if (stillCurrent) {
          router.push({ pathname: '/upgrade', params: { context: capUpgradeContext(res) } });
        }
        return;
      }
      setFlow((cur) => {
        // STALENESS GUARDS. The old automatic refine had these and the first
        // version of this handler dropped them, which rebuilt the very race I15
        // exists to remove - just started by a button instead of a timer.
        if (cur.status !== 'review') return cur;
        // Different meal entirely: the user discarded and parsed something else
        // while this was in flight.
        if (cur.raw !== raw) return cur;
        // The line we asked about must still BE that line. Keyed on name AND
        // grams, not name alone, so two same-named entries of different sizes
        // (a 75 g chai and a 150 g chai) cannot cross-apply, and so an edit the
        // user made mid-flight is never silently overwritten.
        const atIndex = cur.meal.items[i];
        if (!atIndex || key(atIndex) !== originalKey) return cur;
        if (res.kind === 'declined') {
          // Either nothing trustworthy was found, or the web disagreed enough
          // that the server offered its answer instead of applying it.
          return { ...cur, notice: res.message, proposal: res.proposal ?? null };
        }
        if (res.kind === 'parsed') {
          // The server returns a parsed meal when the web AGREED closely enough
          // that swapping is not a material change; a real disagreement comes
          // back as a proposal above. So applying here is the server's call,
          // not a silent overwrite of something the user would dispute.
          //
          // But apply it to the TAPPED LINE ONLY. researchPrevious looks up
          // every previous item, so taking its whole item list would rewrite
          // lines the user never asked about - which is precisely the mutation
          // I15 exists to stop, just triggered by a button instead of a timer.
          // Prefer the exact name+grams match; fall back to name only, and to
          // the sole item when the lookup returned just one.
          // The server hands every line back in the order it was sent, and a
          // looked-up line may come back under the user's own words (said_name)
          // rather than the card's name, so position is the last fallback.
          const sentAt = far ? 0 : i;
          const sentCount = far ? 1 : Math.min(cur.meal.items.length, 12);
          const found = res.meal.items.find((r) => key(r) === originalKey)
            ?? res.meal.items.find(
              (r) => r.food_name.toLowerCase() === item.food_name.toLowerCase(),
            )
            ?? (res.meal.items.length === sentCount ? res.meal.items[sentAt] ?? null : null)
            ?? (res.meal.items.length === 1 ? res.meal.items[0] : null);
          if (!found) return { ...cur, notice: 'I could not improve that one.' };
          const items = cur.meal.items.map((it, idx) => (idx === i ? found : it));
          return { ...cur, meal: { ...cur.meal, items }, notice: res.meal.drona_line };
        }
        if (res.kind === 'error') {
          // Fire-and-forget still owes the user a word. Without this the
          // spinner just vanishes and the tap looks like it did nothing.
          return { ...cur, notice: 'Could not reach the web just now. Your numbers are unchanged.' };
        }
        return cur;
      });
    } finally {
      // Clear only if THIS check is still the one running. Anything newer owns
      // the state now and an abandoned request must not touch it.
      setChecking((curr) => (curr?.token === token ? null : curr));
    }
  }, [supabase]);
  // How many times the user corrected the card before adding it. Read by
  // onAdd so "accepted untouched" and "fixed three lines first" are separable.
  const editCountRef = useRef(0);
  /** One tap on a variant chip: the line becomes the variant the user also
   *  logs, priced from their own numbers (lib/variantSwap). Pure client state
   *  like every card edit; nothing is written until Add. */
  const onSwapItem = useCallback((i: number, k: number) => {
    // Counted only when there is a line to swap: a tap that lands after the
    // card moved on is not an edit.
    const cur = flowRef.current;
    if (cur.status !== 'review' || !cur.meal.items[i]?.alternatives?.[k]) return;
    editCountRef.current += 1;
    track('parse_proposal_edited', { action: 'swap_variant' });
    setFlow((f): ParseFlow => {
      if (f.status !== 'review' || !f.meal.items[i]) return f;
      const items = f.meal.items.map((it, idx) => (idx === i ? swapToAlternative(it, k) : it));
      return { ...f, meal: { ...f.meal, items } };
    });
  }, []);

  /** One - or + on a line's amount in the result screen. Every number on
   *  the line moves with it (lib/mealReady scaleLine). */
  const onStepAmount = useCallback((i: number, dir: 1 | -1) => {
    const cur = flowRef.current;
    if (cur.status !== 'review' || !cur.meal.items[i]) return;
    editCountRef.current += 1;
    track('parse_proposal_edited', { action: 'step_amount', direction: dir > 0 ? 'more' : 'less' });
    haptics.tick();
    setFlow((f): ParseFlow => {
      if (f.status !== 'review' || !f.meal.items[i]) return f;
      const items = f.meal.items.map((it, idx) => (
        idx === i ? scaleLine(it, stepAmount(it.quantity, isMeasurementUnit(it.serving_label), dir)) : it
      ));
      return { ...f, meal: { ...f.meal, items } };
    });
  }, []);

  const onRemoveItem = useCallback((i: number) => {
    editCountRef.current += 1;
    track('parse_proposal_edited', { action: 'remove_item' });
    setFlow((f): ParseFlow => {
      if (f.status !== 'review') return f;
        const items = f.meal.items.filter((_, idx) => idx !== i);
      if (items.length === 0) {
        // The card is gone; its edit count must not leak into the next one.
        editCountRef.current = 0;
        return { status: 'idle' };
      }
      // Removing the last line of a section collapses the card, exactly as a
      // group move does, so the head is recomputed here for the same reason:
      // a stale card-level section is what onAdd falls back to for any line
      // that carries none.
      const head = items[0]?.meal_type ?? f.meal.meal_type;
      return { ...f, mealType: head, meal: { ...f.meal, items, meal_type: head } };
    });
  }, []);
  const onEditSave = useCallback((patch: ParsedMealItem) => {
    editCountRef.current += 1;
    track('parse_proposal_edited', { action: 'edit_item', source: patch.source ?? null });
    setFlow((f) => {
      if (f.status !== 'review' || editIndex === null) return f;
      // A different food now: the user's old words no longer name this line,
      // and a later double check must not look up the food they replaced.
      const before = f.meal.items[editIndex];
      const renamed = before && patch.food_name.trim().toLowerCase() !== before.food_name.trim().toLowerCase();
      const line = renamed ? { ...patch, said_name: undefined } : patch;
      const items = f.meal.items.map((it, i) => (i === editIndex ? line : it));
      // The editor can move one line, which can leave the card with a single
      // section. Keep the card-level field on the first line so a later
      // fallback reads the surviving section rather than an emptied one.
      const head = items[0]?.meal_type ?? f.meal.meal_type;
      return { ...f, mealType: head, meal: { ...f.meal, items, meal_type: head } };
    });
    setEditIndex(null);
  }, [editIndex]);

  const onSend = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    // 'streaming' is mid-parse too: fast mode flips to it ~1.2s in, when the
    // first rows land but the parse is still running. Guarding only on
    // 'analysing' re-opened the send control and let a second parse race the
    // first, and setFlow(reviewFlow) below is unconditional, so whichever
    // finished last won regardless of which meal the user meant.
    if (flow.status === 'analysing' || flow.status === 'streaming') return;
    // Guest fallback: no JWT means parse_meal would 401, so route to the
    // manual picker exactly as the old bar did.
    if (!isSignedIn) { openSearch(mealForNow(), 'guest_bar'); return; }
    if (boxFocusRef.current) boxFocusRef.current.sent = true;
    lastBoxSendAt.current = Date.now();
    setText('');
    void runParse(t);
  }, [text, isSignedIn, flow.status, runParse]);

  const onMealTypeChange = useCallback((m: MealType) => {
    editCountRef.current += 1;
    track('parse_proposal_edited', { action: 'change_section', to: m });
    setFlow((f) => {
      if (f.status !== 'review') return f;
      // The chip row moves the WHOLE meal, so it stamps every line rather than
      // only the card-level field. That is what makes the lines the single
      // source of truth for where this meal goes: onAdd can then just read
      // them, instead of deciding between a card-level value and per-line ones
      // and getting that choice wrong whenever the two disagree.
      return {
        ...f,
        mealType: m,
        mealTypePicked: true,
        meal: { ...f.meal, meal_type: m, items: f.meal.items.map((it) => ({ ...it, meal_type: m })) },
      };
    });
  }, []);

  /** Multi-section card: move every line of one group to another section. */
  const onMoveGroup = useCallback((from: MealType, to: MealType) => {
    if (from !== to) {
      editCountRef.current += 1;
      track('parse_proposal_edited', { action: 'move_group', from, to });
    }
    setFlow((f) => {
      if (f.status !== 'review' || from === to) return f;
      const items = f.meal.items.map((it) => (it.meal_type === from ? { ...it, meal_type: to } : it));
      const head = items[0]?.meal_type ?? f.meal.meal_type;
      // mealType moves too, and that is not cosmetic. Moving the last group out
      // of a section collapses the card back to ONE section, and onAdd then
      // takes the single-section branch and stamps flow.mealType over every
      // line. Left stale, moving breakfast into snacks logged the meal to
      // breakfast - the section the user had just emptied.
      return {
        ...f,
        meal: { ...f.meal, items, meal_type: head },
        mealType: head,
      };
    });
  }, []);

  // A second tap during the write must not log the meal twice. State lags a
  // render; this ref is set before the first await.
  const addingRef = useRef(false);
  /** Undo from the "Added" toast: the lines come out and the meal goes back
   *  to waiting, so an Undo is never a silent discard. */
  const onUndoAdd = useCallback(async (ref: LoggedParseRef, review: Extract<ParseFlow, { status: 'review' }>) => {
    if (!supabase) return;
    track('meal_undone', {
      section_count: ref.sections.length,
      entry_count: ref.sections.reduce((t, sec) => t + sec.entryIds.length, 0),
      via: 'toast',
    });
    let failed = false;
    try {
      failed = !!(await undoParsedMeal(supabase, ref)).error;
    } catch {
      failed = true;
    }
    reload();
    if (failed) {
      haptics.warning();
      toastRef.current.error('That did not undo. The food is still in your diary.');
      return;
    }
    haptics.tap();
    if (flowRef.current.status === 'idle') setFlow(review);
  }, [supabase, reload]);

  const onAdd = useCallback(async () => {
    if (flow.status !== 'review' || !supabase || addingRef.current) return;
    const review = flow;
    addingRef.current = true;
    setAdding(true);
    // The LINES say where they go, always. Every control that can change a
    // section now writes it onto the lines (the chip row stamps all of them,
    // a group header stamps its group, the line editor stamps one), so there
    // is no second opinion to reconcile here. meal_type rides along only as
    // the fallback for a line that carries none, which is what an older
    // server's response looks like.
    const meal = { ...review.meal, meal_type: review.mealType };
    const day = review.dayIso ? dateFromYmd(review.dayIso) : viewDate;
    const sections = sectionsOf(meal);
    const destination = sections.length > 1
      ? `${sections.length} meals`
      : (MEALS.find((m) => m.type === sections[0])?.label ?? 'your diary').toLowerCase();
    // Answer the tap: the screen closes and the lines show in their meals at
    // once (lib/pendingEntries) while the write runs. A meal for another day
    // takes the diary there instead; that day's read shows the lines.
    const sameDay = ymd(day) === viewIso;
    const groups = sameDay
      ? sections.map((sec) => ({
          sec,
          id: addPendingLines(
            meal.items.filter((it) => (it.meal_type ?? meal.meal_type) === sec).map((it) => ({
              food_id: it.food_id, food_name: it.food_name, quantity: it.quantity,
              serving_unit: it.serving_label, grams_logged: it.grams,
              kcal: it.kcal, protein_g: it.protein_g, carb_g: it.carb_g, fat_g: it.fat_g, source: it.source,
            })),
            sec,
          ),
        }))
      : [];
    if (!sameDay) setViewDate(day);
    setResultOpen(false);
    setCardMinimized(false);
    // Tells the tour this close was Add, not Discard (tourSignalForFlow).
    tourAddedRef.current = true;
    setFlow({ status: 'idle' });
    let res: Awaited<ReturnType<typeof logParsedMeal>>;
    try {
      res = await logParsedMeal(supabase, meal, day, review.origin ?? 'ai');
    } catch (e) {
      res = { error: e instanceof Error ? e.message : 'Could not add that' };
    }
    const { ref, error } = res;
    if (review.origin) {
      track('food_suggestion_logged', {
        meal_type: review.mealType, item_count: review.meal.items.length, all: false,
        edited: editCountRef.current > 0, is_today: isToday, write_failed: !!error,
        from_previous_day: review.origin === 'copy_day',
      });
    }
    addingRef.current = false;
    setAdding(false);
    if (!review.origin) {
      track('parse_proposal_accepted', {
        item_count: review.meal.items.length,
        section_count: sections.length,
        edit_count: editCountRef.current,
        meal_type_picked: !!review.mealTypePicked,
        is_today: isToday,
        write_failed: !!error,
      });
    }
    if (error || !ref) {
      for (const g of groups) dropPendingLines(g.id);
      haptics.warning();
      // Keep the reviewed meal so Retry re-attempts the write (see onRetry).
      setFlow({ status: 'error', raw: review.raw, message: 'Could not add that. Try again.', meal: review.meal, mealType: review.mealType, words: review.words, origin: review.origin, dayIso: review.dayIso, tier: review.tier });
      return;
    }
    editCountRef.current = 0;
    for (const g of groups) {
      const sec = ref.sections.find((x) => x.mealType === g.sec);
      if (sec) settlePendingLines(g.id, sec.entryIds);
      else dropPendingLines(g.id);
    }
    haptics.success();
    reload();
    toastRef.current.show({
      type: 'success',
      text: `Added to ${destination}`,
      action: { label: 'Undo', onPress: () => { void onUndoAdd(ref, review); } },
      durationMs: UNDO_MS,
    });
  }, [flow, supabase, reload, viewDate, viewIso, isToday, addPendingLines, settlePendingLines, dropPendingLines, onUndoAdd]);

  const onRetry = useCallback(() => {
    if (flow.status !== 'error') return;
    // A write failure kept the meal → re-show the review card (tapping Add re-writes
    // it, to the current day). Only re-run the AI parse if the meal is gone.
    if (flow.meal && flow.mealType) {
      setFlow({ status: 'review', raw: flow.raw, meal: flow.meal, mealType: flow.mealType, words: flow.words, origin: flow.origin, dayIso: flow.dayIso ?? viewIso, tier: flow.tier });
    } else {
      // A failed "Just log it" send retries under its ORIGINAL id (see ParseFlow).
      void runParse(
        flow.raw,
        flow.clientId && flow.logDate ? { clientId: flow.clientId, logDate: flow.logDate } : undefined,
      );
    }
  }, [flow, runParse, viewIso]);

  // Save the food or meal Drona drafted, and log it too when the user said they
  // ate it. Guarded against a double tap, which would put a duplicate in My
  // Meals. Logs to the day on screen, same as every other add from this box.
  const onApplyCreate = useCallback(async () => {
    if (flow.status !== 'create' || flow.busy || flow.result || !supabase) return;
    const { create } = flow;
    setFlow({ ...flow, busy: true });
    const res = await applyCoachFoodCreate(supabase, create, mealForNow(), viewDate);
    track('drona_food_create_applied', { kind: create.kind, logged: res.logged, ok: !res.error });
    setFlow((cur) => (cur.status === 'create' && cur.create === create ? { ...cur, busy: false, result: res } : cur));
    if (res.savedMealId) {
      if (res.logged) reload();
      haptics.success();
    } else {
      haptics.warning();
    }
  }, [flow, supabase, viewDate, reload]);

  /** Close the card with no verdict on it. Discard calls this after counting a
   *  rejection; editing your words calls it without one, since taking the words
   *  back to change them is not a no to the meal. */
  const clearCard = useCallback(() => {
    editCountRef.current = 0;
    setChecking(null);
    setCardMinimized(false);
    // Discard is reachable mid-parse. Bumping the token orphans whatever is in
    // flight so it cannot resurrect the card the user just threw away, and the
    // abort stops that work rather than merely ignoring its answer.
    parseTokenRef.current += 1;
    parseAbortRef.current?.abort();
    turnsRef.current = [];
    lastReviewRef.current = null;
    setWaitOpen(false);
    setResultOpen(false);
    setFlow({ status: 'idle' });
  }, []);

  const onDismiss = useCallback(() => {
    track('parse_proposal_rejected', {
      flow_status: flow.status,
      item_count: flow.status === 'review' ? flow.meal.items.length : null,
      edit_count: editCountRef.current,
    });
    clearCard();
  }, [flow, clearCard]);

  /** Undo from a diary row's "Added by Drona" chip: the whole send that row
   *  came from, which is the action being undone. Removing one line is what
   *  tapping the row already does. */
  const onUndoRow = useCallback(async (ref: LoggedParseRef) => {
    if (!supabase) return;
    track('meal_undone', {
      section_count: ref.sections.length,
      entry_count: ref.sections.reduce((t, s) => t + s.entryIds.length, 0),
    });
    // A failed delete keeps the chip, so Undo can be tried again.
    let failed = false;
    try {
      failed = !!(await undoParsedMeal(supabase, ref)).error;
    } catch {
      failed = true;
    }
    if (failed) {
      haptics.warning();
      reload();
      return;
    }
    forgetAddedByDrona(ref);
    reload();
  }, [supabase, reload]);

  /** Deletes every row waiting behind the Undo bar, one at a time so two lines
   *  of one meal never race the empty-meal cleanup. A failed one comes back. */
  const commitRemoves = useCallback(async () => {
    if (removeTimer.current) { clearTimeout(removeTimer.current); removeTimer.current = null; }
    const batch = pendingRemoves.current;
    pendingRemoves.current = [];
    if (!batch.length || !supabase) return;
    const failed: string[] = [];
    for (const e of batch) {
      try {
        if ((await deleteMealEntry(supabase, e)).error) failed.push(e.id);
        else track('meal_entry_deleted', { meal_type: e.meal_type, kcal: Math.round(e.kcal), via: 'swipe' });
      } catch {
        failed.push(e.id);
      }
    }
    if (failed.length) {
      setRemovedIds((ids) => { const next = new Set(ids); for (const id of failed) next.delete(id); return next; });
      haptics.warning();
      // A newer swipe's Undo bar may be up. Replacing it would leave those
      // rows to delete with no Undo, and the failed rows reappearing say enough.
      if (!pendingRemoves.current.length) toastRef.current.error(failed.length === 1 ? 'That food did not delete. It is back on the list.' : `${failed.length} foods did not delete. They are back on the list.`);
    }
    reload();
  }, [supabase, reload]);
  const commitRef = useRef(commitRemoves);
  commitRef.current = commitRemoves;

  /** Undo brings back every row removed since the bar appeared. */
  const undoRemoves = useCallback(() => {
    if (removeTimer.current) { clearTimeout(removeTimer.current); removeTimer.current = null; }
    const back = pendingRemoves.current;
    pendingRemoves.current = [];
    if (!back.length) return;
    setRemovedIds((ids) => { const next = new Set(ids); for (const e of back) next.delete(e.id); return next; });
    haptics.tap();
  }, []);

  /** A row swiped off the screen. Each new swipe restarts the Undo window, so
   *  clearing a meal line by line ends in one bar: "Removed 3 foods · Undo".
   *  False when it cannot be removed now, so the swiped row springs back. */
  const onRemoveEntry = useCallback((e: LoggedEntry) => {
    if (!supabase || e.pending) { haptics.warning(); return false; }
    if (pendingRemoves.current.some((p) => p.id === e.id)) return true;
    pendingRemoves.current = [...pendingRemoves.current, e];
    setRemovedIds((ids) => new Set(ids).add(e.id));
    haptics.medium();
    const n = pendingRemoves.current.length;
    toastRef.current.show({
      type: 'success',
      text: n === 1 ? `Removed ${e.food_name}` : `Removed ${n} foods`,
      action: { label: 'Undo', onPress: undoRemoves },
      durationMs: UNDO_MS,
    });
    if (removeTimer.current) clearTimeout(removeTimer.current);
    removeTimer.current = setTimeout(() => { void commitRef.current(); }, COMMIT_MS);
    return true;
  }, [supabase, undoRemoves]);

  // Leaving the screen or the app sends the deletes now: the Undo goes with it.
  useFocusEffect(useCallback(() => () => {
    if (!pendingRemoves.current.length) return;
    toastRef.current.hide();
    void commitRef.current();
  }, []));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      // Background only: 'inactive' is also the notification shade or a
      // system prompt, which would drop the Undo bar early.
      if (next !== 'background' || !pendingRemoves.current.length) return;
      toastRef.current.hide();
      void commitRef.current();
    });
    return () => sub.remove();
  }, []);

  // A sentence the food search's "Log it with Drona" row left for this box.
  // Taking it clears it, so it runs once however often this effect re-runs
  // (runParse changes identity with the day; a re-focus finds nothing). It
  // waits while a parse is still running here, as the composer's send does,
  // and then goes in exactly as if typed into the box: with a card under
  // review it is a follow-up to that card, never a silent discard of it.
  useFocusEffect(useCallback(() => {
    if (!supabase || !isSignedIn || parseInFlight) return;
    const p = takePendingParse();
    if (!p) return;
    void runParse(p.text, undefined, { mealHint: p.meal, day: p.day });
  }, [supabase, isSignedIn, parseInFlight, runParse]));

  /** A send the server never took, re-sent under the SAME id and day. */
  const onRetryLost = useCallback((p: PendingAutoLog) => {
    setLostSends((l) => l.filter((x) => x.client_id !== p.client_id));
    void runParse(p.text, { clientId: p.client_id, logDate: p.log_date });
  }, [runParse]);
  const onForgetLost = useCallback(async (p: PendingAutoLog) => {
    await removePending(p.client_id);
    setLostSends((l) => l.filter((x) => x.client_id !== p.client_id));
  }, []);

  const eaten = { kcal: totals.kcal, protein: totals.protein_g, carb: totals.carb_g, fat: totals.fat_g };
  // One story, one narrator: Drona's line must agree with the ring. Placeholder
  // logic until the coach reads the day for real (edge fn).
  const surplus = eaten.kcal - targets.kcal;
  // A day still ahead holds a plan, not food eaten, so it gets its own line.
  const dronaLine = viewIso > todayIso
    ? surplus > 0
      ? `That plan runs ${fmtK(surplus)} over. Trim it now and the day lands on target.`
      : 'Planning ahead. Build the day here and keep the ring inside your goal.'
    : surplus > 0
    ? `You're ${fmtK(surplus)} over today. Ease up at dinner and the week still balances.`
    : "Good start. Get one more protein hit in at lunch and you're on pace.";

  const s = makeStyles(C);

  // The tour's line in the food bar. While reading there is nothing to say; in
  // review it rides on the full-screen result instead, when that is up.
  const inlineTourTip = tourStep === 'type' || tourStep === 'write' || tourStep === 'retry' || tourStep === 'done'
    ? TOUR_COPY[tourStep]
    : tourStep === 'review' && !resultOpen ? TOUR_COPY.review : null;

  // Shared by the inline card and the result screen, so a choice made on
  // either is the same change to the meal.
  const acceptProposal = () => setFlow((f) => {
    if (f.status !== 'review' || !f.proposal) return f;
    // The proposal replaces the LINES, never their placement. Each
    // incoming line inherits the section of the line it stands in
    // for, matched by name and falling back to position, so
    // accepting better numbers for a breakfast item cannot move it.
    // POSITION first, then name. A name-keyed map cannot tell two
    // same-named lines in different sections apart - the later key
    // overwrites the earlier - and a proposal is a positional
    // replacement of the same list, so the index is the stronger
    // handle. The name is the fallback for a reordered list.
    const key = (n: string) => n.trim().toLowerCase();
    const bySection = new Map(f.meal.items.map((it) => [key(it.food_name), it.meal_type]));
    const items = f.proposal.items.map((it, i) => {
      const atIdx = f.meal.items[i];
      const positional = atIdx && key(atIdx.food_name) === key(it.food_name)
        ? atIdx.meal_type
        : undefined;
      return {
        ...it,
        meal_type: it.meal_type ?? positional ?? bySection.get(key(it.food_name)) ?? f.mealType,
      };
    });
    return { ...f, meal: { ...f.meal, items }, notice: null, proposal: null };
  });
  const dismissNotice = () => setFlow((f) => (f.status === 'review' ? { ...f, notice: null, proposal: null } : f));
  const editWordsBlocked = parseInFlight || adding || flow.status === 'sent' || (flow.status === 'error' && (!!flow.clientId || !!flow.meal));
  const editWords = () => {
    if (flow.status === 'idle' || flow.status === 'create') return;
    // The whole conversation, not just a correction's own words.
    const raw = flow.status === 'review' && flow.words ? flow.words : flow.raw;
    track('food_text_reused', { from: 'card', flow_status: flow.status, chars: raw.length });
    clearCard();
    // Keep a half-typed follow-up: it rides after the words, not over them.
    setText((cur) => (cur.trim() ? `${raw}, ${cur.trim()}` : raw));
    inputRef.current?.focus();
  };

  // What the result screen draws: the meal under review, or, while a
  // correction typed there is read, the meal it is correcting.
  const shownReview = flow.status === 'review' ? flow : parseInFlight && resultOpen ? lastReviewRef.current : null;
  const closeWait = () => { track('meal_wait_closed', { status: flow.status }); setWaitOpen(false); };
  const closeResult = () => setResultOpen(false);

  /** The inline card above the food box: a decline, an error, a "Just log
   *  it" send still settling, and a reviewed meal folded to its one-line
   *  strip while it waits (the meal itself opens full screen). */
  const renderParseCard = (extra: Partial<React.ComponentProps<typeof ParsedMealCard>>) => {
    if (flow.status === 'idle' || flow.status === 'create') return null;
    return (
      <ParsedMealCard
        state={flow.status as ParseCardState}
        rawText={flow.raw}
        maxHeight={cardMaxHeight}
        hardMaxHeight={Math.max(0, hardAvail)}
        // Fast mode's settling window: real names, shimmering numbers.
        streamingRows={flow.status === 'streaming' ? flow.rows : null}
        meal={flow.status === 'review' ? flow.meal : null}
        mealType={flow.status === 'review' ? flow.mealType : undefined}
        adding={adding}
        message={
          flow.status === 'declined' || flow.status === 'error' || flow.status === 'sent' ? flow.message : null
        }
        autoLogging={(flow.status === 'analysing' || flow.status === 'streaming') && !!flow.auto}
        statusLabel={flow.status === 'analysing' ? flow.statusLabel ?? null : null}
        onMealTypeChange={onMealTypeChange}
        onMoveGroup={flow.status === 'review' ? onMoveGroup : undefined}
        notice={flow.status === 'review' ? flow.notice ?? null : null}
        proposalLabel={flow.status === 'review' ? flow.proposal?.note ?? null : null}
        onAcceptProposal={acceptProposal}
        onDismissNotice={dismissNotice}
        // Frozen while a check is in flight: editing or removing a line
        // mid-lookup shifts indices and races the write below.
        onEditItem={flow.status === 'review' && checkingIndex === null ? onEditItem : undefined}
        checkingIndex={flow.status === 'review' ? checkingIndex : null}
        onCheckItem={flow.status === 'review' ? onCheckItem : undefined}
        onRemoveItem={flow.status === 'review' && checkingIndex === null ? onRemoveItem : undefined}
        onSwapItem={flow.status === 'review' && checkingIndex === null ? onSwapItem : undefined}
        saved={flow.status === 'review' && savedReview}
        onAdd={flow.status === 'review' ? onAdd : undefined}
        onSave={flow.status === 'review' ? () => setSaveItems(flow.meal.items) : undefined}
        onRetry={flow.status === 'error' ? onRetry : undefined}
        onDismiss={onDismiss}
        // Editing the words starts this meal over: a send while a card is
        // in review would be read as a correction to it.
        // Not on 'sent', nor on a "Just log it" send that failed in transport
        // (it carries a clientId): the server may already be writing that
        // meal. Retry keeps the id and is safe; resending the words is not.
        // Nor while Add is writing, nor after Add failed (the error card
        // keeps the meal): the write may still have landed, and the words
        // left in the box could log the meal twice. Retry is the safe path.
        onEditWords={editWordsBlocked ? undefined : editWords}
        minimized={cardMinimized}
        onToggleMinimize={() => setCardMinimized((v) => !v)}
        {...extra}
      />
    );
  };

  return (
    <View style={[s.root, { backgroundColor: C.background }]}>
      <ScrollView
        // The blurred day behind the open card is out of the screen-reader
        // tree too; the card and the food box (outside this list) stay in it.
        accessibilityElementsHidden={resultOpen}
        importantForAccessibility={resultOpen ? 'no-hide-descendants' : 'auto'}
        contentContainerStyle={{ paddingTop: insets.top + Spacing.sm, paddingBottom: 150 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onScroll={onDayScroll}
        scrollEventThrottle={16}
        refreshControl={<OrbRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <RefreshOrb refreshing={refreshing} />
        {/* Header — back + a day stepper (‹ Today ›, tap the label for the calendar) */}
        <View style={s.header}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={s.back}>
            <Feather name="chevron-left" size={22} color={C.foreground} />
          </Pressable>
          <View style={s.dayNavWrap} pointerEvents="box-none">
            <View style={s.dayNav}>
              <Pressable onPress={() => stepDay(-1)} hitSlop={8} style={s.dayArrow} accessibilityLabel="Previous day">
                <Feather name="chevron-left" size={18} color={C.textSecondary} />
              </Pressable>
              <Pressable onPress={() => setCalendarOpen(true)} hitSlop={6} style={s.dayLabelBtn} accessibilityLabel="Pick a day">
                <Text style={s.title}>{dayLabel(viewDate)}</Text>
                <Feather name="calendar" size={13} color={C.textMuted} />
              </Pressable>
              <Pressable onPress={() => stepDay(1)} disabled={atLatest} hitSlop={8} style={[s.dayArrow, { opacity: atLatest ? 0.3 : 1 }]} accessibilityLabel="Next day">
                <Feather name="chevron-right" size={18} color={C.textSecondary} />
              </Pressable>
            </View>
          </View>
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => setSavedListOpen(true)} hitSlop={10} style={s.headerBtn} accessibilityLabel="Saved meals">
            <Feather name="bookmark" size={17} color={C.foreground} />
          </Pressable>
          {streak > 0 && (
            <View style={[s.streak, { marginLeft: Spacing.md }]}>
              <Feather name="zap" size={12} color={Colors.stat.streak} />
              <Text style={s.streakTxt}>{streak}</Text>
            </View>
          )}
        </View>

        {/* Week strip — calendar weeks, swipe for the one before or after; tap a
            bubble to jump straight there. Each day wears a ring showing how
            much of the calorie goal is logged for that day, planned days
            included. Over goal it overflows like the hero MacroRing: the ring
            stays full and the surplus laps it again in the same hue, its rounded
            cap set in a small background-colored gap so the lap's end shows.
            Only days past latestLogDay() are dimmed/locked. */}
        <FlatList
          ref={weekListRef}
          data={weekStarts}
          keyExtractor={(w) => ymd(w)}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          getItemLayout={(_, i) => ({ length: winW, offset: winW * i, index: i })}
          initialScrollIndex={Math.max(weekIndex, 0)}
          initialNumToRender={1}
          windowSize={3}
          extraData={{ weekKcal, viewIso, latestIso, targetsOn, C }}
          onMomentumScrollEnd={onWeekSwipe}
          onScrollEndDrag={onWeekDragEnd}
          style={s.weekList}
          renderItem={({ item: ws }) => (
            <View style={[s.weekStrip, { width: winW }]}>
              {Array.from({ length: 7 }, (_, i) => {
                const d = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i);
                const iso = ymd(d);
                const selected = iso === viewIso;
                const locked = iso > latestIso;
                const kcal = weekKcal[iso] ?? 0;
                const goal = targetsOn(d).kcal;
                const frac = kcal / (goal || 1);
                const pct = Math.min(frac, 1);
                // No goal set means nothing to be over.
                const over = goal > 0 && frac > 1;
                const R = 16, CIRC = 2 * Math.PI * R;
                const SW = 3;
                // The seam, as on the hero ring: a background-colored disc punched
                // into the ring at the lap's tip. The moat is wider than the hero's
                // or it vanishes on a line this thin.
                const HOLE = 3.6;
                const holeFrac = HOLE / CIRC;
                // A whole extra goal (2x, 3x) leaves no remainder; draw it as a
                // near-full lap, not the minimum stub.
                const rem = (frac - 1) % 1;
                const lapFrac = !over ? 0 : rem === 0 ? 1 - holeFrac * 1.25 : Math.max(rem, holeFrac * 1.25);
                const tipA = (lapFrac * 360 - 90) * (Math.PI / 180);
                return (
                  <Pressable
                    key={iso}
                    onPress={() => setViewDate(d)}
                    disabled={locked}
                    style={[s.weekDay, locked && { opacity: 0.35 }]}
                    accessibilityLabel={over
                      ? `Go to ${dayLabel(d)}, ${round(kcal - goal)} calories over`
                      : `Go to ${dayLabel(d)}`}
                  >
                    <Text style={[s.weekDayName, selected && { color: C.foreground }]}>
                      {d.toLocaleDateString(undefined, { weekday: 'narrow' })}
                    </Text>
                    <View style={s.weekDayRing}>
                      <Svg width={36} height={36} style={StyleSheet.absoluteFill}>
                        <Circle cx={18} cy={18} r={R} stroke={C.borderSubtle} strokeWidth={SW} fill="none" />
                        {!locked && pct > 0 && (
                          <Circle
                            cx={18} cy={18} r={R}
                            stroke={C.macro.calories} strokeWidth={SW} fill="none"
                            strokeLinecap="round"
                            strokeDasharray={`${pct * CIRC} ${CIRC}`}
                            transform="rotate(-90 18 18)"
                          />
                        )}
                        {!locked && over && (
                          <>
                            <Circle
                              cx={18 + R * Math.cos(tipA)} cy={18 + R * Math.sin(tipA)} r={HOLE}
                              fill={C.background}
                            />
                            <Circle
                              cx={18} cy={18} r={R}
                              stroke={C.macro.calories} strokeWidth={SW} fill="none"
                              strokeLinecap="round"
                              strokeDasharray={`${lapFrac * CIRC} ${CIRC}`}
                              transform="rotate(-90 18 18)"
                            />
                          </>
                        )}
                      </Svg>
                      <View style={[s.weekDayNum, selected && s.weekDayNumSelected]}>
                        <Text style={[s.weekDayNumTxt, selected && s.weekDayNumTxtSelected]}>
                          {d.getDate()}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        />

        {/* Summary — calorie hero ring (LEFT + eaten/goal caption below + same-hue
            overshoot) and three macro bars carrying target + signed over. */}
        <View
          style={s.summary}
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout;
            setSummaryBottom(y + height);
          }}
        >
          <Pressable onPress={() => setGoalOpen(true)} hitSlop={8} style={s.goalBtn} accessibilityLabel="Edit daily goal">
            <Feather name="sliders" size={12} color={isCustom ? C.textDim : C.accentText} />
            <Text style={[s.goalBtnTxt, { color: isCustom ? C.textDim : C.accentText }]}>{isCustom ? 'Goal' : 'Set goal'}</Text>
          </Pressable>
          {dayFailed ? <DayLoadFailed onRetry={reload} /> : dayLoading ? <DaySummaryLoading /> : (
          <View style={s.summaryRow}>
            <MacroRing
              value={eaten.kcal} target={targets.kcal} color={C.macro.calories} valueColor={C.macro.calories}
              display="remaining" overshoot name="Calories" size={116} thickness={11} centerFontSize={26}
            />
            <View style={s.macroRailSide}>
              <Text style={s.kcalLine}>{calCaption(eaten.kcal, targets.kcal)}</Text>
              {viewFuel && (
                <Pressable
                  onPress={() => setFuelOpen(true)}
                  hitSlop={6}
                  style={s.fuelTag}
                  accessibilityRole="button"
                  accessibilityLabel={`${viewFuel.label ?? 'Fuel'} day, ${viewFuel.kcal} extra calories. Edit fuel days`}
                >
                  <Feather name="zap" size={10} color={C.accentText} />
                  <Text style={[s.fuelTagTxt, { color: C.accentText }]} numberOfLines={1}>
                    {`${viewFuel.label ?? 'Fuel'} day · +${viewFuel.kcal}`}
                  </Text>
                </Pressable>
              )}
              <MacroBar label="P" name="Protein" value={eaten.protein} target={targets.protein} color={C.macro.protein} delayMs={0} valueMinWidth={52} />
              <MacroBar label="C" name="Carbs" value={eaten.carb} target={targets.carb} color={C.macro.carbs} delayMs={70} valueMinWidth={52} />
              <MacroBar label="F" name="Fat" value={eaten.fat} target={targets.fat} color={C.macro.fat} delayMs={140} valueMinWidth={52} />
            </View>
          </View>
          )}
          {/* What Drona has learned this body burns: one quiet row at the foot of
              the card, details on tap. Moves daily; the target itself only moves
              on the weekly check-in. */}
          {isSignedIn && <MaintenanceRow />}
        </View>

        {/* Drona line. Hidden while the day loads: it is a sentence ABOUT the
            totals, so showing the old day's verdict over a shimmering ring is
            the same stale-number bug wearing a coach's voice. */}
        {!dayUnknown && (
          <View style={s.drona}>
            <View style={s.avatar}><DronaMark size={11} color={`${C.accentText}99`} state="static" /></View>
            <Text style={s.dronaTxt}>{dronaLine}</Text>
          </View>
        )}

        {/* "Just log it" sends the server never took (a network drop on send,
            found by the reconcile). Visible, never silently re-sent: the user
            closed the app trusting it went through, so a miss has to be seen.
            Retry re-sends under the SAME id; the x forgets it. */}
        {lostSends.map((p) => (
          <View key={p.client_id} style={s.lost}>
            <Feather name="alert-circle" size={12} color={C.textSecondary} style={{ marginTop: 2 }} />
            <Text style={s.lostTxt} numberOfLines={2}>{`Drona didn't get: '${p.text}'`}</Text>
            <Pressable onPress={() => onRetryLost(p)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retry sending this to Drona">
              <Text style={s.lostAction}>Retry</Text>
            </Pressable>
            <Pressable onPress={() => void onForgetLost(p)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Forget this one">
              <Feather name="x" size={13} color={C.textMuted} />
            </Pressable>
          </View>
        ))}

        {/* Meal sections */}
        {MEALS.map((m) => {
          const entries = dayUnknown ? [] : byMeal[m.type].filter((e) => !removedIds.has(e.id));
          const sub = entries.reduce((a, e) => ({ kcal: a.kcal + e.kcal, protein: a.protein + e.protein_g }), { kcal: 0, protein: 0 });
          // Copy the day before's meal: offered while that meal holds anything
          // this one does not have yet.
          const usual = dayUnknown ? [] : suggestions[m.type];
          // The day before's rows already ARE the copy, so the icon would say
          // the same thing twice. It comes back once the meal has food.
          const showingPrev = usual.length > 0 && usual.every((x) => x.reason === 'previous_day');
          const canCopy = isSignedIn && !dayUnknown && !showingPrev && copyableFromDay(prevLines[m.type], entries).length > 0;
          return (
            <View key={m.type} style={s.section}>
              <View style={s.sectionHead}>
                <Feather name={m.icon} size={13} color={C.textDim} />
                <Text style={s.sectionLabel}>{m.label}</Text>
                <View style={{ flex: 1 }} />
                {entries.length > 0 && (
                  <Text style={s.sectionSub}>{formatMacroGrams(sub.protein)}g P · {round(sub.kcal)}</Text>
                )}
                {canCopy && (
                  <Pressable
                    onPress={() => {
                      track('meal_copy_opened', { meal_type: m.type, is_today: isToday });
                      setCopyMeal(m.type);
                    }}
                    hitSlop={10}
                    style={s.copyBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Copy ${prevLabel.toLowerCase() === 'yesterday' ? "yesterday's" : `${prevLabel}'s`} ${m.label.toLowerCase()}`}
                  >
                    <Feather name="clipboard" size={13} color={C.textMuted} />
                  </Pressable>
                )}
              </View>

              {dayLoading && <MealRowsLoading />}

              {entries.map((e) => {
                // A row Drona added in "Just log it" this launch wears a quiet
                // chip with Undo, so a meal logged while the app was closed is
                // still one tap from gone. Cleared by the next app launch.
                // A line still saving has no row to open or undo yet: it
                // shows dimmed and quiet until the day is read back with it.
                const dronaRef = e.pending ? undefined : addedByDronaRef(e.id);
                const relog = e.pending ? undefined : relogged.get(e.id);
                // Undo takes back the whole add (a copy or Add all can be
                // several lines), so the chip says so when there is more than one.
                const relogCount = relog ? relog.ref.sections.reduce((t, sec) => t + sec.entryIds.length, 0) : 0;
                return (
                  // Undo is a SIBLING of the row, not nested in it. A Pressable
                  // is accessible by default, so VoiceOver and TalkBack can fold
                  // a nested one into the outer button and leave Undo with no
                  // way to reach it. Same structure ParsedMealCard already uses
                  // for its collapsed strip, and for the same reason.
                  // A line that just came from a suggestion or a copy slides in,
                  // the end of the beat its suggestion row started. Lines that
                  // were already there mount still, so a day load never ripples.
                  <Animated.View
                    key={rowKey(e.id)}
                    style={s.entryWrap}
                    // Timed, not sprung: a spring overshot and the suggestion
                    // rows below, pushed down by it, bobbed before settling.
                    entering={relog || e.pending ? FadeInDown.duration(220) : undefined}
                    layout={LinearTransition.duration(220)}
                  >
                    {/* A plain list row, not a card: only the summary and the food
                        box carry a surface, so the box reads as the thing to use.
                        The chevron and the pressed wash say the row opens.
                        Swipe it off to the left to remove it. */}
                    {/* A line still saving has no row to delete yet, so it does not swipe. */}
                    <SwipeToRemove style={s.entrySwipe} disabled={!!e.pending} onRemove={() => onRemoveEntry(e)}>
                    <Pressable
                      style={({ pressed }) => [s.entry, { backgroundColor: pressed ? C.muted : C.background }, e.pending && s.entryPending]}
                      onPress={e.pending ? undefined : () => setEditEntry(e)}
                      disabled={e.pending}
                      accessibilityRole="button"
                      accessibilityState={{ busy: !!e.pending, disabled: !!e.pending }}
                      accessibilityHint={e.pending ? 'Saving' : 'Edit this food'}
                      // Screen readers get Remove from the actions rotor, no swipe needed.
                      accessibilityActions={e.pending ? undefined : [{ name: 'delete', label: 'Remove' }]}
                      onAccessibilityAction={(ev) => {
                        if (ev.nativeEvent.actionName === 'delete') onRemoveEntry(e);
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={s.entryName}>
                          {e.food_name} <Text style={s.serving}>· {formatServing(e.quantity, e.serving_unit)}</Text>
                        </Text>
                        <View style={s.macros}>
                          <Text style={[s.macroNum, { color: C.foreground }]}>{round(e.kcal)} cal</Text>
                          <Text style={[s.macroNum, { color: C.macro.protein }]}>{formatMacroGrams(e.protein_g)}g P</Text>
                          <Text style={[s.macroNum, { color: C.macro.carbs }]}>{formatMacroGrams(e.carb_g)}g C</Text>
                          <Text style={[s.macroNum, { color: C.macro.fat }]}>{formatMacroGrams(e.fat_g)}g F</Text>
                        </View>
                      </View>
                      <Feather name="chevron-right" size={14} color={C.textDim} />
                    </Pressable>
                    </SwipeToRemove>
                    {dronaRef && (
                      <View style={s.dronaChip}>
                        <DronaMark size={9} color={`${C.accentText}99`} state="static" />
                        <Text style={s.dronaChipTxt}>Added by Drona</Text>
                        <Text style={s.dronaChipTxt}>·</Text>
                        <Pressable
                          onPress={() => { void onUndoRow(dronaRef); }}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`Undo ${e.food_name}, added by Drona`}
                        >
                          <Text style={s.dronaChipUndo}>Undo</Text>
                        </Pressable>
                      </View>
                    )}
                    {!dronaRef && relog && (
                      <View style={s.dronaChip}>
                        <Feather name="check" size={10} color={C.textMuted} />
                        <Text style={s.dronaChipTxt}>{relog.label}</Text>
                        <Text style={s.dronaChipTxt}>·</Text>
                        <Pressable
                          onPress={() => { void onUndoRelog(relog.ref); }}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={relogCount > 1 ? `Undo all ${relogCount} foods added together` : `Undo ${e.food_name}`}
                        >
                          <Text style={s.dronaChipUndo}>{relogCount > 1 ? 'Undo all' : 'Undo'}</Text>
                        </Pressable>
                      </View>
                    )}
                  </Animated.View>
                );
              })}

              <MealSuggestions
                items={usual}
                mealLogged={entries.length > 0}
                mealLabel={m.label}
                weekday={viewDate.getDay()}
                fromWord={prevWord}
                addedKeys={addedKeys}
                onAdd={(items, all) => { void onAddSuggestions(m.type, items, all); }}
                onEdit={(item) => onEditSuggestion(m.type, item)}
              />

              <Pressable style={s.add} hitSlop={8} onPress={() => openSearch(m.type, 'meal_row')}>
                <Feather name="plus" size={14} color={C.textSecondary} />
                <Text style={s.addTxt}>Add to {m.label.toLowerCase()}</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      {/* Food box tour, first step: dim the day so the box stands out. Visual
          only (touches pass through), and declared before the bar so the bar
          and the tip paint over it, sharp. */}
      {tourStep === 'type' && (
        <View
          pointerEvents="none"
          // C.overlay is already translucent (0.70 dark, 0.40 light); 0.75 of it
          // is meant: the day stays readable behind the tip. Checked on device.
          style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay, opacity: 0.75 }]}
        />
      )}

      {/* Bottom logging bar. Signed-in: type free text, Drona parses it and logs
          in place (ParsedMealCard is the receipt + Undo, pinned above). Guest:
          the bar opens the manual food picker. Lifts above the keyboard via
          kbHeight (absolute bar can't rely on window resize under edge-to-edge). */}
      <View style={[
        s.inputWrap,
        { bottom: kbHeight, paddingBottom: barPadBottom },
      ]}>
        {inlineTourTip && (
          <FoodBoxTourTip
            title={inlineTourTip.title}
            body={inlineTourTip.body}
            actionLabel={tourStep === 'done' ? 'Got it' : 'Skip'}
            onAction={() => endTour(tourStep === 'done' ? 'left' : 'skipped')}
          />
        )}
        {flow.status === 'create' && (
          <View style={{ marginBottom: Spacing.sm }}>
            <FoodCreateCard
              create={flow.create}
              result={flow.result}
              busy={flow.busy}
              fallbackMeal={mealForNow()}
              onApply={() => void onApplyCreate()}
              onDismiss={() => setFlow({ status: 'idle' })}
              fullWidth
            />
          </View>
        )}
        {/* Hidden while the sheet or the result is up: they are this card,
            bigger, and two live orbs on one screen is one too many. */}
        {flow.status !== 'idle' && flow.status !== 'create' && !resultOpen && !(parseInFlight && waitOpen) && (
          <View style={{ marginBottom: Spacing.sm }}>
            {parseInFlight ? (
              // The sheet was closed. The parse runs on; one quiet line says
              // so, and a tap brings the sheet back.
              <View style={s.waitStrip}>
                <Pressable
                  onPress={() => { haptics.tap(); setWaitOpen(true); }}
                  style={s.waitStripMain}
                  accessibilityRole="button"
                  accessibilityLabel="Drona is working on your meal. Show it."
                >
                  <OrbLoader size="small" />
                  <Text style={s.waitStripTxt} numberOfLines={1}>
                    {flow.status === 'analysing' && flow.statusLabel
                      ? `${flow.statusLabel}...`
                      : flow.auto ? 'Adding it to your diary...' : 'Working out the macros...'}
                  </Text>
                  <Feather name="chevron-up" size={15} color={C.textMuted} />
                </Pressable>
                {!flow.auto && (
                  <Pressable onPress={onDismiss} hitSlop={8} accessibilityRole="button" accessibilityLabel="Cancel this meal">
                    <Feather name="x" size={14} color={C.textMuted} />
                  </Pressable>
                )}
              </View>
            ) : flow.status === 'review' ? (
              renderParseCard({ minimized: true, onToggleMinimize: () => { haptics.tap(); openResult('strip'); } })
            ) : (
              renderParseCard({})
            )}
          </View>
        )}

        {isSignedIn ? (
          <View style={s.input} onLayout={(e) => setInputRowH(e.nativeEvent.layout.height)}>
            <Pressable onPress={() => openSearch(mealForNow(), 'box_icon')} hitSlop={8} style={s.iconBox}>
              <Feather name="search" size={16} color={C.textSecondary} />
            </Pressable>
            <TextInput
              ref={inputRef}
              style={s.inputText}
              value={text}
              onChangeText={setText}
              onFocus={onBoxFocus}
              onBlur={onBoxBlur}
              // "Just log it" changes what send DOES, and the placeholder is the
              // honest always-visible signal of that: send now commits.
              placeholder={autoLog ? 'Tell Drona what you ate, it goes straight in' : 'Tell Drona what you ate'}
              placeholderTextColor={C.textSecondary}
              returnKeyType="send"
              onSubmitEditing={onSend}
              blurOnSubmit={false}
              // Wrap + grow for long entries (e.g. several metrics at once)
              // instead of scrolling off one clipped line. Submit via the arrow.
              multiline
            />
            {/* Parse-tier chip: quiet in the default (Quick), lime once the user
                has opted up, so only the non-default state draws the eye. Tap
                opens the sheet; the choice is sticky. It shows the tier that
                will actually RUN, so a lapsed subscriber sees Thorough rather
                than a Precise badge over a Thorough parse. */}
            <Pressable
              onPress={() => {
                // The portal shares the app window, so the keyboard would cover
                // its bottom rows. Blur the composer without clearing its draft.
                Keyboard.dismiss();
                setSpeedSheetOpen(true);
              }}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={`Logging mode: ${SPEED_CHIP[runningSpeed].label}`}
              style={s.iconBox}
            >
              <Feather
                name={SPEED_CHIP[runningSpeed].icon}
                size={14}
                color={runningSpeed === 'quick' ? C.textSecondary : C.accentText}
              />
            </Pressable>
            <Pressable
              // Bright while empty, so a tap must do something: open the field.
              onPress={() => (text.trim() ? onSend() : inputRef.current?.focus())}
              hitSlop={8}
              disabled={parseInFlight}
              // Full strength while empty too: the send circle is what marks
              // this bar as the place to log. Dimmed only while a parse runs.
              style={[s.send, { opacity: parseInFlight ? 0.4 : 1 }]}
              // Says what a tap does now: with nothing typed it only opens the field.
              accessibilityLabel={!text.trim() ? 'Type what you ate' : autoLog ? 'Log it' : 'Send to Drona'}
            >
              <Feather name={autoLog ? 'check' : 'arrow-up'} size={16} color={C.background} />
            </Pressable>
          </View>
        ) : (
          <Pressable style={s.input} onPress={() => openSearch(mealForNow(), 'guest_bar')}>
            <Feather name="plus-circle" size={16} color={C.accentText} />
            <Text style={[s.inputText, { color: C.textDim }]}>Add what you ate</Text>
          </Pressable>
        )}
      </View>

      {/* Tap a logged entry to edit its portion, macros, or meal section. */}
      <EntryEditSheet
        entry={editEntry}
        date={viewDate}
        onClose={() => setEditEntry(null)}
        onSaved={() => { setEditEntry(null); reload(); }}
      />

      {/* Set daily calorie + macro goals (the ring/bars draw against these). */}
      <NutritionGoalSheet
        open={goalOpen}
        // The goal sheet edits the day on screen when it is a future day, else
        // today (a past day keeps the goal it had). Seed it from that day's own
        // one-day goal when it has one, else the lasting one.
        day={viewDate}
        initial={overrideOn(goalDayFor(viewDate)) ?? baseTargets}
        lasting={baseTargets}
        firstGoal={!isCustom}
        fuelDays={fuelDays}
        onClose={() => setGoalOpen(false)}
        onSaved={(saved, scope, dayISO, clearedDays) => {
          setGoalOpen(false);
          if (scope === 'day') {
            applyDayTarget(dayISO, saved);
          } else {
            applyTargets(saved);
            // Only drop a one-day goal on screen when the server really did;
            // otherwise it would come back on the next refetch.
            for (const d of clearedDays) applyDayTarget(d, null);
          }
        }}
        // A change to the whole plan is Drona's job: open the program chat on
        // Goal & Plan with the new number already typed, sent by the user.
        onOpenDronaPlan={(kcal) => {
          setGoalOpen(false);
          router.push({ pathname: '/goal-plan', params: { drona: 'calories', kcal: String(kcal) } } as any);
        }}
        // Guests have no profile to save fuel days to, so no door to the sheet.
        onOpenFuelDays={isSignedIn ? () => { setGoalOpen(false); setFuelOpen(true); } : undefined}
      />

      {/* Fuel days: more on the weekdays the user works hardest. */}
      <FuelDaysSheet
        open={fuelOpen}
        initial={fuelDays}
        baseKcal={baseTargets.kcal}
        source="nutrition"
        onClose={() => setFuelOpen(false)}
        onSaved={(saved) => { setFuelOpen(false); applyFuelDays(saved); }}
      />

      {/* The calm wait, then the meal full screen. Declared BEFORE the line
          editor, save and day sheets: portal order is paint order, so those
          open on top of the result. */}
      <MealWaitSheet
        open={waitOpen && parseInFlight}
        words={parseInFlight ? flow.raw : ''}
        statusLabel={flow.status === 'analysing' ? flow.statusLabel ?? null : null}
        rows={flow.status === 'streaming' ? flow.rows : null}
        autoLogging={parseInFlight && !!flow.auto}
        onClose={closeWait}
        onCancel={onDismiss}
      />
      <MealResultScreen
        open={resultOpen && !!shownReview}
        meal={shownReview?.meal ?? null}
        mealType={shownReview?.mealType ?? 'snack'}
        words={shownReview ? shownReview.words ?? shownReview.raw : ''}
        tier={shownReview?.tier ?? null}
        dayLabel={dayLabel(shownReview?.dayIso ? dateFromYmd(shownReview.dayIso) : viewDate)}
        notice={flow.status === 'review' ? flow.notice ?? null : null}
        proposalLabel={flow.status === 'review' ? flow.proposal?.note ?? null : null}
        saved={savedReview}
        adding={adding}
        checkingIndex={flow.status === 'review' ? checkingIndex : null}
        updating={parseInFlight
          ? flow.status === 'analysing' && flow.statusLabel ? `${flow.statusLabel}...` : 'Updating your meal...'
          : null}
        onClose={closeResult}
        onDiscard={onDismiss}
        onAdd={() => { void onAdd(); }}
        onMealTypeChange={onMealTypeChange}
        onMoveGroup={onMoveGroup}
        onPickDay={() => setResultDayOpen(true)}
        onEditItem={onEditItem}
        onRemoveItem={onRemoveItem}
        onSwapItem={onSwapItem}
        onCheckItem={(i) => { void onCheckItem(i); }}
        onStepAmount={onStepAmount}
        onAcceptProposal={acceptProposal}
        onDismissNotice={dismissNotice}
        onSave={() => { if (flow.status === 'review') setSaveItems(flow.meal.items); }}
        onCorrect={(t) => { void runParse(t); }}
        onEditWords={editWordsBlocked ? undefined : editWords}
        tip={tourStep === 'review' ? (
          <FoodBoxTourTip
            title={TOUR_COPY.review.title}
            body={TOUR_COPY.review.body}
            actionLabel="Skip"
            onAction={() => endTour('skipped')}
            caret={false}
          />
        ) : undefined}
      />

      {/* Correct a parsed line (serving / quantity / macros) before adding it. */}
      <ParsedItemEditor
        item={flow.status === 'review' && editIndex !== null ? flow.meal.items[editIndex] ?? null : null}
        onCancel={() => setEditIndex(null)}
        onSave={onEditSave}
      />

      {/* Save the current parse as a reusable meal. */}
      <SaveMealSheet
        open={!!saveItems}
        items={saveItems ?? []}
        onClose={() => setSaveItems(null)}
        onSaved={() => { setSaveItems(null); setSavedReview(true); }}
      />

      {/* Browse saved meals and log one in a tap. */}
      <SavedMealsSheet
        open={savedListOpen}
        defaultMeal={nowMeal}
        mealLabel={nowMealLabel}
        onClose={() => setSavedListOpen(false)}
        onLogged={reload}
      />

      {/* Copy one meal from the day before into the day on screen. */}
      <CopyMealSheet
        open={copyMeal != null}
        title={copyMeal ? `${prevLabel}'s ${MEALS.find((x) => x.type === copyMeal)?.label.toLowerCase()}` : ''}
        subtitle={copyMeal ? `Copies into ${isToday ? "today's" : `${dayLabel(viewDate)}'s`} ${MEALS.find((x) => x.type === copyMeal)?.label.toLowerCase()}` : ''}
        lines={copyMeal ? prevLines[copyMeal] : NO_LINES}
        current={copyMeal ? byMeal[copyMeal] : NO_LINES}
        busy={relogBusy != null}
        onClose={() => setCopyMeal(null)}
        onCopy={(lines) => { void onCopyLines(lines); }}
      />

      {/* Jump the diary to any past day, or ahead to plan one. */}
      <ParseSpeedSheet
        open={speedSheetOpen}
        value={parseSpeed}
        autoLog={autoLog}
        canUsePrecise={canUsePrecise}
        onClose={() => setSpeedSheetOpen(false)}
        onPick={pickParseSpeed}
        onAutoLogChange={pickAutoLog}
        onUpgrade={() => router.push({ pathname: '/upgrade', params: { context: 'pro_feature' } })}
      />
      <DayPickerSheet
        open={calendarOpen}
        date={viewDate}
        onClose={() => setCalendarOpen(false)}
        onPick={setViewDate}
      />
      {/* The result screen's day: where this one meal goes, not the diary. */}
      <DayPickerSheet
        open={resultDayOpen}
        date={shownReview?.dayIso ? dateFromYmd(shownReview.dayIso) : viewDate}
        onClose={() => setResultDayOpen(false)}
        onPick={(d) => setFlow((f) => (f.status === 'review' ? { ...f, dayIso: ymd(d) } : f))}
      />
    </View>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, height: 44 },
    back: { width: 32, height: 32, justifyContent: 'center', marginLeft: -8 },
    headerBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    dayNavWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
    dayNav: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    dayArrow: { width: 28, height: 32, alignItems: 'center', justifyContent: 'center' },
    dayLabelBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 2, minWidth: 92, justifyContent: 'center' },
    title: { fontSize: FontSize.xl, fontWeight: FontWeight.black, letterSpacing: LetterSpacing.tight, color: C.foreground },
    streak: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 'auto' },
    streakTxt: { fontSize: FontSize.sm, color: C.textSecondary, fontVariant: ['tabular-nums'], fontWeight: FontWeight.semibold },

    weekList: { marginTop: Spacing.xs, flexGrow: 0 },
    weekStrip: { flexDirection: 'row', paddingHorizontal: Spacing.xl, gap: 4 },
    weekDay: { flex: 1, alignItems: 'center', gap: 5, paddingVertical: 4 },
    weekDayName: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, color: C.textMuted, letterSpacing: LetterSpacing.eyebrow },
    weekDayRing: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
    // overflow:'hidden' is load-bearing on Android: without it the selected day's
    // background paints as a square even though borderRadius is set. iOS rounds
    // it either way. Verified on a Pixel emulator.
    weekDayNum: { width: 26, height: 26, borderRadius: 13, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    weekDayNumSelected: { backgroundColor: C.foreground },
    weekDayNumTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: C.textSecondary, fontVariant: ['tabular-nums'] },
    weekDayNumTxtSelected: { color: C.background, fontWeight: FontWeight.bold },

    summary: { marginHorizontal: Spacing.xl, marginTop: Spacing.sm, backgroundColor: C.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: C.borderSubtle, padding: Spacing.lg, ...Shadow.card },
    goalBtn: { position: 'absolute', top: Spacing.sm, right: Spacing.sm, zIndex: 2, flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 6 },
    goalBtnTxt: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase' },
    summaryRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xxxl, marginTop: 0, paddingVertical: Spacing.xs },
    macroRailSide: { flex: 1, gap: Spacing.md },
    kcalLine: { fontSize: FontSize.xs, color: C.textMuted, fontVariant: ['tabular-nums'], marginBottom: 2 },
    fuelTag: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: -Spacing.sm + 2, alignSelf: 'flex-start' },
    fuelTagTxt: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },

    drona: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: Spacing.xl, marginTop: Spacing.md },
    avatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.primarySubtle, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    dronaTxt: { flex: 1, fontSize: FontSize.sm, lineHeight: 18, color: C.textSecondary },

    section: { marginTop: Spacing.xl, paddingHorizontal: Spacing.xl },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.xs },
    sectionLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase', color: C.textDim },
    sectionSub: { fontSize: 11, color: C.textMuted, fontVariant: ['tabular-nums'] },

    // The card and its Drona chip share a wrapper so the chip's Undo can be a
    // SIBLING of the row's Pressable rather than nested inside it. marginTop
    // moves here; the entry itself no longer sets it, or every row would gain
    // a second gap.
    // The hairline sits on the wrapper so a row's Drona chip stays inside it.
    entryWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, paddingBottom: Spacing.xs },
    // The swipe box bleeds a little past the column so the pressed wash has
    // room around the text. On the box, not the row, or the box would clip it.
    entrySwipe: { marginHorizontal: -Spacing.sm, borderRadius: Radius.sm },
    entry: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.md, paddingHorizontal: Spacing.sm, borderRadius: Radius.sm },
    // Still saving: the whole row, chevron included, so nothing moves when it lands.
    entryPending: { opacity: 0.5 },
    raw: { fontSize: 10, color: C.textDim, marginBottom: 1 },
    entryName: { fontSize: FontSize.base, fontWeight: FontWeight.medium, color: C.foreground },
    serving: { fontSize: FontSize.sm, color: C.textMuted, fontWeight: FontWeight.regular },
    macros: { flexDirection: 'row', gap: Spacing.md, marginTop: 6 },
    macroNum: { fontSize: 11, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
    analysing: { flexDirection: 'row', alignItems: 'center' },
    analysingTxt: { fontSize: FontSize.sm, color: C.textSecondary },

    add: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: Spacing.sm, paddingLeft: 2 },
    copyBtn: { marginLeft: Spacing.sm, padding: 2 },
    // Grey, not lime: four of these per day would spend the accent the food
    // box needs. textSecondary, not textMuted: muted misses 4.5:1 on light.
    addTxt: { fontSize: FontSize.sm, color: C.textSecondary, fontWeight: FontWeight.medium },

    // "Just log it". The chip is a receipt line under the row, muted except for
    // the Undo it exists to offer; the miss line sits where Drona's own line
    // does, in the same register, with its two actions on the right.
    dronaChip: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
    dronaChipTxt: { fontSize: FontSize.xs, color: C.textMuted },
    dronaChipUndo: { fontSize: FontSize.xs, color: C.accentText, fontWeight: FontWeight.semibold },
    lost: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: Spacing.xl, marginTop: Spacing.sm },
    lostTxt: { flex: 1, fontSize: FontSize.sm, lineHeight: 18, color: C.textSecondary },
    lostAction: { fontSize: FontSize.sm, lineHeight: 18, color: C.accentText, fontWeight: FontWeight.semibold },

    // A parse running with its sheet closed: one line, the card's look.
    waitStrip: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
      backgroundColor: C.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: C.borderSubtle,
      paddingVertical: 10, paddingHorizontal: Spacing.md, ...Shadow.card,
    },
    waitStripMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
    waitStripTxt: { flex: 1, fontSize: FontSize.sm, color: C.foreground, fontWeight: FontWeight.medium },
    inputWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, backgroundColor: C.background },
    // alignItems flex-end keeps the search + send icons on the bottom line as the field grows.
    // Radius.xxl, not lg: a 16px corner on a 48pt full-width bar reads as a wide
    // flat box; a near-pill reads as a composer. Fixed radius, so the corners
    // stay sane when the multiline field grows the bar.
    // The one lime-edged surface on the screen, so it is the first place the
    // eye lands. The edge carries that, not the fill: inputBg is lighter than
    // the card on dark but a grey field on light.
    input: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.primaryBorder, borderRadius: Radius.xxl, paddingHorizontal: Spacing.lg, paddingVertical: 12, ...Shadow.card },
    // maxHeight caps growth (~4 lines) then scrolls; textAlignVertical top for Android multiline.
    // The row bottom-aligns (icons must hug the bottom as the field grows), so
    // at REST the centres drift: the 28pt send circle's centre sits higher than
    // a bare 16px icon's or the text line's. Every icon gets the same 28pt
    // centred box the send button has, and the text line is lifted to match.
    inputText: { flex: 1, fontSize: FontSize.base, lineHeight: 20, color: C.foreground, padding: 0, marginBottom: 4, maxHeight: 96, textAlignVertical: 'top' },
    iconBox: { height: 28, justifyContent: 'center', alignItems: 'center' },
    send: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.accentText, alignItems: 'center', justifyContent: 'center' },
  });
}

