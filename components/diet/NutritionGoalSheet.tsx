/**
 * NutritionGoalSheet — set your daily calorie + macro targets.
 *
 * The nutrition hero (calorie ring + protein/carb/fat bars) draws against these;
 * until they're set the app falls back to sensible defaults, so this is how a
 * user makes the framing theirs. Writes the four nullable columns on
 * user_profiles (the ai-coach parse_meal fn reads the same values for Drona's
 * day-aware line). Portal sheet, matching EntryEditSheet / SetTypeSheet.
 */
import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, TouchableOpacity, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import { saveNutritionTargets, type NutritionTargets } from '@/lib/dietData';
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
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();

  // Local string state per field so mid-typing ("2" on the way to "2200") is fine.
  const [vals, setVals] = useState<Record<keyof NutritionTargets, string>>({
    kcal: '', protein: '', carb: '', fat: '',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setVals({
        kcal: String(Math.round(initial.kcal)),
        protein: String(Math.round(initial.protein)),
        carb: String(Math.round(initial.carb)),
        fat: String(Math.round(initial.fat)),
      });
      setBusy(false);
    }
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return <Portal>{null}</Portal>;

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
    const next: NutritionTargets = {
      kcal: clamp(vals.kcal, FIELDS[0], initial.kcal),
      protein: clamp(vals.protein, FIELDS[1], initial.protein),
      carb: clamp(vals.carb, FIELDS[2], initial.carb),
      fat: clamp(vals.fat, FIELDS[3], initial.fat),
    };
    const { error } = await saveNutritionTargets(supabase, clerkId, next);
    setBusy(false);
    if (error) return;
    onSaved(next);
  };

  return (
    <Portal>
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
        <Animated.View
          entering={SlideInDown.duration(320).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(180)}
          style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.md }]}
        >
          <Pressable style={{ flexShrink: 1 }}>
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

            {FIELDS.map((f) => (
              <View key={f.key} style={[s.row, { borderColor: C.borderSubtle }]}>
                <View style={[s.dot, { backgroundColor: f.color(C) }]} />
                <Text style={[s.rowLabel, { color: C.foreground }]}>{f.label}</Text>
                <TextInput
                  style={[s.input, { color: C.foreground, backgroundColor: C.muted }]}
                  value={vals[f.key]}
                  onChangeText={(t) => setVals((v) => ({ ...v, [f.key]: t.replace(/[^0-9]/g, '').slice(0, 5) }))}
                  keyboardType="number-pad"
                  returnKeyType="done"
                  selectTextOnFocus
                  maxLength={5}
                  accessibilityLabel={`${f.label} target`}
                />
                <Text style={[s.unit, { color: C.textMuted }]}>{f.unit}</Text>
              </View>
            ))}

            <Pressable onPress={onSave} disabled={busy} style={[s.saveBtn, { opacity: busy ? 0.5 : 1 }]}>
              <Text style={s.saveTxt}>{busy ? 'Saving...' : 'Save goal'}</Text>
            </Pressable>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
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

  saveBtn: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, marginTop: Spacing.lg },
  saveTxt: { fontSize: FontSize.base, color: Colors.primaryFg, fontWeight: FontWeight.bold },
});
