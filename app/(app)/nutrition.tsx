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
import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import {
  Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing, Shadow,
} from '@/constants/theme';
import { MacroRing } from '@/components/ui/MacroRing';
import { MacroBar } from '@/components/diet/MacroBar';
import { ParsedMealCard, type ParseCardState } from '@/components/diet/ParsedMealCard';
import { EntryEditSheet } from '@/components/diet/EntryEditSheet';
import { NutritionGoalSheet } from '@/components/diet/NutritionGoalSheet';
import { SaveMealSheet } from '@/components/diet/SaveMealSheet';
import { SavedMealsSheet } from '@/components/diet/SavedMealsSheet';
import {
  useTodayNutrition, useNutritionTargets, setLogMeal,
  parseMeal, logParsedMeal,
  type ParsedMeal, type LoggedEntry, type ParsedMealItem,
} from '@/lib/dietData';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import type { MealType } from '@/lib/foods';

/** The AI-logging flow state driving the bar + the ParsedMealCard above it.
 *  'review' holds a parsed-but-UNLOGGED meal: nothing is written until the user
 *  picks a section and taps Add. mealType is the currently-selected section. */
type ParseFlow =
  | { status: 'idle' }
  | { status: 'analysing'; raw: string }
  | { status: 'review'; raw: string; meal: ParsedMeal; mealType: MealType }
  | { status: 'declined'; raw: string; message: string }
  | { status: 'error'; raw: string; message: string };

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
  const { byMeal, totals, reload } = useTodayNutrition();
  const supabase = useSupabaseClient();
  const { isSignedIn } = useClerkUser();
  const { kbHeight } = useKeyboardAwareScroll();

  // AI food logging (Drona parse). Signed-in only; guests keep the picker.
  // Parse -> review card (nothing logged yet) -> the user picks the section and
  // taps Add -> we write it. No auto-log, no auto-dismiss: the user is in control.
  const [text, setText] = useState('');
  const [flow, setFlow] = useState<ParseFlow>({ status: 'idle' });
  const [adding, setAdding] = useState(false);
  const [editEntry, setEditEntry] = useState<LoggedEntry | null>(null);
  const { targets, isCustom, apply: applyTargets } = useNutritionTargets();
  const [goalOpen, setGoalOpen] = useState(false);
  // Saved meals: save a parse for later; log a saved one in a tap.
  const [saveItems, setSaveItems] = useState<ParsedMealItem[] | null>(null);
  const [savedReview, setSavedReview] = useState(false); // current parse was saved
  const [savedListOpen, setSavedListOpen] = useState(false);
  const nowMeal = mealForNow();
  const nowMealLabel = MEALS.find((m) => m.type === nowMeal)?.label ?? 'this meal';

  const runParse = useCallback(async (raw: string) => {
    const t = raw.trim();
    if (!t || !supabase) return;
    setSavedReview(false);
    setFlow({ status: 'analysing', raw: t });
    const res = await parseMeal(supabase, { text: t, mealHint: mealForNow() });
    if (res.kind === 'declined') { setFlow({ status: 'declined', raw: t, message: res.message }); return; }
    if (res.kind === 'error') { setFlow({ status: 'error', raw: t, message: res.message }); return; }
    // Parsed, not logged. Seed the section selector with Drona's best guess.
    setFlow({ status: 'review', raw: t, meal: res.meal, mealType: res.meal.meal_type });
  }, [supabase]);

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
    setFlow((f) => (f.status === 'review' ? { ...f, mealType: m } : f));
  }, []);

  const onAdd = useCallback(async () => {
    if (flow.status !== 'review' || !supabase || adding) return;
    setAdding(true);
    const { error } = await logParsedMeal(supabase, { ...flow.meal, meal_type: flow.mealType });
    setAdding(false);
    if (error) { setFlow({ status: 'error', raw: flow.raw, message: 'Could not add that. Try again.' }); return; }
    reload();
    setFlow({ status: 'idle' });
  }, [flow, supabase, adding, reload]);

  const onRetry = useCallback(() => {
    if (flow.status === 'error') void runParse(flow.raw);
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
        {/* Header */}
        <View style={s.header}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={s.back}>
            <Feather name="chevron-left" size={22} color={C.foreground} />
          </Pressable>
          <Text style={s.title}>Today</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => setSavedListOpen(true)} hitSlop={10} style={s.headerBtn} accessibilityLabel="Saved meals">
            <Feather name="bookmark" size={17} color={C.foreground} />
          </Pressable>
          <View style={[s.streak, { marginLeft: Spacing.md }]}>
            <Feather name="zap" size={12} color={Colors.stat.streak} />
            <Text style={s.streakTxt}>3</Text>
          </View>
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
          <View style={s.avatar}><Feather name="zap" size={11} color={C.accentText} /></View>
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
    </View>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, height: 44 },
    back: { width: 32, height: 32, justifyContent: 'center', marginLeft: -8 },
    headerBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
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
    input: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: Radius.lg, paddingHorizontal: Spacing.md, paddingVertical: 10, ...Shadow.card },
    inputText: { flex: 1, fontSize: FontSize.base, color: C.foreground, padding: 0 },
    send: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.accentText, alignItems: 'center', justifyContent: 'center' },
  });
}
