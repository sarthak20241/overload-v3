/**
 * Nutrition day view — the diet "diary" + journal in one screen.
 *
 * Structure = MyFitnessPal meal sections (Breakfast / Lunch / Dinner / Snacks),
 * each with its entries + subtotal, under a co-equal calories + protein summary
 * (MacroRing). Logging = the inline "Tell Drona what you ate" input at the bottom
 * (Journable model): you type/speak plain words, the entry resolves in place, and
 * tapping an entry shows Drona's read. Calm/mature system: Inter (system fallback
 * for now), tabular figures, Colors.macro register, lime reserved for the action.
 *
 * v1 renders with sample data so the layout is verifiable on-device; the Supabase
 * day-load + the NL parse (Drona edge fn) wire in next.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet } from 'react-native';
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
import {
  useDayNutrition, useNutritionTargets, useNutritionStreak, setLogMeal, setLogDate, ymd,
  parseMeal, logParsedMeal,
  type ParsedMeal, type LoggedEntry, type ParsedMealItem,
} from '@/lib/dietData';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import type { MealType } from '@/lib/foods';
import { DronaMark } from '@/components/coach/DronaMark';

/** The AI-logging flow state driving the bar + the ParsedMealCard above it.
 *  'review' holds a parsed-but-UNLOGGED meal: nothing is written until the user
 *  picks a section and taps Add. mealType is the currently-selected section. */
