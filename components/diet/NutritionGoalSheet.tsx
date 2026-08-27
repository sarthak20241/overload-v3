/**
 * NutritionGoalSheet — set your daily calorie + macro targets.
 *
 * The nutrition hero (calorie ring + protein/carb/fat bars) draws against these;
 * until they're set the app falls back to sensible defaults, so this is how a
 * user makes the framing theirs. Writes the four nullable columns on
 * user_profiles (the ai-coach parse_meal fn reads the same values for Drona's
 * day-aware line). Portal sheet, matching EntryEditSheet / SetTypeSheet.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, TouchableOpacity, StyleSheet, BackHandler, Keyboard, Platform, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { useSheetSlide } from '@/hooks/useSheetSlide';
import { haptics } from '@/lib/haptics';
import {
  saveNutritionTargets, energySplit, macrosForKcal, macroKcal,
  type NutritionTargets, type EnergySplit,
} from '@/lib/dietData';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';

interface Field { key: keyof NutritionTargets; label: string; unit: string; color: (c: any) => string; min: number; max: number }
const FIELDS: Field[] = [
  { key: 'kcal', label: 'Calories', unit: 'kcal', color: (c) => c.macro.calories, min: 800, max: 8000 },
  { key: 'protein', label: 'Protein', unit: 'g', color: (c) => c.macro.protein, min: 0, max: 500 },
  { key: 'carb', label: 'Carbs', unit: 'g', color: (c) => c.macro.carbs, min: 0, max: 1000 },
  { key: 'fat', label: 'Fat', unit: 'g', color: (c) => c.macro.fat, min: 0, max: 400 },
];

interface Props {
  open: boolean;
  initial: NutritionTargets;
  onClose: () => void;
  onSaved: (saved: NutritionTargets) => void;
}

export function NutritionGoalSheet({ open, initial, onClose, onSaved }: Props) {
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
    }
    wasOpen.current = open;
  }, [open, initial]);

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
  const onChangeField = (key: keyof NutritionTargets, raw: string) => {
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
    const { error } = await saveNutritionTargets(supabase, clerkId, next);
    setBusy(false);
    if (error) { haptics.warning(); return; }
    onSaved(next);
  };

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
              <Text style={[s.subtitle, { color: C.mutedFg }]}>What Drona coaches you toward</Text>
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
          </ScrollView>

          <Pressable onPress={onSave} disabled={busy} style={[s.saveBtn, { opacity: busy ? 0.5 : 1 }]}>
            <Text style={s.saveTxt}>{busy ? 'Saving...' : 'Save goal'}</Text>
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

  saveBtn: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, marginTop: Spacing.lg },
  saveTxt: { fontSize: FontSize.base, color: Colors.primaryFg, fontWeight: FontWeight.bold },
});
