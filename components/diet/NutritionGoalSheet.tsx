/**
 * NutritionGoalSheet — set your daily calorie + macro targets.
 *
 * The nutrition hero (calorie ring + protein/carb/fat bars) draws against these;
 * until they're set the app falls back to sensible defaults, so this is how a
 * user makes the framing theirs. Portal sheet, matching EntryEditSheet.
 *
 * Where a change lands (asked once a goal exists, "Today only" first):
 *   - Today only         -> user_day_targets for today; the plan is untouched
 *   - Rest of this phase -> the profile AND the current program phase, so the
 *                           plan and the ring agree (with a program)
 *   - From today on      -> the profile (no program)
 * A first goal skips the question: there is nothing to go back to. A bigger
 * change to the plan is Drona's job, through the "whole plan" link.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, TouchableOpacity, StyleSheet, BackHandler, Keyboard, Platform, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import { Portal } from '@/components/ui/Portal';
import { useSheetSlide } from '@/hooks/useSheetSlide';
import { haptics } from '@/lib/haptics';
import {
  saveNutritionTargets, saveDayTarget, clearDayTarget, energySplit, macrosForKcal, macroKcal, ymd,
  type NutritionTargets, type EnergySplit,
} from '@/lib/dietData';
import { loadActiveProgram } from '@/lib/programData';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import { fuelDayText, type FuelDay } from '@/lib/fuelDays';

interface Field { key: keyof NutritionTargets; label: string; unit: string; color: (c: any) => string; min: number; max: number }
const FIELDS: Field[] = [
  { key: 'kcal', label: 'Calories', unit: 'kcal', color: (c) => c.macro.calories, min: 800, max: 8000 },
  { key: 'protein', label: 'Protein', unit: 'g', color: (c) => c.macro.protein, min: 0, max: 500 },
  { key: 'carb', label: 'Carbs', unit: 'g', color: (c) => c.macro.carbs, min: 0, max: 1000 },
  { key: 'fat', label: 'Fat', unit: 'g', color: (c) => c.macro.fat, min: 0, max: 400 },
];

export type GoalScope = 'today' | 'lasting';

interface Props {
  open: boolean;
  /** Today's goal: a one-day goal when today has one, else the lasting goal. */
  initial: NutritionTargets;
  /**
   * The lasting goal. Switching to the lasting choice before typing reseeds the
   * fields from it, so a one-day number is never saved to the whole phase just
   * because it was on screen. Defaults to `initial`.
   */
  lasting?: NutritionTargets;
  onClose: () => void;
  /** `today`: a goal for today only; `lasting`: from today on (and the phase, with a program). */
  onSaved: (saved: NutritionTargets, scope: GoalScope) => void;
  /** No goal set yet: save it as the lasting goal without asking. */
  firstGoal?: boolean;
  /** With a program: hand the new calories to Drona to rework the whole plan. */
  onOpenDronaPlan?: (kcal: number) => void;
  /** The weekdays that get more on top of this goal. Shown as a door to FuelDaysSheet. */
  fuelDays?: FuelDay[];
  onOpenFuelDays?: () => void;
}