type ParseFlow =
  | { status: 'idle' }
  | { status: 'analysing'; raw: string }
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
  | { status: 'error'; raw: string; message: string; meal?: ParsedMeal; mealType?: MealType };

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
  const isToday = viewIso === ymd(new Date());
  const { byMeal, totals, reload } = useDayNutrition(viewIso);
  const supabase = useSupabaseClient();
  const { isSignedIn } = useClerkUser();
  const { kbHeight } = useKeyboardAwareScroll();

  // AI food logging (Drona parse). Signed-in only; guests keep the picker.
  // Parse -> review card (nothing logged yet) -> the user picks the section and
  // taps Add -> we write it. No auto-log, no auto-dismiss: the user is in control.
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

  // Step the diary a day back/forward; never past today.
  const stepDay = useCallback((delta: number) => {
    setViewDate((d) => {
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
      return ymd(next) > ymd(new Date()) ? d : next;
    });
  }, []);

  const runParse = useCallback(async (raw: string) => {
    const t = raw.trim();
    if (!t || !supabase) return;
    setSavedReview(false);
    // A meal still under review is context for the next line: "make it a small
    // one" should correct THAT samosa, not log a second one. Captured before we
    // switch to 'analysing' (which drops the reviewed meal from flow).
    const prevReview = flowRef.current.status === 'review' ? flowRef.current : null;
    const pending = prevReview ? { text: prevReview.raw, items: prevReview.meal.items } : null;
    setFlow({ status: 'analysing', raw: t });
    const turns = turnsRef.current.slice();
    pushTurn('user', t);
    const res = await parseMeal(supabase, {
      text: t, mealHint: mealForNow(), previous: pending, turns,
    });
    // A reply that is not a meal (an answer, or a failure) must NOT discard a
    // meal still under review — that is unlogged work the user would have to
    // retype. Keep the card and show the reply as a notice on it.
    if (res.kind === 'declined') {
      pushTurn('drona', res.message);
      if (prevReview) {
        setFlow({ ...prevReview, notice: res.message, proposal: res.proposal ?? null });
        return;
      }
      setFlow({ status: 'declined', raw: t, message: res.message });
      return;
    }
    if (res.kind === 'error') {
      // Clear any standing proposal: it answered the previous message, and
      // leaving it up would attach "use these numbers" to an error the user
      // just got for something else entirely.
      if (prevReview) { setFlow({ ...prevReview, notice: res.message, proposal: null }); return; }
      setFlow({ status: 'error', raw: t, message: res.message });
      return;
    }
    pushTurn('drona', res.meal.drona_line);
    // The user's own section pick outranks a guess made from the follow-up
    // text alone; without a pick we take the server's.
    const keptMealType = prevReview?.mealTypePicked ? prevReview.mealType : null;
    // Parsed, not logged. Seed the section selector with Drona's best guess.
    // A follow-up either CORRECTS the pending meal (replace its lines) or ADDS
    // to it (append) — appending is what keeps "and a dosa" from silently
    // dropping the samosa the user already reviewed.
    if (pending && !res.meal.corrects_previous) {
      setFlow({
        status: 'review',
        raw: `${pending.text}; ${t}`,
        meal: { ...res.meal, items: [...pending.items, ...res.meal.items] },
        mealType: keptMealType ?? res.meal.meal_type,
        mealTypePicked: prevReview?.mealTypePicked,
      });
      return;
    }
    setFlow({
      status: 'review',
      raw: t,
      meal: res.meal,
      mealType: keptMealType ?? res.meal.meal_type,
      mealTypePicked: prevReview?.mealTypePicked,
    });
  }, [supabase]);

  /** Index of the pending line being corrected (null = editor closed). Edits
   *  are pure client state: nothing is written until Add, so a correction just
   *  patches the reviewed meal in place. */
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const onEditItem = useCallback((i: number) => setEditIndex(i), []);
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
    if (flow.status === 'analysing') return; // a parse is already in flight
    // Guest fallback: no JWT means parse_meal would 401, so route to the
    // manual picker exactly as the old bar did.
    if (!isSignedIn) { openSearch(mealForNow()); return; }
    setText('');
    void runParse(t);
  }, [text, isSignedIn, flow.status, runParse]);

  const onMealTypeChange = useCallback((m: MealType) => {
    setFlow((f) => (f.status === 'review' ? { ...f, mealType: m, mealTypePicked: true } : f));
  }, []);

  const onAdd = useCallback(async () => {
    if (flow.status !== 'review' || !supabase || adding) return;
    setAdding(true);
    const { error } = await logParsedMeal(supabase, { ...flow.meal, meal_type: flow.mealType }, viewDate);
    setAdding(false);
    if (error) {
      // Keep the reviewed meal so Retry re-attempts the write (see onRetry).
      setFlow({ status: 'error', raw: flow.raw, message: 'Could not add that. Try again.', meal: flow.meal, mealType: flow.mealType });
      return;
    }
    reload();
    setFlow({ status: 'idle' });
  }, [flow, supabase, adding, reload, viewDate]);

  const onRetry = useCallback(() => {
    if (flow.status !== 'error') return;
    // A write failure kept the meal → re-show the review card (tapping Add re-writes
    // it, to the current day). Only re-run the AI parse if the meal is gone.
    if (flow.meal && flow.mealType) {
      setFlow({ status: 'review', raw: flow.raw, meal: flow.meal, mealType: flow.mealType });
    } else {
      void runParse(flow.raw);
    }
  }, [flow, runParse]);

  const onDismiss = useCallback(() => setFlow({ status: 'idle' }), []);

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
      >
        {/* Header — back + a day stepper (‹ Today ›, tap the label for the calendar) */}
        <View style={s.header}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={s.back}>
            <Feather name="chevron-left" size={22} color={C.foreground} />
          </Pressable>
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

        {/* Summary — calorie hero ring (LEFT + eaten/goal caption below + same-hue
            overshoot) and three macro bars carrying target + signed over. */}
        <View style={s.summary}>
          <Pressable onPress={() => setGoalOpen(true)} hitSlop={8} style={s.goalBtn} accessibilityLabel="Edit daily goal">
            <Feather name="sliders" size={12} color={isCustom ? C.textDim : C.accentText} />
            <Text style={[s.goalBtnTxt, { color: isCustom ? C.textDim : C.accentText }]}>{isCustom ? 'Goal' : 'Set goal'}</Text>
          </Pressable>
          <View style={{ alignItems: 'center' }}>
            <MacroRing
              value={eaten.kcal} target={targets.kcal} color={C.macro.calories} valueColor={C.macro.calories}
              display="remaining" overshoot name="Calories" size={132} thickness={13} centerFontSize={32}
              belowCaption={calCaption(eaten.kcal, targets.kcal)}
            />
          </View>
          <View style={s.macroRail}>
            <MacroBar verbose label="Protein" name="Protein" value={eaten.protein} target={targets.protein} color={C.macro.protein} delayMs={0} />
            <MacroBar verbose label="Carbs" name="Carbs" value={eaten.carb} target={targets.carb} color={C.macro.carbs} delayMs={70} />
            <MacroBar verbose label="Fat" name="Fat" value={eaten.fat} target={targets.fat} color={C.macro.fat} delayMs={140} />
          </View>
        </View>

        {/* Drona line */}
        <View style={s.drona}>
          <View style={s.avatar}><DronaMark size={11} color={C.accentText} state="static" /></View>
          <Text style={s.dronaTxt}>{dronaLine}</Text>
        </View>

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

              {entries.map((e) => (
                <Pressable key={e.id} style={s.entry} onPress={() => setEditEntry(e)}>
                  <Text style={s.entryName}>
                    {e.food_name} <Text style={s.serving}>· {e.quantity !== 1 ? `${e.quantity} × ` : ''}{e.serving_unit}</Text>
                  </Text>
                  <View style={s.macros}>
                    <Text style={[s.macroNum, { color: C.foreground }]}>{round(e.kcal)}</Text>
                    <Text style={[s.macroNum, { color: C.macro.protein }]}>{round(e.protein_g)}g P</Text>
                    <Text style={[s.macroNum, { color: C.macro.carbs }]}>{round(e.carb_g)}g C</Text>
                    <Text style={[s.macroNum, { color: C.macro.fat }]}>{round(e.fat_g)}g F</Text>
                  </View>
                </Pressable>
              ))}

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
              meal={flow.status === 'review' ? flow.meal : null}
              mealType={flow.status === 'review' ? flow.mealType : undefined}
              adding={adding}
              message={
                flow.status === 'declined' || flow.status === 'error' ? flow.message : null
              }
              onMealTypeChange={onMealTypeChange}
              notice={flow.status === 'review' ? flow.notice ?? null : null}
              proposalLabel={flow.status === 'review' ? flow.proposal?.note ?? null : null}
              onAcceptProposal={() => setFlow((f) => (
                f.status === 'review' && f.proposal
                  ? { ...f, meal: { ...f.meal, items: f.proposal.items }, notice: null, proposal: null }
                  : f
              ))}
              onDismissNotice={() => setFlow((f) => (f.status === 'review' ? { ...f, notice: null, proposal: null } : f))}
              onEditItem={flow.status === 'review' ? onEditItem : undefined}
              saved={flow.status === 'review' && savedReview}
              onAdd={flow.status === 'review' ? onAdd : undefined}
              onSave={flow.status === 'review' ? () => setSaveItems(flow.meal.items) : undefined}
              onRetry={flow.status === 'error' ? onRetry : undefined}
              onDismiss={onDismiss}
            />
          </View>
        )}

        {isSignedIn ? (
          <View style={s.input}>
            <Pressable onPress={() => openSearch(mealForNow())} hitSlop={8}>
              <Feather name="search" size={16} color={C.textSecondary} />
            </Pressable>
            <TextInput
              style={s.inputText}
              value={text}
              onChangeText={setText}
              placeholder="Tell Drona what you ate"
              placeholderTextColor={C.textDim}
              returnKeyType="send"
              onSubmitEditing={onSend}
              blurOnSubmit={false}
              // Wrap + grow for long entries (e.g. several metrics at once)
              // instead of scrolling off one clipped line. Submit via the arrow.
              multiline
            />
            <Pressable
              onPress={onSend}
              hitSlop={8}
              disabled={!text.trim() || flow.status === 'analysing'}
              style={[s.send, { opacity: text.trim() && flow.status !== 'analysing' ? 1 : 0.4 }]}
            >
              <Feather name="arrow-up" size={16} color={C.background} />
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
    dayNav: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    dayArrow: { width: 28, height: 32, alignItems: 'center', justifyContent: 'center' },
    dayLabelBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 2, minWidth: 92, justifyContent: 'center' },
    title: { fontSize: FontSize.xl, fontWeight: FontWeight.black, letterSpacing: LetterSpacing.tight, color: C.foreground },
    streak: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 'auto' },
    streakTxt: { fontSize: FontSize.sm, color: C.textSecondary, fontVariant: ['tabular-nums'], fontWeight: FontWeight.semibold },

    summary: { marginHorizontal: Spacing.xl, marginTop: Spacing.sm, backgroundColor: C.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: C.borderSubtle, padding: Spacing.lg, ...Shadow.card },
    goalBtn: { position: 'absolute', top: Spacing.sm, right: Spacing.sm, zIndex: 2, flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 6 },
    goalBtnTxt: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase' },
    macroRail: { marginTop: Spacing.lg, gap: 11 },

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

    inputWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, backgroundColor: C.background },
    // alignItems flex-end keeps the search + send icons on the bottom line as the field grows.
    input: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: Radius.lg, paddingHorizontal: Spacing.md, paddingVertical: 10, ...Shadow.card },
    // maxHeight caps growth (~4 lines) then scrolls; textAlignVertical top for Android multiline.
    inputText: { flex: 1, fontSize: FontSize.base, color: C.foreground, padding: 0, maxHeight: 96, textAlignVertical: 'top' },
    send: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.accentText, alignItems: 'center', justifyContent: 'center' },
  });
}
