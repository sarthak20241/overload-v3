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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, TextInput, StyleSheet, useWindowDimensions, AppState,
  type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import {
  Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow,
} from '@/constants/theme';
import { MacroRing } from '@/components/ui/MacroRing';
import { MacroBar } from '@/components/diet/MacroBar';
import { ParsedMealCard, type ParseCardState } from '@/components/diet/ParsedMealCard';
import { ParsedItemEditor } from '@/components/diet/ParsedItemEditor';
import { EntryEditSheet } from '@/components/diet/EntryEditSheet';
import { NutritionGoalSheet } from '@/components/diet/NutritionGoalSheet';
import { SaveMealSheet } from '@/components/diet/SaveMealSheet';
import { SavedMealsSheet } from '@/components/diet/SavedMealsSheet';
import { DayPickerSheet } from '@/components/diet/DayPickerSheet';
import Svg, { Circle } from 'react-native-svg';
import { ParseSpeedSheet } from '@/components/diet/ParseSpeedSheet';
import { getParseSpeed, setParseSpeed, type ParseSpeed } from '@/lib/parseSpeed';
import {
  useDayNutrition, useNutritionTargets, useNutritionStreak, setLogMeal, setLogDate, ymd,
  parseMeal, parseMealStreaming, logParsedMeal, undoParsedMeal, sectionsOf, capNotice, capUpgradeContext,
  loadNutritionRange, dateFromYmd,
  type ParsedMeal, type LoggedEntry, type ParsedMealItem, type StreamedItem, type LoggedParseRef,
} from '@/lib/dietData';
import {
  getAutoLog, setAutoLog, newAutoLogClientId, addPending, removePending, touchPending,
  reconcilePending, markAddedByDrona, addedByDronaRef, forgetAddedByDrona,
  type PendingAutoLog,
} from '@/lib/autoLog';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import type { MealType } from '@/lib/foods';
import { formatServing } from '@/lib/foods';
import { DronaMark } from '@/components/coach/DronaMark';

/** The AI-logging flow state driving the bar + the ParsedMealCard above it.
 *  'review' holds a parsed-but-UNLOGGED meal: nothing is written until the user
 *  picks a section and taps Add. mealType is the currently-selected section. */
type ParseFlow =
  | { status: 'idle' }
  // `auto`: this parse was sent in "Just log it" mode, so the card says
  // "adding" rather than "reading" while it waits.
  | { status: 'analysing'; raw: string; auto?: boolean }
  // Fast mode only: the names are known and the numbers are still settling, so
  // the card shows real rows with shimmering figures instead of a spinner.
  // Named rows arrive ~1.2s ahead of the finished parse; this is that window.
  | { status: 'streaming'; raw: string; rows: StreamedItem[]; auto?: boolean }
  // "Just log it": the server wrote the diary. The card is the receipt + Undo;
  // `ref` is what Undo deletes, `clientId` the send it belongs to.
  | { status: 'logged'; raw: string; meal: ParsedMeal; ref: LoggedParseRef; clientId: string }
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
      notice?: string | null;
      // Researched numbers that disagree with what is shown, offered as a
      // choice. Applying is local, so picking costs no round trip.
      proposal?: { items: ParsedMealItem[]; note: string } | null;
    }
  | { status: 'declined'; raw: string; message: string }
  // On an add (write) failure we keep the reviewed meal so Retry re-attempts the
  // WRITE, not the whole AI parse (which would burn an API call + could differ).
  // `clientId`/`logDate`: a "Just log it" send that failed in transport. Retry
  // re-uses the SAME id, so if the request did reach the server (which then
  // finished without us) the retry is a no-op there instead of a double log.
  | {
      status: 'error'; raw: string; message: string; meal?: ParsedMeal; mealType?: MealType;
      clientId?: string; logDate?: string;
    };

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

/** Open the full-screen food search targeting a meal (MFP model, not a drawer).
 *  The target meal goes through setLogMeal (a module store the screens read on
 *  focus) because food-search is a retained Tabs screen and router params went
 *  stale across re-opens — which made every log land in breakfast. */
function openSearch(meal: MealType) {
  setLogMeal(meal);
  router.push({ pathname: '/food-search', params: { meal } });
}

interface MealDef { type: MealType; label: string; icon: keyof typeof Feather.glyphMap }