export function NutritionGoalSheet({
  open, initial, lasting, onClose, onSaved, fuelDays, onOpenFuelDays, firstGoal, onOpenDronaPlan,
}: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();

  // Local string state per field so mid-typing ("2" on the way to "2200") is fine.
  const [vals, setVals] = useState<Record<keyof NutritionTargets, string>>({
    kcal: '', protein: '', carb: '', fat: '',
  });
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<GoalScope>('today');
  // The program phase running today, if any: "Rest of this phase" writes it too.
  // `before` keeps the phase's own values, nulls included, so an undo restores
  // exactly what was there.
  type PhaseDiet = { kcal: number | null; protein: number | null; carb: number | null; fat: number | null };
  const [phase, setPhase] = useState<{ id: string; name: string; before: PhaseDiet } | null>(null);
  // True once the user types: from then on switching the choice keeps their numbers.
  const [dirty, setDirty] = useState(false);
  // Until the program lookup answers, the choice is unknown: showing "From
  // today on" and flipping to "Rest of this phase" read as a glitch, and a
  // lasting save before it answered would skip the phase.
  const [phaseReady, setPhaseReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // The split the calorie field scales against. Seeded from the saved goal and
  // re-read whenever the user edits a macro by hand, so their own ratio sticks.
  const splitRef = useRef<EnergySplit>(energySplit(initial));

  const { mounted, slideStyle } = useSheetSlide(open);
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    if (!open) { setKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, [open]);

  // Seed the form on the closed -> open edge only. Re-seeding whenever `initial`
  // changes would let a background target refresh (the hook refetches on focus)
  // overwrite whatever the user is halfway through typing, so we gate on the
  // transition rather than dropping `initial` out of the dependency list.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setVals({
        kcal: String(Math.round(initial.kcal)),
        protein: String(Math.round(initial.protein)),
        carb: String(Math.round(initial.carb)),
        fat: String(Math.round(initial.fat)),
      });
      splitRef.current = energySplit(initial);
      setBusy(false);
      setFailed(false);
      setDirty(false);
      setScope(firstGoal ? 'lasting' : 'today');
      setPhase(null);
      setPhaseReady(false);
      const clerkId = user?.id;
      if (supabase && clerkId) {
        loadActiveProgram(supabase, clerkId)
          .then((p) => {
            const ph = p && p.currentPhaseSeq != null ? p.phases[p.currentPhaseSeq] : null;
            setPhase(ph
              ? {
                  id: ph.id,
                  name: ph.name,
                  // What the phase held, so a failed profile write can put it back.
                  before: {
                    kcal: ph.diet_calorie_target,
                    protein: ph.diet_protein_g,
                    carb: ph.diet_carb_g,
                    fat: ph.diet_fat_g,
                  },
                }
              : null);
          })
          .catch(() => setPhase(null))
          .finally(() => setPhaseReady(true));
      } else {
        setPhaseReady(true);
      }
    }
    wasOpen.current = open;
  }, [open, initial, firstGoal, supabase, user?.id]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  // Editing calories re-derives the macros at the same split; editing a macro
  // re-reads the split so the next calorie change respects it.
  //
  // The next state is computed here rather than inside a setVals updater: React
  // may replay or discard an updater, and a discarded one that had written
  // splitRef would leave the split describing values that never committed.
  // Updaters stay pure; the ref is written from the handler, which runs once.
  const seed = (t: NutritionTargets) => {
    setVals({
      kcal: String(Math.round(t.kcal)),
      protein: String(Math.round(t.protein)),
      carb: String(Math.round(t.carb)),
      fat: String(Math.round(t.fat)),
    });
    splitRef.current = energySplit(t);
  };
  // Untouched fields follow the choice: today's goal for "Today only", the
  // lasting goal otherwise. Typed numbers stay whatever the choice.
  const pickScope = (k: GoalScope) => {
    haptics.selection();
    setScope(k);
    if (!dirty) seed(k === 'today' ? initial : (lasting ?? initial));
  };

  const onChangeField = (key: keyof NutritionTargets, raw: string) => {
    setDirty(true);
    const txt = raw.replace(/[^0-9]/g, '').slice(0, 5);
    if (key === 'kcal') {
      const n = parseInt(txt, 10);
      // Ignore half-typed numbers below the floor ("1" on the way to "1600");
      // scaling those would round the macros to junk. onSave re-derives from the
      // clamped value, so a number left out of range still saves consistently.
      if (!Number.isFinite(n) || n < FIELDS[0].min) {
        setVals({ ...vals, kcal: txt });
        return;
      }
      const m = macrosForKcal(Math.min(n, FIELDS[0].max), splitRef.current);
      setVals({ kcal: txt, protein: String(m.protein), carb: String(m.carb), fat: String(m.fat) });
      return;
    }
    const next = { ...vals, [key]: txt };
    splitRef.current = energySplit({
      protein: parseInt(next.protein, 10) || 0,
      carb: parseInt(next.carb, 10) || 0,
      fat: parseInt(next.fat, 10) || 0,
    });
    setVals(next);
  };

  // Live read-out so the split is visible, and so a hand-edited macro that no
  // longer matches the calorie goal says so instead of hiding.
  const parsed = {
    protein: parseInt(vals.protein, 10) || 0,
    carb: parseInt(vals.carb, 10) || 0,
    fat: parseInt(vals.fat, 10) || 0,
  };
  const sumKcal = macroKcal(parsed);
  const goalKcal = parseInt(vals.kcal, 10);
  const drift = Number.isFinite(goalKcal) ? sumKcal - goalKcal : 0;
  const onGoal = Math.abs(drift) <= 5;
  const driftNote = onGoal
    ? 'That matches your goal.'
    : `That is ${Math.abs(drift)} ${drift > 0 ? 'over' : 'under'} your goal.`;

  if (!mounted) return <Portal>{null}</Portal>;

  const onSave = async () => {
    const clerkId = user?.id;
    if (!supabase || !clerkId || busy) { onClose(); return; }
    // Every save waits for the program lookup: a lasting save made before it
    // answers would skip the phase, even a first goal's.
    if (!phaseReady) return;
    setBusy(true);
    haptics.selection();
    // Clamp each field into its sane range; blank/garbage falls back to the
    // initial value so a half-cleared field never writes a 0-calorie goal.
    const clamp = (raw: string, f: Field, fallback: number) => {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(Math.max(n, f.min), f.max);
    };
    const kcal = clamp(vals.kcal, FIELDS[0], initial.kcal);
    const next: NutritionTargets = {
      kcal,
      protein: clamp(vals.protein, FIELDS[1], initial.protein),
      carb: clamp(vals.carb, FIELDS[2], initial.carb),
      fat: clamp(vals.fat, FIELDS[3], initial.fat),
    };
    // A calorie value the field never rescaled against (blank, or outside
    // 800..8000) would otherwise save the CLAMPED number next to macros still
    // sized for the old goal: typing 700 over a 2200 goal saved 800 kcal with
    // ~2200 kcal of macros. Re-derive at the split whenever what we are about
    // to persist is not what the user typed.
    if (kcal !== parseInt(vals.kcal, 10)) {
      const m = macrosForKcal(kcal, splitRef.current);
      next.protein = m.protein;
      next.carb = m.carb;
      next.fat = m.fat;
    }
    const today = ymd(new Date());
    let error: string | undefined;
    if (scope === 'today') {
      ({ error } = await saveDayTarget(supabase, clerkId, today, next));
    } else {
      // With a program, the phase moves too, so Goal & Plan, the next phase
      // change and Drona all read the same number as the ring. Phase first,
      // and it must really match a row: an RLS or stale-id miss returns no
      // error, and the profile alone would leave the ring and plan apart.
      const writePhase = async (t: NutritionTargets | PhaseDiet) => {
        if (!phase) return undefined;
        const { data, error: phaseErr } = await supabase
          .from('coach_program_phases')
          .update({ diet_calorie_target: t.kcal, diet_protein_g: t.protein, diet_carb_g: t.carb, diet_fat_g: t.fat })
          .eq('id', phase.id)
          .select('id');
        if (phaseErr) return phaseErr.message;
        return (data?.length ?? 0) === 0 ? 'phase not updated' : undefined;
      };
      error = await writePhase(next);
      if (!error) {
        ({ error } = await saveNutritionTargets(supabase, clerkId, next));
        // The profile write failed after the phase moved: put the phase back,
        // so "did not save" is true of both.
        if (error && phase) await writePhase(phase.before);
      }
      // A lasting goal ends any "today only" one, or today would still show it.
      // Not fatal: the goal itself is saved, and a "did not save" here would
      // be untrue. The caller clears it locally either way.
      if (!error) {
        const { error: clearErr } = await clearDayTarget(supabase, clerkId, today);
        if (clearErr) console.warn('[goal] could not clear today\'s one-day goal', clearErr);
      }
    }
    setBusy(false);
    if (error) { haptics.warning(); setFailed(true); return; }
    track('nutrition_targets_edited', {
      kcal: next.kcal,
      kcal_delta: next.kcal - initial.kcal,
      protein_delta: next.protein - initial.protein,
      clamped: kcal !== parseInt(vals.kcal, 10),
      scope: scope === 'today' ? 'today' : phase ? 'phase' : 'from_today',
    });
    onSaved(next, scope);
  };

  const lastingLabel = phase ? 'Rest of this phase' : 'From today on';
  const scopeNote = scope === 'today'
    ? (phase ? 'Just for today. Tomorrow you are back on your plan.' : 'Just for today. Tomorrow goes back to your usual goal.')
    : (phase ? `Every day until ${phase.name} ends. Your plan changes to match.` : 'Every day from today on.');
  const saveLabel = busy
    ? 'Saving...'
    : firstGoal ? 'Save goal' : scope === 'today' ? 'Save for today' : phase ? 'Save for this phase' : 'Save goal';

  return (
    <Portal>
      <View style={s.backdrop} pointerEvents={open ? 'auto' : 'none'}>
        {open && (
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
            style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]}
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
          </Animated.View>
        )}
        <Animated.View
          style={[s.sheet, slideStyle, {
            backgroundColor: C.elevated,
            // The keyboard covers the home indicator, so reserving its inset
            // while the keyboard is up just leaves dead space under the button.
            paddingBottom: kbHeight > 0 ? Spacing.md : insets.bottom + Spacing.md,
            marginBottom: kbHeight,
            maxHeight: (winH - kbHeight) * 0.9,
          }]}
        >
          <View style={[s.handle, { backgroundColor: C.handle }]} />

          <View style={s.header}>
            <View style={{ flex: 1 }}>
              <Text style={[s.title, { color: C.foreground }]}>Daily goal</Text>
              <Text style={[s.subtitle, { color: C.mutedFg }]}>Past days keep the goal they had.</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityLabel="Close">
              <Feather name="x" size={15} color={C.foreground} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{ flexShrink: 1 }}>
            {FIELDS.map((f) => (
              <View key={f.key} style={[s.row, { borderColor: C.borderSubtle }]}>
                <View style={[s.dot, { backgroundColor: f.color(C) }]} />
                <Text style={[s.rowLabel, { color: C.foreground }]}>{f.label}</Text>
                <TextInput
                  style={[s.input, { color: C.foreground, backgroundColor: C.muted }]}
                  value={vals[f.key]}
                  onChangeText={(t) => onChangeField(f.key, t)}
                  keyboardType="number-pad"
                  returnKeyType="done"
                  selectTextOnFocus
                  maxLength={5}
                  accessibilityLabel={`${f.label} target`}
                />
                <Text style={[s.unit, { color: C.textMuted }]}>{f.unit}</Text>
              </View>
            ))}

            <View style={[s.summary, { borderColor: C.borderSubtle }]}>
              <Text style={[s.summaryTxt, { color: onGoal ? C.mutedFg : C.macro.calories }]}>
                {`Macros add up to ${sumKcal} kcal. ${driftNote}`}
              </Text>
            </View>

            {/* This is the ordinary day. Harder days get more on top. */}
            {onOpenFuelDays && (
              <Pressable
                onPress={onOpenFuelDays}
                style={[s.fuelRow, { borderColor: C.borderSubtle }]}
                accessibilityRole="button"
                accessibilityLabel="Fuel days"
              >
                <Feather name="zap" size={13} color={C.accentText} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.fuelTitle, { color: C.foreground }]}>Fuel days</Text>
                  <Text style={[s.fuelSub, { color: C.mutedFg }]} numberOfLines={1}>
                    {fuelDays && fuelDays.length > 0
                      ? fuelDays.map(fuelDayText).join(', ')
                      : 'More food on long-run or leg days'}
                  </Text>
                </View>
                <Feather name="chevron-right" size={15} color={C.textMuted} />
              </Pressable>
            )}
          </ScrollView>

          {/* Where the change lands. Asked once a goal exists; "Today only" first,
              so a one-off day never quietly rewrites the plan. */}
          {!firstGoal && phaseReady && (
            <View style={s.scopeWrap}>
              <View style={[s.scopeTrack, { backgroundColor: C.muted }]}>
                {(['today', 'lasting'] as const).map((k) => {
                  const on = scope === k;
                  return (
                    <Pressable
                      key={k}
                      onPress={() => pickScope(k)}
                      style={[s.scopeOpt, on && { backgroundColor: C.elevated }]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                    >
                      <Text style={[s.scopeTxt, { color: on ? C.foreground : C.mutedFg }]}>
                        {k === 'today' ? 'Today only' : lastingLabel}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={[s.scopeNote, { color: C.mutedFg }]}>{scopeNote}</Text>
              {phase && onOpenDronaPlan && (
                <Pressable
                  onPress={() => {
                    const n = parseInt(vals.kcal, 10);
                    // Same bounds Save uses: never hand the chat a number the sheet would refuse.
                    const kcal = Number.isFinite(n) ? Math.min(Math.max(n, FIELDS[0].min), FIELDS[0].max) : initial.kcal;
                    onOpenDronaPlan(kcal);
                  }}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Change my whole plan with Drona"
                >
                  <Text style={[s.dronaLink, { color: C.accentText }]}>Change my whole plan with Drona ›</Text>
                </Pressable>
              )}
            </View>
          )}

          {failed && (
            <Text style={[s.scopeNote, { color: C.dangerText, marginTop: Spacing.sm }]}>
              That did not save. Check your connection and try again.
            </Text>
          )}

          <Pressable
            onPress={onSave}
            disabled={busy || !phaseReady}
            style={[s.saveBtn, { opacity: busy || !phaseReady ? 0.5 : 1 }]}
          >
            <Text style={s.saveTxt}>{saveLabel}</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowLabel: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.medium },
  input: {
    minWidth: 76, borderRadius: Radius.sm, paddingVertical: 8, paddingHorizontal: 12,
    fontSize: FontSize.base, fontWeight: FontWeight.semibold, textAlign: 'right', fontVariant: ['tabular-nums'],
  },
  unit: { fontSize: FontSize.sm, width: 28 },

  summary: { paddingTop: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  summaryTxt: { fontSize: FontSize.sm, lineHeight: 18 },

  fuelRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.md, paddingTop: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  fuelTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  fuelSub: { fontSize: FontSize.xs, marginTop: 1 },

  scopeWrap: { marginTop: Spacing.md, gap: 6 },
  scopeTrack: { flexDirection: 'row', borderRadius: Radius.md, padding: 3 },
  scopeOpt: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: Radius.sm },
  scopeTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  scopeNote: { fontSize: FontSize.xs, lineHeight: 17 },
  dronaLink: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, marginTop: 2 },

  saveBtn: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, marginTop: Spacing.lg },
  saveTxt: { fontSize: FontSize.base, color: Colors.primaryFg, fontWeight: FontWeight.bold },
});
