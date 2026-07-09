/**
 * EntryEditSheet — tap a logged entry on the nutrition day view to open this.
 *
 * Three fix-it affordances in one sheet (P2):
 *   - rescale the quantity (a stepper; macros scale live from the snapshot)
 *   - move it to another meal section (Breakfast/Lunch/Dinner/Snacks chips)
 *   - delete it
 *
 * Works uniformly for every entry type (catalog / off / estimate) because it
 * scales the stored per-line macro snapshot rather than re-deriving from a food
 * row: macros are linear in amount, so quantity x ratio is exact. Portal sheet,
 * matching SetTypeSheet / WorkoutSettingsSheet (renders flush on Android
 * edge-to-edge).
 */
import { useEffect, useState } from 'react';
import { View, Text, Pressable, TouchableOpacity, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import {
  deleteMealEntry, updateEntryQuantity, moveEntry,
  type LoggedEntry,
} from '@/lib/dietData';
import { useSupabaseClient } from '@/lib/supabase';
import type { MealType } from '@/lib/foods';

const MEAL_OPTIONS: { value: MealType; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snacks' },
];

const QTY_MIN = 0.25;
const QTY_MAX = 50;
const fmtQty = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
const r0 = (n: number) => Math.round(n);

interface Props {
  entry: LoggedEntry | null;   // null = closed
  onClose: () => void;
  onSaved: () => void;         // reload the day after a mutation
}

export function EntryEditSheet({ entry, onClose, onSaved }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const supabase = useSupabaseClient();

  const [qty, setQty] = useState(1);
  const [section, setSection] = useState<MealType>('snack');
  const [busy, setBusy] = useState(false);

  // Re-seed local state each time a new entry opens the sheet.
  useEffect(() => {
    if (entry) { setQty(entry.quantity > 0 ? entry.quantity : 1); setSection(entry.meal_type); setBusy(false); }
  }, [entry]);

  useEffect(() => {
    if (!entry) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [entry, onClose]);

  if (!entry) return <Portal>{null}</Portal>;

  // Live macro preview scales from the snapshot by the quantity ratio.
  const ratio = qty / (entry.quantity > 0 ? entry.quantity : 1);
  const preview = {
    kcal: r0(entry.kcal * ratio),
    protein: r0(entry.protein_g * ratio),
    carb: r0(entry.carb_g * ratio),
    fat: r0(entry.fat_g * ratio),
  };
  const dirty = qty !== entry.quantity || section !== entry.meal_type;

  const step = (dir: 1 | -1) => {
    haptics.selection();
    setQty((q) => {
      const next = Math.round((q + dir * 0.5) * 100) / 100;
      return Math.min(Math.max(next, QTY_MIN), QTY_MAX);
    });
  };

  const onSave = async () => {
    if (!supabase || busy || !dirty) { onClose(); return; }
    setBusy(true);
    haptics.selection();
    if (qty !== entry.quantity) {
      const { error } = await updateEntryQuantity(supabase, entry, qty);
      if (error) { setBusy(false); return; }
    }
    if (section !== entry.meal_type) {
      const { error } = await moveEntry(supabase, entry, section);
      if (error) { setBusy(false); return; }
    }
    onSaved();
  };

  const onDelete = async () => {
    if (!supabase || busy) return;
    setBusy(true);
    haptics.warning();
    const { error } = await deleteMealEntry(supabase, entry);
    if (error) { setBusy(false); return; }
    onSaved();
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
                <Text style={[s.title, { color: C.foreground }]} numberOfLines={1}>{entry.food_name}</Text>
                <Text style={[s.subtitle, { color: C.mutedFg }]}>{entry.serving_unit}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityLabel="Close">
                <Feather name="x" size={15} color={C.foreground} />
              </TouchableOpacity>
            </View>

            {/* Quantity stepper + live macro preview */}
            <View style={s.qtyRow}>
              <Text style={[s.qtyLabel, { color: C.textSecondary }]}>Quantity</Text>
              <View style={s.stepper}>
                <TouchableOpacity onPress={() => step(-1)} style={[s.stepBtn, { backgroundColor: C.muted }]} accessibilityLabel="Decrease quantity">
                  <Feather name="minus" size={16} color={C.foreground} />
                </TouchableOpacity>
                <Text style={[s.qtyVal, { color: C.foreground }]}>{fmtQty(qty)}</Text>
                <TouchableOpacity onPress={() => step(1)} style={[s.stepBtn, { backgroundColor: C.muted }]} accessibilityLabel="Increase quantity">
                  <Feather name="plus" size={16} color={C.foreground} />
                </TouchableOpacity>
              </View>
            </View>

            <View style={[s.preview, { borderColor: C.borderSubtle }]}>
              <Text style={[s.macroBig, { color: C.foreground }]}>{preview.kcal}<Text style={[s.macroUnit, { color: C.textMuted }]}> kcal</Text></Text>
              <View style={{ flex: 1 }} />
              <Text style={[s.macroNum, { color: C.macro.protein }]}>{preview.protein}g P</Text>
              <Text style={[s.macroNum, { color: C.macro.carbs }]}>{preview.carb}g C</Text>
              <Text style={[s.macroNum, { color: C.macro.fat }]}>{preview.fat}g F</Text>
            </View>

            {/* Move section */}
            <Text style={[s.sectionLabel, { color: C.textMuted }]}>Section</Text>
            <View style={s.chips}>
              {MEAL_OPTIONS.map((o) => {
                const on = o.value === section;
                return (
                  <Pressable
                    key={o.value}
                    onPress={() => { haptics.selection(); setSection(o.value); }}
                    style={[s.chip, { borderColor: on ? C.accentText : C.border, backgroundColor: on ? C.accentText : 'transparent' }]}
                  >
                    <Text style={[s.chipTxt, { color: on ? C.background : C.textSecondary }]}>{o.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Actions */}
            <View style={s.actions}>
              <TouchableOpacity onPress={onDelete} disabled={busy} style={[s.deleteBtn, { backgroundColor: Colors.dangerBg }]} accessibilityLabel="Delete entry">
                <Feather name="trash-2" size={16} color={Colors.danger} />
              </TouchableOpacity>
              <Pressable onPress={onSave} disabled={busy} style={[s.saveBtn, { opacity: busy ? 0.5 : 1 }]}>
                <Text style={s.saveTxt}>{busy ? 'Saving...' : dirty ? 'Save' : 'Done'}</Text>
              </Pressable>
            </View>
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
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  qtyLabel: { fontSize: FontSize.base, fontWeight: FontWeight.medium },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  stepBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  qtyVal: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, minWidth: 44, textAlign: 'center', fontVariant: ['tabular-nums'] },

  preview: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.md, marginTop: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.xs, borderTopWidth: 1 },
  macroBig: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },
  macroUnit: { fontSize: FontSize.sm, fontWeight: FontWeight.regular },
  macroNum: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },

  sectionLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, textTransform: 'uppercase', letterSpacing: 1, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  chips: { flexDirection: 'row', gap: 6 },
  chip: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: Radius.md, borderWidth: 1 },
  chipTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },

  actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.xl },
  deleteBtn: { width: 48, height: 48, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  saveBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14 },
  saveTxt: { fontSize: FontSize.base, color: Colors.primaryFg, fontWeight: FontWeight.bold },
});