const MEALS: MealDef[] = [
  { type: 'breakfast', label: 'Breakfast', icon: 'sunrise' },
  { type: 'lunch', label: 'Lunch', icon: 'sun' },
  { type: 'dinner', label: 'Dinner', icon: 'sunset' },
  { type: 'snack', label: 'Snacks', icon: 'coffee' },
];

const round = (n: number) => Math.round(n);

export default function NutritionScreen() {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  // Which calendar day the diary is showing. Defaults to today; ‹ › + the calendar
  // move it. Logging/editing on a past day writes to that day (see the sync below).
  const [viewDate, setViewDate] = useState<Date>(() => new Date());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const viewIso = ymd(viewDate);
  const todayIso = ymd(new Date());
  const isToday = viewIso === todayIso;
  // The strip shows the Sunday-start calendar week containing viewDate, so the
  // columns (S M T W T F S) never shuffle — only the highlight moves. Jumping
  // to another week via the calendar swaps the whole row in place.
  const weekStart = new Date(viewDate.getFullYear(), viewDate.getMonth(), viewDate.getDate() - viewDate.getDay());
  const weekStartIso = ymd(weekStart);
  const weekDays = Array.from({ length: 7 }, (_, i) =>
    new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i));
  const { byMeal, totals, totalsDayIso, reload } = useDayNutrition(viewIso);
  const supabase = useSupabaseClient();
  const { isSignedIn } = useClerkUser();
  const { kbHeight } = useKeyboardAwareScroll();
  const { height: winH } = useWindowDimensions();
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
  // Cap the parse card so a long meal never runs past the top of the screen
  // (the card is pinned above the input, outside the day scroll — the lines
  // scroll INSIDE it instead). 96 ≈ the input bar plus its gap.
  //
  // `hardAvail` is the whole gap between the safe area and the input bar. It is
  // the ceiling in both states, so the card's own header — and the minimize
  // control in it — is always on screen.
  const hardAvail = winH - kbHeight - insets.top - 96;

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
    turnsRef.current = [...turnsRef.current, { role, text }].slice(-6);
  }, []);
  const [adding, setAdding] = useState(false);
  const [editEntry, setEditEntry] = useState<LoggedEntry | null>(null);
  const { targets, isCustom, apply: applyTargets } = useNutritionTargets();
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
  // Parse tier (Quick default / Thorough opt-in). A ref mirrors the state so
  // onSend reads the CURRENT choice, matching the flowRef idiom above.
  const [parseSpeed, setParseSpeedState] = useState<ParseSpeed>('quick');
  const parseSpeedRef = useRef<ParseSpeed>('quick');
  const [speedSheetOpen, setSpeedSheetOpen] = useState(false);
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
    autoLogRef.current = v;
    setAutoLogState(v);
    void setAutoLog(v);
  };
  const [undoing, setUndoing] = useState(false);
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
  const [savedListOpen, setSavedListOpen] = useState(false);
  const nowMeal = mealForNow();
  const nowMealLabel = MEALS.find((m) => m.type === nowMeal)?.label ?? 'this meal';

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
      const rows = await loadNutritionRange(supabase, dateFromYmd(weekStartIso), 7);
      if (!alive) return;
      const map: Record<string, number> = {};
      for (const r of rows) map[r.dayIso] = r.kcal;
      setWeekKcal(() => {
        const p = livePatch.current;
        return p ? { ...map, [p.day]: p.kcal } : map;
      });
    })();
    return () => { alive = false; };
  }, [supabase, weekStartIso]);
  // Keyed on totalsDayIso, NOT viewIso: on a day switch viewIso updates a render
  // before the refetch lands, so keying on viewIso would stamp the previous
  // day's kcal onto the newly selected day's ring until the fetch resolved.
  useEffect(() => {
    livePatch.current = { day: totalsDayIso, kcal: totals.kcal };
    setWeekKcal((prev) => (
      prev[totalsDayIso] === totals.kcal ? prev : { ...prev, [totalsDayIso]: totals.kcal }
    ));
  }, [totalsDayIso, totals.kcal]);

  // Step the diary a day back/forward; never past today.
  const stepDay = useCallback((delta: number) => {
    setViewDate((d) => {
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
      return ymd(next) > ymd(new Date()) ? d : next;
    });
  }, []);

  /** `retry`: re-send a "Just log it" send with its ORIGINAL id and day (from
   *  the error card or a "Drona didn't get" line). Forces auto mode even if the
   *  toggle has since been flipped: the user is retrying that send, not making
   *  a new choice. */
  const runParse = useCallback(async (raw: string, retry?: { clientId: string; logDate: string }) => {
    const t = raw.trim();
    if (!t || !supabase) return;
    setSavedReview(false);
    setCardMinimized(false);
    // A meal still under review is context for the next line: "make it a small
    // one" should correct THAT samosa, not log a second one. Captured before we
    // switch to 'analysing' (which drops the reviewed meal from flow).
    const prevReview = flowRef.current.status === 'review' ? flowRef.current : null;
    const pending = prevReview ? { text: prevReview.raw, items: prevReview.meal.items } : null;
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
    const auto = !pending && (retry || autoLogRef.current)
      ? retry ?? { clientId: newAutoLogClientId(), logDate: ymd(viewDate) }
      : null;
    if (auto) {
      // Pending BEFORE the request leaves: if the app dies mid-stream, the next
      // open still knows to look for this send in the diary.
      if (retry) await touchPending(auto.clientId);
      else await addPending({ client_id: auto.clientId, text: t, sent_at: Date.now(), log_date: auto.logDate });
      setLostSends((l) => l.filter((x) => x.client_id !== auto.clientId));
    }
    setFlow({ status: 'analysing', raw: t, auto: !!auto });
    const turns = turnsRef.current.slice();
    pushTurn('user', t);
    const args = { text: t, mealHint: mealForNow(), previous: pending, turns, autoLog: auto };
    // Streaming is only worth it on a first-shot log: a correction needs the
    // full pipeline anyway, and parseMealStreaming falls back on its own, but
    // not opening the stream saves the wasted round trip. A user on Thorough
    // takes that same full-pipeline road - parseMeal sends no speed field,
    // which the server reads as smart.
    const res = pending || parseSpeedRef.current === 'thorough'
      ? await parseMeal(supabase, args)
      : await parseMealStreaming(supabase, args, (rows) => {
        // A stream that resolves after the user has moved on must not repaint
        // the card they are now looking at.
        if (parseTokenRef.current !== token) return;
        setFlow((cur) => (
          cur.status === 'analysing' && cur.raw === t ? { status: 'streaming', raw: t, rows, auto: cur.auto } : cur
        ));
      }, ac.signal);
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
      setFlow({ status: 'declined', raw: t, message: res.message });
      return;
    }
    // The free tier's daily logs ran out. This is a paywall, not a breakage:
    // routing it through the error path told users "Something broke on my end"
    // and hid the upgrade entirely. Say what actually happened, keep their text
    // so nothing is lost, and open the same paywall the coach chat opens.
    if (res.kind === 'cap') {
      const capLine = capNotice(res);
      pushTurn('drona', capLine);
      if (prevReview) setFlow({ ...prevReview, notice: capLine, proposal: null });
      else setFlow({ status: 'declined', raw: t, message: capLine });
      router.push({ pathname: '/upgrade', params: { context: capUpgradeContext(res) } });
      return;
    }
    if (res.kind === 'error') {
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
    pushTurn('drona', res.meal.drona_line);
    // "Just log it": the server already wrote these lines. Straight to the
    // receipt; the diary refresh paints the rows with their chip.
    if (auto && res.logged) {
      markAddedByDrona(res.logged);
      reload();
      setFlow({ status: 'logged', raw: t, meal: res.meal, ref: res.logged, clientId: auto.clientId });
      return;
    }
    // Asked to log, and the server sent it back for review instead. Say why
    // on the card; the meal itself is fine to Add by hand.
    const skippedNotice = auto && res.autoLogSkipped === 'implausible'
      ? 'One of these numbers looked off to Drona, so he left it for you to check before it goes in.'
      : auto && res.autoLogSkipped === 'write_error'
      ? 'Drona could not write that to your diary. Check it and tap Add.'
      : null;
    // The user's own section pick outranks a guess made from the follow-up
    // text alone; without a pick we take the server's.
    const keptMealType = prevReview?.mealTypePicked ? prevReview.mealType : null;
    // Parsed, not logged. Seed the section selector with Drona's best guess.
    // A follow-up either CORRECTS the pending meal (replace its lines) or ADDS
    // to it (append) — appending is what keeps "and a dosa" from silently
    // dropping the samosa the user already reviewed.
    const reviewFlow: ParseFlow = (pending && !res.meal.corrects_previous)
      ? {
          status: 'review',
          raw: `${pending.text}; ${t}`,
          meal: { ...res.meal, items: [...pending.items, ...res.meal.items] },
          mealType: keptMealType ?? res.meal.meal_type,
          mealTypePicked: prevReview?.mealTypePicked,
        }
      : {
          status: 'review',
          raw: t,
          meal: res.meal,
          mealType: keptMealType ?? res.meal.meal_type,
          mealTypePicked: prevReview?.mealTypePicked,
        };
    setFlow(skippedNotice ? { ...reviewFlow, notice: skippedNotice } : reviewFlow);
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
        text: `yes, look up the label for ${
          item.food_name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80)
        } online and check these numbers`,
        mealHint: f.mealType,
        previous: { text: f.raw, items: f.meal.items },
        turns: turnsRef.current.slice(),
      });
      // The daily allowance covers this lookup too, so a cap here has to say so
      // and open the paywall. Handled BEFORE setFlow: routing is a side effect
      // and a state updater may be replayed or discarded, so it cannot live in
      // one. Falling through to the updater's `return cur` was silent — the
      // spinner just cleared and the tap looked like it did nothing.
      if (res.kind === 'cap') {
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
          const found = res.meal.items.find((r) => key(r) === originalKey)
            ?? res.meal.items.find(
              (r) => r.food_name.toLowerCase() === item.food_name.toLowerCase(),
            )
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
  const onRemoveItem = useCallback((i: number) => {
    setFlow((f): ParseFlow => {
      if (f.status !== 'review') return f;
      const items = f.meal.items.filter((_, idx) => idx !== i);
      if (items.length === 0) return { status: 'idle' };
      return { ...f, meal: { ...f.meal, items } };
    });
  }, []);
  const onEditSave = useCallback((patch: ParsedMealItem) => {
    setFlow((f) => {
      if (f.status !== 'review' || editIndex === null) return f;
      const items = f.meal.items.map((it, i) => (i === editIndex ? patch : it));
      return { ...f, meal: { ...f.meal, items } };
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
    if (!isSignedIn) { openSearch(mealForNow()); return; }
    setText('');
    void runParse(t);
  }, [text, isSignedIn, flow.status, runParse]);

  const onMealTypeChange = useCallback((m: MealType) => {
    setFlow((f) => (f.status === 'review' ? { ...f, mealType: m, mealTypePicked: true } : f));
  }, []);

  /** Multi-section card: move every line of one group to another section. */
  const onMoveGroup = useCallback((from: MealType, to: MealType) => {
    setFlow((f) => {
      if (f.status !== 'review' || from === to) return f;
      const items = f.meal.items.map((it) => (it.meal_type === from ? { ...it, meal_type: to } : it));
      // Keep the meal-level field honest: it is the first line's section.
      return { ...f, meal: { ...f.meal, items, meal_type: items[0]?.meal_type ?? f.meal.meal_type } };
    });
  }, []);

  const onAdd = useCallback(async () => {
    if (flow.status !== 'review' || !supabase || adding) return;
    setAdding(true);
    // Single-section card: the chip row moves EVERY line to the picked
    // section, exactly as before. Multi-section card (a message that named
    // several meals): there is no chip row, each line goes where the user
    // saw it grouped, and the group headers are how they re-home a group.
    const multi = sectionsOf(flow.meal).length > 1;
    const items = multi
      ? flow.meal.items
      : flow.meal.items.map((it) => ({ ...it, meal_type: flow.mealType }));
    const { error } = await logParsedMeal(supabase, { ...flow.meal, meal_type: flow.mealType, items }, viewDate);
    setAdding(false);
    if (error) {
      // Keep the reviewed meal so Retry re-attempts the write (see onRetry).
      setFlow({ status: 'error', raw: flow.raw, message: 'Could not add that. Try again.', meal: flow.meal, mealType: flow.mealType });
      return;
    }
    reload();
    // Reset here too: Undo puts the card back in review, and it should come
    // back open rather than as a summary line the user has to expand.
    setCardMinimized(false);
    setFlow({ status: 'idle' });
  }, [flow, supabase, adding, reload, viewDate]);

  const onRetry = useCallback(() => {
    if (flow.status !== 'error') return;
    // A write failure kept the meal → re-show the review card (tapping Add re-writes
    // it, to the current day). Only re-run the AI parse if the meal is gone.
    if (flow.meal && flow.mealType) {
      setFlow({ status: 'review', raw: flow.raw, meal: flow.meal, mealType: flow.mealType });
    } else {
      // A failed "Just log it" send retries under its ORIGINAL id (see ParseFlow).
      void runParse(
        flow.raw,
        flow.clientId && flow.logDate ? { clientId: flow.clientId, logDate: flow.logDate } : undefined,
      );
    }
  }, [flow, runParse]);

  const onDismiss = useCallback(() => {
    setChecking(null);
    setCardMinimized(false);
    // Discard is reachable mid-parse. Bumping the token orphans whatever is in
    // flight so it cannot resurrect the card the user just threw away, and the
    // abort stops that work rather than merely ignoring its answer.
    parseTokenRef.current += 1;
    parseAbortRef.current?.abort();
    setFlow({ status: 'idle' });
  }, []);

  /** Undo on the receipt strip: delete every row the send wrote, then put the
   *  meal back on the review card. The user undid the WRITE, not the parse, so
   *  the lines stay on screen to fix or Add by hand rather than vanishing. */
  const onUndo = useCallback(async () => {
    if (flow.status !== 'logged' || !supabase || undoing) return;
    setUndoing(true);
    await undoParsedMeal(supabase, flow.ref);
    forgetAddedByDrona(flow.ref);
    setUndoing(false);
    reload();
    setCardMinimized(false);
    setFlow({ status: 'review', raw: flow.raw, meal: flow.meal, mealType: flow.meal.meal_type });
  }, [flow, supabase, undoing, reload]);

  /** Undo from a diary row's "Added by Drona" chip: the whole send that row
   *  came from, which is the action being undone. Removing one line is what
   *  tapping the row already does. */
  const onUndoRow = useCallback(async (ref: LoggedParseRef) => {
    if (!supabase) return;
    await undoParsedMeal(supabase, ref);
    forgetAddedByDrona(ref);
    reload();
  }, [supabase, reload]);

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
  const dronaLine = surplus > 0
    ? `You're ${fmtK(surplus)} over today. Ease up at dinner and the week still balances.`
    : "Good start. Get one more protein hit in at lunch and you're on pace.";

  const s = makeStyles(C);

  return (
    <View style={[s.root, { backgroundColor: C.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + Spacing.sm, paddingBottom: 150 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onScroll={onDayScroll}
        scrollEventThrottle={16}
      >
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
              <Pressable onPress={() => stepDay(1)} disabled={isToday} hitSlop={8} style={[s.dayArrow, { opacity: isToday ? 0.3 : 1 }]} accessibilityLabel="Next day">
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

        {/* Week strip — the calendar week around the viewed day; tap a bubble to
            jump straight there. Each day wears a thin ring showing how much of
            the calorie goal was eaten that day. Future days are dimmed/locked. */}
        <View style={s.weekStrip}>
          {weekDays.map((d) => {
            const iso = ymd(d);
            const selected = iso === viewIso;
            const future = iso > todayIso;
            const pct = Math.min((weekKcal[iso] ?? 0) / (targets.kcal || 1), 1);
            const R = 16, CIRC = 2 * Math.PI * R;
            return (
              <Pressable
                key={iso}
                onPress={() => setViewDate(d)}
                disabled={future}
                style={[s.weekDay, future && { opacity: 0.35 }]}
                accessibilityLabel={`Go to ${dayLabel(d)}`}
              >
                <Text style={[s.weekDayName, selected && { color: C.foreground }]}>
                  {d.toLocaleDateString(undefined, { weekday: 'narrow' })}
                </Text>
                <View style={s.weekDayRing}>
                  <Svg width={36} height={36} style={StyleSheet.absoluteFill}>
                    <Circle cx={18} cy={18} r={R} stroke={C.borderSubtle} strokeWidth={2} fill="none" />
                    {!future && pct > 0 && (
                      <Circle
                        cx={18} cy={18} r={R}
                        stroke={C.macro.calories} strokeWidth={2} fill="none"
                        strokeLinecap="round"
                        strokeDasharray={`${pct * CIRC} ${CIRC}`}
                        transform="rotate(-90 18 18)"
                      />
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
          <View style={s.summaryRow}>
            <MacroRing
              value={eaten.kcal} target={targets.kcal} color={C.macro.calories} valueColor={C.macro.calories}
              display="remaining" overshoot name="Calories" size={116} thickness={11} centerFontSize={26}
            />
            <View style={s.macroRailSide}>
              <Text style={s.kcalLine}>{calCaption(eaten.kcal, targets.kcal)}</Text>
              <MacroBar label="P" name="Protein" value={eaten.protein} target={targets.protein} color={C.macro.protein} delayMs={0} valueMinWidth={52} />
              <MacroBar label="C" name="Carbs" value={eaten.carb} target={targets.carb} color={C.macro.carbs} delayMs={70} valueMinWidth={52} />
              <MacroBar label="F" name="Fat" value={eaten.fat} target={targets.fat} color={C.macro.fat} delayMs={140} valueMinWidth={52} />
            </View>
          </View>
        </View>

        {/* Drona line */}
        <View style={s.drona}>
          <View style={s.avatar}><DronaMark size={11} color={C.accentText} state="static" /></View>
          <Text style={s.dronaTxt}>{dronaLine}</Text>
        </View>

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
          const entries = byMeal[m.type];
          const sub = entries.reduce((a, e) => ({ kcal: a.kcal + e.kcal, protein: a.protein + e.protein_g }), { kcal: 0, protein: 0 });
          return (
            <View key={m.type} style={s.section}>
              <View style={s.sectionHead}>
                <Feather name={m.icon} size={13} color={C.textDim} />
                <Text style={s.sectionLabel}>{m.label}</Text>
                <View style={{ flex: 1 }} />
                {entries.length > 0 && (
                  <Text style={s.sectionSub}>{round(sub.protein)}g P · {round(sub.kcal)}</Text>
                )}
              </View>

              {entries.map((e) => {
                // A row Drona added in "Just log it" this launch wears a quiet
                // chip with Undo, so a meal logged while the app was closed is
                // still one tap from gone. Cleared by the next app launch.
                const dronaRef = addedByDronaRef(e.id);
                return (
                  <Pressable key={e.id} style={s.entry} onPress={() => setEditEntry(e)}>
                    <Text style={s.entryName}>
                      {e.food_name} <Text style={s.serving}>· {formatServing(e.quantity, e.serving_unit)}</Text>
                    </Text>
                    <View style={s.macros}>
                      <Text style={[s.macroNum, { color: C.foreground }]}>{round(e.kcal)} cal</Text>
                      <Text style={[s.macroNum, { color: C.macro.protein }]}>{round(e.protein_g)}g P</Text>
                      <Text style={[s.macroNum, { color: C.macro.carbs }]}>{round(e.carb_g)}g C</Text>
                      <Text style={[s.macroNum, { color: C.macro.fat }]}>{round(e.fat_g)}g F</Text>
                    </View>
                    {dronaRef && (
                      <View style={s.dronaChip}>
                        <DronaMark size={9} color={C.accentText} state="static" />
                        <Text style={s.dronaChipTxt}>Added by Drona</Text>
                        <Text style={s.dronaChipTxt}>·</Text>
                        <Pressable
                          onPress={(ev) => { ev.stopPropagation(); void onUndoRow(dronaRef); }}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel="Undo what Drona added"
                        >
                          <Text style={s.dronaChipUndo}>Undo</Text>
                        </Pressable>
                      </View>
                    )}
                  </Pressable>
                );
              })}

              <Pressable style={s.add} hitSlop={8} onPress={() => openSearch(m.type)}>
                <Feather name="plus" size={14} color={C.accentText} />
                <Text style={s.addTxt}>Add to {m.label.toLowerCase()}</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      {/* Bottom logging bar. Signed-in: type free text, Drona parses it and logs
          in place (ParsedMealCard is the receipt + Undo, pinned above). Guest:
          the bar opens the manual food picker. Lifts above the keyboard via
          kbHeight (absolute bar can't rely on window resize under edge-to-edge). */}
      <View style={[
        s.inputWrap,
        { bottom: kbHeight, paddingBottom: kbHeight > 0 ? Spacing.sm : insets.bottom + 12 },
      ]}>
        {flow.status !== 'idle' && (
          <View style={{ marginBottom: Spacing.sm }}>
            <ParsedMealCard
              state={flow.status as ParseCardState}
              rawText={flow.raw}
              maxHeight={cardMaxHeight}
              // Fast mode's settling window: real names, shimmering numbers.
              streamingRows={flow.status === 'streaming' ? flow.rows : null}
              meal={flow.status === 'review' || flow.status === 'logged' ? flow.meal : null}
              mealType={flow.status === 'review' ? flow.mealType : undefined}
              adding={adding}
              message={
                flow.status === 'declined' || flow.status === 'error' || flow.status === 'sent' ? flow.message : null
              }
              // "Just log it": the receipt strip's Undo, and the waiting copy.
              logged={flow.status === 'logged' ? flow.ref : null}
              onUndo={flow.status === 'logged' ? onUndo : undefined}
              undoing={undoing}
              autoLogging={(flow.status === 'analysing' || flow.status === 'streaming') && !!flow.auto}
              onMealTypeChange={onMealTypeChange}
              onMoveGroup={flow.status === 'review' ? onMoveGroup : undefined}
              notice={flow.status === 'review' ? flow.notice ?? null : null}
              proposalLabel={flow.status === 'review' ? flow.proposal?.note ?? null : null}
              onAcceptProposal={() => setFlow((f) => (
                f.status === 'review' && f.proposal
                  ? { ...f, meal: { ...f.meal, items: f.proposal.items }, notice: null, proposal: null }
                  : f
              ))}
              onDismissNotice={() => setFlow((f) => (f.status === 'review' ? { ...f, notice: null, proposal: null } : f))}
              // Frozen while a check is in flight: editing or removing a line
              // mid-lookup shifts indices and races the write below.
              onEditItem={flow.status === 'review' && checkingIndex === null ? onEditItem : undefined}
              checkingIndex={flow.status === 'review' ? checkingIndex : null}
              onCheckItem={flow.status === 'review' ? onCheckItem : undefined}
              onRemoveItem={flow.status === 'review' && checkingIndex === null ? onRemoveItem : undefined}
              saved={flow.status === 'review' && savedReview}
              onAdd={flow.status === 'review' ? onAdd : undefined}
              onSave={flow.status === 'review' ? () => setSaveItems(flow.meal.items) : undefined}
              onRetry={flow.status === 'error' ? onRetry : undefined}
              onDismiss={onDismiss}
              minimized={cardMinimized}
              onToggleMinimize={() => setCardMinimized((v) => !v)}
            />
          </View>
        )}

        {isSignedIn ? (
          <View style={s.input}>
            <Pressable onPress={() => openSearch(mealForNow())} hitSlop={8} style={s.iconBox}>
              <Feather name="search" size={16} color={C.textSecondary} />
            </Pressable>
            <TextInput
              style={s.inputText}
              value={text}
              onChangeText={setText}
              // "Just log it" changes what send DOES, and the placeholder is the
              // honest always-visible signal of that: send now commits.
              placeholder={autoLog ? 'Tell Drona what you ate, it goes straight in' : 'Tell Drona what you ate'}
              placeholderTextColor={C.textDim}
              returnKeyType="send"
              onSubmitEditing={onSend}
              blurOnSubmit={false}
              // Wrap + grow for long entries (e.g. several metrics at once)
              // instead of scrolling off one clipped line. Submit via the arrow.
              multiline
            />
            {/* Parse-tier chip: quiet in the default (Quick), lime when the user
                has opted into Thorough, so only the non-default state draws the
                eye. Tap opens the sheet; the choice is sticky. */}
            <Pressable
              onPress={() => setSpeedSheetOpen(true)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={parseSpeed === 'thorough' ? 'Logging mode: Thorough' : 'Logging mode: Quick'}
              style={s.iconBox}
            >
              <Feather
                name={parseSpeed === 'thorough' ? 'target' : 'zap'}
                size={14}
                color={parseSpeed === 'thorough' ? C.accentText : C.textSecondary}
              />
            </Pressable>
            <Pressable
              onPress={onSend}
              hitSlop={8}
              disabled={!text.trim() || parseInFlight}
              style={[s.send, { opacity: text.trim() && !parseInFlight ? 1 : 0.4 }]}
              accessibilityLabel={autoLog ? 'Log it' : 'Send to Drona'}
            >
              <Feather name={autoLog ? 'check' : 'arrow-up'} size={16} color={C.background} />
            </Pressable>
          </View>
        ) : (
          <Pressable style={s.input} onPress={() => openSearch(mealForNow())}>
            <Feather name="plus-circle" size={16} color={C.accentText} />
            <Text style={[s.inputText, { color: C.textDim }]}>Add what you ate</Text>
          </Pressable>
        )}
      </View>

      {/* Tap a logged entry to rescale it, move its section, or delete it. */}
      <EntryEditSheet
        entry={editEntry}
        onClose={() => setEditEntry(null)}
        onSaved={() => { setEditEntry(null); reload(); }}
      />

      {/* Set daily calorie + macro goals (the ring/bars draw against these). */}
      <NutritionGoalSheet
        open={goalOpen}
        initial={targets}
        onClose={() => setGoalOpen(false)}
        onSaved={(saved) => { setGoalOpen(false); applyTargets(saved); }}
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

      {/* Jump the diary to any past day. */}
      <ParseSpeedSheet
        open={speedSheetOpen}
        value={parseSpeed}
        autoLog={autoLog}
        onClose={() => setSpeedSheetOpen(false)}
        onPick={pickParseSpeed}
        onAutoLogChange={pickAutoLog}
      />
      <DayPickerSheet
        open={calendarOpen}
        date={viewDate}
        onClose={() => setCalendarOpen(false)}
        onPick={setViewDate}
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

    weekStrip: { flexDirection: 'row', paddingHorizontal: Spacing.xl, marginTop: Spacing.xs, gap: 4 },
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

    drona: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: Spacing.xl, marginTop: Spacing.md },
    avatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.primarySubtle, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    dronaTxt: { flex: 1, fontSize: FontSize.sm, lineHeight: 18, color: C.textSecondary },

    section: { marginTop: Spacing.xl, paddingHorizontal: Spacing.xl },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.xs },
    sectionLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase', color: C.textDim },
    sectionSub: { fontSize: 11, color: C.textMuted, fontVariant: ['tabular-nums'] },

    entry: { backgroundColor: C.card, borderRadius: Radius.md, borderWidth: 1, borderColor: C.borderSubtle, padding: Spacing.md, marginTop: Spacing.sm, ...Shadow.card },
    raw: { fontSize: 10, color: C.textDim, marginBottom: 1 },
    entryName: { fontSize: FontSize.base, fontWeight: FontWeight.medium, color: C.foreground },
    serving: { fontSize: FontSize.sm, color: C.textMuted, fontWeight: FontWeight.regular },
    macros: { flexDirection: 'row', gap: Spacing.md, marginTop: 6 },
    macroNum: { fontSize: 11, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
    analysing: { flexDirection: 'row', alignItems: 'center' },
    analysingTxt: { fontSize: FontSize.sm, color: C.textSecondary },

    add: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: Spacing.sm, paddingLeft: 2 },
    addTxt: { fontSize: FontSize.sm, color: C.accentText, fontWeight: FontWeight.medium },

    // "Just log it". The chip is a receipt line under the row, muted except for
    // the Undo it exists to offer; the miss line sits where Drona's own line
    // does, in the same register, with its two actions on the right.
    dronaChip: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
    dronaChipTxt: { fontSize: FontSize.xs, color: C.textMuted },
    dronaChipUndo: { fontSize: FontSize.xs, color: C.accentText, fontWeight: FontWeight.semibold },
    lost: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: Spacing.xl, marginTop: Spacing.sm },
    lostTxt: { flex: 1, fontSize: FontSize.sm, lineHeight: 18, color: C.textSecondary },
    lostAction: { fontSize: FontSize.sm, lineHeight: 18, color: C.accentText, fontWeight: FontWeight.semibold },

    inputWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, backgroundColor: C.background },
    // alignItems flex-end keeps the search + send icons on the bottom line as the field grows.
    // Radius.xxl, not lg: a 16px corner on a 48pt full-width bar reads as a wide
    // flat box; a near-pill reads as a composer. Fixed radius, so the corners
    // stay sane when the multiline field grows the bar.
    input: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: Radius.xxl, paddingHorizontal: Spacing.lg, paddingVertical: 10, ...Shadow.card },
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
